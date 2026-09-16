/**
 * Error analyzer — the cold lane's main output. ROADMAP.md M5.
 *
 * Runs OFF the critical path, batched over several turns (ARCHITECTURE.md §2). It returns
 * structured data and does not persist anything — services persist, analyzers analyse, which is
 * what keeps this runnable inside the eval harness with no database attached.
 *
 * It also does not decide anything. It proposes candidates with a confidence; lib/coaching/policy
 * decides what happens to them (CLAUDE.md invariant 6).
 */

import { assembleAnalyzerPrompt, renderUtterances } from '@/lib/llm/assemble';
import { completeStructured } from '@/lib/llm/client';
import { errorAnalyzerOutputSchema, toJsonSchema } from '@/lib/llm/schemas';
import { categoryOf, getRule } from './taxonomy';
import type { CandidateFinding, StructureObservation } from '@/lib/types';

export type AnalyzerUtterance = { id: string; text: string };

export type ErrorAnalysisResult = {
  candidates: CandidateFinding[];
  observations: StructureObservation[];
  promptVersion: string;
  modelId: string;
  isLive: boolean;
  costUsd: number;
  latencyMs: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
};

const PROMPT_FILE = 'analyzers/error-analyzer.md';

export async function analyzeErrors(
  utterances: AnalyzerUtterance[],
  options: { learnerLevel?: string | null } = {},
): Promise<ErrorAnalysisResult> {
  if (utterances.length === 0) {
    return {
      candidates: [],
      observations: [],
      promptVersion: 'analyzers/error-analyzer@0',
      modelId: 'none',
      isLive: false,
      costUsd: 0,
      latencyMs: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    };
  }

  const context = options.learnerLevel
    ? `The learner is around ${options.learnerLevel}. Judge naturalness against that level.`
    : undefined;

  const prompt = assembleAnalyzerPrompt({
    promptFile: PROMPT_FILE,
    userContent: renderUtterances(utterances),
    ...(context ? { context } : {}),
  });

  const { data, meta } = await completeStructured(
    {
      lane: 'cold',
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: 4096,
      promptVersion: prompt.promptVersion,
      schema: {
        name: 'report_findings',
        description: 'Report English errors and structure observations for the given utterances.',
        jsonSchema: toJsonSchema(errorAnalyzerOutputSchema),
      },
    },
    errorAnalyzerOutputSchema,
  );

  const byId = new Map(utterances.map((u) => [u.id, u.text]));

  const candidates: CandidateFinding[] = [];
  for (const [i, finding] of data.findings.entries()) {
    const original = byId.get(finding.utteranceId);
    // A finding about an utterance we did not send cannot be anchored, highlighted, or
    // confidence-scored against real audio. Drop it rather than persist an orphan.
    if (original === undefined) continue;
    const rule = getRule(finding.ruleTag);
    if (!rule) continue;

    candidates.push({
      id: `${finding.utteranceId}:${i}`,
      utteranceId: finding.utteranceId,
      type: categoryOf(finding.ruleTag) ?? 'grammar',
      ruleTag: finding.ruleTag,
      span: { wordStart: finding.wordStart, wordEnd: Math.max(finding.wordStart, finding.wordEnd) },
      originalSpanText: finding.originalSpanText,
      originalUtterance: original,
      suggestedSpanText: emptyToNull(finding.suggestedSpanText),
      suggestedUtterance: emptyToNull(finding.suggestedUtterance),
      explanationShort: finding.explanationShort,
      severity: finding.severity as CandidateFinding['severity'],
      llmConfidence: finding.llmConfidence,
    });
  }

  const observations: StructureObservation[] = data.observations
    .filter((o) => byId.has(o.utteranceId) && getRule(o.ruleTag))
    .map((o) => ({
      utteranceId: o.utteranceId,
      ruleTag: o.ruleTag,
      obligatoryContext: o.obligatoryContext,
      produced: o.produced,
      correct: o.correct,
    }));

  return {
    candidates,
    observations,
    promptVersion: prompt.promptVersion,
    modelId: meta.modelId,
    isLive: meta.isLive,
    costUsd: meta.costUsd,
    latencyMs: meta.latencyMs,
    usage: meta.usage,
  };
}

/**
 * The JSON Schema we send models nullable-as-empty-string (schemas.ts `toJsonSchema`), so an
 * absent suggestion arrives as "" rather than null.
 */
function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
