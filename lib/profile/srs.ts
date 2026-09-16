/**
 * Spaced repetition for vocabulary — AI_BEHAVIOR.md §5.3.
 *
 * PURE MODULE (CLAUDE.md invariant 1). The clock is injected; nothing here calls Date.now().
 *
 * Note what this is NOT: a flashcard scheduler. Reinforcement happens *inside the conversation* —
 * the coach seeds a due word into its own speech, and the topic strategy steers toward a context
 * where the word is the natural choice. The schedule decides *when*, not *how*.
 */

import type { VocabState, VocabStateRecord } from '@/lib/types';

/** Due intervals in days. Failure steps back one rung rather than resetting to zero. */
export const INTERVAL_LADDER = [1, 3, 7, 16, 35, 90] as const;

export const MAX_NEW_ITEMS_PER_SESSION = 3;
export const MAX_REVIEW_ITEMS_PER_SESSION = 2;

/** Spontaneous uses needed at `used_spontaneous` before an item counts as retained. */
export const RETENTION_USES = 3;
/** ...and this much time must have passed, so a single enthusiastic session cannot fake it. */
export const RETENTION_MIN_DAYS = 14;

const STATE_ORDER: readonly VocabState[] = [
  'candidate',
  'introduced',
  'recognised',
  'used_prompted',
  'used_spontaneous',
  'retained',
];

export function stateRank(state: VocabState): number {
  const index = STATE_ORDER.indexOf(state);
  return index === -1 ? 0 : index;
}

export function nextInterval(currentDays: number): number {
  const index = INTERVAL_LADDER.indexOf(currentDays as (typeof INTERVAL_LADDER)[number]);
  if (index === -1) {
    const next = INTERVAL_LADDER.find((d) => d > currentDays);
    return next ?? INTERVAL_LADDER[INTERVAL_LADDER.length - 1] ?? 90;
  }
  return INTERVAL_LADDER[Math.min(index + 1, INTERVAL_LADDER.length - 1)] ?? 90;
}

export function previousInterval(currentDays: number): number {
  const index = INTERVAL_LADDER.indexOf(currentDays as (typeof INTERVAL_LADDER)[number]);
  if (index <= 0) return INTERVAL_LADDER[0] ?? 1;
  return INTERVAL_LADDER[index - 1] ?? 1;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000);
}

export type ReviewOutcome =
  /** The coach used it and the user showed comprehension. */
  | 'recognised'
  /** The user produced it after a nudge. */
  | 'used_prompted'
  /** The user produced it unprompted — the goal state. */
  | 'used_spontaneous'
  /** The item came up and the user did not engage with it. */
  | 'missed';

/**
 * Advance (or demote) an item after a review opportunity.
 *
 * Demotion matters: an item at `used_spontaneous` that goes missing across reviews drops back
 * to `recognised`, because "I used it once three weeks ago" is not knowing a word.
 */
export function applyReview(
  record: VocabStateRecord,
  outcome: ReviewOutcome,
  now: Date,
): VocabStateRecord {
  const exposures = record.exposures + 1;

  if (outcome === 'missed') {
    const interval = previousInterval(record.srsIntervalDays);
    // One rung back in state, never below `introduced` — the user has still met the word.
    const demotedRank = Math.max(stateRank('introduced'), stateRank(record.state) - 1);
    const state = STATE_ORDER[demotedRank] ?? 'introduced';
    return {
      ...record,
      state,
      exposures,
      srsIntervalDays: interval,
      srsDueAt: addDays(now, interval),
      lastSeenAt: now,
    };
  }

  const spontaneousUses =
    outcome === 'used_spontaneous' ? record.spontaneousUses + 1 : record.spontaneousUses;

  const candidateState: VocabState = outcome;
  // Never move backwards on a success.
  let state: VocabState =
    stateRank(candidateState) > stateRank(record.state) ? candidateState : record.state;

  const interval = nextInterval(record.srsIntervalDays);

  // Retention needs both repetition and elapsed time.
  const firstSeen = record.lastProducedAt ?? record.lastSeenAt;
  const longEnough = firstSeen !== null && daysBetween(firstSeen, now) >= RETENTION_MIN_DAYS;
  if (state === 'used_spontaneous' && spontaneousUses >= RETENTION_USES && longEnough) {
    state = 'retained';
  }

  return {
    ...record,
    state,
    exposures,
    spontaneousUses,
    srsIntervalDays: interval,
    srsDueAt: addDays(now, interval),
    lastSeenAt: now,
    lastProducedAt:
      outcome === 'used_spontaneous' || outcome === 'used_prompted' ? now : record.lastProducedAt,
  };
}

/** A newly introduced item starts at the bottom of the ladder. */
export function introduce(itemId: string, lemma: string, now: Date): VocabStateRecord {
  const interval = INTERVAL_LADDER[0] ?? 1;
  return {
    itemId,
    lemma,
    state: 'introduced',
    srsIntervalDays: interval,
    srsDueAt: addDays(now, interval),
    exposures: 1,
    spontaneousUses: 0,
    lastSeenAt: now,
    lastProducedAt: null,
  };
}

/**
 * Items due for reinforcement, most overdue first, capped.
 * `retained` items drop out of the rotation entirely.
 */
export function selectDue(
  records: readonly VocabStateRecord[],
  now: Date,
  limit = MAX_REVIEW_ITEMS_PER_SESSION,
): VocabStateRecord[] {
  return records
    .filter((r) => r.state !== 'retained' && r.srsDueAt.getTime() <= now.getTime())
    .sort((a, b) => a.srsDueAt.getTime() - b.srsDueAt.getTime() || a.lemma.localeCompare(b.lemma))
    .slice(0, limit);
}
