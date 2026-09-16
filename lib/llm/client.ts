/**
 * LLM transport — CLAUDE.md invariant 2. The single entry point for every model call.
 *
 * This module now dispatches; the adapters live beside it (ADR-022):
 *
 *   anthropic.ts  the hosted default
 *   ollama.ts     local models, no cost, nothing leaves the machine
 *   scripted.ts   a deterministic stand-in, used when nothing else is configured
 *
 * Which one serves which lane is decided in `providers.ts`, per lane, because the trade-offs
 * genuinely differ between the conversation and the analyzer.
 *
 * The scripted provider is NOT a fake success path: every response carries `isLive: false`, the
 * modelId is prefixed "scripted:", the session UI shows a persistent banner, and the analyzer
 * eval refuses to report a precision figure against it. See README "Running without credentials".
 */

import type { z } from 'zod';
import { modelFor } from './models';
import { LlmErrorShape } from './errors';
import { providerFor, hasAnthropicCredentials } from './providers';
import { anthropicComplete, anthropicStream } from './anthropic';
import { ollamaComplete, ollamaStream } from './ollama';
import { scriptedComplete, scriptedStream } from './scripted';
import type { CompletionRequest, CompletionResult, StreamEvent } from './types';

export type { LlmMessage, CompletionRequest, CompletionResult, StreamEvent } from './types';

/** Kept as the exported name for compatibility; the class itself lives in errors.ts. */
export const LlmError = LlmErrorShape;
export type LlmError = LlmErrorShape;

/**
 * True when the app is configured with a real model somewhere.
 *
 * Note this is no longer "is there an Anthropic key" — a fully local Ollama setup is a live
 * configuration too, and the UI should not call it degraded.
 */
export function hasLiveCredentials(): boolean {
  return (['hot', 'cold', 'session'] as const).every((lane) => providerFor(lane) !== 'scripted');
}

export { hasAnthropicCredentials };

export async function complete(request: CompletionRequest): Promise<CompletionResult<string>> {
  const provider = providerFor(request.lane);
  const modelId = modelFor(request.lane);

  switch (provider) {
    case 'anthropic':
      return anthropicComplete(request, modelId);
    case 'ollama':
      return ollamaComplete(request, modelId);
    case 'scripted': {
      const started = Date.now();
      const scripted = await scriptedComplete(request);
      return { ...scripted, modelId: `scripted:${modelId}`, latencyMs: Date.now() - started };
    }
  }
}

/**
 * Streaming completion for the hot lane. Streaming is what lets the sentence chunker start
 * synthesising audio before the reply is finished — the largest perceived-latency win available
 * (ARCHITECTURE.md §1.3).
 */
export async function* stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
  const provider = providerFor(request.lane);
  const modelId = modelFor(request.lane);

  switch (provider) {
    case 'anthropic':
      yield* anthropicStream(request, modelId);
      return;
    case 'ollama':
      yield* ollamaStream(request, modelId);
      return;
    case 'scripted':
      yield* scriptedStream(request, modelId, Date.now());
      return;
  }
}

/**
 * Schema-constrained call with validation. A response that does not validate is retried once and
 * then thrown — never a silent partial (ARCHITECTURE.md §5.3).
 *
 * Both real providers constrain decoding to the schema (Anthropic via forced tool use, Ollama via
 * its `format` parameter), so a validation failure here means the model produced something
 * structurally valid but semantically unusable, or the provider ignored the constraint.
 */
export async function completeStructured<T>(
  request: CompletionRequest,
  schema: z.ZodType<T>,
): Promise<{ data: T; meta: Omit<CompletionResult, 'content'> }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete(request);
    try {
      const json: unknown = JSON.parse(stripFences(result.raw));
      const data = schema.parse(json);
      const { content: _content, ...meta } = result;
      return { data, meta };
    } catch (error) {
      lastError = error;
    }
  }

  throw new LlmErrorShape(
    `Structured output failed validation after 2 attempts: ${String(lastError)}`,
    false,
    lastError,
  );
}

/** Models occasionally wrap JSON in a fenced block. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
