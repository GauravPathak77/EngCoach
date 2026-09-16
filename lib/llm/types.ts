/**
 * Shared LLM transport types.
 *
 * Extracted from client.ts so the scripted provider can reference the request/result shapes
 * without importing the client that imports it. The architecture guard caught the cycle
 * (ADR-014) — a type-only cycle is harmless at runtime but it is exactly the kind of edge that
 * grows into a real one.
 */

import type { Lane, Usage } from './models';

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

export type CompletionRequest = {
  lane: Lane;
  /** Cache-stable prefix. Order matters: see ARCHITECTURE.md §5.2. */
  system: Array<{ text: string; cacheable: boolean }>;
  messages: LlmMessage[];
  maxTokens: number;
  /** When present the call is schema-constrained (CLAUDE.md invariant 3). */
  schema?: { name: string; description: string; jsonSchema: unknown };
  /** Identifier of the prompt that produced this call, persisted for provenance. */
  promptVersion: string;
};

export type CompletionResult<T = string> = {
  content: T;
  raw: string;
  modelId: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  /** False when the scripted development provider produced this. Never hide it. */
  isLive: boolean;
};

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; result: CompletionResult<string> }
  | { type: 'error'; message: string };
