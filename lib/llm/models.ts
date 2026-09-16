/**
 * Model tiering — ADR-013, extended for local providers by ADR-022.
 *
 * One file, so the largest controllable cost line is a one-line change (COSTS.md §5).
 * Prices are the Anthropic first-party rates recorded in COSTS.md §0 and are used to compute
 * per-call cost for the LlmCall telemetry, which is what makes ADR-013 revisitable with data
 * rather than with a guess.
 *
 * EVERY model name is resolved from the environment AT CALL TIME, not at module load. Reading
 * `process.env` into a module-level const bakes in whatever was set when the module was first
 * imported, which silently ignores a late-loaded `.env.local` and makes the value untestable.
 */

import { configuredProviderFor } from './providerNames';

export type Lane = 'hot' | 'cold' | 'session';

export type ModelSpec = {
  id: string;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cached-read input tokens (0.1x input). */
  cachedInputPerMTok: number;
};

export const MODELS: Record<string, ModelSpec> = {
  'claude-opus-5': { id: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 },
  'claude-sonnet-5': { id: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  'claude-haiku-4-5': { id: 'claude-haiku-4-5', inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 },
};

/**
 * Built-in defaults when nothing is configured.
 *
 * Anthropic is tiered deliberately (ADR-013): Opus where conversational judgement is most
 * visible, Haiku on the high-volume cold lane. Ollama defaults to one model everywhere because
 * a local setup usually has one model pulled.
 */
export const DEFAULT_ANTHROPIC_MODELS: Record<Lane, string> = {
  hot: 'claude-opus-5',
  cold: 'claude-haiku-4-5',
  session: 'claude-opus-5',
};

/**
 * The default local model. A 3B, ~2GB download that answers a conversation turn in ~650ms warm.
 *
 * It is deliberately small. The reason to reach for a bigger local model used to be the
 * analyzer, and ADR-025 measured that and rejected it — no local model we tried is safe on the
 * cold lane, so the extra weight buys nothing the product uses. Anyone who wants a larger model
 * sets ENGCOACH_OLLAMA_MODEL.
 */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b';

export const DEFAULT_OLLAMA_MODELS: Record<Lane, string> = {
  hot: DEFAULT_OLLAMA_MODEL,
  cold: DEFAULT_OLLAMA_MODEL,
  session: DEFAULT_OLLAMA_MODEL,
};

/**
 * Read an env var, treating blank as unset.
 *
 * `.env` files routinely contain `FOO=` for "I left this empty", and an empty string is not a
 * model name — without this a blank line silently overrides the default with "".
 */
function env(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether this lane is served by a local model, for naming purposes only.
 *
 * Uses the SAME validated lookup as `providers.ts` (ADR-023). Re-reading the environment here
 * is what let the two modules disagree: an invalid `ENGCOACH_PROVIDER_COLD` was ignored by the
 * router (correctly falling back to the global setting) but treated as "not ollama" here, so the
 * lane routed to Ollama while asking it for a Claude model.
 *
 * 'anthropic' and 'scripted' both use the hosted model names — the scripted stand-in prefixes
 * them at the call site — so only 'ollama' needs distinguishing.
 */
function isLocalLane(lane: Lane): boolean {
  return configuredProviderFor(lane) === 'ollama';
}

/**
 * The model name for a lane, most specific setting wins:
 *
 *   Ollama lanes:     ENGCOACH_OLLAMA_MODEL_<LANE>  →  ENGCOACH_OLLAMA_MODEL  →  default
 *   Anthropic lanes:  ENGCOACH_MODEL_<LANE>         →  ENGCOACH_MODEL         →  tiered default
 *
 * The single-variable forms exist because most people want one model everywhere; the per-lane
 * forms exist because the lanes have genuinely different needs (ADR-022).
 *
 * Note that setting `ENGCOACH_MODEL` flattens the Anthropic tiering in ADR-013 — that is a
 * legitimate choice, just an explicit one.
 */
export function modelFor(lane: Lane): string {
  if (isLocalLane(lane)) {
    return (
      env(`ENGCOACH_OLLAMA_MODEL_${lane.toUpperCase()}`) ??
      env('ENGCOACH_OLLAMA_MODEL') ??
      DEFAULT_OLLAMA_MODELS[lane]
    );
  }

  return (
    env(`ENGCOACH_MODEL_${lane.toUpperCase()}`) ??
    env('ENGCOACH_MODEL') ??
    DEFAULT_ANTHROPIC_MODELS[lane]
  );
}

/** Every lane's resolved model, for the config endpoint and the dev helper. */
export function modelSummary(): Record<Lane, string> {
  return { hot: modelFor('hot'), cold: modelFor('cold'), session: modelFor('session') };
}

export function specFor(modelId: string): ModelSpec {
  return (
    MODELS[modelId] ?? {
      id: modelId,
      inputPerMTok: 0,
      outputPerMTok: 0,
      cachedInputPerMTok: 0,
    }
  );
}

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/**
 * Cost of one call in USD.
 *
 * An unpriced model — any local one — returns 0 rather than inventing a rate, which is
 * accurate: local inference has no marginal cost.
 */
export function costOf(modelId: string, usage: Usage): number {
  const spec = specFor(modelId);
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (fresh * spec.inputPerMTok) / 1_000_000 +
    (usage.cachedInputTokens * spec.cachedInputPerMTok) / 1_000_000 +
    (usage.outputTokens * spec.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Hard daily spend cap — COSTS.md §6 lever 7.
 * A runaway loop can spend a month's budget in an hour; this is the cheap insurance.
 * Read at call time for the same reason the model names are.
 */
export function dailySpendCapUsd(): number {
  return Number.parseFloat(env('ENGCOACH_DAILY_SPEND_CAP_USD') ?? '5.00');
}
