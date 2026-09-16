/**
 * Objective speech measurement — AI_BEHAVIOR.md §6.1 Layer A.
 *
 * PURE MODULE (CLAUDE.md invariant 1). Everything here is computed from word-level timings
 * produced by the recogniser. No LLM is involved and none may be: these are the *facts* that
 * back every fluency number the product displays, and a model judging them would defeat the
 * purpose (AI_BEHAVIOR.md §7.1 — no score without evidence).
 */

import type { UtteranceMetrics, Word } from '@/lib/types';

/** A pause longer than this breaks a "run" and is excluded from articulation rate. */
export const PAUSE_THRESHOLD_S = 0.25;

/** A pause longer than this counts as a hesitation event worth reporting. */
export const SILENT_PAUSE_THRESHOLD_S = 0.5;

/**
 * Words that typically end a clause. A pause *after* one of these is normal prosody;
 * a pause in the middle of a clause is the real hesitation signal (AI_BEHAVIOR.md §6.1).
 */
const CLAUSE_BOUNDARY_WORDS = new Set([
  'and', 'but', 'so', 'because', 'or', 'then', 'however', 'though', 'although',
  'while', 'when', 'if', 'that', 'which', 'who', 'after', 'before', 'since',
]);

/** Trailing punctuation also marks a clause boundary. */
const BOUNDARY_PUNCT = /[.,;:!?]$/;

/** Hedges — a confidence *proxy*, never aggregated into a confidence score (ADR-008). */
const HEDGE_WORDS = new Set([
  'maybe', 'perhaps', 'possibly', 'probably', 'somewhat', 'kind', 'sort',
  'guess', 'suppose', 'might', 'apparently', 'basically', 'actually',
]);

/** Common verbal fillers, used when the recogniser does not tag them itself. */
const FILLER_WORDS = new Set([
  'um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'eh', 'hmm', 'mmm', 'mm',
]);

export function normalise(word: string): string {
  return word.toLowerCase().replace(/[^a-z'’-]/g, '');
}

export function isFiller(word: Word): boolean {
  if (word.filler === true) return true;
  return FILLER_WORDS.has(normalise(word.w));
}

export function isHedge(word: Word): boolean {
  return HEDGE_WORDS.has(normalise(word.w));
}

/** Words that carry real content, i.e. everything that is not a filler. */
export function contentWords(words: Word[]): Word[] {
  return words.filter((w) => !isFiller(w) && normalise(w.w).length > 0);
}

type Pause = { durationS: number; midClause: boolean; afterIndex: number };

/**
 * Gaps between consecutive words. Classified mid-clause vs boundary, because only the
 * mid-clause ones indicate the speaker was searching for language.
 */
export function findPauses(words: Word[], thresholdS = SILENT_PAUSE_THRESHOLD_S): Pause[] {
  const pauses: Pause[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const current = words[i];
    const next = words[i + 1];
    if (!current || !next) continue;
    const gap = next.s - current.e;
    if (gap < thresholdS) continue;
    const token = normalise(current.w);
    const boundary = CLAUSE_BOUNDARY_WORDS.has(token) || BOUNDARY_PUNCT.test(current.w.trim());
    pauses.push({ durationS: gap, midClause: !boundary, afterIndex: i });
  }
  return pauses;
}

/** Total time spent in gaps above the articulation threshold, in seconds. */
export function totalPauseTime(words: Word[], thresholdS = PAUSE_THRESHOLD_S): number {
  let total = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const current = words[i];
    const next = words[i + 1];
    if (!current || !next) continue;
    const gap = next.s - current.e;
    if (gap >= thresholdS) total += gap;
  }
  return total;
}

/**
 * Mean Length of Run: the average number of words between disruptions, where a disruption is
 * a pause above threshold or a filler. The classic second-language fluency measure — it tracks
 * how much language the speaker can produce in one go.
 */
export function meanLengthOfRun(words: Word[]): number {
  if (words.length === 0) return 0;
  const runs: number[] = [];
  let current = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    if (isFiller(word)) {
      if (current > 0) runs.push(current);
      current = 0;
      continue;
    }
    current += 1;
    const next = words[i + 1];
    if (next && next.s - word.e >= PAUSE_THRESHOLD_S) {
      runs.push(current);
      current = 0;
    }
  }
  if (current > 0) runs.push(current);
  if (runs.length === 0) return 0;
  return runs.reduce((a, b) => a + b, 0) / runs.length;
}

/**
 * Self-repairs: immediate repetitions ("I I went") and false starts where a short word is
 * abandoned and restarted. A rough but honest count — a proxy for uncertainty, not a verdict.
 */
export function countRepairs(words: Word[]): number {
  const tokens = contentWords(words).map((w) => normalise(w.w));
  let repairs = 0;
  for (let i = 1; i < tokens.length; i++) {
    const previous = tokens[i - 1];
    const current = tokens[i];
    if (!previous || !current) continue;
    if (previous.length > 0 && previous === current) {
      repairs += 1;
      continue;
    }
    // Abandoned start: "wen— went", detected as a short prefix of the next word.
    if (previous.length >= 2 && current.length > previous.length && current.startsWith(previous)) {
      repairs += 1;
    }
  }
  return repairs;
}

/**
 * Compute every per-utterance metric.
 *
 * `responseLatencyMs` is the gap between the coach finishing and the user starting; it is
 * measured by the caller (which knows about the previous turn) and passed in.
 */
export function computeUtteranceMetrics(
  words: Word[],
  options: {
    responseLatencyMs?: number | null;
    /**
     * False when the speech source gave us text but no per-word timings (ADR-018). We then
     * compute only what is genuinely derivable — word count, duration, speech rate — and zero
     * the timing-derived fields, which consumers must skip rather than display.
     */
    timingsReliable?: boolean;
    /** Wall-clock recording duration, used when word timings are unavailable. */
    fallbackDurationMs?: number;
  } = {},
): UtteranceMetrics {
  const responseLatencyMs = options.responseLatencyMs ?? null;
  const timingsReliable = options.timingsReliable ?? true;

  if (words.length === 0) {
    return {
      timingsReliable,
      wordCount: 0,
      durationMs: 0,
      speechRate: 0,
      articulationRate: 0,
      pauseCountMidclause: 0,
      pauseCountBoundary: 0,
      pauseMsTotal: 0,
      fillerCount: 0,
      mlr: 0,
      repairCount: 0,
      responseLatencyMs,
    };
  }

  const first = words[0];
  const last = words[words.length - 1];
  // Guarded above by the length check, but the compiler cannot see that.
  if (!first || !last) throw new Error('unreachable: non-empty words with missing endpoints');

  const content = contentWords(words);
  const wordCount = content.length;
  const fillerCount = words.filter(isFiller).length;

  const durationS = timingsReliable
    ? Math.max(0, last.e - first.s)
    : Math.max(0, (options.fallbackDurationMs ?? 0) / 1000);
  const durationMs = Math.round(durationS * 1000);

  // Without real timings there are no gaps to measure. Reporting zero pauses would read as
  // "perfectly fluent", so the flag on the result is what consumers must branch on.
  if (!timingsReliable) {
    return {
      timingsReliable: false,
      wordCount,
      durationMs,
      speechRate: durationS > 0 ? round2((wordCount / durationS) * 60) : 0,
      articulationRate: 0,
      pauseCountMidclause: 0,
      pauseCountBoundary: 0,
      pauseMsTotal: 0,
      fillerCount,
      mlr: 0,
      repairCount: countRepairs(words),
      responseLatencyMs,
    };
  }

  const pauses = findPauses(words);
  const pauseCountMidclause = pauses.filter((p) => p.midClause).length;
  const pauseCountBoundary = pauses.length - pauseCountMidclause;
  const pauseMsTotal = Math.round(pauses.reduce((a, p) => a + p.durationS, 0) * 1000);

  // Speech rate over the whole utterance including hesitation.
  const speechRate = durationS > 0 ? (wordCount / durationS) * 60 : 0;

  // Articulation rate excludes pause time, isolating how fast they speak when they are speaking.
  const articulationTime = Math.max(0, durationS - totalPauseTime(words));
  const articulationRate = articulationTime > 0 ? (wordCount / articulationTime) * 60 : 0;

  return {
    timingsReliable: true,
    wordCount,
    durationMs,
    speechRate: round2(speechRate),
    articulationRate: round2(articulationRate),
    pauseCountMidclause,
    pauseCountBoundary,
    pauseMsTotal,
    fillerCount,
    mlr: round2(meanLengthOfRun(words)),
    repairCount: countRepairs(words),
    responseLatencyMs,
  };
}

export function countHedges(words: Word[]): number {
  return words.filter(isHedge).length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
