/**
 * The hot-lane endpoint — ARCHITECTURE.md §1.3.
 *
 * Accepts either audio (Deepgram path) or a client-side transcript (browser-speech path,
 * ADR-018) or typed text, then streams the coach's reply over SSE so the client can start
 * synthesising the first sentence before generation finishes.
 */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import { getSession } from '@/server/services/sessionService';
import { recordUserTurn, streamCoachReply } from '@/server/services/turnService';
import { runColdLane } from '@/server/services/analysisService';
import { getSttProvider } from '@/lib/voice/stt';
import { BrowserSpeechStt } from '@/lib/voice/stt/browserSpeech';
import { putAudio, audioKeyFor } from '@/server/storage';
import { newId } from '@/lib/ids';
import { badRequest, errorResponse, notFound } from '@/lib/api/errors';
import type { SttResult } from '@/lib/voice/stt/provider';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();

    const form = await request.formData();
    const sessionId = String(form.get('sessionId') ?? '');
    if (!sessionId) throw badRequest('sessionId is required');

    const session = await getSession(sessionId, user.id);
    if (!session) throw notFound('Session not found');
    if (session.status === 'ended') throw badRequest('This session has already ended.');

    const responseLatencyMs = numberOrNull(form.get('responseLatencyMs'));
    const durationMs = Number(form.get('durationMs') ?? 0);

    const transcription = await transcribe(form, durationMs);
    if (transcription.text.trim().length === 0) {
      // Empty or very short speech: a normal event, not an error. The UI just re-arms the mic.
      return Response.json({ empty: true, message: "I didn't catch anything — try again." });
    }

    // Store audio only if the user opted in; the default discards it once transcribed.
    let audioKey: string | null = null;
    const audio = form.get('audio');
    if (user.settings.retainAudio && audio instanceof File) {
      const key = audioKeyFor(user.id, sessionId, newId());
      await putAudio(key, Buffer.from(await audio.arrayBuffer()));
      audioKey = key;
    }

    const { directive } = await recordUserTurn(user, session, {
      text: transcription.text,
      words: transcription.words,
      durationMs: transcription.durationMs || durationMs,
      meanConfidence: transcription.meanConfidence,
      snrEstimate: transcription.snrEstimate,
      timingsReliable: transcription.timingsReliable,
      sttProvider: transcription.provider,
      sttModel: transcription.model,
      audioKey,
      responseLatencyMs,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown): void => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        send('transcript', {
          text: transcription.text,
          timingsReliable: transcription.timingsReliable,
          provider: transcription.provider,
        });
        send('directive', { kind: directive.kind, ruleTag: directive.ruleTag });

        try {
          for await (const event of streamCoachReply(user, session, directive)) {
            if (event.type === 'text') send('delta', { text: event.delta });
            else if (event.type === 'error') send('error', { message: event.message });
            else send('done', { isLive: event.result.isLive, costUsd: event.result.costUsd });
          }
        } catch (error) {
          const { toApiError } = await import('@/lib/api/errors');
          const api = toApiError(error);
          send('error', { message: api.message, code: api.code, retryable: api.retryable });
        }

        controller.close();

        // Cold lane, fire and forget: it must never delay the reply the user is waiting for.
        void runColdLane(user.id, sessionId, { learnerLevel: user.selfReportedLevel }).catch(
          (error) => console.error('[engcoach] cold lane failed:', error),
        );
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function transcribe(form: FormData, durationMs: number): Promise<SttResult> {
  const provider = getSttProvider();

  const clientTranscript = form.get('transcript');
  if (typeof clientTranscript === 'string' && clientTranscript.trim().length > 0) {
    // The client must say where the text came from. Conflating the two is a real correctness
    // bug: typed text has no recognition uncertainty, so putting it through the browser-speech
    // path (confidence 0.5) would silently suppress every asr-prone correction.
    const source = String(form.get('source') ?? 'speech');

    if (source === 'speech' && provider instanceof BrowserSpeechStt) {
      // Browser-speech path (ADR-018): the client already did recognition and posts the text.
      return provider.fromTranscript({ transcript: clientTranscript, durationMs });
    }
    return typedTranscript(clientTranscript, durationMs);
  }

  const audio = form.get('audio');
  if (!(audio instanceof File)) {
    throw badRequest('Provide either an audio file or a transcript.');
  }

  const buffer = Buffer.from(await audio.arrayBuffer());
  return provider.transcribe(buffer, audio.type || 'audio/webm');
}

/**
 * Typed text. Confidence is 1.0 because there is no recogniser in the loop — the ASR-suspect
 * gate exists to protect against mishearing, and nothing was heard.
 * `timingsReliable` is false: we know what they wrote, not how they would have said it.
 */
function typedTranscript(text: string, durationMs: number): SttResult {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  return {
    text: text.trim(),
    words: tokens.map((w, i) => ({ w, s: i, e: i, c: 1 })),
    durationMs,
    meanConfidence: 1,
    provider: 'typed',
    model: 'none',
    snrEstimate: null,
    isLive: false,
    timingsReliable: false,
  };
}

function numberOrNull(value: FormDataEntryValue | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
