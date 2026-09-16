/**
 * Adaptive focus selection — AI_BEHAVIOR.md §6.2, M10.
 *
 * PURE MODULE (CLAUDE.md invariant 1). The clock is injected.
 *
 * The key move is elicitation, not instruction. A focus skill does not become "tell the user
 * about the past perfect"; it becomes topic and question selection, so the user meets a context
 * where the structure is *obligatory* and has to produce it. Avoidance — dodging the structure
 * by restructuring the sentence — raises priority rather than lowering it, because avoidance is
 * a stronger signal of weakness than error.
 */


import { elicitableRules, getRule } from '@/lib/analysis/taxonomy';

export type WeaknessEvidence = {
  ruleTag: string;
  /** Wilson lower bound of correct/obligatory. Low means weak. */
  mastery: number;
  /** How many obligatory contexts we have seen. Gate: too few and we do not act. */
  evidenceCount: number;
  sessionsContributing: number;
  /** Most recent error, for the recency decay. Null when there has never been one. */
  lastErrorAt: Date | null;
  /** Obligatory contexts where the user restructured to dodge the form. */
  avoidanceCount: number;
  /** True when a spaced-repetition review of this structure is due. */
  reviewDue: boolean;
  /** This rule was the primary focus in one of the last two sessions. */
  recentlyFocused: boolean;
};

export type FocusSelection = {
  primary: string | null;
  secondary: string | null;
  /** Ranked candidates with their scores, for the dev panel and for tests. */
  ranked: Array<{ ruleTag: string; priority: number; reason: string }>;
};

/** Weight by how badly the rule breaks comprehension. */
const SEVERITY_WEIGHT = { blocking: 1.0, notable: 0.75, polish: 0.45 } as const;

/** Errors stop counting for much after roughly three weeks. */
export const RECENCY_HALFLIFE_DAYS = 21;

/** Below this many obligatory contexts we have no business calling something a weakness. */
export const MIN_EVIDENCE_FOR_FOCUS = 5;
export const MIN_SESSIONS_FOR_FOCUS = 2;

export function recencyWeight(lastErrorAt: Date | null, now: Date): number {
  if (lastErrorAt === null) return 0.2;
  const days = Math.max(0, (now.getTime() - lastErrorAt.getTime()) / (24 * 60 * 60 * 1000));
  return round4(Math.pow(0.5, days / RECENCY_HALFLIFE_DAYS));
}

/**
 * Priority score — AI_BEHAVIOR.md §6.2.
 *
 *   severity × recency × (1 - mastery) × srsDue × goalAlignment × noveltyPenalty × avoidanceBoost
 */
export function priorityOf(
  evidence: WeaknessEvidence,
  now: Date,
  goalAlignedRules: readonly string[] = [],
): { priority: number; reason: string } {
  const rule = getRule(evidence.ruleTag);
  if (!rule) return { priority: 0, reason: 'unknown rule_tag' };
  if (rule.elicitation === null) {
    // A focus we cannot engineer a conversational context for is useless as a focus.
    return { priority: 0, reason: 'rule has no elicitation strategy' };
  }
  if (
    evidence.evidenceCount < MIN_EVIDENCE_FOR_FOCUS ||
    evidence.sessionsContributing < MIN_SESSIONS_FOR_FOCUS
  ) {
    return { priority: 0, reason: 'insufficient evidence to call this a weakness' };
  }

  const severity = SEVERITY_WEIGHT[rule.defaultSeverity];
  const recency = recencyWeight(evidence.lastErrorAt, now);
  const room = 1 - clamp01(evidence.mastery);
  const srs = evidence.reviewDue ? 2.0 : 1.0;
  const goal = goalAlignedRules.includes(evidence.ruleTag) ? 1.4 : 1.0;
  const novelty = evidence.recentlyFocused ? 0.4 : 1.0;

  // Avoidance is a stronger signal than error: the user is not getting it wrong, they are
  // refusing to attempt it, which is exactly the fossilised pattern we exist to break.
  const avoidanceRate =
    evidence.evidenceCount > 0 ? evidence.avoidanceCount / evidence.evidenceCount : 0;
  const avoidanceBoost = 1 + avoidanceRate;

  const priority = round4(severity * recency * room * srs * goal * novelty * avoidanceBoost);

  const notes = [
    `severity ${severity}`,
    `recency ${recency}`,
    `room ${round4(room)}`,
    srs > 1 ? 'review due' : null,
    goal > 1 ? 'goal-aligned' : null,
    novelty < 1 ? 'recently focused (penalised)' : null,
    avoidanceBoost > 1 ? `avoidance ${round4(avoidanceRate)}` : null,
  ].filter(Boolean);

  return { priority, reason: notes.join(', ') };
}

/**
 * Choose exactly one primary and one secondary focus.
 *
 * Not five. A session that tries to fix five things fixes none, and the voice budget only
 * permits a handful of interventions anyway (AI_BEHAVIOR.md §6.2).
 */
export function selectFocus(
  evidence: readonly WeaknessEvidence[],
  now: Date,
  goalAlignedRules: readonly string[] = [],
): FocusSelection {
  const ranked = evidence
    .map((e) => {
      const { priority, reason } = priorityOf(e, now, goalAlignedRules);
      return { ruleTag: e.ruleTag, priority, reason };
    })
    .filter((r) => r.priority > 0)
    .sort((a, b) => b.priority - a.priority || a.ruleTag.localeCompare(b.ruleTag));

  return {
    primary: ranked[0]?.ruleTag ?? null,
    secondary: ranked[1]?.ruleTag ?? null,
    ranked,
  };
}

/**
 * The elicitation instruction for the current focus, for prompt layer L2.
 * Returns null when there is no focus yet — a new user gets an ordinary conversation, which is
 * correct: we have no evidence, so we have nothing to target.
 */
export function elicitationFor(ruleTag: string | null): string | null {
  if (ruleTag === null) return null;
  return getRule(ruleTag)?.elicitation ?? null;
}

/**
 * Fallback topic steering when there is no evidence-backed focus yet. Rotates deterministically
 * over the elicitable rules by session count, so a new user still meets a variety of structures
 * instead of the same one every time.
 */
export function warmUpElicitation(sessionCount: number): string | null {
  const rules = elicitableRules();
  if (rules.length === 0) return null;
  const rule = rules[sessionCount % rules.length];
  return rule?.elicitation ?? null;
}

/**
 * Difficulty dial, 1..10 — one dial, not four. Four independent dials produce incoherent
 * combinations and are untunable (AI_BEHAVIOR.md §6.2).
 */
export function nextDifficulty(
  current: number,
  recentAccuracy: number,
  evidenceCount: number,
): number {
  if (evidenceCount < MIN_EVIDENCE_FOR_FOCUS) return current;
  if (recentAccuracy > 0.85) return clampDifficulty(current + 1);
  if (recentAccuracy < 0.55) return clampDifficulty(current - 1);
  return current;
}

export function clampDifficulty(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/** Human-readable guidance for the difficulty dial, injected into prompt layer L2. */
export function difficultyGuidance(difficulty: number): string {
  if (difficulty <= 3) {
    return 'Speak simply and slowly. Short sentences, very common words, concrete topics.';
  }
  if (difficulty <= 6) {
    return 'Speak at a natural but unhurried pace. Everyday vocabulary, some idioms, concrete topics with light abstraction.';
  }
  if (difficulty <= 8) {
    return 'Speak at a natural pace. Richer vocabulary, idiomatic phrasing, and more abstract questions.';
  }
  return 'Speak as you would to a fluent colleague. Full idiomatic range, abstract and hypothetical questions.';
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
