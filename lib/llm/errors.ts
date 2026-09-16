/**
 * LLM transport error.
 *
 * Extracted from `client.ts` so the provider adapters can throw it without importing the client
 * that imports them — the architecture guard catches that cycle (ADR-014), and it is the same
 * split that `types.ts` exists for.
 *
 * `LlmError` remains the exported name from `client.ts`; this class is that class.
 */
export class LlmErrorShape extends Error {
  readonly retryable: boolean;
  readonly detail: unknown;

  constructor(message: string, retryable: boolean, detail?: unknown) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.detail = detail;
  }
}
