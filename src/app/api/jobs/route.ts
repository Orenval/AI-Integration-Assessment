import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import { validateCsrfToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';
import { deleteObject } from '@/lib/storage/r2';
import { JobDto } from '@/lib/ai/types';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const auth = await validateSession();
  if (!auth) {
    return NextResponse.json(
      { success: false, message: 'Authentication required' },
      { status: 401 }
    );
  }

  const jobs = await prisma.job.findMany({
    where: {
      userId: auth.session.userId,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 20,
    select: {
      id: true,
      status: true,
      attempts: true,
      errorMessage: true,
      originalFileName: true,
      createdAt: true,
      result: true,
    },
  });

  const formattedJobs: JobDto[] = jobs.map((job) => {
    const resultObj = job.result as { title?: string } | null;
    return {
      id: job.id,
      status: job.status as JobDto['status'],
      attempts: job.attempts,
      errorMessage: job.errorMessage,
      originalFileName: job.originalFileName,
      createdAt: job.createdAt.toISOString(),
      resultTitle: resultObj?.title || null,
    };
  });

  return NextResponse.json({
    success: true,
    jobs: formattedJobs,
  });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  // 1. Session check
  const auth = await validateSession();
  if (!auth) {
    return NextResponse.json(
      { success: false, message: 'Authentication required' },
      { status: 401 }
    );
  }

  // 2. CSRF check
  const isCsrfValid = await validateCsrfToken(request);
  if (!isCsrfValid) {
    return NextResponse.json(
      { success: false, message: 'Invalid or missing CSRF token' },
      { status: 403 }
    );
  }

  // 3. Body parse
  let body: { ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON request body' },
      { status: 400 }
    );
  }

  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
    : [];

  if (ids.length === 0) {
    return NextResponse.json(
      { success: false, message: 'No listing IDs provided' },
      { status: 400 }
    );
  }

  // 4. Scoped query ensuring user ownership
  const targetJobs = await prisma.job.findMany({
    where: {
      id: { in: ids },
      userId: auth.session.userId,
    },
    select: {
      id: true,
      storageKey: true,
    },
  });

  if (targetJobs.length === 0) {
    return NextResponse.json(
      { success: false, message: 'No matching listings found' },
      { status: 404 }
    );
  }

  // 5. Clean up R2 objects
  await Promise.allSettled(
    targetJobs.map(async (job) => {
      if (job.storageKey) {
        try {
          await deleteObject(job.storageKey);
        } catch (storageErr) {
          console.error(
            `[batch-delete] Failed to delete R2 object ${job.storageKey}:`,
            storageErr
          );
        }
      }
    })
  );

  // 6. Delete DB records
  const deleteResult = await prisma.job.deleteMany({
    where: {
      id: { in: targetJobs.map((j) => j.id) },
      userId: auth.session.userId,
    },
  });

  return NextResponse.json({
    success: true,
    message: `${deleteResult.count} listing${
      deleteResult.count === 1 ? '' : 's'
    } successfully removed`,
    deletedCount: deleteResult.count,
  });
}

