import { redirect } from 'next/navigation';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import { getSession, listTurns } from '@/server/services/sessionService';
import { hasLiveCredentials } from '@/lib/llm/client';
import { hasSttCredentials } from '@/lib/voice/stt';
import { resolveCoachVoice, ttsMode } from '@/lib/voice/tts';
import { providerSummary } from '@/lib/llm/providers';
import { usingPglite } from '@/db/client';
import { SessionClient } from '@/components/session/SessionClient';

export const dynamic = 'force-dynamic';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const { id } = await params;
  const session = await getSession(id, user.id);
  if (!session) redirect('/home');
  if (session.status === 'ended') redirect(`/report/${id}`);

  const turns = await listTurns(id);
  // Resolved server-side so the client never handles a provider voice id (ADR-020).
  const coachVoice = resolveCoachVoice(user.settings.coachVoice);
  const lanes = providerSummary();

  return (
    <SessionClient
      sessionId={id}
      mode={session.mode}
      config={{
        llm: hasLiveCredentials() ? 'live' : 'scripted',
        stt: hasSttCredentials() ? 'deepgram' : 'browser',
        tts: ttsMode(),
        db: usingPglite() ? 'pglite' : 'postgres',
        coachVoice: {
          id: coachVoice.id,
          displayName: coachVoice.displayName,
          presentation: coachVoice.presentation,
        },
        lanes,
      }}
      initialTurns={turns.map((t) => ({
        id: t.id,
        role: t.role as 'user' | 'coach',
        text: t.text,
      }))}
    />
  );
}
