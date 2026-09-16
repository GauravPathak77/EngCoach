/**
 * TTS provider selection — ADR-004, ADR-020.
 *
 * OpenAI when credentials exist; otherwise the browser's own speech synthesis, which the client
 * handles. The browser path is free and always available, which makes the voice loop testable
 * without a paid key, but it is a fallback and the UI says so.
 *
 * Callers pass a provider-agnostic presentation key ('female' | 'male'). The translation to a
 * provider voice id happens here, inside the voice layer — the conversation engine and the
 * session UI never see `'sage'`.
 */

import { OpenAiTts } from './openai';
import type { TtsProvider } from './provider';
import {
  DEFAULT_VOICE_PRESENTATION,
  getCoachVoice,
  providerVoiceId,
  type CoachVoice,
  type VoicePresentation,
} from './voices';

export type TtsMode = 'server' | 'browser';

export function hasTtsCredentials(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

export function ttsMode(): TtsMode {
  return hasTtsCredentials() ? 'server' : 'browser';
}

/**
 * Deployment-level override of the default coach voice. Accepts a presentation key; a legacy
 * raw provider id is normalised rather than passed through (see `normalisePresentation`).
 */
export const DEFAULT_COACH_VOICE: CoachVoice = getCoachVoice(
  process.env.ENGCOACH_TTS_VOICE ?? DEFAULT_VOICE_PRESENTATION,
);

let cached: TtsProvider | null = null;

/** Null in browser mode: there is no server-side provider to return. */
export function getTtsProvider(): TtsProvider | null {
  if (!hasTtsCredentials()) return null;
  if (!cached) cached = new OpenAiTts(process.env.OPENAI_API_KEY!.trim());
  return cached;
}

export function resetTtsProviderForTests(): void {
  cached = null;
}

/**
 * Resolve the voice a request should use: the caller's choice, else the user's stored
 * preference, else the deployment default — always landing on a real registry entry.
 */
export function resolveCoachVoice(...candidates: Array<unknown>): CoachVoice {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      return getCoachVoice(candidate);
    }
  }
  return DEFAULT_COACH_VOICE;
}

/** The id to hand a specific provider for this coach voice. */
export function voiceIdFor(voice: CoachVoice, provider: TtsProvider): string {
  return providerVoiceId(voice, provider.name);
}

export { OpenAiTts };
export * from './provider';
export * from './voices';
export type { VoicePresentation };
