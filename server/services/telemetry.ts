/**
 * LLM and TTS telemetry — DATA_MODEL.md § LlmCall, COSTS.md §6 lever 7.
 *
 * Not optional. Two things depend on it:
 *   1. `cachedInputTokens` sustained at zero is a caching BUG, not a cost detail — it means the
 *      prompt prefix is being invalidated and the hot lane is costing 3-4x what it should.
 *   2. The daily spend cap needs a running total. A runaway loop can spend a month's budget in
 *      an hour, and this is the cheap insurance against that.
 */

import { and, gte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { llmCalls, ttsCalls } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { newId } from '@/lib/ids';
import { dailySpendCapUsd } from '@/lib/llm/models';
import type { Lane } from '@/lib/llm/models';

export type LlmCallRecord = {
  userId: string;
  sessionId: string | null;
  lane: Lane;
  modelId: string;
  promptVersion: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  latencyMs: number;
  costUsd: number;
  isLive: boolean;
  error?: string | null;
};

export async function recordLlmCall(record: LlmCallRecord): Promise<string> {
  const id = newId();
  await getDb()
    .insert(llmCalls)
    .values({
      id,
      userId: record.userId,
      sessionId: record.sessionId,
      lane: record.lane,
      modelId: record.modelId,
      promptVersion: record.promptVersion,
      inputTokens: record.usage.inputTokens,
      cachedInputTokens: record.usage.cachedInputTokens,
      outputTokens: record.usage.outputTokens,
      latencyMs: record.latencyMs,
      costUsd: record.costUsd,
      isLive: record.isLive,
      error: record.error ?? null,
    });
  return id;
}

export async function recordTtsCall(record: {
  userId: string;
  sessionId: string | null;
  provider: string;
  voice: string;
  characters: number;
  latencyMs: number;
  cached: boolean;
}): Promise<void> {
  await getDb()
    .insert(ttsCalls)
    .values({ id: newId(), ...record });
}

/** Total spend today, used by the cap check. */
export async function spendToday(userId: string): Promise<number> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const rows = await getDb()
    .select({ total: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)` })
    .from(llmCalls)
    .where(and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, since)));

  return Number(rows[0]?.total ?? 0);
}

export class SpendCapExceededError extends Error {
  constructor(
    readonly spent: number,
    readonly cap: number,
  ) {
    super(
      `Daily spend cap reached ($${spent.toFixed(2)} of $${cap.toFixed(2)}). ` +
        'Raise ENGCOACH_DAILY_SPEND_CAP_USD to continue.',
    );
    this.name = 'SpendCapExceededError';
  }
}

/**
 * Call before any billable lane. Degrades gracefully rather than silently overspending.
 *
 * Local lanes cost nothing, so their LlmCall rows carry costUsd 0 and never move the total —
 * a fully local setup simply never trips this (ADR-022).
 */
export async function assertUnderSpendCap(userId: string): Promise<void> {
  const cap = dailySpendCapUsd();
  if (!Number.isFinite(cap) || cap <= 0) return;
  const spent = await spendToday(userId);
  if (spent >= cap) throw new SpendCapExceededError(spent, cap);
}

export type SessionCostSummary = {
  llmCostUsd: number;
  ttsCharacters: number;
  calls: number;
  cacheHitRatio: number | null;
};

export async function sessionCost(sessionId: string): Promise<SessionCostSummary> {
  const db = getDb();
  const llm = await db
    .select({
      cost: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)`,
      calls: sql<number>`count(*)`,
      input: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${llmCalls.cachedInputTokens}), 0)`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.sessionId, sessionId));

  const tts = await db
    .select({ characters: sql<number>`coalesce(sum(${ttsCalls.characters}), 0)` })
    .from(ttsCalls)
    .where(eq(ttsCalls.sessionId, sessionId));

  const input = Number(llm[0]?.input ?? 0);
  const cachedTokens = Number(llm[0]?.cachedTokens ?? 0);

  return {
    llmCostUsd: Number(llm[0]?.cost ?? 0),
    ttsCharacters: Number(tts[0]?.characters ?? 0),
    calls: Number(llm[0]?.calls ?? 0),
    cacheHitRatio: input > 0 ? cachedTokens / input : null,
  };
}
