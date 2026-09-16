/**
 * Channel budgets — AI_BEHAVIOR.md §3.2.
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 *
 * The voice channel interrupts the flow of the conversation, so it is rationed hard. The visual
 * channel is silent and non-interrupting, so it is generous. This separation is what produces
 * "real coach" rather than "classroom" (PRODUCT.md §4).
 */

import type { ModeConfig, SessionState, UserSettings } from '@/lib/types';

/** No correction at all during the opening turns. AI_BEHAVIOR.md §3.2 "Never". */
export const WARMUP_TURNS = 3;

/** Visual cards are budgeted per segment of this many turns. */
export const SEGMENT_TURNS = 8;

/** Maximum visual cards per segment. */
export const MAX_VISUAL_CARDS_PER_SEGMENT = 3;

/** Micro-teach requires the rule to have already occurred this many times this session. */
export const MICRO_TEACH_MIN_OCCURRENCES = 2;

export const MAX_MICRO_TEACH_PER_SESSION = 1;
export const MAX_DRILLS_PER_SESSION = 2;

/** Disputes in one session that trigger the frustration brake. AI_BEHAVIOR.md §3.3. */
export const DISPUTES_TO_BRAKE = 2;

/** Consecutive very short turns after a correction that read as disengagement. */
export const SHORT_TURNS_TO_BRAKE = 3;

/** A user turn shorter than this is "very short" for the disengagement proxy. */
export const SHORT_TURN_WORDS = 5;

/**
 * Maximum voice corrections permitted across a whole session:
 * `ceil(turns / recastInterval)`. An infinite interval means the user turned the voice
 * channel off, which yields zero.
 */
export function maxRecastsForSession(turnCount: number, mode: ModeConfig): number {
  if (!Number.isFinite(mode.recastInterval) || mode.recastInterval <= 0) return 0;
  return Math.ceil(turnCount / mode.recastInterval);
}

/**
 * Whether a voice correction may be spoken on this turn.
 *
 * Deliberately conservative: every condition must hold. The design bias is that a missed
 * correction costs far less than one correction too many (RISKS.md R3).
 */
export function voiceChannelOpen(
  state: SessionState,
  mode: ModeConfig,
  settings: UserSettings,
): { open: boolean; reason: string } {
  if (!settings.voiceCorrectionsEnabled) {
    return { open: false, reason: 'user disabled voice corrections' };
  }
  if (!Number.isFinite(mode.recastInterval)) {
    return { open: false, reason: 'mode has no voice channel' };
  }
  if (state.turnIndex < WARMUP_TURNS) {
    return { open: false, reason: `warm-up: first ${WARMUP_TURNS} turns are never corrected` };
  }
  if (brakeEngaged(state).engaged) {
    return { open: false, reason: 'frustration brake engaged' };
  }
  const allowed = maxRecastsForSession(state.userTurnCount, mode);
  if (state.spokenCount >= allowed) {
    return { open: false, reason: `voice budget spent (${state.spokenCount}/${allowed})` };
  }
  // Space corrections out: at least `recastInterval` turns since the last one.
  const turnsSinceLast = state.turnIndex - lastRecastTurn(state);
  if (turnsSinceLast < mode.recastInterval) {
    return { open: false, reason: 'too soon since the last voice correction' };
  }
  return { open: true, reason: 'voice channel open' };
}

/**
 * Turn index of the most recent voice correction, derived from the spoken count and interval.
 * The session state carries counts rather than a history, so this is an approximation that
 * errs towards *not* speaking — which is the correct direction to err in.
 */
function lastRecastTurn(state: SessionState): number {
  return state.lastSpokenTurnIndex ?? -Infinity;
}

/** The frustration brake — AI_BEHAVIOR.md §3.3. Any one condition zeroes the voice channel. */
export function brakeEngaged(state: SessionState): { engaged: boolean; reason: string | null } {
  if (state.disputesThisSession >= DISPUTES_TO_BRAKE) {
    return { engaged: true, reason: `${state.disputesThisSession} corrections disputed` };
  }
  if (state.stopIntentRaised) {
    return { engaged: true, reason: 'user asked to stop being corrected' };
  }
  if (state.consecutiveShortTurns >= SHORT_TURNS_TO_BRAKE) {
    return { engaged: true, reason: 'user disengaging (consecutive very short turns)' };
  }
  return { engaged: false, reason: null };
}

/** Remaining visual card budget for the current segment. */
export function visualCardsRemaining(state: SessionState): number {
  return Math.max(0, MAX_VISUAL_CARDS_PER_SEGMENT - state.visualCardsThisSegment);
}

/** Which 8-turn segment a turn index falls in. Card budgets and dedup reset per segment. */
export function segmentIndex(turnIndex: number): number {
  return Math.floor(turnIndex / SEGMENT_TURNS);
}

export function microTeachAllowed(
  state: SessionState,
  mode: ModeConfig,
  ruleTag: string,
): { allowed: boolean; reason: string } {
  if (!mode.allowMicroTeach) return { allowed: false, reason: 'mode does not allow micro-teach' };
  if (state.microTeachCount >= MAX_MICRO_TEACH_PER_SESSION) {
    return { allowed: false, reason: 'micro-teach already used this session' };
  }
  if (state.focusSkills.primary !== ruleTag) {
    return { allowed: false, reason: 'micro-teach is reserved for the primary focus skill' };
  }
  const occurrences = state.ruleTagCountsThisSession[ruleTag] ?? 0;
  if (occurrences < MICRO_TEACH_MIN_OCCURRENCES) {
    return { allowed: false, reason: `only ${occurrences} occurrence(s) so far` };
  }
  if (!state.atTopicBoundary) {
    return { allowed: false, reason: 'not at a topic boundary' };
  }
  return { allowed: true, reason: 'micro-teach permitted' };
}

export function drillAllowed(
  state: SessionState,
  mode: ModeConfig,
  settings: UserSettings,
  ruleTag: string,
): { allowed: boolean; reason: string } {
  if (!mode.allowDrill) return { allowed: false, reason: 'mode does not allow drills' };
  if (!settings.drillsOptIn) return { allowed: false, reason: 'user has not opted into drills' };
  if (state.drillCount >= MAX_DRILLS_PER_SESSION) {
    return { allowed: false, reason: 'drill budget spent' };
  }
  const isFocus =
    state.focusSkills.primary === ruleTag || state.focusSkills.secondary === ruleTag;
  if (!isFocus) return { allowed: false, reason: 'drills are reserved for focus skills' };
  return { allowed: true, reason: 'drill permitted' };
}
