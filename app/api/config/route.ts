/**
 * Runtime capability report.
 *
 * The UI uses this to tell the user honestly which providers are live and which are running in
 * the degraded development path. Nothing here is secret — it reports whether keys exist and
 * which local models are pulled, never a key's value.
 */

import { hasLiveCredentials } from '@/lib/llm/client';
import { providerSummary } from '@/lib/llm/providers';
import { ollamaStatus } from '@/lib/llm/ollama';
import { modelSummary } from '@/lib/llm/models';
import { hasSttCredentials } from '@/lib/voice/stt';
import { ttsMode } from '@/lib/voice/tts';
import { usingPglite } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const providers = providerSummary();
  const models = modelSummary();
  const usesOllama = Object.values(providers).includes('ollama');

  return Response.json({
    // Kept for the existing session banner: 'live' vs 'scripted'.
    llm: hasLiveCredentials() ? 'live' : 'scripted',
    stt: hasSttCredentials() ? 'deepgram' : 'browser',
    tts: ttsMode(),
    db: usingPglite() ? 'pglite' : 'postgres',
    lanes: {
      hot: { provider: providers.hot, model: models.hot },
      cold: { provider: providers.cold, model: models.cold },
      session: { provider: providers.session, model: models.session },
    },
    // Only probed when a lane actually depends on it — no point pinging a server nobody uses.
    ollama: usesOllama ? await ollamaStatus() : null,
  });
}
