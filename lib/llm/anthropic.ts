/**
 * Anthropic adapter — ADR-017, extracted from client.ts by ADR-022.
 *
 * STRUCTURED OUTPUT: schema constraint is implemented with forced tool use rather than
 * `output_config.format`, because the pinned SDK predates that parameter. The guarantee is the
 * same — the model must emit an object matching our JSON Schema, and we never parse prose into
 * application data (CLAUDE.md invariant 3).
 */

import Anthropic from '@anthropic-ai/sdk';
import { costOf } from './models';
import { LlmErrorShape } from './errors';
import type { CompletionRequest, CompletionResult, StreamEvent } from './types';
import type { Usage } from './models';

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (!cached) {
    cached = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', maxRetries: 2 });
  }
  return cached;
}

export function resetAnthropicClientForTests(): void {
  cached = null;
}

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

function systemBlocks(system: CompletionRequest['system']): SystemBlock[] {
  return system.map((block) =>
    block.cacheable
      ? { type: 'text' as const, text: block.text, cache_control: { type: 'ephemeral' as const } }
      : { type: 'text' as const, text: block.text },
  );
}

function usageFrom(raw: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
}): Usage {
  const cachedTokens = raw.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (raw.input_tokens ?? 0) + cachedTokens,
    cachedInputTokens: cachedTokens,
    outputTokens: raw.output_tokens ?? 0,
  };
}

export async function anthropicComplete(
  request: CompletionRequest,
  modelId: string,
): Promise<CompletionResult<string>> {
  const started = Date.now();

  try {
    const response = await client().messages.create({
      model: modelId,
      max_tokens: request.maxTokens,
      system: systemBlocks(request.system),
      messages: request.messages,
      ...(request.schema
        ? {
            tools: [
              {
                name: request.schema.name,
                description: request.schema.description,
                input_schema: request.schema.jsonSchema as Anthropic.Tool['input_schema'],
              },
            ],
            tool_choice: { type: 'tool' as const, name: request.schema.name },
          }
        : {}),
    });

    const text = request.schema
      ? extractToolInput(response.content, request.schema.name)
      : extractText(response.content);
    const usage = usageFrom(response.usage);

    return {
      content: text,
      raw: text,
      modelId,
      usage,
      costUsd: costOf(modelId, usage),
      latencyMs: Date.now() - started,
      isLive: true,
    };
  } catch (error) {
    throw toLlmError(error);
  }
}

export async function* anthropicStream(
  request: CompletionRequest,
  modelId: string,
): AsyncGenerator<StreamEvent> {
  const started = Date.now();
  let text = '';
  let usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  try {
    const streamed = client().messages.stream({
      model: modelId,
      max_tokens: request.maxTokens,
      system: systemBlocks(request.system),
      messages: request.messages,
    });

    for await (const event of streamed) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        yield { type: 'text', delta: event.delta.text };
      } else if (event.type === 'message_start') {
        usage = usageFrom(event.message.usage);
      } else if (event.type === 'message_delta') {
        const outputTokens = event.usage?.output_tokens;
        if (typeof outputTokens === 'number') usage = { ...usage, outputTokens };
      }
    }

    yield {
      type: 'done',
      result: {
        content: text,
        raw: text,
        modelId,
        usage,
        costUsd: costOf(modelId, usage),
        latencyMs: Date.now() - started,
        isLive: true,
      },
    };
  } catch (error) {
    yield { type: 'error', message: toLlmError(error).message };
  }
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** With forced tool use the payload arrives as the tool_use block's `input`. */
function extractToolInput(content: Anthropic.ContentBlock[], toolName: string): string {
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === toolName) {
      return JSON.stringify(block.input);
    }
  }
  throw new LlmErrorShape(`Model did not call the required tool "${toolName}"`, true);
}

function toLlmError(error: unknown): LlmErrorShape {
  if (error instanceof LlmErrorShape) return error;
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new LlmErrorShape(
      `Anthropic API error ${status || '?'}: ${error.message}`,
      status === 429 || status >= 500,
      error,
    );
  }
  if (error instanceof Error) return new LlmErrorShape(error.message, true, error);
  return new LlmErrorShape(String(error), false, error);
}
