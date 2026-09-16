import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth';
import { ensureSchema } from '@/db/migrate';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  if (!user.onboardedAt) redirect('/onboarding');
  redirect('/home');
}
