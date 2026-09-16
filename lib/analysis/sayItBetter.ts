/**
 * Say It Better — ROADMAP.md M11, AI_BEHAVIOR.md §4.
 *
 * On-demand first: the user taps a caption bubble. Two variants by default, expandable.
 * The register set comes from the MODE, not a fixed ladder — most casual speech should not be
 * professionalised, and four variants would imply the last rung is best. It is not.
 */

import { assembleAnalyzerPrompt } from '@/lib/llm/assemble';
import { completeStructured } from '@/lib/llm/client';
import { sayItBetterOutputSchema, toJsonSchema } from '@/lib/llm/schemas';
import type { SayItBetterRegister, SayItBetterResult, SayItBetterVariant } from '@/lib/types';

const PROMPT_FILE = 'analyzers/say-it-better.md';

export type SayItBetterAnalysis = SayItBetterResult & {
  meaningPreserved: boolean;
  promptVersion: string;
  modelId: string;
  isLive: boolean;
  costUsd: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
};

export async function sayItBetter(
  originalText: string,
  registers: readonly SayItBetterRegister[],
  options: { conversationContext?: string; expanded?: boolean } = {},
): Promise<SayItBetterAnalysis> {
  // Expanding shows the full register set; the default stays narrow so the feature informs
  // rather than overwhelms.
  const requested: SayItBetterRegister[] = options.expanded
    ? ['natural', 'professional', 'persuasive', 'formal']
    : [...registers];

  const contextParts = [`Produce exactly these registers, in this order: ${requested.join(', ')}.`];
  if (options.conversationContext) {
    contextParts.push(`They were talking about: ${options.conversationContext}`);
  }

  const prompt = assembleAnalyzerPrompt({
    promptFile: PROMPT_FILE,
    userContent: `The learner said: "${originalText}"`,
    context: contextParts.join('\n'),
  });

  const { data, meta } = await completeStructured(
    {
      lane: 'cold',
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: 1536,
      promptVersion: prompt.promptVersion,
      schema: {
        name: 'rewrite_variants',
        description: 'Rewrite the learner sentence in the requested registers.',
        jsonSchema: toJsonSchema(sayItBetterOutputSchema),
      },
    },
    sayItBetterOutputSchema,
  );

  const variants: SayItBetterVariant[] = data.variants
    .filter((v) => requested.includes(v.register as SayItBetterRegister))
    .map((v) => ({
      register: v.register as SayItBetterRegister,
      text: v.text,
      why: v.why,
    }));

  return {
    originalText,
    variants,
    meaningPreserved: data.meaningPreserved,
    promptVersion: prompt.promptVersion,
    modelId: meta.modelId,
    isLive: meta.isLive,
    costUsd: meta.costUsd,
    usage: meta.usage,
  };
}

/**
 * Pick the utterance for the one automatic Say It Better per session: the user's most *invested*
 * turn — longest, weighted by how much improvement headroom it has (AI_BEHAVIOR.md §4).
 * Pure selection logic, so it is testable without a model.
 */
export function selectMostInvested(
  utterances: Array<{ id: string; text: string; wordCount: number; polishFindingCount: number }>,
): { id: string; text: string } | null {
  if (utterances.length === 0) return null;
  const scored = utterances
    .filter((u) => u.wordCount >= 8)
    .map((u) => ({ ...u, score: u.wordCount + u.polishFindingCount * 5 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const best = scored[0];
  return best ? { id: best.id, text: best.text } : null;
}
