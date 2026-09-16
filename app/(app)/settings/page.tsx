import { redirect } from 'next/navigation';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import { hasLiveCredentials } from '@/lib/llm/client';
import { hasSttCredentials } from '@/lib/voice/stt';
import { ttsMode } from '@/lib/voice/tts';
import { usingPglite } from '@/db/client';
import { SettingsClient } from '@/components/SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  return (
    <SettingsClient
      email={user.email}
      initial={user.settings}
      providers={{
        llm: hasLiveCredentials() ? 'live' : 'scripted',
        stt: hasSttCredentials() ? 'deepgram' : 'browser',
        tts: ttsMode(),
        db: usingPglite() ? 'pglite' : 'postgres',
      }}
    />
  );
}
