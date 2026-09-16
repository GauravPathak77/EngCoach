/**
 * The COLD LANE — ARCHITECTURE.md §2, ROADMAP.md M5/M8.
 *
 * Runs asynchronously, batched over several turns, on the cheap model tier. Nothing here is on
 * the critical path: the user is already talking to the coach while this catches up.
 *
 * Batching is not only a cost decision (analysing every turn on a strong model would multiply
 * this line by ~20x) — the analysis is genuinely BETTER with several turns of context around
 * each utterance.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { findings, speechSegments, structureObservations, turns } from '@/db/schema';
import { newId } from '@/lib/ids';
import { analyzeErrors, type AnalyzerUtterance } from '@/lib/analysis/errorAnalyzer';
import { analyzeVocabulary } from '@/lib/analysis/vocabAnalyzer';
import { categoryOf } from '@/lib/analysis/taxonomy';
import { scoreFinding } from '@/lib/coaching/policy';
import { lemmas, overusedLemmas } from '@/lib/metrics/lexical';
import type { Word } from '@/lib/types';
import { recordLlmCall } from './telemetry';
import { introduceCandidates } from './vocabService';
import { knownLemmas } from './profileService';

/** Analyse every fourth turn — ARCHITECTURE.md §2 / COSTS.md §1. */
export const COLD_LANE_BATCH_TURNS = 4;

export type ColdLaneResult = {
  analysedTurns: number;
  findingsRecorded: number;
  observationsRecorded: number;
  vocabIntroduced: number;
  isLive: boolean;
  skipped: string | null;
};

/**
 * Analyse the user turns in this session that have not been analysed yet.
 *
 * `force` bypasses the batch threshold — used at session end so the final turns are not lost.
 */
export async function runColdLane(
  userId: string,
  sessionId: string,
  options: { force?: boolean; learnerLevel?: string | null } = {},
  now: Date = new Date(),
): Promise<ColdLaneResult> {
  const db = getDb();

  const pending = await db
    .select({
      turnId: turns.id,
      index: turns.index,
      text: turns.text,
      words: speechSegments.words,
      snr: speechSegments.snrEstimate,
    })
    .from(turns)
    .leftJoin(speechSegments, eq(speechSegments.turnId, turns.id))
    .where(
      and(
        eq(turns.sessionId, sessionId),
        eq(turns.role, 'user'),
        // A turn is "analysed" once any finding or observation references it. Turns with
        // neither are re-examined, which is correct: an empty result is not a record.
        sql`not exists (select 1 from findings f where f.turn_id = ${turns.id})`,
        sql`not exists (select 1 from structure_observations o where o.utterance_id = ${turns.id})`,
      ),
    )
    .orderBy(asc(turns.index));

  const empty: ColdLaneResult = {
    analysedTurns: 0,
    findingsRecorded: 0,
    observationsRecorded: 0,
    vocabIntroduced: 0,
    isLive: false,
    skipped: null,
  };

  if (pending.length === 0) return { ...empty, skipped: 'nothing pending' };
  if (!options.force && pending.length < COLD_LANE_BATCH_TURNS) {
    return { ...empty, skipped: `batching (${pending.length}/${COLD_LANE_BATCH_TURNS})` };
  }

  const utterances: AnalyzerUtterance[] = pending
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ id: p.turnId, text: p.text }));

  if (utterances.length === 0) return { ...empty, skipped: 'no non-empty utterances' };

  const wordsByTurn = new Map<string, Word[]>(pending.map((p) => [p.turnId, p.words ?? []]));
  const snrByTurn = new Map<string, number | null>(pending.map((p) => [p.turnId, p.snr]));

  // --- Errors and structure observations -----------------------------------
  const analysis = await analyzeErrors(utterances, {
    learnerLevel: options.learnerLevel ?? null,
  });

  await recordLlmCall({
    userId,
    sessionId,
    lane: 'cold',
    modelId: analysis.modelId,
    promptVersion: analysis.promptVersion,
    usage: analysis.usage,
    latencyMs: analysis.latencyMs,
    costUsd: analysis.costUsd,
    isLive: analysis.isLive,
  });

  let findingsRecorded = 0;

  for (const candidate of analysis.candidates) {
    const words = wordsByTurn.get(candidate.utteranceId) ?? [];
    const snr = snrByTurn.get(candidate.utteranceId) ?? null;

    // Gate 1 runs HERE, before persistence — a finding we are not confident about must not
    // pollute the learning profile either (AI_BEHAVIOR.md §3.1).
    const scored = scoreFinding(candidate, words, snr);

    await db.insert(findings).values({
      id: newId(),
      userId,
      sessionId,
      turnId: candidate.utteranceId,
      utteranceId: candidate.utteranceId,
      type: categoryOf(candidate.ruleTag) ?? 'grammar',
      ruleTag: candidate.ruleTag,
      wordStart: candidate.span.wordStart,
      wordEnd: candidate.span.wordEnd,
      originalSpanText: candidate.originalSpanText,
      originalUtterance: candidate.originalUtterance,
      suggestedSpanText: candidate.suggestedSpanText,
      suggestedUtterance: candidate.suggestedUtterance,
      explanationShort: candidate.explanationShort,
      severity: candidate.severity,
      llmConfidence: scored.llmConfidence,
      asrConfidence: scored.asrConfidence,
      combinedConfidence: scored.combinedConfidence,
      isAsrSuspect: scored.isAsrSuspect,
      // The policy engine promotes these to shown/spoken on a later turn. Findings that fail
      // Gate 1 are stored as 'suppressed' so the eval harness and the precision metric can see
      // what we chose not to say.
      status: scored.isAsrSuspect || scored.combinedConfidence < 0.7 ? 'suppressed' : 'recorded',
      policyReason: scored.isAsrSuspect ? 'gate1: asr-suspect' : '',
      promptVersion: analysis.promptVersion,
      modelId: analysis.modelId,
      createdAt: now,
    });
    findingsRecorded += 1;
  }

  for (const observation of analysis.observations) {
    await db.insert(structureObservations).values({
      id: newId(),
      userId,
      sessionId,
      utteranceId: observation.utteranceId,
      ruleTag: observation.ruleTag,
      obligatoryContext: observation.obligatoryContext,
      produced: observation.produced,
      correct: observation.correct,
      promptVersion: analysis.promptVersion,
      modelId: analysis.modelId,
      createdAt: now,
    });
  }

  // --- Vocabulary -----------------------------------------------------------
  const allWords = pending.flatMap((p) => p.words ?? []);
  const tokens = lemmas(allWords);
  const known = await knownLemmas(userId);

  const vocab = await analyzeVocabulary(utterances, {
    learnerLevel: options.learnerLevel ?? null,
    overused: overusedLemmas(tokens, { minCount: 2, limit: 8 }),
    knownLemmas: known,
  });

  await recordLlmCall({
    userId,
    sessionId,
    lane: 'cold',
    modelId: vocab.modelId,
    promptVersion: vocab.promptVersion,
    usage: vocab.usage,
    latencyMs: 0,
    costUsd: vocab.costUsd,
    isLive: vocab.isLive,
  });

  const vocabIntroduced = await introduceCandidates(userId, sessionId, vocab.candidates, now);

  return {
    analysedTurns: utterances.length,
    findingsRecorded,
    observationsRecorded: analysis.observations.length,
    vocabIntroduced,
    isLive: analysis.isLive,
    skipped: null,
  };
}

/** Findings for the notes rail: surfaced this session, newest first. */
export async function surfacedFindings(sessionId: string, userId: string) {
  return getDb()
    .select({
      id: findings.id,
      ruleTag: findings.ruleTag,
      originalUtterance: findings.originalUtterance,
      originalSpanText: findings.originalSpanText,
      suggestedUtterance: findings.suggestedUtterance,
      suggestedSpanText: findings.suggestedSpanText,
      explanationShort: findings.explanationShort,
      severity: findings.severity,
      status: findings.status,
      userFeedback: findings.userFeedback,
      surfacedAt: findings.surfacedAt,
    })
    .from(findings)
    .where(
      and(
        eq(findings.sessionId, sessionId),
        eq(findings.userId, userId),
        sql`${findings.surfacedAt} is not null`,
      ),
    )
    .orderBy(asc(findings.surfacedAt));
}

/** Everything recorded this session, for the report. Includes never-surfaced findings. */
export async function recordedFindings(sessionId: string, userId: string) {
  return getDb()
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.sessionId, sessionId),
        eq(findings.userId, userId),
        sql`${findings.status} <> 'suppressed'`,
      ),
    )
    .orderBy(asc(findings.createdAt));
}

export async function unanalysedTurnCount(sessionId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(turns)
    .leftJoin(findings, eq(findings.turnId, turns.id))
    .where(and(eq(turns.sessionId, sessionId), eq(turns.role, 'user'), isNull(findings.id)));
  return Number(rows[0]?.n ?? 0);
}
