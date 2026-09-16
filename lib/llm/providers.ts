/**
 * LLM provider selection — ADR-022.
 *
 * PURE-ish: configuration and dispatch only, no network. The adapters live in `anthropic.ts`,
 * `ollama.ts` and `scripted.ts`, and `client.ts` is still the single public entry point
 * (CLAUDE.md invariant 2).
 *
 * Provider is chosen PER LANE, because the right answer genuinely differs by lane:
 *
 *   hot lane     highest call volume, so the biggest cost saving from going local — but it is
 *                the latency-critical one (<2s to first audio), so a slow local model is felt
 *                immediately, in the one place the product cannot afford it.
 *
 *   cold lane    low volume, latency irrelevant, so almost nothing to save — but it is where a
 *                weak model does real DAMAGE. Analyzer precision is the product's central
 *                safety property (RISKS.md R2). Never move this to a model you have not run
 *                through `npm run eval:analyzers`.
 *
 *   session lane one call per session. Quality is visible in the report; cost is negligible.
 *
 * The upshot: hot-lane-local is the sensible first experiment. Cold-lane-local is gated on
 * evidence, not on preference.
 */

import type { Lane } from './models';
import { configuredProviderFor, type ProviderName } from './providerNames';

// Re-exported so existing importers do not need to know the names moved (ADR-023).
export { PROVIDERS, isProviderName } from './providerNames';
export type { ProviderName } from './providerNames';

/** Ollama's local server. Nothing leaves the machine. */
export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

export function hasAnthropicCredentials(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * Resolve the provider for a lane.
 *
 * Explicit per-lane env wins; then the global override; then: Anthropic if a key exists,
 * otherwise the scripted stand-in. Ollama is never selected implicitly — a local server being
 * up is not consent to route the product through it.
 */
export function providerFor(lane: Lane): ProviderName {
  return (
    configuredProviderFor(lane) ?? (hasAnthropicCredentials() ? 'anthropic' : 'scripted')
  );
}

/** True when every lane is served by something that is not the scripted stand-in. */
export function isLiveConfiguration(): boolean {
  return (['hot', 'cold', 'session'] as Lane[]).every((lane) => providerFor(lane) !== 'scripted');
}

/** Human-readable summary for the settings page and the session banner. */
export function providerSummary(): Record<Lane, ProviderName> {
  return {
    hot: providerFor('hot'),
    cold: providerFor('cold'),
    session: providerFor('session'),
  };
}
