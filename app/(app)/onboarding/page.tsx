import { redirect } from 'next/navigation';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import { OnboardingForm } from '@/components/OnboardingForm';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  return <OnboardingForm />;
}
