/**
 * Vocabulary miner — ROADMAP.md M8, AI_BEHAVIOR.md §5.
 *
 * Every item is mined from something the user actually tried to say. No wordlists.
 * Returns structured data; persistence and SRS scheduling belong to the service layer.
 */

import { assembleAnalyzerPrompt, renderUtterances } from '@/lib/llm/assemble';
import { completeStructured } from '@/lib/llm/client';
import { toJsonSchema, vocabAnalyzerOutputSchema } from '@/lib/llm/schemas';
import type { VocabCandidate } from '@/lib/types';
import type { AnalyzerUtterance } from './errorAnalyzer';

const PROMPT_FILE = 'analyzers/vocab-analyzer.md';

export type VocabAnalysisResult = {
  candidates: VocabCandidate[];
  promptVersion: string;
  modelId: string;
  isLive: boolean;
  costUsd: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
};

export async function analyzeVocabulary(
  utterances: AnalyzerUtterance[],
  options: {
    learnerLevel?: string | null;
    /** Lemmas the user leans on, from lib/metrics/lexical. Focuses the miner on real overuse. */
    overused?: Array<{ lemma: string; count: number }>;
    /** Items the user already has, so we do not re-teach them. */
    knownLemmas?: string[];
  } = {},
): Promise<VocabAnalysisResult> {
  if (utterances.length === 0) {
    return {
      candidates: [],
      promptVersion: 'analyzers/vocab-analyzer@0',
      modelId: 'none',
      isLive: false,
      costUsd: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    };
  }

  const contextParts: string[] = [];
  if (options.learnerLevel) contextParts.push(`Learner level: roughly ${options.learnerLevel}.`);
  if (options.overused && options.overused.length > 0) {
    const list = options.overused.map((o) => `${o.lemma} (x${o.count})`).join(', ');
    contextParts.push(`Words they lean on across recent sessions: ${list}.`);
  }
  if (options.knownLemmas && options.knownLemmas.length > 0) {
    contextParts.push(
      `Already taught, do NOT propose again: ${options.knownLemmas.slice(0, 60).join(', ')}.`,
    );
  }

  const prompt = assembleAnalyzerPrompt({
    promptFile: PROMPT_FILE,
    userContent: renderUtterances(utterances),
    ...(contextParts.length > 0 ? { context: contextParts.join('\n') } : {}),
  });

  const { data, meta } = await completeStructured(
    {
      lane: 'cold',
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: 2048,
      promptVersion: prompt.promptVersion,
      schema: {
        name: 'propose_vocabulary',
        description: 'Propose at most three vocabulary items mined from the learner speech.',
        jsonSchema: toJsonSchema(vocabAnalyzerOutputSchema),
      },
    },
    vocabAnalyzerOutputSchema,
  );

  const known = new Set((options.knownLemmas ?? []).map((l) => l.toLowerCase()));

  const candidates: VocabCandidate[] = data.candidates
    .filter((c) => !known.has(c.lemma.toLowerCase()))
    // An item without the user's own sentence attached is a flashcard, and flashcards do not
    // produce speech (AI_BEHAVIOR.md §5.4). The schema requires it; this is belt and braces.
    .filter((c) => c.anchorUtterance.trim().length > 0)
    .map((c) => ({
      lemma: c.lemma,
      sense: c.sense,
      definition: c.definition,
      register: c.register as VocabCandidate['register'],
      cefrLevel: c.cefrLevel,
      examples: c.examples,
      anchorUtterance: c.anchorUtterance,
      replacesText: c.replacesText && c.replacesText.trim().length > 0 ? c.replacesText : null,
      reason: c.reason,
    }));

  return {
    candidates,
    promptVersion: prompt.promptVersion,
    modelId: meta.modelId,
    isLive: meta.isLive,
    costUsd: meta.costUsd,
    usage: meta.usage,
  };
}
