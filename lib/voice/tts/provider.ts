/**
 * TtsProvider — ADR-004. Interface from day one, which is a deliberate exception to the
 * "no abstraction before the second implementation" rule.
 *
 * Reason: TTS is the largest and most variable cost in the system (roughly a 10-20x spread
 * across providers, COSTS.md §5) and voice identity is a late-stage polish decision. Marrying
 * a voice before the loop works is expensive to undo.
 */

export type TtsAudio = {
  audio: Buffer;
  mimeType: string;
  characters: number;
  provider: string;
  voice: string;
  cached: boolean;
};

export interface TtsProvider {
  readonly name: string;
  /** True when this synthesises server-side audio. False for the browser fallback. */
  readonly isServerSide: boolean;
  synthesize(text: string, voice: string): Promise<TtsAudio>;
}

export class TtsError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'TtsError';
    this.retryable = retryable;
  }
}
