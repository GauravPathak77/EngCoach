/**
 * Retention policy — ADR-015, ARCHITECTURE.md §6, ROADMAP.md M12.
 *
 * PURE MODULE by intent: constants and pure predicates only. Retention rules scattered across
 * a codebase is how retention promises get quietly broken, so they live here, in one place,
 * unit-tested, with the clock injected.
 */

/** Audio is transcribed, analysed, then deleted. Not kept "just in case" (ADR-015). */
export const AUDIO_RETENTION_HOURS = 24;

/** Telemetry rows roll off after this. */
export const LLM_CALL_RETENTION_DAYS = 90;

export function audioPurgeDeadline(transcribedAt: Date): Date {
  return new Date(transcribedAt.getTime() + AUDIO_RETENTION_HOURS * 60 * 60 * 1000);
}

/**
 * Whether a segment's audio should be purged now.
 * Pinned clips survive — the user explicitly asked to keep them for review.
 */
export function shouldPurgeAudio(
  segment: { audioKey: string | null; pinned: boolean; audioPurgeAfter: Date | null },
  now: Date,
): boolean {
  if (segment.audioKey === null) return false;
  if (segment.pinned) return false;
  if (segment.audioPurgeAfter === null) return true;
  return segment.audioPurgeAfter.getTime() <= now.getTime();
}

export function llmCallCutoff(now: Date): Date {
  return new Date(now.getTime() - LLM_CALL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The tables a full user deletion must clear. Enumerated rather than relying purely on cascade
 * so the deletion test can assert against a list, and so adding a table without adding it here
 * is a visible omission rather than a silent leak.
 */
export const USER_SCOPED_TABLES = [
  'findings',
  'structure_observations',
  'utterance_metrics',
  'session_metrics',
  'skill_estimates',
  'learning_profiles',
  'user_vocab_states',
  'suppressed_rules',
  'frustration_events',
  'session_reports',
  'progress_snapshots',
  'llm_calls',
  'tts_calls',
  'speech_segments',
  'turns',
  'sessions',
  'auth_sessions',
  'users',
] as const;
