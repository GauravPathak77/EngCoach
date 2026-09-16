/**
 * Session-level aggregation of the per-utterance metrics — AI_BEHAVIOR.md §6.1.
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 */

import type { SessionMetrics, UtteranceMetrics, Word } from '@/lib/types';
import { contentWords, countHedges } from './fluency';
import { advancedWordRatio, lemmas, mtld } from './lexical';

export type SessionAggregateInput = {
  /** Per-utterance metrics for every user turn, in order. */
  utterances: UtteranceMetrics[];
  /** All user words across the session, in order. Needed for MTLD, which is not additive. */
  allUserWords: Word[];
  /** Total milliseconds the coach spent speaking. Drives the talk-time ratio. */
  coachSpeechMs: number;
};

export function computeSessionMetrics(input: SessionAggregateInput): SessionMetrics {
  const { utterances, allUserWords, coachSpeechMs } = input;

  const turnCount = utterances.length;
  const userSpeechMs = utterances.reduce((a, u) => a + u.durationMs, 0);
  const wordCount = utterances.reduce((a, u) => a + u.wordCount, 0);
  const fillerCount = utterances.reduce((a, u) => a + u.fillerCount, 0);
  const repairCount = utterances.reduce((a, u) => a + u.repairCount, 0);
  const pauseMsTotal = utterances.reduce((a, u) => a + u.pauseMsTotal, 0);

  const totalMs = userSpeechMs + coachSpeechMs;
  const talkTimeRatio = totalMs > 0 ? userSpeechMs / totalMs : 0;

  const userSpeechS = userSpeechMs / 1000;
  const speechRate = userSpeechS > 0 ? (wordCount / userSpeechS) * 60 : 0;

  const articulationS = Math.max(0, (userSpeechMs - pauseMsTotal) / 1000);
  const articulationRate = articulationS > 0 ? (wordCount / articulationS) * 60 : 0;

  const mlrValues = utterances.filter((u) => u.mlr > 0).map((u) => u.mlr);
  const meanMlr = mlrValues.length > 0 ? mean(mlrValues) : 0;

  const latencies = utterances
    .map((u) => u.responseLatencyMs)
    .filter((v): v is number => v !== null);
  const meanResponseLatencyMs = latencies.length > 0 ? Math.round(mean(latencies)) : null;

  const tokens = lemmas(allUserWords);
  const contentCount = contentWords(allUserWords).length;
  const hedges = countHedges(allUserWords);

  return {
    // One unreliable turn taints the session aggregate: a mean articulation rate computed over
    // a mix of real and absent timings is not a measurement of anything.
    timingsReliable: utterances.length > 0 && utterances.every((u) => u.timingsReliable),
    turnCount,
    userSpeechMs,
    coachSpeechMs,
    talkTimeRatio: round2(talkTimeRatio),
    wordCount,
    speechRate: round2(speechRate),
    articulationRate: round2(articulationRate),
    fillersPer100Words: contentCount > 0 ? round2((fillerCount / contentCount) * 100) : 0,
    repairsPer100Words: contentCount > 0 ? round2((repairCount / contentCount) * 100) : 0,
    meanMlr: round2(meanMlr),
    mtld: mtld(tokens),
    advancedWordRatio: advancedWordRatio(tokens),
    meanResponseLatencyMs,
    hedgeDensityPer100Words: contentCount > 0 ? round2((hedges / contentCount) * 100) : 0,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
