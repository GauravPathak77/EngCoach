/**
 * Provider names and the configured-provider lookup — ADR-023.
 *
 * This module exists so that `providers.ts` (which decides *routing*) and `models.ts` (which
 * decides *model names*) cannot disagree about what the environment says. They previously each
 * read `ENGCOACH_PROVIDER_*` themselves, and only one of them validated the value — so an
 * invalid per-lane setting routed a lane to Ollama while asking it for a Claude model.
 *
 * No imports, so both modules can depend on it without a cycle.
 */

export const PROVIDERS = ['anthropic', 'ollama', 'scripted'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export type LaneName = 'hot' | 'cold' | 'session';

/**
 * The provider the user explicitly configured for a lane, or undefined if they configured
 * nothing valid. Per-lane setting wins over the global one; anything unrecognised is ignored
 * rather than trusted.
 *
 * Callers apply their own default: routing falls back to Anthropic-or-scripted, model naming
 * only cares whether the answer is 'ollama'.
 */
export function configuredProviderFor(lane: LaneName): ProviderName | undefined {
  const perLane = process.env[`ENGCOACH_PROVIDER_${lane.toUpperCase()}`];
  if (isProviderName(perLane)) return perLane;

  const global = process.env.ENGCOACH_LLM_PROVIDER;
  if (isProviderName(global)) return global;

  return undefined;
}
