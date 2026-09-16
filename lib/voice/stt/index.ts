/**
 * STT provider selection.
 *
 * Deepgram when credentials exist (the supported configuration); the browser-speech fallback
 * otherwise (ADR-018), which is a degraded path and says so.
 */

import { DeepgramStt } from './deepgram';
import { BrowserSpeechStt } from './browserSpeech';
import type { SttProvider } from './provider';

export function hasSttCredentials(): boolean {
  const key = process.env.DEEPGRAM_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

let cached: SttProvider | null = null;

export function getSttProvider(): SttProvider {
  if (cached) return cached;
  const key = process.env.DEEPGRAM_API_KEY;
  cached = key && key.trim().length > 0 ? new DeepgramStt(key.trim()) : new BrowserSpeechStt();
  return cached;
}

export function resetSttProviderForTests(): void {
  cached = null;
}

export { DeepgramStt, BrowserSpeechStt };
export * from './provider';
