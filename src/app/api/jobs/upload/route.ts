import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import { validateCsrfToken } from '@/lib/csrf';
import { checkSlidingRateLimit } from '@/lib/sliding-rate-limit';
import { UPLOAD_LIMITS } from '@/lib/ai/config';
import { generateStorageKey, putObject, deleteObject } from '@/lib/storage/r2';
import { enqueueJob } from '@/lib/jobs/queue';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';

/**
 * Validates file magic bytes (signatures) to ensure real JPEG or PNG content.
 */
function validateImageMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 8) return false;

  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimeType === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  return false;
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Session check
  const auth = await validateSession();
  if (!auth) {
    return NextResponse.json(
      { success: false, message: 'Authentication required' },
      { status: 401 }
    );
  }

  // 2. CSRF validation
  const isCsrfValid = await validateCsrfToken(request);
  if (!isCsrfValid) {
    return NextResponse.json(
      { success: false, message: 'Invalid or missing CSRF token' },
      { status: 403 }
    );
  }

  // 3. Rate limit check (Sliding Window: 10 requests per 10 minutes)
  const rateLimit = await checkSlidingRateLimit(auth.session.userId, 'upload');
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        message: 'Too many upload requests. Please try again later.',
        retryAfter: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: rateLimit.headers,
      }
    );
  }

  // 4. Input parsing & validation
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid multipart form data' },
      { status: 400 }
    );
  }

  // Retrieve files from formData ('files' or 'file')
  const rawFiles = formData.getAll('files');
  if (rawFiles.length === 0) {
    const single = formData.get('file');
    if (single) rawFiles.push(single);
  }

  const files = rawFiles.filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json(
      { success: false, message: 'No files provided in upload payload' },
      { status: 400 }
    );
  }

  if (files.length > UPLOAD_LIMITS.maxFilesPerUpload) {
    return NextResponse.json(
      {
        success: false,
        message: `Upload exceeds maximum allowed batch size of ${UPLOAD_LIMITS.maxFilesPerUpload} files`,
      },
      { status: 400 }
    );
  }

  const createdJobs: Array<{
    id: string;
    originalFileName: string;
    status: string;
    createdAt: Date;
  }> = [];

  const rejectedFiles: Array<{
    name: string;
    reason: string;
  }> = [];

  for (const file of files) {
    const fileName = file.name || 'unnamed_file';

    if (file.size === 0) {
      rejectedFiles.push({ name: fileName, reason: 'File is empty (0 bytes).' });
      continue;
    }

    if (file.size > UPLOAD_LIMITS.maxFileSizeBytes) {
      rejectedFiles.push({
        name: fileName,
        reason: `File size exceeds the 5MB limit (${(file.size / (1024 * 1024)).toFixed(2)}MB).`,
      });
      continue;
    }

    const mimeType = file.type;
    if (!UPLOAD_LIMITS.allowedMimeTypes.includes(mimeType as 'image/jpeg' | 'image/png')) {
      rejectedFiles.push({
        name: fileName,
        reason: `Unsupported file format (${mimeType || 'unknown'}). Only JPEG and PNG are allowed.`,
      });
      continue;
    }

    let buffer: Buffer;
    try {
      const arrayBuffer = await file.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch {
      rejectedFiles.push({ name: fileName, reason: 'Failed to read file contents.' });
      continue;
    }

    if (!validateImageMagicBytes(buffer, mimeType)) {
      rejectedFiles.push({
        name: fileName,
        reason: 'Invalid file signature: content does not match genuine JPEG/PNG image data.',
      });
      continue;
    }

    const storageKey = generateStorageKey(auth.session.userId, mimeType);

    // Upload to Cloudflare R2
    try {
      await putObject(storageKey, buffer, mimeType);
    } catch (storageErr) {
      console.error(`[upload] Storage upload failed for ${fileName}:`, storageErr);
      rejectedFiles.push({ name: fileName, reason: 'Failed to upload image to object storage.' });
      continue;
    }

    // Persist Job row in database
    try {
      const job = await prisma.job.create({
        data: {
          userId: auth.session.userId,
          status: 'pending',
          storageKey,
          originalFileName: fileName,
          fileSize: file.size,
          mimeType,
        },
      });

      enqueueJob(job.id);

      createdJobs.push({
        id: job.id,
        originalFileName: job.originalFileName,
        status: job.status,
        createdAt: job.createdAt,
      });
    } catch (dbErr) {
      console.error(`[upload] DB record creation failed for ${fileName}. Cleaning up R2 object:`, dbErr);
      // Cleanup orphan R2 object if DB insertion fails
      try {
        await deleteObject(storageKey);
      } catch (delErr) {
        console.error(`[upload] Failed to delete orphaned R2 object ${storageKey}:`, delErr);
      }

      rejectedFiles.push({ name: fileName, reason: 'Database error while registering upload.' });
    }
  }

  // If every file was rejected, return 400
  if (createdJobs.length === 0) {
    return NextResponse.json(
      {
        success: false,
        message: 'All uploaded files were rejected.',
        rejected: rejectedFiles,
      },
      { status: 400, headers: rateLimit.headers }
    );
  }

  return NextResponse.json(
    {
      success: true,
      jobs: createdJobs,
      rejected: rejectedFiles,
    },
    {
      status: 201,
      headers: rateLimit.headers,
    }
  );
}
