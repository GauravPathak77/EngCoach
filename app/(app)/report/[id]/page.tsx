import { redirect } from 'next/navigation';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import { getSession } from '@/server/services/sessionService';
import { loadReport } from '@/server/services/reportService';
import { ReportClient } from '@/components/report/ReportClient';

export const dynamic = 'force-dynamic';

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const { id } = await params;
  const session = await getSession(id, user.id);
  if (!session) redirect('/home');

  // Generating a report costs a model call, so it happens on demand from the client rather than
  // on every page render. A refresh should show the stored one, not bill for a new one.
  const existing = await loadReport(id, user.id);

  return <ReportClient sessionId={id} initialReport={existing} />;
}
