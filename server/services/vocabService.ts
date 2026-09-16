/**
 * Vocabulary persistence and SRS scheduling — ROADMAP.md M8.
 *
 * The state machine and interval ladder live in lib/profile/srs (pure, tested). This module
 * reads and writes rows.
 */

import { and, eq, lte, sql, inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { userVocabStates, vocabularyItems } from '@/db/schema';
import { newId } from '@/lib/ids';
import {
  applyReview,
  introduce,
  MAX_NEW_ITEMS_PER_SESSION,
  MAX_REVIEW_ITEMS_PER_SESSION,
  selectDue,
  type ReviewOutcome,
} from '@/lib/profile/srs';
import type { VocabCandidate, VocabState, VocabStateRecord } from '@/lib/types';

export type VocabRow = VocabStateRecord & {
  definition: string;
  register: string;
  cefrLevel: string;
  examples: string[];
  anchorUtterance: string;
  replacesText: string | null;
};

async function upsertItem(candidate: VocabCandidate): Promise<string> {
  const db = getDb();
  const existing = await db
    .select({ id: vocabularyItems.id })
    .from(vocabularyItems)
    .where(and(eq(vocabularyItems.lemma, candidate.lemma), eq(vocabularyItems.sense, candidate.sense)))
    .limit(1);

  const found = existing[0];
  if (found) return found.id;

  const id = newId();
  await db.insert(vocabularyItems).values({
    id,
    lemma: candidate.lemma,
    sense: candidate.sense,
    definition: candidate.definition,
    register: candidate.register,
    cefrLevel: candidate.cefrLevel,
    examples: candidate.examples,
  });
  return id;
}

/**
 * Introduce mined candidates for a user, capped at three per session.
 * The cap is a design decision, not a limitation (AI_BEHAVIOR.md §5.1).
 */
export async function introduceCandidates(
  userId: string,
  sessionId: string,
  candidates: VocabCandidate[],
  now: Date,
): Promise<number> {
  const db = getDb();

  const alreadyThisSession = await db
    .select({ n: sql<number>`count(*)` })
    .from(userVocabStates)
    .where(
      and(eq(userVocabStates.userId, userId), eq(userVocabStates.introducedSessionId, sessionId)),
    );

  let budget = MAX_NEW_ITEMS_PER_SESSION - Number(alreadyThisSession[0]?.n ?? 0);
  if (budget <= 0) return 0;

  let introduced = 0;
  for (const candidate of candidates) {
    if (budget <= 0) break;

    const itemId = await upsertItem(candidate);

    const existing = await db
      .select({ itemId: userVocabStates.itemId })
      .from(userVocabStates)
      .where(and(eq(userVocabStates.userId, userId), eq(userVocabStates.itemId, itemId)))
      .limit(1);
    if (existing[0]) continue;

    const record = introduce(itemId, candidate.lemma, now);
    await db.insert(userVocabStates).values({
      userId,
      itemId,
      state: record.state,
      introducedSessionId: sessionId,
      anchorUtterance: candidate.anchorUtterance,
      replacesText: candidate.replacesText,
      srsIntervalDays: record.srsIntervalDays,
      srsDueAt: record.srsDueAt,
      exposures: record.exposures,
      spontaneousUses: record.spontaneousUses,
      lastSeenAt: record.lastSeenAt,
      lastProducedAt: record.lastProducedAt,
    });

    budget -= 1;
    introduced += 1;
  }

  return introduced;
}

export async function getVocabRows(userId: string): Promise<VocabRow[]> {
  const rows = await getDb()
    .select({
      itemId: userVocabStates.itemId,
      state: userVocabStates.state,
      srsIntervalDays: userVocabStates.srsIntervalDays,
      srsDueAt: userVocabStates.srsDueAt,
      exposures: userVocabStates.exposures,
      spontaneousUses: userVocabStates.spontaneousUses,
      lastSeenAt: userVocabStates.lastSeenAt,
      lastProducedAt: userVocabStates.lastProducedAt,
      anchorUtterance: userVocabStates.anchorUtterance,
      replacesText: userVocabStates.replacesText,
      lemma: vocabularyItems.lemma,
      definition: vocabularyItems.definition,
      register: vocabularyItems.register,
      cefrLevel: vocabularyItems.cefrLevel,
      examples: vocabularyItems.examples,
    })
    .from(userVocabStates)
    .innerJoin(vocabularyItems, eq(vocabularyItems.id, userVocabStates.itemId))
    .where(eq(userVocabStates.userId, userId));

  return rows.map((r) => ({
    itemId: r.itemId,
    lemma: r.lemma,
    state: r.state as VocabState,
    srsIntervalDays: r.srsIntervalDays,
    srsDueAt: new Date(r.srsDueAt),
    exposures: r.exposures,
    spontaneousUses: r.spontaneousUses,
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt) : null,
    lastProducedAt: r.lastProducedAt ? new Date(r.lastProducedAt) : null,
    definition: r.definition,
    register: r.register,
    cefrLevel: r.cefrLevel,
    examples: r.examples ?? [],
    anchorUtterance: r.anchorUtterance,
    replacesText: r.replacesText,
  }));
}

/**
 * Items to seed into the coach's own speech, and items to steer toward so the user has a chance
 * to produce them. Reinforcement happens INSIDE the conversation, not on flashcards
 * (AI_BEHAVIOR.md §5.3).
 */
export async function selectForSession(
  userId: string,
  now: Date,
): Promise<{ toSeed: VocabStateRecord[]; toElicit: VocabStateRecord[] }> {
  const rows = await getVocabRows(userId);
  const due = selectDue(rows, now, MAX_REVIEW_ITEMS_PER_SESSION * 2);

  // Newly introduced words get seeded (the coach uses them); words the user has already
  // recognised get elicited (steer to a context where they are the natural choice).
  const toSeed = due.filter((r) => r.state === 'introduced').slice(0, MAX_REVIEW_ITEMS_PER_SESSION);
  const toElicit = due
    .filter((r) => r.state === 'recognised' || r.state === 'used_prompted')
    .slice(0, MAX_REVIEW_ITEMS_PER_SESSION);

  return { toSeed, toElicit };
}

/**
 * Detect production of tracked vocabulary in a user utterance and advance those items.
 *
 * `prompted` means the coach used the word in its immediately preceding turn, so producing it
 * back is echo rather than recall — a weaker signal, and the state machine distinguishes them.
 */
export async function recordProductions(
  userId: string,
  utteranceText: string,
  coachPreviousTurnText: string | null,
  now: Date,
): Promise<string[]> {
  const rows = await getVocabRows(userId);
  if (rows.length === 0) return [];

  const text = utteranceText.toLowerCase();
  const coachText = (coachPreviousTurnText ?? '').toLowerCase();
  const advanced: string[] = [];

  for (const row of rows) {
    if (row.state === 'retained') continue;
    const lemma = row.lemma.toLowerCase();
    if (!new RegExp(`\\b${escapeRegex(lemma)}`, 'i').test(text)) continue;

    const outcome: ReviewOutcome = coachText.includes(lemma) ? 'used_prompted' : 'used_spontaneous';
    const next = applyReview(row, outcome, now);

    await getDb()
      .update(userVocabStates)
      .set({
        state: next.state,
        srsIntervalDays: next.srsIntervalDays,
        srsDueAt: next.srsDueAt,
        exposures: next.exposures,
        spontaneousUses: next.spontaneousUses,
        lastSeenAt: next.lastSeenAt,
        lastProducedAt: next.lastProducedAt,
      })
      .where(and(eq(userVocabStates.userId, userId), eq(userVocabStates.itemId, row.itemId)));

    advanced.push(row.lemma);
  }

  return advanced;
}

/** Mark seeded items as exposed after the coach has used them. */
export async function markSeeded(userId: string, itemIds: string[], now: Date): Promise<void> {
  if (itemIds.length === 0) return;
  await getDb()
    .update(userVocabStates)
    .set({ exposures: sql`${userVocabStates.exposures} + 1`, lastSeenAt: now })
    .where(and(eq(userVocabStates.userId, userId), inArray(userVocabStates.itemId, itemIds)));
}

export async function dueCount(userId: string, now: Date): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(userVocabStates)
    .where(and(eq(userVocabStates.userId, userId), lte(userVocabStates.srsDueAt, now)));
  return Number(rows[0]?.n ?? 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
