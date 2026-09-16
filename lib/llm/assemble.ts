/**
 * Prompt assembly — ARCHITECTURE.md §3.1, ADR-007.
 *
 * Five layers, ordered MOST STABLE FIRST so the prompt cache has a byte-stable prefix:
 *
 *   L0 core identity      frozen per deploy   ─┐
 *   L1 mode persona       frozen per session   ├─ cacheable prefix
 *   L2 learner snapshot   frozen per session  ─┘
 *   L3 conversation history                    volatile
 *   L4 turn directive     every turn           volatile, last
 *
 * The ordering is not stylistic. Without it the hot lane costs roughly 3-4x more, which is the
 * difference between $21/month and $50/month at 30 minutes a day (COSTS.md §5).
 *
 * This module is a pure function of its inputs — it reads prompt files but performs no network
 * or model calls.
 */

import { loadPrompt } from '@/prompts/index';
import type { LlmMessage } from './client';
import type { ModeConfig, TurnDirective } from '@/lib/types';

export type AssembledPrompt = {
  system: Array<{ text: string; cacheable: boolean }>;
  messages: LlmMessage[];
  /** "core@1+modes/casual@1" — persisted with the turn for provenance. */
  promptVersion: string;
};

export type AssembleInput = {
  mode: ModeConfig;
  /** The frozen L2 text, generated once at session start. */
  snapshot: string;
  history: LlmMessage[];
  directive: TurnDirective;
};

export function assembleConversationPrompt(input: AssembleInput): AssembledPrompt {
  const core = loadPrompt('core/identity.md');
  const mode = loadPrompt(input.mode.promptFile);

  // L0 + L1 + L2 form the cacheable prefix. Nothing in here may vary within a session:
  // no timestamps, no request ids, no shuffled lists (ARCHITECTURE.md §5.2).
  const system: Array<{ text: string; cacheable: boolean }> = [
    { text: core.body, cacheable: true },
    { text: mode.body, cacheable: true },
    { text: input.snapshot, cacheable: true },
  ];

  // L4 sits after the cache breakpoint, so a directive that changes every turn costs nothing
  // in cache invalidation.
  system.push({
    text: `## DIRECTIVE FOR THIS TURN\n\n${input.directive.text}`,
    cacheable: false,
  });

  return {
    system,
    messages: input.history,
    promptVersion: `${core.versionKey}+${mode.versionKey}`,
  };
}

export type AnalyzerPromptInput = {
  promptFile: string;
  /** Utterances rendered as "[id] text" lines — the contract analyzers and fixtures share. */
  userContent: string;
  /** Extra context appended after the cacheable analyzer instructions. */
  context?: string;
};

export function assembleAnalyzerPrompt(input: AnalyzerPromptInput): AssembledPrompt {
  const prompt = loadPrompt(input.promptFile);

  const system: Array<{ text: string; cacheable: boolean }> = [
    { text: prompt.body, cacheable: true },
  ];
  if (input.context) {
    system.push({ text: input.context, cacheable: false });
  }

  return {
    system,
    messages: [{ role: 'user', content: input.userContent }],
    promptVersion: prompt.versionKey,
  };
}

/** Render utterances into the "[id] text" form every analyzer prompt expects. */
export function renderUtterances(utterances: Array<{ id: string; text: string }>): string {
  return utterances.map((u) => `[${u.id}] ${u.text}`).join('\n');
}
