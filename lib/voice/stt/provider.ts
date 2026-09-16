/**
 * SttProvider — ADR-005. Interface from day one.
 *
 * The requirements, not the brand, decided this: we need word-level timings, per-word
 * confidence, and filler detection in one API, from the same vendor for batch and streaming so
 * the V2 streaming upgrade is a swap and not a rewrite. Everything in lib/metrics and the
 * ASR-suspect safety gate depends on that metadata.
 */

import type { Transcript } from '@/lib/types';

export type SttResult = Transcript & {
  provider: string;
  model: string;
  /** Rough signal-to-noise estimate, 0..1. Feeds the Gate 1 low-SNR check. */
  snrEstimate: number | null;
  isLive: boolean;
};

export interface SttProvider {
  readonly name: string;
  readonly isLive: boolean;
  transcribe(audio: Buffer, mimeType: string): Promise<SttResult>;
}

export class SttError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'SttError';
    this.retryable = retryable;
  }
}

/** Mean of per-word confidences, used for the segment-level record. */
export function meanConfidence(words: Transcript['words']): number {
  if (words.length === 0) return 0;
  return words.reduce((a, w) => a + w.c, 0) / words.length;
}
