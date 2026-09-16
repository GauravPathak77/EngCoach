/**
 * The SESSION LANE — end-of-session report. ROADMAP.md M7, UX.md §2.
 *
 * Built from all RECORDED findings clustered by rule_tag, regardless of what was surfaced live.
 * Exactly three fixes maximum — three is what a person can hold, and a wall of corrections after
 * a conversation they enjoyed is demotivating and will not be read.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { sessionReports, sessionMetrics, turns, utteranceMetrics } from '@/db/schema';
import { assembleAnalyzerPrompt } from '@/lib/llm/assemble';
import { completeStructured } from '@/lib/llm/client';
import { sessionReportOutputSchema, toJsonSchema } from '@/lib/llm/schemas';
import { getRule } from '@/lib/analysis/taxonomy';
import { getMode } from '@/lib/modes/registry';
import { sayItBetter, selectMostInvested } from '@/lib/analysis/sayItBetter';
import type { SessionMetrics } from '@/lib/types';
import { recordedFindings, runColdLane } from './analysisService';
import { computeAndStoreSessionMetrics } from './sessionService';
import { recomputeSkills } from './profileService';
import { getVocabRows } from './vocabService';
import { recordLlmCall } from './telemetry';
import type { SessionRecord } from './sessionService';
import type { AuthUser } from '@/server/auth';

const PROMPT_FILE = 'report/session-report.md';

export type SessionReport = {
  sessionId: string;
  topFixes: Array<{
    ruleTag: string;
    label: string;
    youSaid: string;
    better: string;
    why: string;
    occurrences: number;
    findingId: string | null;
  }>;
  phrasesToSteal: Array<{ phrase: string; insteadOf: string | null; note: string }>;
  vocabItems: Array<{ lemma: string; definition: string; register: string; anchor: string }>;
  sayItBetter: { original: string; variants: Array<{ register: string; text: string; why: string }> } | null;
  oneThingThatWentWell: string;
  focusNext: string;
  metrics: SessionMetrics;
  isLive: boolean;
};

/**
 * Generate (or regenerate) the report for a session.
 *
 * Runs the cold lane with `force` first, so the final turns of the conversation are analysed
 * rather than lost to the batching threshold.
 */
export async function generateReport(
  user: AuthUser,
  session: SessionRecord,
  now: Date = new Date(),
): Promise<SessionReport> {
  const db = getDb();

  await runColdLane(user.id, session.id, { force: true, learnerLevel: user.selfReportedLevel }, now);
  const metrics = await computeAndStoreSessionMetrics(session.id, user.id);
  await recomputeSkills(user.id);

  const recorded = await recordedFindings(session.id, user.id);

  // Cluster by rule so "you did this four times" is one entry, not four.
  const clusters = new Map<
    string,
    { ruleTag: string; count: number; example: (typeof recorded)[number] }
  >();
  for (const finding of recorded) {
    const existing = clusters.get(finding.ruleTag);
    if (existing) {
      existing.count += 1;
      // Prefer the highest-confidence instance as the quoted example.
      if (finding.combinedConfidence > existing.example.combinedConfidence) {
        existing.example = finding;
      }
    } else {
      clusters.set(finding.ruleTag, { ruleTag: finding.ruleTag, count: 1, example: finding });
    }
  }

  const ranked = [...clusters.values()].sort((a, b) => {
    const severityRank = { blocking: 0, notable: 1, polish: 2 } as const;
    const aSeverity = severityRank[a.example.severity as keyof typeof severityRank] ?? 2;
    const bSeverity = severityRank[b.example.severity as keyof typeof severityRank] ?? 2;
    if (aSeverity !== bSeverity) return aSeverity - bSeverity;
    return b.count - a.count;
  });

  const topClusters = ranked.slice(0, 3);

  // The report model gets the clustered findings plus the numbers, not every raw row —
  // sending everything is wasteful and roughly doubles this line (COSTS.md §6 lever 8).
  const findingsBrief = topClusters
    .map(
      (c) =>
        `- rule: ${c.ruleTag} (${getRule(c.ruleTag)?.label ?? c.ruleTag}), ${c.count}x\n` +
        `  they said: "${c.example.originalUtterance}"\n` +
        `  better: "${c.example.suggestedUtterance ?? c.example.suggestedSpanText ?? ''}"`,
    )
    .join('\n');

  const transcript = await db
    .select({ role: turns.role, text: turns.text })
    .from(turns)
    .where(eq(turns.sessionId, session.id))
    .orderBy(turns.index);

  const userLines = transcript.filter((t) => t.role === 'user').map((t) => t.text);

  const metricsBrief =
    `Words spoken: ${metrics.wordCount}. Talk-time ratio: ${(metrics.talkTimeRatio * 100).toFixed(0)}%. ` +
    `Fillers per 100 words: ${metrics.fillersPer100Words}. ` +
    (metrics.timingsReliable
      ? `Speech rate: ${metrics.speechRate} wpm. Mean run length: ${metrics.meanMlr} words.`
      : 'Timing-derived metrics unavailable for this session.');

  const userContent = [
    'FINDINGS (clustered):',
    findingsBrief.length > 0 ? findingsBrief : '(none — the learner made no confident errors)',
    '',
    'MEASUREMENTS:',
    metricsBrief,
    '',
    'WHAT THEY SAID:',
    ...userLines.map((l) => `- ${l}`),
  ].join('\n');

  const prompt = assembleAnalyzerPrompt({ promptFile: PROMPT_FILE, userContent });

  const { data, meta } = await completeStructured(
    {
      lane: 'session',
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: 2048,
      promptVersion: prompt.promptVersion,
      schema: {
        name: 'write_report',
        description: 'Write the end-of-session report for the learner.',
        jsonSchema: toJsonSchema(sessionReportOutputSchema),
      },
    },
    sessionReportOutputSchema,
  );

  await recordLlmCall({
    userId: user.id,
    sessionId: session.id,
    lane: 'session',
    modelId: meta.modelId,
    promptVersion: prompt.promptVersion,
    usage: meta.usage,
    latencyMs: meta.latencyMs,
    costUsd: meta.costUsd,
    isLive: meta.isLive,
  });

  // Anchor every fix back to a real finding row so the dispute affordance works.
  const topFixes = topClusters.map((cluster, i) => {
    const modelFix = data.topFixes[i];
    return {
      ruleTag: cluster.ruleTag,
      label: getRule(cluster.ruleTag)?.label ?? cluster.ruleTag,
      youSaid: modelFix?.youSaid || cluster.example.originalUtterance,
      better:
        modelFix?.better ||
        cluster.example.suggestedUtterance ||
        cluster.example.suggestedSpanText ||
        '',
      why: modelFix?.why || cluster.example.explanationShort,
      occurrences: cluster.count,
      findingId: cluster.example.id,
    };
  });

  // --- The one automatic Say It Better per session (AI_BEHAVIOR.md §4) -----
  const utterancesForSelection = await db
    .select({
      turnId: turns.id,
      text: turns.text,
      wordCount: utteranceMetrics.wordCount,
    })
    .from(turns)
    .innerJoin(utteranceMetrics, eq(utteranceMetrics.turnId, turns.id))
    .where(eq(turns.sessionId, session.id));

  const polishCounts = new Map<string, number>();
  for (const finding of recorded) {
    if (finding.severity !== 'polish') continue;
    polishCounts.set(finding.turnId, (polishCounts.get(finding.turnId) ?? 0) + 1);
  }

  const chosen = selectMostInvested(
    utterancesForSelection.map((u) => ({
      id: u.turnId,
      text: u.text,
      wordCount: u.wordCount,
      polishFindingCount: polishCounts.get(u.turnId) ?? 0,
    })),
  );

  let sayItBetterResult: SessionReport['sayItBetter'] = null;
  if (chosen) {
    try {
      const mode = getMode(session.mode);
      const result = await sayItBetter(chosen.text, mode.sayItBetterRegisters);
      if (result.meaningPreserved && result.variants.length > 0) {
        sayItBetterResult = { original: result.originalText, variants: result.variants };
      }
    } catch {
      // A failed rewrite must not cost the user their report. It is one card out of many.
      sayItBetterResult = null;
    }
  }

  const vocabRows = await getVocabRows(user.id);
  const introducedHere = vocabRows.filter((v) => v.state === 'introduced').slice(0, 3);

  const report: SessionReport = {
    sessionId: session.id,
    topFixes,
    phrasesToSteal: data.phrasesToSteal.map((p) => ({
      phrase: p.phrase,
      insteadOf: p.insteadOf && p.insteadOf.trim().length > 0 ? p.insteadOf : null,
      note: p.note,
    })),
    vocabItems: introducedHere.map((v) => ({
      lemma: v.lemma,
      definition: v.definition,
      register: v.register,
      anchor: v.anchorUtterance,
    })),
    sayItBetter: sayItBetterResult,
    oneThingThatWentWell: data.oneThingThatWentWell,
    focusNext: data.focusNext,
    metrics,
    isLive: meta.isLive,
  };

  await db
    .insert(sessionReports)
    .values({
      sessionId: session.id,
      userId: user.id,
      topFixes: report.topFixes,
      phrasesToSteal: report.phrasesToSteal,
      vocabItems: report.vocabItems,
      sayItBetter: report.sayItBetter,
      oneThingThatWentWell: report.oneThingThatWentWell,
      focusNext: report.focusNext,
      modelId: meta.modelId,
      promptVersion: prompt.promptVersion,
      generatedAt: now,
    })
    .onConflictDoUpdate({
      target: sessionReports.sessionId,
      set: {
        topFixes: report.topFixes,
        phrasesToSteal: report.phrasesToSteal,
        vocabItems: report.vocabItems,
        sayItBetter: report.sayItBetter,
        oneThingThatWentWell: report.oneThingThatWentWell,
        focusNext: report.focusNext,
        modelId: meta.modelId,
        promptVersion: prompt.promptVersion,
        generatedAt: now,
      },
    });

  return report;
}

/** Load a previously generated report without regenerating it. */
export async function loadReport(
  sessionId: string,
  userId: string,
): Promise<SessionReport | null> {
  const db = getDb();

  const rows = await db
    .select()
    .from(sessionReports)
    .where(eq(sessionReports.sessionId, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row || row.userId !== userId) return null;

  const metricRows = await db
    .select()
    .from(sessionMetrics)
    .where(eq(sessionMetrics.sessionId, sessionId))
    .limit(1);

  const m = metricRows[0];
  if (!m) return null;

  return {
    sessionId,
    topFixes: row.topFixes as SessionReport['topFixes'],
    phrasesToSteal: row.phrasesToSteal as SessionReport['phrasesToSteal'],
    vocabItems: row.vocabItems as SessionReport['vocabItems'],
    sayItBetter: row.sayItBetter as SessionReport['sayItBetter'],
    oneThingThatWentWell: row.oneThingThatWentWell,
    focusNext: row.focusNext,
    metrics: {
      timingsReliable: m.articulationRate > 0,
      turnCount: m.turnCount,
      userSpeechMs: m.userSpeechMs,
      coachSpeechMs: m.coachSpeechMs,
      talkTimeRatio: m.talkTimeRatio,
      wordCount: m.wordCount,
      speechRate: m.speechRate,
      articulationRate: m.articulationRate,
      fillersPer100Words: m.fillersPer100Words,
      repairsPer100Words: m.repairsPer100Words,
      meanMlr: m.meanMlr,
      mtld: m.mtld,
      advancedWordRatio: m.advancedWordRatio,
      meanResponseLatencyMs: m.meanResponseLatencyMs,
      hedgeDensityPer100Words: m.hedgeDensityPer100Words,
    },
    isLive: !row.modelId.startsWith('scripted:'),
  };
}
