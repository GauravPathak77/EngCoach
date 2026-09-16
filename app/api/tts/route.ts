/**
 * Sentence-level TTS — ROADMAP.md M3, ADR-020.
 *
 * One sentence per request so the client can play chunk N while chunk N+1 synthesises. In
 * browser mode there is no server provider and this returns a directive telling the client to
 * use its own speech synthesis (ADR-004), including which voice to look for.
 *
 * The request carries a presentation key ('female' | 'male'), never a provider voice id.
 */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import { getTtsProvider, resolveCoachVoice, ttsMode, voiceIdFor } from '@/lib/voice/tts';
import { getCached, putCached } from '@/lib/voice/tts/cache';
import { recordTtsCall } from '@/server/services/telemetry';
import { badRequest, errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as { text?: string; sessionId?: string; voice?: string };

    const text = (body.text ?? '').trim();
    if (text.length === 0) throw badRequest('text is required');

    const provider = getTtsProvider();
    const coachVoice = resolveCoachVoice(body.voice, user.settings.coachVoice);

    if (!provider) {
      // Browser mode: the client speaks it. The hints let the client pick a matching voice
      // from `speechSynthesis.getVoices()`, which is the only selection the Web Speech API
      // allows. Still counted, so cost visibility is uniform.
      await recordTtsCall({
        userId: user.id,
        sessionId: body.sessionId ?? null,
        provider: 'browser',
        voice: `browser:${coachVoice.presentation}`,
        characters: text.length,
        latencyMs: 0,
        cached: false,
      });
      return Response.json({
        mode: 'browser',
        text,
        presentation: coachVoice.presentation,
      });
    }

    const providerVoice = voiceIdFor(coachVoice, provider);
    const started = Date.now();
    const cached = getCached(provider.name, providerVoice, text);
    const audio = cached ?? (await provider.synthesize(text, providerVoice));
    if (!cached) putCached(provider.name, providerVoice, text, audio);

    await recordTtsCall({
      userId: user.id,
      sessionId: body.sessionId ?? null,
      provider: provider.name,
      voice: providerVoice,
      characters: audio.characters,
      latencyMs: Date.now() - started,
      cached: cached !== null,
    });

    return new Response(new Uint8Array(audio.audio), {
      headers: {
        'Content-Type': audio.mimeType,
        'Cache-Control': 'no-store',
        'X-Tts-Cached': cached ? '1' : '0',
        'X-Coach-Voice': coachVoice.presentation,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ mode: ttsMode() });
}
