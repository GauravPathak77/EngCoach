/**
 * lib/coaching/focus — the adaptive engine. AI_BEHAVIOR.md §6.2, ROADMAP.md M10.
 *
 * The property that matters: avoidance must RAISE priority. A learner who restructures every
 * sentence to dodge the past perfect looks flawless to an error counter and is exactly the
 * fossilised case the product exists to break.
 */

import { describe, expect, it } from 'vitest';
import {
  clampDifficulty,
  difficultyGuidance,
  elicitationFor,
  nextDifficulty,
  priorityOf,
  recencyWeight,
  selectFocus,
  warmUpElicitation,
  MIN_EVIDENCE_FOR_FOCUS,
  type WeaknessEvidence,
} from '@/lib/coaching/focus';

const NOW = new Date('2026-08-22T12:00:00Z');

function evidence(over: Partial<WeaknessEvidence> = {}): WeaknessEvidence {
  return {
    ruleTag: 'grammar.tense.past_simple.irregular',
    mastery: 0.3,
    evidenceCount: 12,
    sessionsContributing: 3,
    lastErrorAt: NOW,
    avoidanceCount: 0,
    reviewDue: false,
    recentlyFocused: false,
    ...over,
  };
}

describe('recency weighting', () => {
  it('is full strength for an error just made', () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
  });

  it('halves over the 21-day half-life', () => {
    const threeWeeksAgo = new Date(NOW.getTime() - 21 * 24 * 60 * 60 * 1000);
    expect(recencyWeight(threeWeeksAgo, NOW)).toBeCloseTo(0.5, 2);
  });

  it('gives a small baseline when there has never been an error', () => {
    expect(recencyWeight(null, NOW)).toBe(0.2);
  });
});

describe('priority scoring', () => {
  it('refuses to call something a weakness below the evidence floor', () => {
    const thin = priorityOf(evidence({ evidenceCount: MIN_EVIDENCE_FOR_FOCUS - 1 }), NOW);
    expect(thin.priority).toBe(0);
    expect(thin.reason).toContain('insufficient evidence');
  });

  it('refuses on a single session no matter how many observations', () => {
    expect(priorityOf(evidence({ sessionsContributing: 1 }), NOW).priority).toBe(0);
  });

  it('scores 0 for a rule with no elicitation strategy', () => {
    // A focus you cannot engineer a conversational context for is useless as a focus.
    const result = priorityOf(evidence({ ruleTag: 'lexical.overuse' }), NOW);
    expect(result.priority).toBe(0);
    expect(result.reason).toContain('elicitation');
  });

  it('gives more room to a weaker skill', () => {
    const weak = priorityOf(evidence({ mastery: 0.1 }), NOW).priority;
    const strong = priorityOf(evidence({ mastery: 0.9 }), NOW).priority;
    expect(weak).toBeGreaterThan(strong);
  });

  it('RAISES priority when the learner is avoiding the structure', () => {
    // Avoidance is a stronger signal of weakness than error — the learner is not getting it
    // wrong, they are refusing to attempt it.
    const plain = priorityOf(evidence(), NOW).priority;
    const avoiding = priorityOf(evidence({ avoidanceCount: 6 }), NOW).priority;
    expect(avoiding).toBeGreaterThan(plain);
  });

  it('penalises a rule that was the focus recently, so sessions vary', () => {
    const fresh = priorityOf(evidence(), NOW).priority;
    const repeat = priorityOf(evidence({ recentlyFocused: true }), NOW).priority;
    expect(repeat).toBeLessThan(fresh);
  });

  it('doubles priority when a scheduled review is due', () => {
    const due = priorityOf(evidence({ reviewDue: true }), NOW).priority;
    const notDue = priorityOf(evidence(), NOW).priority;
    expect(due).toBeCloseTo(notDue * 2, 3);
  });

  it('boosts rules aligned with the learner stated goals', () => {
    const aligned = priorityOf(evidence(), NOW, ['grammar.tense.past_simple.irregular']).priority;
    expect(aligned).toBeGreaterThan(priorityOf(evidence(), NOW).priority);
  });
});

describe('focus selection', () => {
  it('picks exactly one primary and one secondary — never five', () => {
    // A session that tries to fix five things fixes none, and the voice budget only permits a
    // handful of interventions anyway.
    const candidates = [
      evidence({ ruleTag: 'grammar.tense.past_simple.irregular', mastery: 0.1 }),
      evidence({ ruleTag: 'grammar.article.definite', mastery: 0.2 }),
      evidence({ ruleTag: 'grammar.conditional.second', mastery: 0.3 }),
      evidence({ ruleTag: 'grammar.preposition.dependent', mastery: 0.4 }),
    ];
    const selection = selectFocus(candidates, NOW);

    expect(selection.primary).not.toBeNull();
    expect(selection.secondary).not.toBeNull();
    expect(selection.primary).not.toBe(selection.secondary);
    expect(selection.ranked.length).toBeGreaterThan(2);
  });

  it('returns nulls when nothing has enough evidence — a new user just gets a conversation', () => {
    const selection = selectFocus([evidence({ evidenceCount: 1, sessionsContributing: 1 })], NOW);
    expect(selection.primary).toBeNull();
    expect(selection.secondary).toBeNull();
  });

  it('ranks the weakest elicitable rule first', () => {
    const selection = selectFocus(
      [
        evidence({ ruleTag: 'grammar.article.definite', mastery: 0.85 }),
        evidence({ ruleTag: 'grammar.tense.past_simple.irregular', mastery: 0.05 }),
      ],
      NOW,
    );
    expect(selection.primary).toBe('grammar.tense.past_simple.irregular');
  });

  it('is deterministic for the same input', () => {
    const candidates = [
      evidence({ ruleTag: 'grammar.article.definite' }),
      evidence({ ruleTag: 'grammar.conditional.second' }),
    ];
    expect(selectFocus(candidates, NOW)).toEqual(selectFocus(candidates, NOW));
  });
});

describe('elicitation', () => {
  it('turns a focus rule into a conversational context, not a lecture', () => {
    const strategy = elicitationFor('grammar.tense.past_simple.irregular');
    expect(strategy).toBeTruthy();
    expect(strategy?.toLowerCase()).toContain('ask');
  });

  it('returns null for no focus', () => {
    expect(elicitationFor(null)).toBeNull();
  });

  it('rotates warm-up topics deterministically so a new user meets variety', () => {
    const first = warmUpElicitation(0);
    const second = warmUpElicitation(1);
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
    expect(warmUpElicitation(0)).toBe(first);
  });
});

describe('difficulty dial', () => {
  it('holds steady without enough evidence', () => {
    expect(nextDifficulty(5, 0.95, MIN_EVIDENCE_FOR_FOCUS - 1)).toBe(5);
  });

  it('steps up when the learner is coasting and down when they are struggling', () => {
    expect(nextDifficulty(5, 0.9, 20)).toBe(6);
    expect(nextDifficulty(5, 0.4, 20)).toBe(4);
    expect(nextDifficulty(5, 0.7, 20)).toBe(5);
  });

  it('clamps to the 1..10 range', () => {
    expect(clampDifficulty(0)).toBe(1);
    expect(clampDifficulty(99)).toBe(10);
    expect(nextDifficulty(10, 0.99, 30)).toBe(10);
  });

  it('produces one coherent instruction per level, not four independent dials', () => {
    const low = difficultyGuidance(2);
    const high = difficultyGuidance(10);
    expect(low).not.toBe(high);
    expect(low.toLowerCase()).toContain('simply');
    expect(high.toLowerCase()).toContain('fluent');
  });
});
