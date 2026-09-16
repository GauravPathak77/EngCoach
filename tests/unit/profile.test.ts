/**
 * lib/profile — AI_BEHAVIOR.md §6.1, ADR-010.
 *
 * The point of these tests: uncertainty must fall out of the MATHS, not out of special-case
 * code. If the Wilson bound stops being pessimistic at low n, the product starts telling users
 * confident things about themselves from one conversation.
 */

import { describe, expect, it } from 'vitest';
import {
  accuracyEstimate,
  confidenceFor,
  ewma,
  ewmaAlpha,
  foldAccuracy,
  foldContinuous,
  isDisplayable,
  normaliseInverted,
  normaliseToBand,
  trendOf,
  wilsonLowerBound,
  MIN_EVIDENCE_COUNT,
} from '@/lib/profile/estimate';
import {
  addDays,
  applyReview,
  INTERVAL_LADDER,
  introduce,
  nextInterval,
  previousInterval,
  selectDue,
  stateRank,
  RETENTION_USES,
} from '@/lib/profile/srs';
import { buildSnapshot, estimateTokens } from '@/lib/profile/snapshot';
import type { AccuracyObservation, ContinuousObservation, VocabStateRecord } from '@/lib/types';

describe('Wilson lower bound', () => {
  it('refuses to read a perfect score at low n as mastery', () => {
    // 2 successes out of 2 is a raw proportion of 1.0 — a confident claim of mastery from
    // nothing. The bound discounts it hard (~0.55 at 90% one-sided).
    const bound = wilsonLowerBound(2, 2);
    expect(bound).toBeLessThan(0.6);
    expect(bound).toBeGreaterThan(0);

    // And it stays well below the same proportion measured properly.
    expect(bound).toBeLessThan(wilsonLowerBound(100, 100));
  });

  it('leaves the very-low-n guard to the evidence gate, which blocks display entirely', () => {
    // The bound keeps the number honest; the gate stops us showing a number at all until it
    // means something. Both are needed — see the note on wilsonLowerBound.
    expect(confidenceFor(2, 1)).toBe('insufficient');
  });

  it('converges toward the raw proportion as evidence accumulates', () => {
    const small = wilsonLowerBound(8, 10); // ~0.61
    const large = wilsonLowerBound(80, 100); // ~0.74
    const huge = wilsonLowerBound(800, 1000); // ~0.78

    // Still below the raw 0.8 even at n=1000 — the bound is a floor, not an estimate — but
    // the gap closes monotonically as evidence accumulates.
    expect(small).toBeLessThan(large);
    expect(large).toBeLessThan(huge);
    expect(huge).toBeLessThan(0.8);
    expect(huge).toBeGreaterThan(0.75);
  });

  it('is monotonic in successes', () => {
    expect(wilsonLowerBound(5, 10)).toBeGreaterThan(wilsonLowerBound(3, 10));
  });

  it('returns 0 with no attempts rather than dividing by zero', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('never returns above 1 or below 0', () => {
    expect(wilsonLowerBound(100, 100)).toBeLessThanOrEqual(1);
    expect(wilsonLowerBound(0, 100)).toBeGreaterThanOrEqual(0);
  });
});

describe('EWMA', () => {
  it('holds at the 0.30 cap early, then decays as evidence accumulates', () => {
    // alpha = min(0.30, 1/(n+1)). The cap binds until n = 3, after which the rate falls, so
    // early sessions move the estimate at a fixed modest pace and later ones move it less.
    expect(ewmaAlpha(0)).toBe(0.3);
    expect(ewmaAlpha(2)).toBe(0.3);
    expect(ewmaAlpha(3)).toBe(0.25);
    expect(ewmaAlpha(10)).toBeCloseTo(0.0909, 3);
    // Monotonically non-increasing — a later session can never swing the estimate harder
    // than an earlier one.
    expect(ewmaAlpha(20)).toBeLessThan(ewmaAlpha(10));
  });

  it('moves the estimate toward the observation', () => {
    expect(ewma(0.5, 1.0, 4)).toBeGreaterThan(0.5);
    expect(ewma(0.5, 0.0, 4)).toBeLessThan(0.5);
  });
});

describe('evidence gating — the "one bad conversation" guard', () => {
  it('refuses to grade below the evidence floor', () => {
    expect(confidenceFor(MIN_EVIDENCE_COUNT - 1, 5)).toBe('insufficient');
  });

  it('refuses to grade from a single session no matter how much evidence', () => {
    // 50 observations from one conversation is still one conversation.
    expect(confidenceFor(50, 1)).toBe('insufficient');
  });

  it('grades once both thresholds are met', () => {
    expect(confidenceFor(5, 2)).toBe('low');
    expect(confidenceFor(20, 3)).toBe('medium');
    expect(confidenceFor(40, 5)).toBe('high');
  });

  it('marks insufficient estimates as not displayable', () => {
    const estimate = accuracyEstimate({
      skill: 'grammar.article.definite',
      successes: 2,
      attempts: 3,
      sessions: new Set(['s1']),
    });
    expect(estimate.confidence).toBe('insufficient');
    expect(isDisplayable(estimate)).toBe(false);
  });
});

describe('accuracy folding', () => {
  it('sums successes and attempts across sessions and counts distinct sessions', () => {
    const observations: AccuracyObservation[] = [
      { skill: 'g', successes: 2, attempts: 4, sessionId: 's1' },
      { skill: 'g', successes: 3, attempts: 5, sessionId: 's2' },
      { skill: 'other', successes: 9, attempts: 9, sessionId: 's3' },
    ];
    const folded = foldAccuracy(observations, 'g');
    expect(folded.successes).toBe(5);
    expect(folded.attempts).toBe(9);
    expect(folded.sessions.size).toBe(2);
  });
});

describe('continuous folding and outlier damping', () => {
  it('damps a wild session so one bad day cannot move the profile far', () => {
    const steady: ContinuousObservation[] = Array.from({ length: 6 }, (_, i) => ({
      skill: 'fluency',
      value: 0.6,
      sessionId: `s${i}`,
    }));

    const withOutlier: ContinuousObservation[] = [
      ...steady,
      { skill: 'fluency', value: 0.05, sessionId: 's-bad' },
    ];

    const base = foldContinuous(steady, 'fluency');
    const shocked = foldContinuous(withOutlier, 'fluency');

    // It moves, but not far — a cold, a bad microphone, or a hard topic is not a skill change.
    expect(shocked.value).toBeLessThan(base.value);
    expect(base.value - shocked.value).toBeLessThan(0.1);
  });

  it('returns an insufficient placeholder when there are no observations', () => {
    const estimate = foldContinuous([], 'fluency');
    expect(estimate.confidence).toBe('insufficient');
    expect(estimate.evidenceCount).toBe(0);
  });
});

describe('normalisation', () => {
  it('clamps rather than extrapolating', () => {
    // A 400 wpm reading is a measurement error, not superhuman fluency.
    expect(normaliseToBand(400, 60, 200)).toBe(1);
    expect(normaliseToBand(10, 60, 200)).toBe(0);
  });

  it('inverts for metrics where lower is better', () => {
    expect(normaliseInverted(0, 0, 20)).toBe(1);
    expect(normaliseInverted(20, 0, 20)).toBe(0);
  });

  it('handles a degenerate band without dividing by zero', () => {
    expect(normaliseToBand(5, 10, 10)).toBe(0);
  });
});

describe('trend', () => {
  it('is zero without enough points to compare', () => {
    expect(trendOf([0.5, 0.6])).toBe(0);
  });

  it('is positive when later values exceed earlier ones', () => {
    expect(trendOf([0.2, 0.3, 0.4, 0.6, 0.7, 0.8])).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Spaced repetition
// ---------------------------------------------------------------------------

describe('SRS interval ladder', () => {
  it('advances one rung at a time and stops at the top', () => {
    expect(nextInterval(1)).toBe(3);
    expect(nextInterval(35)).toBe(90);
    expect(nextInterval(90)).toBe(90);
  });

  it('steps BACK one rung on failure rather than resetting to zero', () => {
    // Resetting to day one punishes a single lapse far too hard.
    expect(previousInterval(16)).toBe(7);
    expect(previousInterval(1)).toBe(1);
  });

  it('handles an interval that is not on the ladder', () => {
    expect(nextInterval(5)).toBe(7);
  });
});

describe('SRS state machine', () => {
  const now = new Date('2026-08-22T10:00:00Z');

  it('introduces at the bottom of the ladder', () => {
    const record = introduce('i1', 'haggle', now);
    expect(record.state).toBe('introduced');
    expect(record.srsIntervalDays).toBe(INTERVAL_LADDER[0]);
    expect(record.srsDueAt).toEqual(addDays(now, 1));
  });

  it('advances through recognition to spontaneous use', () => {
    let record = introduce('i1', 'haggle', now);
    record = applyReview(record, 'recognised', now);
    expect(record.state).toBe('recognised');

    record = applyReview(record, 'used_spontaneous', now);
    expect(record.state).toBe('used_spontaneous');
    expect(record.spontaneousUses).toBe(1);
  });

  it('never moves backwards on a success', () => {
    let record = introduce('i1', 'haggle', now);
    record = applyReview(record, 'used_spontaneous', now);
    record = applyReview(record, 'recognised', now);
    expect(record.state).toBe('used_spontaneous');
  });

  it('demotes on a miss, but never below "introduced"', () => {
    let record = introduce('i1', 'haggle', now);
    record = applyReview(record, 'used_spontaneous', now);
    record = applyReview(record, 'missed', now);
    // "I used it once three weeks ago" is not knowing a word.
    expect(stateRank(record.state)).toBeLessThan(stateRank('used_spontaneous'));

    record = applyReview(record, 'missed', now);
    record = applyReview(record, 'missed', now);
    expect(record.state).toBe('introduced');
  });

  it('requires BOTH repetition and elapsed time before calling an item retained', () => {
    let record = introduce('i1', 'haggle', now);

    // Three spontaneous uses in one sitting is enthusiasm, not retention.
    for (let i = 0; i < RETENTION_USES; i++) {
      record = applyReview(record, 'used_spontaneous', now);
    }
    expect(record.state).not.toBe('retained');

    // The same uses spread past the minimum window do count.
    const later = addDays(now, 20);
    record = applyReview(record, 'used_spontaneous', later);
    expect(record.state).toBe('retained');
  });
});

describe('due selection', () => {
  const now = new Date('2026-08-22T10:00:00Z');

  const record = (over: Partial<VocabStateRecord>): VocabStateRecord => ({
    itemId: 'x',
    lemma: 'x',
    state: 'introduced',
    srsIntervalDays: 1,
    srsDueAt: now,
    exposures: 1,
    spontaneousUses: 0,
    lastSeenAt: null,
    lastProducedAt: null,
    ...over,
  });

  it('returns overdue items first and respects the cap', () => {
    const items = [
      record({ itemId: 'a', lemma: 'a', srsDueAt: addDays(now, -5) }),
      record({ itemId: 'b', lemma: 'b', srsDueAt: addDays(now, -1) }),
      record({ itemId: 'c', lemma: 'c', srsDueAt: addDays(now, -10) }),
    ];
    const due = selectDue(items, now, 2);
    expect(due.map((d) => d.lemma)).toEqual(['c', 'a']);
  });

  it('excludes items not yet due', () => {
    expect(selectDue([record({ srsDueAt: addDays(now, 3) })], now)).toHaveLength(0);
  });

  it('drops retained items out of the rotation entirely', () => {
    expect(selectDue([record({ state: 'retained' })], now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The learner snapshot (prompt layer L2)
// ---------------------------------------------------------------------------

describe('learner snapshot', () => {
  const base = {
    levelCefr: 'B2',
    nativeLanguage: 'Hindi',
    interests: ['cricket', 'product design'],
    goals: ['work meetings'],
    difficulty: 6,
    focus: { primary: null, secondary: null },
    focusLabels: {},
    warmUpElicitation: null,
    vocabToSeed: [],
    vocabToElicit: [],
    suppressedRuleTags: [],
    skills: [],
    sessionCount: 3,
  };

  it('is deterministic — the same input yields byte-identical output', () => {
    // ARCHITECTURE.md §5.2: a snapshot that varies silently destroys the cache prefix and
    // roughly triples the hot-lane cost.
    expect(buildSnapshot(base)).toBe(buildSnapshot(base));
  });

  it('stays within the ~300 token budget', () => {
    const snapshot = buildSnapshot({
      ...base,
      interests: Array.from({ length: 20 }, (_, i) => `interest-${i}`),
      goals: Array.from({ length: 10 }, (_, i) => `goal-${i}`),
      suppressedRuleTags: Array.from({ length: 20 }, (_, i) => `rule-${i}`),
    });
    expect(estimateTokens(snapshot)).toBeLessThan(300);
  });

  it('expresses focus as topic steering, never as a grammar target to announce', () => {
    // AI_BEHAVIOR.md §6.2: elicitation, not instruction.
    const snapshot = buildSnapshot({
      ...base,
      focus: { primary: 'grammar.tense.past_simple.irregular', secondary: null },
      focusLabels: { 'grammar.tense.past_simple.irregular': 'Past simple' },
    });
    expect(snapshot).toContain('Steer the conversation');
    expect(snapshot).toContain('do NOT name any grammar point');
    expect(snapshot).not.toContain('past_simple');
  });

  it('tells the coach what it must never comment on', () => {
    const snapshot = buildSnapshot({
      ...base,
      suppressedRuleTags: ['grammar.countability'],
      focusLabels: { 'grammar.countability': 'Countable / uncountable' },
    });
    expect(snapshot).toContain('Never comment on: Countable / uncountable');
  });

  it('says so plainly on a first session rather than inventing history', () => {
    expect(buildSnapshot({ ...base, sessionCount: 0 })).toContain('first session');
  });
});
