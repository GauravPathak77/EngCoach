/**
 * Skill estimation — AI_BEHAVIOR.md §6.1, ADR-010.
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 *
 * The central idea: uncertainty falls out of the maths rather than out of special-case code.
 * The Wilson lower bound is automatically pessimistic at low n, so "don't judge the user from
 * one conversation" is a property of the estimator, not a rule someone has to remember to apply.
 */

import type {
  AccuracyObservation,
  ConfidenceLevel,
  ContinuousObservation,
  SkillEstimate,
} from '@/lib/types';

/** Below this many observations we refuse to show a number at all. */
export const MIN_EVIDENCE_COUNT = 5;
/** ...and it must come from more than one session, so a single good day proves nothing. */
export const MIN_SESSIONS = 2;

export const EVIDENCE_LOW = 12;
export const EVIDENCE_MEDIUM = 30;

/** z for a 90% one-sided interval. */
const Z_90 = 1.2816;

/**
 * Wilson score interval, lower bound.
 *
 * With 2 successes out of 2 the raw proportion is 1.0 — a confident claim of mastery from
 * nothing. At the 90% one-sided bound used here it returns ~0.55 instead, and it keeps rising
 * only as real evidence arrives (80/100 -> ~0.74, 800/1000 -> ~0.78).
 *
 * The bound alone is not the whole low-n guard: `confidenceFor` gates display and focus
 * selection entirely below 5 observations across 2 sessions. The two work together — the bound
 * keeps the NUMBER honest, the gate stops us showing a number at all until it means something.
 */
export function wilsonLowerBound(successes: number, attempts: number, z = Z_90): number {
  if (attempts <= 0) return 0;
  const p = successes / attempts;
  const z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const centre = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  const lower = (centre - margin) / denominator;
  return clamp01(round4(lower));
}

/**
 * Adaptive EWMA rate: fast while there is little history, stable once there is plenty.
 * `alpha = min(0.30, 1/(n+1))` — AI_BEHAVIOR.md §6.1.
 */
export function ewmaAlpha(observationCount: number): number {
  return Math.min(0.3, 1 / (observationCount + 1));
}

export function ewma(previous: number, observation: number, observationCount: number): number {
  const alpha = ewmaAlpha(observationCount);
  return round4(previous + alpha * (observation - previous));
}

export function confidenceFor(evidenceCount: number, sessionsContributing: number): ConfidenceLevel {
  if (evidenceCount < MIN_EVIDENCE_COUNT || sessionsContributing < MIN_SESSIONS) {
    return 'insufficient';
  }
  if (evidenceCount < EVIDENCE_LOW) return 'low';
  if (evidenceCount < EVIDENCE_MEDIUM) return 'medium';
  return 'high';
}

/**
 * A skill at `insufficient` is never displayed as a number, never used to select a focus skill,
 * and never mentioned in a report. The UI renders "gathering evidence".
 */
export function isDisplayable(estimate: SkillEstimate): boolean {
  return estimate.confidence !== 'insufficient';
}

export type AccuracyState = {
  skill: string;
  successes: number;
  attempts: number;
  sessions: Set<string>;
};

/**
 * Fold accuracy observations (successes out of obligatory contexts) into an estimate.
 *
 * The denominator matters: 2 errors out of 3 opportunities and 2 out of 30 are completely
 * different facts, and only the structure observations (AI_BEHAVIOR.md §2.1) let us tell them
 * apart. Counting errors alone would make a talkative user look worse than a quiet one.
 */
export function foldAccuracy(
  observations: readonly AccuracyObservation[],
  skill: string,
): AccuracyState {
  const state: AccuracyState = { skill, successes: 0, attempts: 0, sessions: new Set() };
  for (const observation of observations) {
    if (observation.skill !== skill) continue;
    state.successes += observation.successes;
    state.attempts += observation.attempts;
    state.sessions.add(observation.sessionId);
  }
  return state;
}

export function accuracyEstimate(
  state: AccuracyState,
  options: { previousValue?: number; trend28d?: number } = {},
): SkillEstimate {
  const value = wilsonLowerBound(state.successes, state.attempts);
  const p = state.attempts > 0 ? state.successes / state.attempts : 0;
  return {
    skill: state.skill,
    value,
    evidenceCount: state.attempts,
    sessionsContributing: state.sessions.size,
    // Binomial variance of the underlying proportion.
    variance: state.attempts > 0 ? round4((p * (1 - p)) / state.attempts) : 0,
    confidence: confidenceFor(state.attempts, state.sessions.size),
    trend28d: options.trend28d ?? 0,
  };
}

/**
 * Fold continuous observations (fluency, lexical diversity — already normalised to 0..1)
 * with outlier damping.
 *
 * A session more than two standard deviations from the running estimate is weighted at half.
 * One session with a cold, a bad microphone, or an unusually hard topic should not move the
 * profile far (AI_BEHAVIOR.md §6.1).
 */
export function foldContinuous(
  observations: readonly ContinuousObservation[],
  skill: string,
  options: { seed?: number } = {},
): SkillEstimate {
  const relevant = observations.filter((o) => o.skill === skill);
  if (relevant.length === 0) {
    return {
      skill,
      value: options.seed ?? 0,
      evidenceCount: 0,
      sessionsContributing: 0,
      variance: 0,
      confidence: 'insufficient',
      trend28d: 0,
    };
  }

  const first = relevant[0];
  if (!first) throw new Error('unreachable: non-empty observations with no first element');

  let value = options.seed ?? first.value;
  const seen: number[] = [];
  const sessions = new Set<string>();

  for (let i = 0; i < relevant.length; i++) {
    const observation = relevant[i];
    if (!observation) continue;
    sessions.add(observation.sessionId);

    const sd = standardDeviation(seen);
    const isOutlier = seen.length >= 3 && sd > 0 && Math.abs(observation.value - value) > 2 * sd;

    const alpha = ewmaAlpha(i) * (isOutlier ? 0.5 : 1);
    value = round4(value + alpha * (observation.value - value));
    seen.push(observation.value);
  }

  return {
    skill,
    value: clamp01(value),
    evidenceCount: relevant.length,
    sessionsContributing: sessions.size,
    variance: round4(variance(seen)),
    confidence: confidenceFor(relevant.length, sessions.size),
    trend28d: trendOf(relevant.map((o) => o.value)),
  };
}

/** Signed change between the first and last thirds of the window. */
export function trendOf(values: readonly number[]): number {
  if (values.length < 4) return 0;
  const third = Math.max(1, Math.floor(values.length / 3));
  const early = values.slice(0, third);
  const late = values.slice(-third);
  return round4(mean(late) - mean(early));
}

/**
 * Normalise a raw metric into 0..1 against a plausible operating band.
 * Values outside the band clamp rather than extrapolate — a 400 wpm reading is a measurement
 * error, not superhuman fluency.
 */
export function normaliseToBand(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return clamp01(round4((value - low) / (high - low)));
}

/** Lower raw value is better (fillers, repairs, latency), so the scale inverts. */
export function normaliseInverted(value: number, low: number, high: number): number {
  return round4(1 - normaliseToBand(value, low, high));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
}

function standardDeviation(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
