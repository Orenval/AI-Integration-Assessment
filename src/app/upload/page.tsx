import { redirect } from 'next/navigation';
import { validateSession } from '@/lib/session';
import { UploadView } from './upload-view';

export const runtime = 'nodejs';

export default async function UploadPage() {
  const sessionData = await validateSession();

  if (!sessionData) {
    redirect('/signin');
  }

  if (!sessionData.user.emailVerified) {
    redirect('/verify-email');
  }

  return <UploadView user={sessionData.user} />;
}
