/**
 * Provider selection and the Ollama adapter — ADR-022.
 *
 * The rule that matters most: **Ollama is never selected implicitly.** A local server being up
 * is not consent to route the product through it, and silently switching the analyzer to an
 * unmeasured model is exactly how the precision gate gets bypassed without anyone deciding to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderName, PROVIDERS, providerFor, providerSummary } from '@/lib/llm/providers';
import {
  modelFor,
  modelSummary,
  costOf,
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_MODELS,
} from '@/lib/llm/models';
import type { Lane } from '@/lib/llm/models';

const LANES: Lane[] = ['hot', 'cold', 'session'];

const VOLATILE = [
  'ANTHROPIC_API_KEY',
  'ENGCOACH_LLM_PROVIDER',
  'ENGCOACH_PROVIDER_HOT',
  'ENGCOACH_PROVIDER_COLD',
  'ENGCOACH_PROVIDER_SESSION',
  'ENGCOACH_MODEL',
  'ENGCOACH_MODEL_HOT',
  'ENGCOACH_MODEL_COLD',
  'ENGCOACH_MODEL_SESSION',
  'ENGCOACH_OLLAMA_MODEL',
  'ENGCOACH_OLLAMA_MODEL_HOT',
  'ENGCOACH_OLLAMA_MODEL_COLD',
  'ENGCOACH_OLLAMA_MODEL_SESSION',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(VOLATILE.map((k) => [k, process.env[k]]));
  for (const key of VOLATILE) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('provider selection', () => {
  it('falls back to the scripted stand-in with nothing configured', () => {
    for (const lane of LANES) expect(providerFor(lane), lane).toBe('scripted');
  });

  it('uses Anthropic when a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    for (const lane of LANES) expect(providerFor(lane), lane).toBe('anthropic');
  });

  it('NEVER selects Ollama implicitly, even with no other provider available', () => {
    // A running local server is not consent. Choosing it has to be deliberate.
    for (const lane of LANES) expect(providerFor(lane), lane).not.toBe('ollama');
  });

  it('honours the global override', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    for (const lane of LANES) expect(providerFor(lane), lane).toBe('ollama');
  });

  it('lets a per-lane override beat the global one', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_PROVIDER_COLD = 'anthropic';

    // The realistic hybrid: local conversation (saves the most), hosted analyzer (the one
    // whose precision the product depends on).
    expect(providerFor('hot')).toBe('ollama');
    expect(providerFor('session')).toBe('ollama');
    expect(providerFor('cold')).toBe('anthropic');
  });

  it('ignores a junk provider name rather than crashing', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'gpt-9';
    for (const lane of LANES) expect(providerFor(lane), lane).toBe('scripted');
  });

  it('a per-lane override beats an Anthropic key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ENGCOACH_PROVIDER_HOT = 'ollama';
    expect(providerFor('hot')).toBe('ollama');
    expect(providerFor('cold')).toBe('anthropic');
  });

  it('summarises every lane', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    expect(providerSummary()).toEqual({ hot: 'ollama', cold: 'ollama', session: 'ollama' });
  });

  it('validates provider names', () => {
    expect(PROVIDERS).toEqual(['anthropic', 'ollama', 'scripted']);
    expect(isProviderName('ollama')).toBe(true);
    expect(isProviderName('llamacpp')).toBe(false);
  });
});

describe('model selection follows the provider', () => {
  it('uses Claude model ids for Anthropic lanes', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(modelFor('hot')).toBe(DEFAULT_ANTHROPIC_MODELS.hot);
    expect(modelFor('hot')).toContain('claude');
  });

  it('uses Ollama model names when a lane is local', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    for (const lane of LANES) {
      expect(modelFor(lane), lane).toBe(DEFAULT_OLLAMA_MODELS[lane]);
      expect(modelFor(lane), lane).not.toContain('claude');
    }
  });

  it('mixes correctly when only one lane is local', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ENGCOACH_PROVIDER_HOT = 'ollama';
    expect(modelFor('hot')).toBe(DEFAULT_OLLAMA_MODELS.hot);
    expect(modelFor('cold')).toBe(DEFAULT_ANTHROPIC_MODELS.cold);
  });
});

describe('local inference is free, and the telemetry says so', () => {
  it('costs nothing for an unpriced local model', () => {
    // Local models are not in the price table, so costOf returns 0 rather than inventing a rate.
    expect(costOf('qwen2.5:7b-instruct', { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 2000 })).toBe(0);
    expect(costOf('ollama:llama3.1:8b', { inputTokens: 9000, cachedInputTokens: 0, outputTokens: 4000 })).toBe(0);
  });

  it('still charges for hosted models', () => {
    expect(costOf('claude-opus-5', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 })).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

describe('the Ollama adapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends the JSON schema as `format` so decoding is genuinely constrained', async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return new Response(
        JSON.stringify({ message: { content: '{"ok":true}' }, prompt_eval_count: 10, eval_count: 5 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { ollamaComplete } = await import('@/lib/llm/ollama');
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await ollamaComplete(
      {
        lane: 'cold',
        system: [{ text: 'You analyse English.', cacheable: true }],
        messages: [{ role: 'user', content: '[u1] I have went' }],
        maxTokens: 512,
        promptVersion: 'analyzers/error-analyzer@1',
        schema: { name: 'report_findings', description: 'x', jsonSchema: schema },
      },
      'qwen2.5:7b-instruct',
    );

    // This is the whole reason a local model is usable for the analyzer at all.
    expect(captured.format).toEqual(schema);
    // Deterministic for structured calls; the analyzer must not be creative.
    expect((captured.options as { temperature: number }).temperature).toBe(0);
  });

  it('reports zero cost and zero cache, which is accurate for local inference', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ message: { content: 'hi' }, prompt_eval_count: 100, eval_count: 20 }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const { ollamaComplete } = await import('@/lib/llm/ollama');
    const result = await ollamaComplete(
      { lane: 'hot', system: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, promptVersion: 'x@1' },
      'llama3.1:8b',
    );

    expect(result.costUsd).toBe(0);
    expect(result.usage.cachedInputTokens).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);
    // Marked live: a real model produced this, unlike the scripted stand-in.
    expect(result.isLive).toBe(true);
    expect(result.modelId).toBe('ollama:llama3.1:8b');
  });

  it('gives an actionable message when the model is not pulled', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('model "foo" not found', { status: 404 }),
    ) as unknown as typeof fetch;

    const { ollamaComplete } = await import('@/lib/llm/ollama');
    await expect(
      ollamaComplete(
        { lane: 'hot', system: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, promptVersion: 'x@1' },
        'foo',
      ),
    ).rejects.toThrow(/ollama pull/i);
  });

  it('gives an actionable message when the server is down', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { ollamaComplete } = await import('@/lib/llm/ollama');
    await expect(
      ollamaComplete(
        { lane: 'hot', system: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, promptVersion: 'x@1' },
        'llama3.1:8b',
      ),
    ).rejects.toThrow(/ollama serve/i);
  });

  it('parses newline-delimited streaming chunks', async () => {
    const chunks = [
      JSON.stringify({ message: { content: 'That ' } }),
      JSON.stringify({ message: { content: 'sounds ' } }),
      JSON.stringify({ message: { content: 'good.' }, done: true, prompt_eval_count: 40, eval_count: 8 }),
    ].join('\n');

    globalThis.fetch = vi.fn(
      async () => new Response(chunks, { status: 200 }),
    ) as unknown as typeof fetch;

    const { ollamaStream } = await import('@/lib/llm/ollama');
    const deltas: string[] = [];
    let final = '';

    for await (const event of ollamaStream(
      { lane: 'hot', system: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, promptVersion: 'x@1' },
      'llama3.1:8b',
    )) {
      if (event.type === 'text') deltas.push(event.delta);
      if (event.type === 'done') final = event.result.content;
    }

    expect(deltas).toEqual(['That ', 'sounds ', 'good.']);
    expect(final).toBe('That sounds good.');
  });

  it('surfaces an error chunk instead of returning half a reply as success', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'out of memory' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const { ollamaStream } = await import('@/lib/llm/ollama');
    const events: string[] = [];
    for await (const event of ollamaStream(
      { lane: 'hot', system: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, promptVersion: 'x@1' },
      'llama3.1:8b',
    )) {
      events.push(event.type);
    }

    expect(events).toContain('error');
    expect(events).not.toContain('done');
  });

  it('reports honestly when the server is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { ollamaStatus } = await import('@/lib/llm/ollama');
    const status = await ollamaStatus();
    expect(status.reachable).toBe(false);
    expect(status.models).toEqual([]);
    expect(status.message).toMatch(/ollama serve/i);
  });

  it('says so when the server is up but has no models', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const { ollamaStatus } = await import('@/lib/llm/ollama');
    const status = await ollamaStatus();
    expect(status.reachable).toBe(true);
    expect(status.message).toMatch(/no models pulled/i);
  });
});

describe('model names are configurable from the environment', () => {
  it('ENGCOACH_OLLAMA_MODEL sets every local lane at once', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_OLLAMA_MODEL = 'llama3.1:8b';

    expect(modelSummary()).toEqual({
      hot: 'llama3.1:8b',
      cold: 'llama3.1:8b',
      session: 'llama3.1:8b',
    });
  });

  it('a per-lane local override beats the single variable', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_OLLAMA_MODEL = 'llama3.2:3b';
    process.env.ENGCOACH_OLLAMA_MODEL_COLD = 'qwen2.5:14b-instruct';

    // The realistic local split: a small fast model for conversation, a bigger one for the
    // analyzer, where accuracy matters and latency does not.
    expect(modelFor('hot')).toBe('llama3.2:3b');
    expect(modelFor('session')).toBe('llama3.2:3b');
    expect(modelFor('cold')).toBe('qwen2.5:14b-instruct');
  });

  it('ENGCOACH_MODEL sets every hosted lane, flattening the ADR-013 tiering', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ENGCOACH_MODEL = 'claude-sonnet-5';

    expect(modelSummary()).toEqual({
      hot: 'claude-sonnet-5',
      cold: 'claude-sonnet-5',
      session: 'claude-sonnet-5',
    });
  });

  it('a per-lane hosted override beats the single variable', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ENGCOACH_MODEL = 'claude-sonnet-5';
    process.env.ENGCOACH_MODEL_COLD = 'claude-haiku-4-5';

    expect(modelFor('hot')).toBe('claude-sonnet-5');
    expect(modelFor('cold')).toBe('claude-haiku-4-5');
  });

  it('keeps the two provider namespaces separate', () => {
    // A hosted override must not leak into a local lane, or you would ask Ollama for
    // "claude-opus-5" and get a 404.
    process.env.ENGCOACH_PROVIDER_HOT = 'ollama';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ENGCOACH_MODEL = 'claude-sonnet-5';
    process.env.ENGCOACH_OLLAMA_MODEL = 'llama3.1:8b';

    expect(modelFor('hot')).toBe('llama3.1:8b');
    expect(modelFor('cold')).toBe('claude-sonnet-5');
  });

  it('treats a BLANK value as unset rather than as a model named ""', () => {
    // .env files are full of `FOO=` meaning "left empty". An empty string is not a model name,
    // and passing it through would send an empty model to the provider.
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_OLLAMA_MODEL = '';
    expect(modelFor('hot')).toBe(DEFAULT_OLLAMA_MODEL);

    process.env.ENGCOACH_OLLAMA_MODEL = '   ';
    expect(modelFor('hot')).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it('trims surrounding whitespace from a pasted value', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_OLLAMA_MODEL = '  llama3.1:8b  ';
    expect(modelFor('hot')).toBe('llama3.1:8b');
  });

  it('reads the environment at CALL time, not at module load', () => {
    // Frozen module-level consts silently ignore a late-loaded .env.local. This is the
    // regression that fix guards against.
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_OLLAMA_MODEL = 'first-model';
    expect(modelFor('hot')).toBe('first-model');

    process.env.ENGCOACH_OLLAMA_MODEL = 'second-model';
    expect(modelFor('hot')).toBe('second-model');
  });

  it('falls back to the built-in defaults with nothing set', () => {
    expect(modelSummary()).toEqual(DEFAULT_ANTHROPIC_MODELS);

    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    expect(modelSummary()).toEqual(DEFAULT_OLLAMA_MODELS);
  });
});

describe('routing and model naming can never disagree (ADR-023 regression)', () => {
  /**
   * The bug this pins down: `providers.ts` validated `ENGCOACH_PROVIDER_<LANE>` and ignored a
   * junk value, correctly falling back to the global setting. `models.ts` re-read the same
   * variable WITHOUT validating, saw a string that was not 'ollama', and returned an Anthropic
   * model name. Result: the lane routed to Ollama while asking it for `claude-haiku-4-5`.
   *
   * This is exactly what happened in the wild — a `#` was dropped from a commented example
   * line in .env.local, turning it into
   *     ENGCOACH_PROVIDER_COLD=ollama npm run eval:analyzers -- --gate
   */
  it('an invalid per-lane provider falls back consistently in BOTH modules', () => {
    process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
    process.env.ENGCOACH_PROVIDER_COLD = 'ollama npm run eval:analyzers -- --gate';
    process.env.ENGCOACH_OLLAMA_MODEL = 'qwen2.5:7b-instruct';

    // Router ignores the junk and uses the global setting.
    expect(providerFor('cold')).toBe('ollama');
    // Model naming must reach the SAME conclusion, not hand Ollama a Claude model.
    expect(modelFor('cold')).toBe('qwen2.5:7b-instruct');
    expect(modelFor('cold')).not.toContain('claude');
  });

  it('holds for every lane and every shape of junk', () => {
    const junk = ['ollama npm run eval', 'OLLAMA', 'ollama ', 'gpt-4', '1', 'true'];

    for (const value of junk) {
      for (const lane of LANES) {
        process.env.ENGCOACH_LLM_PROVIDER = 'ollama';
        process.env[`ENGCOACH_PROVIDER_${lane.toUpperCase()}`] = value;
        process.env.ENGCOACH_OLLAMA_MODEL = 'qwen2.5:7b-instruct';

        const routedLocal = providerFor(lane) === 'ollama';
        const namedLocal = !modelFor(lane).includes('claude');

        expect(namedLocal, `${lane} with "${value}"`).toBe(routedLocal);
        delete process.env[`ENGCOACH_PROVIDER_${lane.toUpperCase()}`];
      }
    }
  });

  it('stays consistent when junk falls all the way through to the default', () => {
    // No global setting either: both modules must land on the hosted side.
    process.env.ENGCOACH_PROVIDER_HOT = 'not-a-provider';
    process.env.ANTHROPIC_API_KEY = 'sk-test';

    expect(providerFor('hot')).toBe('anthropic');
    expect(modelFor('hot')).toBe(DEFAULT_ANTHROPIC_MODELS.hot);
  });

  it('agrees across every valid combination too', () => {
    const settings = ['anthropic', 'ollama', 'scripted', undefined] as const;

    for (const global of settings) {
      for (const perLane of settings) {
        if (global) process.env.ENGCOACH_LLM_PROVIDER = global;
        else delete process.env.ENGCOACH_LLM_PROVIDER;
        if (perLane) process.env.ENGCOACH_PROVIDER_HOT = perLane;
        else delete process.env.ENGCOACH_PROVIDER_HOT;

        const routedLocal = providerFor('hot') === 'ollama';
        const namedLocal = !modelFor('hot').includes('claude');
        expect(namedLocal, `global=${global} perLane=${perLane}`).toBe(routedLocal);
      }
    }
  });
});
