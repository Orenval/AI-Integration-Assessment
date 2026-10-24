import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import { validateCsrfToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';
import { deleteObject } from '@/lib/storage/r2';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
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

  const { id } = await context.params;

  // 3. Find job scoped to current user
  const job = await prisma.job.findFirst({
    where: {
      id,
      userId: auth.session.userId,
    },
    select: {
      id: true,
      storageKey: true,
      originalFileName: true,
    },
  });

  if (!job) {
    return NextResponse.json(
      { success: false, message: 'Listing not found or access denied' },
      { status: 404 }
    );
  }

  // 4. Delete R2 storage object if it exists
  if (job.storageKey) {
    try {
      await deleteObject(job.storageKey);
    } catch (storageErr) {
      console.error(
        `[delete] Failed to delete R2 object ${job.storageKey} for job ${id}:`,
        storageErr
      );
      // Proceed with database deletion so the record does not remain stuck
    }
  }

  // 5. Delete job record from database
  await prisma.job.delete({
    where: { id: job.id },
  });

  return NextResponse.json({
    success: true,
    message: `Listing "${job.originalFileName}" was successfully removed`,
  });
}
