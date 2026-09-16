/**
 * API error shaping — the "no raw stack traces" requirement.
 *
 * Every failure the user can hit (mic denied, STT down, model down, network gone, database
 * unavailable) resolves to a short, plain-English message plus a machine-readable code the UI
 * uses to choose an inline recovery affordance. A voice conversation that dies with "500" is
 * worse than a page that fails to load — the user has just spent effort speaking.
 */

import { LlmError } from '@/lib/llm/client';
import { SttError } from '@/lib/voice/stt/provider';
import { TtsError } from '@/lib/voice/tts/provider';
import { UnauthorizedError } from '@/server/auth';
import { SpendCapExceededError } from '@/server/services/telemetry';

export type ApiErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'stt_failed'
  | 'llm_failed'
  | 'tts_failed'
  | 'spend_cap'
  | 'database'
  | 'internal';

export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; retryable: boolean };
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError('bad_request', message, 400);
}

export function notFound(message = 'Not found'): ApiError {
  return new ApiError('not_found', message, 404);
}

/** Map any thrown value onto a user-facing message. Never leak an internal message verbatim. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof UnauthorizedError) {
    return new ApiError('unauthorized', 'Please sign in again.', 401);
  }

  if (error instanceof SpendCapExceededError) {
    return new ApiError('spend_cap', error.message, 429);
  }

  if (error instanceof SttError) {
    return new ApiError(
      'stt_failed',
      error.retryable
        ? "I couldn't hear that clearly — try saying it again."
        : "Speech recognition isn't available right now.",
      502,
      error.retryable,
    );
  }

  if (error instanceof TtsError) {
    return new ApiError(
      'tts_failed',
      "I couldn't speak that out loud, but you can read my reply below.",
      502,
      error.retryable,
    );
  }

  if (error instanceof LlmError) {
    return new ApiError(
      'llm_failed',
      error.retryable
        ? 'The coach took too long to respond. Try again in a moment.'
        : 'The coach had trouble responding just then.',
      502,
      error.retryable,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/database|connection|ECONNREFUSED|relation .* does not exist/i.test(message)) {
    return new ApiError(
      'database',
      'Could not reach the database. Check your setup and try again.',
      503,
      true,
    );
  }

  // Log the real thing server-side; hand the user something they can act on.
  console.error('[engcoach] unhandled error:', error);
  return new ApiError('internal', 'Something went wrong on our side.', 500, true);
}

export function errorResponse(error: unknown): Response {
  const api = toApiError(error);
  const body: ApiErrorBody = {
    error: { code: api.code, message: api.message, retryable: api.retryable },
  };
  return Response.json(body, { status: api.status });
}
