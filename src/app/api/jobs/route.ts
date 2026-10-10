import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import prisma from '@/lib/prisma';
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
