/**
 * Learning profile persistence and aggregation — ROADMAP.md M9, M10.
 *
 * All the *maths* lives in lib/profile and lib/coaching (pure, tested). This module only reads
 * rows, calls those functions, and writes results back. Keeping the split sharp is what makes
 * the pedagogy testable without a database.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  findings,
  learningProfiles,
  sessions,
  sessionMetrics,
  skillEstimates,
  structureObservations,
  suppressedRules,
  userVocabStates,
} from '@/db/schema';
import {
  accuracyEstimate,
  confidenceFor,
  foldAccuracy,
  foldContinuous,
  normaliseInverted,
  normaliseToBand,
  wilsonLowerBound,
} from '@/lib/profile/estimate';
import { selectFocus, type WeaknessEvidence } from '@/lib/coaching/focus';
import { getRule } from '@/lib/analysis/taxonomy';
import type { AccuracyObservation, ContinuousObservation, SkillEstimate } from '@/lib/types';

/** Rule-level accuracy with its denominator. The core of the whole evidence model. */
export type RuleAccuracy = {
  ruleTag: string;
  label: string;
  errors: number;
  obligatoryContexts: number;
  correctProductions: number;
  avoidanceCount: number;
  /** Wilson lower bound of correct/obligatory. */
  mastery: number;
  confidence: string;
  lastErrorAt: Date | null;
  sessionsContributing: number;
};

export async function ruleAccuracies(userId: string): Promise<RuleAccuracy[]> {
  const db = getDb();

  const obsRows = await db
    .select({
      ruleTag: structureObservations.ruleTag,
      contexts: sql<number>`count(*) filter (where ${structureObservations.obligatoryContext})`,
      correct: sql<number>`count(*) filter (where ${structureObservations.correct})`,
      avoided: sql<number>`count(*) filter (where ${structureObservations.obligatoryContext} and not ${structureObservations.produced})`,
      sessionsCount: sql<number>`count(distinct ${structureObservations.sessionId})`,
    })
    .from(structureObservations)
    .where(eq(structureObservations.userId, userId))
    .groupBy(structureObservations.ruleTag);

  const errorRows = await db
    .select({
      ruleTag: findings.ruleTag,
      errors: sql<number>`count(*)`,
      lastAt: sql<Date>`max(${findings.createdAt})`,
    })
    .from(findings)
    // Suppressed findings never entered the profile in the first place; disputed ones are
    // removed here too, because the user is allowed to be right (AI_BEHAVIOR.md §3.3).
    .where(
      and(
        eq(findings.userId, userId),
        sql`${findings.status} <> 'suppressed'`,
        sql`(${findings.userFeedback} is null or ${findings.userFeedback} <> 'disagreed')`,
      ),
    )
    .groupBy(findings.ruleTag);

  const errorsByRule = new Map(errorRows.map((r) => [r.ruleTag, r]));
  const out: RuleAccuracy[] = [];

  const allTags = new Set([...obsRows.map((o) => o.ruleTag), ...errorRows.map((e) => e.ruleTag)]);

  for (const ruleTag of allTags) {
    const rule = getRule(ruleTag);
    if (!rule) continue;

    const obs = obsRows.find((o) => o.ruleTag === ruleTag);
    const err = errorsByRule.get(ruleTag);

    const contexts = Number(obs?.contexts ?? 0);
    const correct = Number(obs?.correct ?? 0);
    const errors = Number(err?.errors ?? 0);
    const avoided = Number(obs?.avoided ?? 0);
    const sessionsContributing = Number(obs?.sessionsCount ?? 0);

    out.push({
      ruleTag,
      label: rule.label,
      errors,
      obligatoryContexts: contexts,
      correctProductions: correct,
      avoidanceCount: avoided,
      mastery: wilsonLowerBound(correct, contexts),
      confidence: confidenceFor(contexts, sessionsContributing),
      lastErrorAt: err?.lastAt ? new Date(err.lastAt) : null,
      sessionsContributing,
    });
  }

  return out.sort((a, b) => b.errors - a.errors || a.ruleTag.localeCompare(b.ruleTag));
}

/**
 * Recompute every skill estimate from scratch.
 *
 * Recomputing rather than incrementally updating is deliberate at this scale: it means the
 * estimates can never drift from the evidence, and changing a formula re-scores history for
 * free. Cheap for a single user; revisit if it ever stops being.
 */
export async function recomputeSkills(userId: string): Promise<SkillEstimate[]> {
  const db = getDb();
  const accuracies = await ruleAccuracies(userId);

  const accuracyObs: AccuracyObservation[] = accuracies
    .filter((a) => a.obligatoryContexts > 0)
    .map((a) => ({
      skill: a.ruleTag,
      successes: a.correctProductions,
      attempts: a.obligatoryContexts,
      sessionId: 'aggregate',
    }));

  const estimates: SkillEstimate[] = [];

  for (const accuracy of accuracies) {
    if (accuracy.obligatoryContexts === 0) continue;
    const state = foldAccuracy(accuracyObs, accuracy.ruleTag);
    // foldAccuracy collapses sessions because we aggregated in SQL; restore the real count so
    // the evidence gate (>= 2 sessions) is applied against the truth.
    state.sessions = new Set(
      Array.from({ length: accuracy.sessionsContributing }, (_, i) => `s${i}`),
    );
    estimates.push(accuracyEstimate(state));
  }

  // Continuous skills from session metrics. Bands are plausible operating ranges for a
  // B1-C1 speaker; values outside clamp rather than extrapolate.
  const metricRows = await db
    .select({
      sessionId: sessionMetrics.sessionId,
      articulationRate: sessionMetrics.articulationRate,
      fillers: sessionMetrics.fillersPer100Words,
      meanMlr: sessionMetrics.meanMlr,
      mtld: sessionMetrics.mtld,
      advanced: sessionMetrics.advancedWordRatio,
      timings: sql<boolean>`true`,
    })
    .from(sessionMetrics)
    .innerJoin(sessions, eq(sessions.id, sessionMetrics.sessionId))
    .where(eq(sessionMetrics.userId, userId))
    .orderBy(sessions.startedAt);

  const fluencyObs: ContinuousObservation[] = [];
  const vocabObs: ContinuousObservation[] = [];

  for (const row of metricRows) {
    // Composite fluency: articulation rate, run length, and filler rate, each normalised
    // against the user's own plausible band rather than against native speakers.
    const parts = [
      normaliseToBand(row.articulationRate, 60, 200),
      normaliseToBand(row.meanMlr, 2, 14),
      normaliseInverted(row.fillers, 0, 20),
    ];
    const fluency = parts.reduce((a, b) => a + b, 0) / parts.length;
    fluencyObs.push({ skill: 'fluency', value: fluency, sessionId: row.sessionId });

    const vocab =
      (normaliseToBand(row.mtld, 20, 90) + normaliseToBand(row.advanced, 0.1, 0.5)) / 2;
    vocabObs.push({ skill: 'vocabulary', value: vocab, sessionId: row.sessionId });
  }

  estimates.push(foldContinuous(fluencyObs, 'fluency'));
  estimates.push(foldContinuous(vocabObs, 'vocabulary'));

  // Persist.
  for (const estimate of estimates) {
    await db
      .insert(skillEstimates)
      .values({
        userId,
        skill: estimate.skill,
        value: estimate.value,
        evidenceCount: estimate.evidenceCount,
        sessionsContributing: estimate.sessionsContributing,
        variance: estimate.variance,
        confidence: estimate.confidence,
        trend28d: estimate.trend28d,
        lastUpdated: new Date(),
      })
      .onConflictDoUpdate({
        target: [skillEstimates.userId, skillEstimates.skill],
        set: {
          value: estimate.value,
          evidenceCount: estimate.evidenceCount,
          sessionsContributing: estimate.sessionsContributing,
          variance: estimate.variance,
          confidence: estimate.confidence,
          trend28d: estimate.trend28d,
          lastUpdated: new Date(),
        },
      });
  }

  return estimates;
}

export async function getSkillEstimates(userId: string): Promise<SkillEstimate[]> {
  const rows = await getDb()
    .select()
    .from(skillEstimates)
    .where(eq(skillEstimates.userId, userId));

  return rows.map((r) => ({
    skill: r.skill,
    value: r.value,
    evidenceCount: r.evidenceCount,
    sessionsContributing: r.sessionsContributing,
    variance: r.variance,
    confidence: r.confidence as SkillEstimate['confidence'],
    trend28d: r.trend28d,
  }));
}

export async function getSuppressedRuleTags(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ ruleTag: suppressedRules.ruleTag })
    .from(suppressedRules)
    .where(eq(suppressedRules.userId, userId));
  return rows.map((r) => r.ruleTag);
}

/**
 * Choose this session's focus skills. Pure selection in lib/coaching/focus; this only gathers
 * the evidence rows it needs.
 */
export async function chooseFocus(
  userId: string,
  now: Date,
): Promise<{ primary: string | null; secondary: string | null }> {
  const accuracies = await ruleAccuracies(userId);
  const recentFocus = await recentFocusTags(userId);

  const evidence: WeaknessEvidence[] = accuracies.map((a) => ({
    ruleTag: a.ruleTag,
    mastery: a.mastery,
    evidenceCount: a.obligatoryContexts,
    sessionsContributing: a.sessionsContributing,
    lastErrorAt: a.lastErrorAt,
    avoidanceCount: a.avoidanceCount,
    reviewDue: false,
    recentlyFocused: recentFocus.includes(a.ruleTag),
  }));

  const selection = selectFocus(evidence, now);
  return { primary: selection.primary, secondary: selection.secondary };
}

async function recentFocusTags(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ primary: sessions.primaryFocusRuleTag })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.startedAt))
    .limit(2);
  return rows.map((r) => r.primary).filter((t): t is string => t !== null);
}

export async function getOrCreateProfile(userId: string): Promise<{
  levelCefr: string | null;
  difficultyLevel: number;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(learningProfiles)
    .where(eq(learningProfiles.userId, userId))
    .limit(1);

  const existing = rows[0];
  if (existing) {
    return { levelCefr: existing.levelCefr, difficultyLevel: existing.difficultyLevel };
  }

  await db.insert(learningProfiles).values({ userId }).onConflictDoNothing();
  return { levelCefr: null, difficultyLevel: 5 };
}

export async function updateDifficulty(userId: string, difficulty: number): Promise<void> {
  await getDb()
    .update(learningProfiles)
    .set({ difficultyLevel: difficulty, updatedAt: new Date() })
    .where(eq(learningProfiles.userId, userId));
}

export async function sessionCountFor(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.status, 'ended')));
  return Number(rows[0]?.n ?? 0);
}

export async function knownLemmas(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ lemma: sql<string>`vi.lemma` })
    .from(userVocabStates)
    .innerJoin(sql`vocabulary_items vi`, sql`vi.id = ${userVocabStates.itemId}`)
    .where(eq(userVocabStates.userId, userId));
  return rows.map((r) => r.lemma);
}

/** Sessions in the trailing window, for the progress trend lines. */
export async function recentSessionMetrics(userId: string, days = 28) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return getDb()
    .select({
      sessionId: sessionMetrics.sessionId,
      startedAt: sessions.startedAt,
      talkTimeRatio: sessionMetrics.talkTimeRatio,
      speechRate: sessionMetrics.speechRate,
      fillersPer100Words: sessionMetrics.fillersPer100Words,
      meanMlr: sessionMetrics.meanMlr,
      mtld: sessionMetrics.mtld,
      wordCount: sessionMetrics.wordCount,
      hedgeDensity: sessionMetrics.hedgeDensityPer100Words,
      repairs: sessionMetrics.repairsPer100Words,
      meanResponseLatencyMs: sessionMetrics.meanResponseLatencyMs,
    })
    .from(sessionMetrics)
    .innerJoin(sessions, eq(sessions.id, sessionMetrics.sessionId))
    .where(and(eq(sessionMetrics.userId, userId), gte(sessions.startedAt, since)))
    .orderBy(sessions.startedAt);
}
