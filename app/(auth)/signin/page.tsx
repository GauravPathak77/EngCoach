import { redirect } from 'next/navigation';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import { SignInForm } from '@/components/SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (user) redirect('/home');
  return <SignInForm />;
}
