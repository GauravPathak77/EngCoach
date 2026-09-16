/**
 * Ollama adapter — local models, ADR-022.
 *
 * Talks to Ollama's native `/api/chat` over plain HTTP. No SDK: it is two endpoints, and a
 * dependency for that would be weight for nothing.
 *
 * STRUCTURED OUTPUT is the load-bearing part. Ollama's `format` parameter accepts a JSON Schema
 * and enforces it with constrained decoding (llama.cpp grammars), so the analyzer contract in
 * CLAUDE.md invariant 3 holds exactly as it does with Anthropic: the model *cannot* emit a
 * rule_tag outside the taxonomy, and we never parse prose into application data. Requires Ollama
 * 0.5+; `assertOllamaReady()` checks the server is actually there before a lane depends on it.
 *
 * WHAT THIS DOES NOT GIVE YOU: schema conformance is not the same as being RIGHT. A small model
 * will happily return a perfectly-shaped finding that is nonsense. That is what the eval harness
 * is for — see ADR-022 and the note in `providers.ts`.
 */

import { OLLAMA_HOST } from './providers';
import { LlmErrorShape } from './errors';
import type { CompletionRequest, CompletionResult, StreamEvent } from './types';
import type { Usage } from './models';

type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type OllamaChatResponse = {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

/** Ollama takes the system prompt as a message, so the layered blocks are concatenated. */
function toMessages(request: CompletionRequest): OllamaMessage[] {
  const system = request.system.map((block) => block.text).join('\n\n');
  const messages: OllamaMessage[] = [];
  if (system.trim().length > 0) messages.push({ role: 'system', content: system });
  for (const message of request.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function usageFrom(raw: OllamaChatResponse): Usage {
  return {
    inputTokens: raw.prompt_eval_count ?? 0,
    // Local inference has no prompt cache to read from, and no billing either. Reporting 0
    // here is accurate; the cache-hit alarm in ARCHITECTURE.md §5.2 only applies to Anthropic.
    cachedInputTokens: 0,
    outputTokens: raw.eval_count ?? 0,
  };
}

function body(request: CompletionRequest, modelId: string, stream: boolean): string {
  return JSON.stringify({
    model: modelId,
    messages: toMessages(request),
    stream,
    // Constrained decoding when a schema is present — this is the real guarantee, not a prompt
    // asking nicely for JSON.
    ...(request.schema ? { format: request.schema.jsonSchema } : {}),
    options: {
      num_predict: request.maxTokens,
      // The coach must not ramble; local models drift more than hosted ones without this.
      temperature: request.schema ? 0 : 0.7,
    },
  });
}

async function post(path: string, payload: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${OLLAMA_HOST}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new LlmErrorShape(
      `Could not reach Ollama at ${OLLAMA_HOST}. Is it running? Try \`ollama serve\`.`,
      true,
      error,
    );
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  // A missing model is the most common failure and deserves the actual fix in the message.
  if (response.status === 404) {
    throw new LlmErrorShape(
      `Ollama does not have that model pulled. Run \`ollama pull <model>\`. (${text.slice(0, 160)})`,
      false,
    );
  }
  throw new LlmErrorShape(
    `Ollama returned ${response.status}: ${text.slice(0, 200)}`,
    response.status >= 500,
  );
}

export async function ollamaComplete(
  request: CompletionRequest,
  modelId: string,
): Promise<CompletionResult<string>> {
  const started = Date.now();
  const response = await post('/api/chat', body(request, modelId, false));
  await assertOk(response);

  const json = (await response.json()) as OllamaChatResponse;
  if (json.error) throw new LlmErrorShape(`Ollama: ${json.error}`, false);

  const text = json.message?.content ?? '';
  return {
    content: text,
    raw: text,
    modelId: `ollama:${modelId}`,
    usage: usageFrom(json),
    costUsd: 0,
    latencyMs: Date.now() - started,
    // Live in the sense that matters: a real model produced this, not a canned string.
    isLive: true,
  };
}

export async function* ollamaStream(
  request: CompletionRequest,
  modelId: string,
): AsyncGenerator<StreamEvent> {
  const started = Date.now();
  let text = '';
  let usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  const response = await post('/api/chat', body(request, modelId, true));
  await assertOk(response);

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', message: 'Ollama returned no response body.' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  type Parsed = { delta: string } | { error: string } | null;

  const parseLine = (line: string): Parsed => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let chunk: OllamaChatResponse;
    try {
      chunk = JSON.parse(trimmed) as OllamaChatResponse;
    } catch {
      return null; // A partial line; the remainder is carried in `buffer`.
    }

    if (chunk.error) return { error: chunk.error };
    if (chunk.done) usage = usageFrom(chunk);
    return { delta: chunk.message?.content ?? '' };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Ollama streams newline-delimited JSON, one object per chunk. The trailing element is
      // held back because it may be a partial line split across reads.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed === null) continue;
        if ('error' in parsed) {
          yield { type: 'error', message: `Ollama: ${parsed.error}` };
          return;
        }
        if (parsed.delta.length > 0) {
          text += parsed.delta;
          yield { type: 'text', delta: parsed.delta };
        }
      }
    }

    // Flush the tail. Ollama's FINAL chunk — the one carrying `done` and the token counts —
    // frequently arrives without a trailing newline, so skipping this drops both the last
    // delta and the usage numbers.
    const parsed = parseLine(buffer);
    if (parsed !== null) {
      if ('error' in parsed) {
        yield { type: 'error', message: `Ollama: ${parsed.error}` };
        return;
      }
      if (parsed.delta.length > 0) {
        text += parsed.delta;
        yield { type: 'text', delta: parsed.delta };
      }
    }
  } catch (error) {
    yield {
      type: 'error',
      message: `Lost the connection to Ollama mid-reply: ${String(error)}`,
    };
    return;
  }

  yield {
    type: 'done',
    result: {
      content: text,
      raw: text,
      modelId: `ollama:${modelId}`,
      usage,
      costUsd: 0,
      latencyMs: Date.now() - started,
      isLive: true,
    },
  };
}

export type OllamaStatus = {
  reachable: boolean;
  models: string[];
  message: string;
};

/**
 * Check the server is up and report which models are pulled.
 * Used by /api/config so the settings page can tell the truth about a local setup.
 */
export async function ollamaStatus(): Promise<OllamaStatus> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      return { reachable: false, models: [], message: `Ollama returned ${response.status}` };
    }
    const json = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = (json.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    return {
      reachable: true,
      models,
      message:
        models.length === 0
          ? 'Ollama is running but has no models pulled. Try `ollama pull qwen2.5:7b-instruct`.'
          : `Ollama is running with ${models.length} model(s).`,
    };
  } catch {
    return {
      reachable: false,
      models: [],
      message: `No Ollama server at ${OLLAMA_HOST}. Start it with \`ollama serve\`.`,
    };
  }
}
