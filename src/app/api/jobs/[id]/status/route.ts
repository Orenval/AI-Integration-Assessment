import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import prisma from '@/lib/prisma';
import { JobDetailDto } from '@/lib/ai/types';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext
): Promise<NextResponse> {
  const auth = await validateSession();
  if (!auth) {
    return NextResponse.json(
      { success: false, message: 'Authentication required' },
      { status: 401 }
    );
  }

  const { id } = await context.params;

  // Direct scoping by userId ensures isolation; returns 404 if not found or unowned
  const job = await prisma.job.findFirst({
    where: {
      id,
      userId: auth.session.userId,
    },
    select: {
      id: true,
      status: true,
      attempts: true,
      errorMessage: true,
      originalFileName: true,
      result: true,
      expandedResult: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!job) {
    return NextResponse.json(
      { success: false, message: 'Job not found' },
      { status: 404 }
    );
  }

  const jobDetail: JobDetailDto = {
    id: job.id,
    status: job.status as JobDetailDto['status'],
    attempts: job.attempts,
    errorMessage: job.errorMessage,
    originalFileName: job.originalFileName,
    result: job.result,
    expandedResult: job.expandedResult,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };

  return NextResponse.json({
    success: true,
    job: jobDetail,
  });
}
