/**
 * Assembling the SessionState the policy engine reads — AI_BEHAVIOR.md §3.
 *
 * The policy engine is pure and takes a plain snapshot of session state. This module builds that
 * snapshot from the database. Keeping the query logic out of lib/coaching is what lets every
 * policy rule be unit-tested with a hand-written state object.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { findings, frustrationEvents, suppressedRules, turns, utteranceMetrics } from '@/db/schema';
import { newId } from '@/lib/ids';
import { segmentIndex, SEGMENT_TURNS, SHORT_TURN_WORDS } from '@/lib/coaching/budgets';
import type { FrustrationEvent } from '@/lib/coaching/frustration';
import type { SessionState } from '@/lib/types';
import type { SessionRecord } from './sessionService';

export async function loadSessionState(
  userId: string,
  session: SessionRecord,
  turnIndex: number,
  extra: { stopIntentRaised: boolean; lastUserWordCount: number },
): Promise<SessionState> {
  const db = getDb();

  const [counts, suppressed, spoken, segmentCards, ruleCounts, shortStreak, boundary] =
    await Promise.all([
      db
        .select({
          userTurns: sql<number>`count(*) filter (where ${turns.role} = 'user')`,
        })
        .from(turns)
        .where(eq(turns.sessionId, session.id)),

      db
        .select({ ruleTag: suppressedRules.ruleTag })
        .from(suppressedRules)
        .where(eq(suppressedRules.userId, userId)),

      db
        .select({
          spokenCount: sql<number>`count(*) filter (where ${findings.status} in ('spoken','drilled'))`,
          microTeach: sql<number>`count(*) filter (where ${findings.policyReason} like '%micro_teach%')`,
          drills: sql<number>`count(*) filter (where ${findings.status} = 'drilled')`,
          disputes: sql<number>`count(*) filter (where ${findings.userFeedback} = 'disagreed')`,
        })
        .from(findings)
        .where(eq(findings.sessionId, session.id)),

      segmentCardsQuery(session.id, turnIndex),

      db
        .select({ ruleTag: findings.ruleTag, n: sql<number>`count(*)` })
        .from(findings)
        .where(and(eq(findings.sessionId, session.id), sql`${findings.status} <> 'suppressed'`))
        .groupBy(findings.ruleTag),

      shortTurnStreak(session.id),

      lastSpokenTurn(session.id),
    ]);

  const ruleTagCountsThisSession: Record<string, number> = {};
  for (const row of ruleCounts) ruleTagCountsThisSession[row.ruleTag] = Number(row.n);

  return {
    turnIndex,
    userTurnCount: Number(counts[0]?.userTurns ?? 0),
    spokenCount: Number(spoken[0]?.spokenCount ?? 0),
    lastSpokenTurnIndex: boundary.lastSpokenTurnIndex,
    microTeachCount: Number(spoken[0]?.microTeach ?? 0),
    drillCount: Number(spoken[0]?.drills ?? 0),
    disputesThisSession: Number(spoken[0]?.disputes ?? 0),
    stopIntentRaised: extra.stopIntentRaised,
    consecutiveShortTurns: shortStreak,
    suppressedRuleTags: suppressed.map((s) => s.ruleTag),
    focusSkills: {
      primary: session.primaryFocusRuleTag,
      secondary: session.secondaryFocusRuleTag,
    },
    ruleTagCountsThisSession,
    shownRuleTagsThisSegment: segmentCards.ruleTags,
    visualCardsThisSegment: segmentCards.count,
    // A topic boundary is reported by the conversation model's side-channel; without a live
    // model we approximate with "the user just gave a long, complete-sounding turn".
    atTopicBoundary: extra.lastUserWordCount > 25,
  };
}

async function segmentCardsQuery(
  sessionId: string,
  turnIndex: number,
): Promise<{ count: number; ruleTags: string[] }> {
  const segment = segmentIndex(turnIndex);
  const lowerBound = segment * SEGMENT_TURNS;

  const rows = await getDb()
    .select({ ruleTag: findings.ruleTag, turnIndex: turns.index })
    .from(findings)
    .innerJoin(turns, eq(turns.id, findings.turnId))
    .where(
      and(
        eq(findings.sessionId, sessionId),
        eq(findings.status, 'shown_visual'),
        sql`${turns.index} >= ${lowerBound}`,
      ),
    );

  return { count: rows.length, ruleTags: [...new Set(rows.map((r) => r.ruleTag))] };
}

/**
 * Consecutive very short user turns. The disengagement proxy only accumulates after a
 * correction has been surfaced — short turns during ordinary chat mean nothing.
 */
async function shortTurnStreak(sessionId: string): Promise<number> {
  const db = getDb();

  const surfaced = await db
    .select({ n: sql<number>`count(*)` })
    .from(findings)
    .where(and(eq(findings.sessionId, sessionId), sql`${findings.surfacedAt} is not null`));

  if (Number(surfaced[0]?.n ?? 0) === 0) return 0;

  const rows = await db
    .select({ wordCount: utteranceMetrics.wordCount, index: turns.index })
    .from(utteranceMetrics)
    .innerJoin(turns, eq(turns.id, utteranceMetrics.turnId))
    .where(eq(turns.sessionId, sessionId))
    .orderBy(desc(turns.index))
    .limit(5);

  let streak = 0;
  for (const row of rows) {
    if (row.wordCount < SHORT_TURN_WORDS) streak += 1;
    else break;
  }
  return streak;
}

async function lastSpokenTurn(sessionId: string): Promise<{ lastSpokenTurnIndex: number | null }> {
  const rows = await getDb()
    .select({ index: turns.index })
    .from(findings)
    .innerJoin(turns, eq(turns.id, findings.turnId))
    .where(
      and(eq(findings.sessionId, sessionId), sql`${findings.status} in ('spoken','drilled')`),
    )
    .orderBy(desc(turns.index))
    .limit(1);

  return { lastSpokenTurnIndex: rows[0]?.index ?? null };
}

export async function persistFrustrationEvents(
  userId: string,
  sessionId: string,
  events: FrustrationEvent[],
): Promise<void> {
  const db = getDb();

  for (const event of events) {
    // One row per kind per session; the brake fires once, not on every subsequent turn.
    const existing = await db
      .select({ id: frustrationEvents.id })
      .from(frustrationEvents)
      .where(and(eq(frustrationEvents.sessionId, sessionId), eq(frustrationEvents.kind, event.kind)))
      .limit(1);
    if (existing[0]) continue;

    await db.insert(frustrationEvents).values({
      id: newId(),
      userId,
      sessionId,
      turnIndex: event.turnIndex,
      kind: event.kind,
      detail: event.detail,
    });
  }
}

/**
 * Record a user dispute. Two disputes of the same rule across sessions puts it on the
 * persistent suppression list — the user is allowed to be right (AI_BEHAVIOR.md §3.3).
 */
export async function disputeFinding(userId: string, findingId: string): Promise<void> {
  const db = getDb();

  await db
    .update(findings)
    .set({ userFeedback: 'disagreed' })
    .where(and(eq(findings.id, findingId), eq(findings.userId, userId)));

  const row = await db
    .select({ ruleTag: findings.ruleTag })
    .from(findings)
    .where(eq(findings.id, findingId))
    .limit(1);

  const ruleTag = row[0]?.ruleTag;
  if (!ruleTag) return;

  const disputes = await db
    .select({ n: sql<number>`count(*)` })
    .from(findings)
    .where(
      and(
        eq(findings.userId, userId),
        eq(findings.ruleTag, ruleTag),
        eq(findings.userFeedback, 'disagreed'),
      ),
    );

  if (Number(disputes[0]?.n ?? 0) >= 2) {
    await db
      .insert(suppressedRules)
      .values({ userId, ruleTag, reason: 'disputed' })
      .onConflictDoNothing();
  }
}

export async function agreeFinding(userId: string, findingId: string): Promise<void> {
  await getDb()
    .update(findings)
    .set({ userFeedback: 'agreed' })
    .where(and(eq(findings.id, findingId), eq(findings.userId, userId)));
}
