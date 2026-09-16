/**
 * Session lifecycle — ROADMAP.md M1, M9, M10.
 *
 * The important work here is at session START: choosing focus skills, selecting due vocabulary,
 * and generating the FROZEN L2 snapshot. Freezing it is what keeps the prompt cache prefix
 * byte-stable for the whole session (ADR-007), which is worth roughly 3-4x on the hot lane.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { sessions, turns, sessionMetrics, speechSegments, utteranceMetrics } from '@/db/schema';
import { newId } from '@/lib/ids';
import { getMode } from '@/lib/modes/registry';
import { buildSnapshot } from '@/lib/profile/snapshot';
import { warmUpElicitation } from '@/lib/coaching/focus';
import { getRule } from '@/lib/analysis/taxonomy';
import { loadPrompt } from '@/prompts/index';
import { computeSessionMetrics } from '@/lib/metrics/session';
import type { ModeId, SessionMetrics, UtteranceMetrics, Word } from '@/lib/types';
import type { AuthUser } from '@/server/auth';
import {
  chooseFocus,
  getOrCreateProfile,
  getSkillEstimates,
  getSuppressedRuleTags,
  sessionCountFor,
} from './profileService';
import { markSeeded, selectForSession } from './vocabService';

export type StartedSession = {
  id: string;
  mode: ModeId;
  snapshotText: string;
  focus: { primary: string | null; secondary: string | null };
  difficulty: number;
};

export async function startSession(
  user: AuthUser,
  mode: ModeId,
  now: Date = new Date(),
): Promise<StartedSession> {
  const db = getDb();
  const modeConfig = getMode(mode);

  const [profile, focus, skills, suppressed, sessionCount, vocab] = await Promise.all([
    getOrCreateProfile(user.id),
    chooseFocus(user.id, now),
    getSkillEstimates(user.id),
    getSuppressedRuleTags(user.id),
    sessionCountFor(user.id),
    selectForSession(user.id, now),
  ]);

  const focusLabels: Record<string, string> = {};
  for (const tag of [focus.primary, focus.secondary, ...suppressed]) {
    if (tag) focusLabels[tag] = getRule(tag)?.label ?? tag;
  }

  const snapshotText = buildSnapshot({
    levelCefr: profile.levelCefr ?? user.selfReportedLevel,
    nativeLanguage: user.nativeLanguage,
    interests: user.interests,
    goals: user.goals,
    difficulty: user.settings.difficulty || profile.difficultyLevel,
    focus,
    focusLabels,
    warmUpElicitation: focus.primary === null ? warmUpElicitation(sessionCount) : null,
    vocabToSeed: vocab.toSeed,
    vocabToElicit: vocab.toElicit,
    suppressedRuleTags: suppressed,
    skills,
    sessionCount,
  });

  const id = newId();
  const core = loadPrompt('core/identity.md');
  const modePrompt = loadPrompt(modeConfig.promptFile);

  await db.insert(sessions).values({
    id,
    userId: user.id,
    mode,
    status: 'active',
    startedAt: now,
    difficultyLevel: user.settings.difficulty || profile.difficultyLevel,
    primaryFocusRuleTag: focus.primary,
    secondaryFocusRuleTag: focus.secondary,
    snapshotText,
    corePromptVersion: core.versionKey,
    modePromptVersion: modePrompt.versionKey,
  });

  if (vocab.toSeed.length > 0) {
    await markSeeded(user.id, vocab.toSeed.map((v) => v.itemId), now);
  }

  return {
    id,
    mode,
    snapshotText,
    focus,
    difficulty: user.settings.difficulty || profile.difficultyLevel,
  };
}

export type SessionRecord = {
  id: string;
  userId: string;
  mode: ModeId;
  status: 'active' | 'ended';
  startedAt: Date;
  endedAt: Date | null;
  snapshotText: string;
  primaryFocusRuleTag: string | null;
  secondaryFocusRuleTag: string | null;
  difficultyLevel: number;
};

export async function getSession(sessionId: string, userId: string): Promise<SessionRecord | null> {
  const rows = await getDb()
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    mode: row.mode as ModeId,
    status: row.status,
    startedAt: new Date(row.startedAt),
    endedAt: row.endedAt ? new Date(row.endedAt) : null,
    snapshotText: row.snapshotText,
    primaryFocusRuleTag: row.primaryFocusRuleTag,
    secondaryFocusRuleTag: row.secondaryFocusRuleTag,
    difficultyLevel: row.difficultyLevel,
  };
}

export async function getActiveSession(userId: string): Promise<SessionRecord | null> {
  const rows = await getDb()
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.status, 'active')))
    .orderBy(desc(sessions.startedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return getSession(row.id, userId);
}

export async function listTurns(sessionId: string) {
  return getDb().select().from(turns).where(eq(turns.sessionId, sessionId)).orderBy(asc(turns.index));
}

export async function nextTurnIndex(sessionId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`coalesce(max(${turns.index}), -1)` })
    .from(turns)
    .where(eq(turns.sessionId, sessionId));
  return Number(rows[0]?.n ?? -1) + 1;
}

/**
 * End the session and compute its aggregate metrics.
 * Idempotent — ending an already-ended session recomputes rather than failing, because a user
 * refreshing the report page must not produce an error.
 */
export async function endSession(
  sessionId: string,
  userId: string,
  now: Date = new Date(),
): Promise<SessionMetrics> {
  const db = getDb();

  await db
    .update(sessions)
    .set({ status: 'ended', endedAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));

  const metrics = await computeAndStoreSessionMetrics(sessionId, userId);
  return metrics;
}

export async function computeAndStoreSessionMetrics(
  sessionId: string,
  userId: string,
): Promise<SessionMetrics> {
  const db = getDb();

  const utteranceRows = await db
    .select()
    .from(utteranceMetrics)
    .where(eq(utteranceMetrics.sessionId, sessionId));

  const segmentRows = await db
    .select({ words: speechSegments.words, turnId: speechSegments.turnId })
    .from(speechSegments)
    .innerJoin(turns, eq(turns.id, speechSegments.turnId))
    .where(eq(turns.sessionId, sessionId))
    .orderBy(asc(turns.index));

  const allUserWords: Word[] = segmentRows.flatMap((r) => r.words ?? []);

  const utterances: UtteranceMetrics[] = utteranceRows.map((r) => ({
    // Persisted rows do not carry the flag; a zeroed pause profile with a real speech rate is
    // the signature of the browser-speech path (ADR-018).
    timingsReliable: r.articulationRate > 0,
    wordCount: r.wordCount,
    durationMs: r.durationMs,
    speechRate: r.speechRate,
    articulationRate: r.articulationRate,
    pauseCountMidclause: r.pauseCountMidclause,
    pauseCountBoundary: r.pauseCountBoundary,
    pauseMsTotal: r.pauseMsTotal,
    fillerCount: r.fillerCount,
    mlr: r.mlr,
    repairCount: r.repairCount,
    responseLatencyMs: r.responseLatencyMs,
  }));

  // Coach speech time is estimated from its word count at a typical synthesis rate, because
  // we do not measure playback wall-clock. Good enough for the talk-time ratio, which is a
  // behavioural nudge rather than a precision instrument.
  const coachRows = await db
    .select({ text: turns.text })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.role, 'coach')));
  const coachWords = coachRows.reduce((a, r) => a + r.text.split(/\s+/).length, 0);
  const coachSpeechMs = Math.round((coachWords / 150) * 60 * 1000);

  const metrics = computeSessionMetrics({ utterances, allUserWords, coachSpeechMs });

  await db
    .insert(sessionMetrics)
    .values({ sessionId, userId, ...metrics })
    .onConflictDoUpdate({ target: sessionMetrics.sessionId, set: { ...metrics } });

  return metrics;
}

export async function listSessions(userId: string, limit = 30) {
  return getDb()
    .select({
      id: sessions.id,
      mode: sessions.mode,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      talkTimeRatio: sessionMetrics.talkTimeRatio,
      wordCount: sessionMetrics.wordCount,
      fillersPer100Words: sessionMetrics.fillersPer100Words,
    })
    .from(sessions)
    .leftJoin(sessionMetrics, eq(sessionMetrics.sessionId, sessions.id))
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}
