import { redirect } from 'next/navigation';
import { validateSession } from '@/lib/session';
import { JobDetailView } from './job-view';

export const runtime = 'nodejs';

interface JobPageProps {
  params: Promise<{ id: string }>;
}

export default async function JobPage({ params }: JobPageProps) {
  const sessionData = await validateSession();

  if (!sessionData) {
    redirect('/signin');
  }

  if (!sessionData.user.emailVerified) {
    redirect('/verify-email');
  }

  const { id } = await params;

  return <JobDetailView jobId={id} user={sessionData.user} />;
}
