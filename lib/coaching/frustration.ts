/**
 * Frustration detection — AI_BEHAVIOR.md §3.3.
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 *
 * The user is allowed to be right. Two disputes, an explicit "stop correcting me", or visible
 * disengagement all silence the voice channel for the rest of the session — no negotiation, no
 * "are you sure?". Getting this wrong in the permissive direction is how the product becomes
 * something the user quietly stops opening (RISKS.md R3).
 */

import type { SessionState } from '@/lib/types';
import { SHORT_TURN_WORDS } from './budgets';

export type FrustrationKind =
  | 'disputes'
  | 'stop_intent'
  | 'disengagement';

export type FrustrationEvent = {
  kind: FrustrationKind;
  turnIndex: number;
  detail: string;
};

/**
 * Phrases that read as an explicit request to stop.
 *
 * This is a *backstop*, not the primary detector — AI_BEHAVIOR.md §3.3 specifies that the
 * conversation model reports a `wantsToStopCorrections` flag on its structured side-channel,
 * because a regex cannot catch "could you just let me talk for a bit". Both feed the same brake.
 */
const STOP_INTENT_PATTERNS: readonly RegExp[] = [
  /\bstop correcting\b/i,
  /\bdon'?t correct\b/i,
  /\bno more correction/i,
  /\bstop with the correction/i,
  /\bjust talk normally\b/i,
  /\bjust have a conversation\b/i,
  /\bstop the grammar\b/i,
  /\bquit correcting\b/i,
];

export function matchesStopIntent(text: string): boolean {
  return STOP_INTENT_PATTERNS.some((p) => p.test(text));
}

export function isShortTurn(wordCount: number): boolean {
  return wordCount < SHORT_TURN_WORDS;
}

/**
 * Advance the disengagement counter. It only accumulates *after* a correction has been
 * surfaced — short turns during ordinary chat are not a signal of anything.
 */
export function nextShortTurnCount(
  current: number,
  wordCount: number,
  correctionWasSurfacedRecently: boolean,
): number {
  if (!correctionWasSurfacedRecently) return 0;
  return isShortTurn(wordCount) ? current + 1 : 0;
}

/** Any frustration events newly triggered by this state, for persistence and product health. */
export function detectEvents(state: SessionState): FrustrationEvent[] {
  const events: FrustrationEvent[] = [];
  if (state.disputesThisSession >= 2) {
    events.push({
      kind: 'disputes',
      turnIndex: state.turnIndex,
      detail: `${state.disputesThisSession} corrections disputed this session`,
    });
  }
  if (state.stopIntentRaised) {
    events.push({
      kind: 'stop_intent',
      turnIndex: state.turnIndex,
      detail: 'user asked to stop being corrected',
    });
  }
  if (state.consecutiveShortTurns >= 3) {
    events.push({
      kind: 'disengagement',
      turnIndex: state.turnIndex,
      detail: `${state.consecutiveShortTurns} consecutive very short turns after a correction`,
    });
  }
  return events;
}

/**
 * Two disputes of the SAME rule across sessions puts it on the persistent suppression list
 * (AI_BEHAVIOR.md §3.3). Returns the rule tags that should now be suppressed for this user.
 */
export function rulesToSuppress(
  disputeCountsByRule: Record<string, number>,
  threshold = 2,
): string[] {
  return Object.entries(disputeCountsByRule)
    .filter(([, count]) => count >= threshold)
    .map(([ruleTag]) => ruleTag)
    .sort();
}
