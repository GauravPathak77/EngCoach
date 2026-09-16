/**
 * Browser Web Speech API fallback — ADR-018.
 *
 * Used when DEEPGRAM_API_KEY is absent. Recognition happens in the browser; the client posts the
 * resulting text plus the wall-clock recording duration, and this adapter packages it.
 *
 * WHAT IT HONESTLY PROVIDES: the words, the word count, the real recording duration, and
 * therefore a real speech rate. Filler words are detected from the text.
 *
 * WHAT IT CANNOT PROVIDE, and does not pretend to:
 *   - per-word timings  → pause profile, articulation rate and MLR are unavailable, and
 *                         `timingsReliable: false` makes every consumer skip them rather than
 *                         display a fabricated zero.
 *   - per-word confidence → set to 0.5, deliberately BELOW the ASR-suspect threshold, so the
 *                         policy engine suppresses every asr-prone finding. That is the correct
 *                         behaviour: we genuinely do not know whether the recogniser heard the
 *                         articles and verb endings, so we must not correct them.
 *
 * This is a degraded path, labelled as such in the UI. Deepgram is the supported configuration.
 */

import type { Word } from '@/lib/types';
import type { SttProvider, SttResult } from './provider';

/** Below ASR_SUSPECT_THRESHOLD (0.8) on purpose — see the note above. */
export const BROWSER_SPEECH_CONFIDENCE = 0.5;

const FILLER_SET = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'hmm', 'mm']);

export type BrowserSpeechPayload = {
  transcript: string;
  durationMs: number;
};

export class BrowserSpeechStt implements SttProvider {
  readonly name = 'browser-speech';
  readonly isLive = false;

  /** Not used — the browser path calls `fromTranscript`. Present to satisfy the interface. */
  async transcribe(): Promise<SttResult> {
    throw new Error(
      'BrowserSpeechStt does not transcribe audio server-side. The client posts a transcript.',
    );
  }

  fromTranscript(payload: BrowserSpeechPayload): SttResult {
    const tokens = payload.transcript.trim().split(/\s+/).filter((t) => t.length > 0);

    // Timings are placeholders and are never read: timingsReliable is false, and every consumer
    // branches on it. They exist only so the Word[] shape is uniform across providers.
    const words: Word[] = tokens.map((token, i) => {
      const bare = token.toLowerCase().replace(/[^a-z']/g, '');
      const word: Word = { w: token, s: i, e: i, c: BROWSER_SPEECH_CONFIDENCE };
      if (FILLER_SET.has(bare)) word.filler = true;
      return word;
    });

    return {
      text: payload.transcript.trim(),
      words,
      durationMs: payload.durationMs,
      meanConfidence: BROWSER_SPEECH_CONFIDENCE,
      provider: this.name,
      model: 'web-speech-api',
      snrEstimate: null,
      isLive: false,
      timingsReliable: false,
    };
  }
}
