/**
 * The HOT LANE — ARCHITECTURE.md §2, ROADMAP.md M1/M2/M3.
 *
 * One LLM call per turn, streamed. Everything expensive (error analysis, vocabulary mining,
 * profile updates) happens in the cold lane, off the critical path, and never blocks the reply.
 *
 * Latency budget (ARCHITECTURE.md §1.3): user stop -> first audio p50 under 2.0s.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { findings, sessions, speechSegments, turns, utteranceMetrics } from '@/db/schema';
import { newId } from '@/lib/ids';
import { assembleConversationPrompt } from '@/lib/llm/assemble';
import { stream, type LlmMessage, type StreamEvent } from '@/lib/llm/client';
import { getMode } from '@/lib/modes/registry';
import { computeUtteranceMetrics } from '@/lib/metrics/fluency';
import { decide } from '@/lib/coaching/policy';
import { elicitationDirective, NO_DIRECTIVE } from '@/lib/coaching/directive';
import { detectEvents, matchesStopIntent, nextShortTurnCount } from '@/lib/coaching/frustration';
import { elicitationFor } from '@/lib/coaching/focus';
import { segmentIndex, SEGMENT_TURNS } from '@/lib/coaching/budgets';
import type {
  CandidateFinding,
  PolicyDecision,

  TurnDirective,
  UserSettings,
  Word,
} from '@/lib/types';
import type { AuthUser } from '@/server/auth';
import type { SessionRecord } from './sessionService';
import { nextTurnIndex } from './sessionService';
import { assertUnderSpendCap, recordLlmCall } from './telemetry';
import { recordProductions } from './vocabService';
import { persistFrustrationEvents, loadSessionState } from './policyState';

export type UserTurnInput = {
  text: string;
  words: Word[];
  durationMs: number;
  meanConfidence: number;
  snrEstimate: number | null;
  timingsReliable: boolean;
  sttProvider: string;
  sttModel: string;
  audioKey: string | null;
  /** Milliseconds between the coach finishing and the user starting. */
  responseLatencyMs: number | null;
};

export type TurnResult = {
  userTurnId: string;
  coachTurnId: string;
  coachText: string;
  directive: TurnDirective;
  decision: PolicyDecision | null;
  isLive: boolean;
};

/**
 * Persist the user's turn, compute its metrics, and decide the directive for the coach's reply.
 *
 * Note the ordering: metrics and the policy decision are computed from findings that the COLD
 * LANE produced for EARLIER turns. We never wait for analysis of the current turn — that is the
 * whole point of the lane split.
 */
export async function recordUserTurn(
  user: AuthUser,
  session: SessionRecord,
  input: UserTurnInput,
  now: Date = new Date(),
): Promise<{ turnId: string; directive: TurnDirective; decision: PolicyDecision }> {
  const db = getDb();
  const index = await nextTurnIndex(session.id);
  const turnId = newId();

  await db.insert(turns).values({
    id: turnId,
    sessionId: session.id,
    userId: user.id,
    index,
    role: 'user',
    text: input.text,
    createdAt: now,
  });

  // Audio retention: ADR-015. The purge job nulls audio_key after this instant unless pinned.
  const purgeAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await db.insert(speechSegments).values({
    id: newId(),
    turnId,
    userId: user.id,
    audioKey: input.audioKey,
    durationMs: input.durationMs,
    sttProvider: input.sttProvider,
    sttModel: input.sttModel,
    words: input.words,
    meanConfidence: input.meanConfidence,
    snrEstimate: input.snrEstimate,
    audioPurgeAfter: purgeAfter,
    transcribedAt: now,
  });

  const metrics = computeUtteranceMetrics(input.words, {
    responseLatencyMs: input.responseLatencyMs,
    timingsReliable: input.timingsReliable,
    fallbackDurationMs: input.durationMs,
  });

  await db.insert(utteranceMetrics).values({
    turnId,
    userId: user.id,
    sessionId: session.id,
    wordCount: metrics.wordCount,
    durationMs: metrics.durationMs,
    speechRate: metrics.speechRate,
    articulationRate: metrics.articulationRate,
    pauseCountMidclause: metrics.pauseCountMidclause,
    pauseCountBoundary: metrics.pauseCountBoundary,
    pauseMsTotal: metrics.pauseMsTotal,
    fillerCount: metrics.fillerCount,
    mlr: metrics.mlr,
    repairCount: metrics.repairCount,
    responseLatencyMs: metrics.responseLatencyMs,
  });

  // Vocabulary production check: did they use a word we are tracking, and was it prompted?
  const previousCoach = await db
    .select({ text: turns.text })
    .from(turns)
    .where(and(eq(turns.sessionId, session.id), eq(turns.role, 'coach')))
    .orderBy(desc(turns.index))
    .limit(1);

  await recordProductions(user.id, input.text, previousCoach[0]?.text ?? null, now);

  // --- The policy decision --------------------------------------------------
  const settings: UserSettings = {
    voiceCorrectionsEnabled: user.settings.voiceCorrectionsEnabled,
    drillsOptIn: user.settings.drillsOptIn,
    difficulty: user.settings.difficulty,
  };

  const state = await loadSessionState(user.id, session, index, {
    stopIntentRaised: matchesStopIntent(input.text),
    lastUserWordCount: metrics.wordCount,
  });

  // Candidates come from the cold lane's analysis of PREVIOUS turns that has not yet been
  // surfaced. This is what lets the coach react to a pattern without blocking on analysis.
  const pending = await pendingCandidates(session.id, user.id);

  const decision = decide({
    candidates: pending.candidates,
    words: pending.words,
    snrEstimate: input.snrEstimate,
    state,
    mode: getMode(session.mode),
    settings,
  });

  await applyDecision(session.id, decision, now);

  const events = detectEvents(state);
  if (events.length > 0) await persistFrustrationEvents(user.id, session.id, events);

  // No correction to make? Use the turn to engineer an obligatory context for the focus skill
  // instead — elicitation, not instruction (AI_BEHAVIOR.md §6.2).
  let directive = decision.turnDirective;
  if (directive.kind === 'none') {
    const elicitation = elicitationFor(session.primaryFocusRuleTag);
    if (elicitation && session.primaryFocusRuleTag) {
      directive = elicitationDirective(elicitation, session.primaryFocusRuleTag);
    }
  }

  return { turnId, directive, decision };
}

/**
 * Findings the cold lane has recorded but the policy engine has not yet surfaced.
 * Only findings from turns in the current segment are eligible, so a mistake from ten turns ago
 * does not surface out of context.
 */
async function pendingCandidates(
  sessionId: string,
  userId: string,
): Promise<{ candidates: CandidateFinding[]; words: Word[] }> {
  const db = getDb();

  const rows = await db
    .select({
      id: findings.id,
      utteranceId: findings.utteranceId,
      turnId: findings.turnId,
      type: findings.type,
      ruleTag: findings.ruleTag,
      wordStart: findings.wordStart,
      wordEnd: findings.wordEnd,
      originalSpanText: findings.originalSpanText,
      originalUtterance: findings.originalUtterance,
      suggestedSpanText: findings.suggestedSpanText,
      suggestedUtterance: findings.suggestedUtterance,
      explanationShort: findings.explanationShort,
      severity: findings.severity,
      llmConfidence: findings.llmConfidence,
    })
    .from(findings)
    .where(
      and(
        eq(findings.sessionId, sessionId),
        eq(findings.userId, userId),
        eq(findings.status, 'recorded'),
        sql`${findings.surfacedAt} is null`,
      ),
    )
    .orderBy(asc(findings.createdAt))
    .limit(12);

  if (rows.length === 0) return { candidates: [], words: [] };

  const firstTurnId = rows[0]?.turnId;
  const segment = firstTurnId
    ? await db
        .select({ words: speechSegments.words })
        .from(speechSegments)
        .where(eq(speechSegments.turnId, firstTurnId))
        .limit(1)
    : [];

  return {
    candidates: rows.map((r) => ({
      id: r.id,
      utteranceId: r.utteranceId,
      type: r.type as CandidateFinding['type'],
      ruleTag: r.ruleTag,
      span: { wordStart: r.wordStart, wordEnd: r.wordEnd },
      originalSpanText: r.originalSpanText,
      originalUtterance: r.originalUtterance,
      suggestedSpanText: r.suggestedSpanText,
      suggestedUtterance: r.suggestedUtterance,
      explanationShort: r.explanationShort,
      severity: r.severity as CandidateFinding['severity'],
      llmConfidence: r.llmConfidence,
    })),
    words: segment[0]?.words ?? [],
  };
}

/** Write the policy engine's status decisions back onto the finding rows. */
async function applyDecision(
  sessionId: string,
  decision: PolicyDecision,
  now: Date,
): Promise<void> {
  const db = getDb();

  for (const finding of [...decision.recorded, ...decision.suppressed]) {
    const surfaced = finding.status === 'shown_visual' || finding.status === 'spoken' || finding.status === 'drilled';
    await db
      .update(findings)
      .set({
        status: finding.status,
        policyReason: finding.reason,
        ...(surfaced ? { surfacedAt: now } : {}),
      })
      .where(and(eq(findings.id, finding.id), eq(findings.sessionId, sessionId)));
  }
}

/** Conversation history for the model, capped so the context does not grow without bound. */
export async function buildHistory(sessionId: string, limit = 24): Promise<LlmMessage[]> {
  const rows = await getDb()
    .select({ role: turns.role, text: turns.text })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(asc(turns.index));

  const recent = rows.slice(-limit);
  return recent.map((r) => ({
    role: r.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: r.text,
  }));
}

/**
 * Stream the coach's reply. Yields text deltas so the route can forward them over SSE and the
 * client can start synthesising the first sentence before generation finishes.
 */
export async function* streamCoachReply(
  user: AuthUser,
  session: SessionRecord,
  directive: TurnDirective,
  now: Date = new Date(),
): AsyncGenerator<StreamEvent & { coachTurnId?: string }> {
  await assertUnderSpendCap(user.id);

  const mode = getMode(session.mode);
  const history = await buildHistory(session.id);

  const prompt = assembleConversationPrompt({
    mode,
    snapshot: session.snapshotText,
    history,
    directive,
  });

  let text = '';

  for await (const event of stream({
    lane: 'hot',
    system: prompt.system,
    messages: prompt.messages,
    maxTokens: 400,
    promptVersion: prompt.promptVersion,
  })) {
    if (event.type === 'text') {
      text += event.delta;
      yield event;
    } else if (event.type === 'error') {
      yield event;
      return;
    } else {
      const index = await nextTurnIndex(session.id);
      const coachTurnId = newId();

      const llmCallId = await recordLlmCall({
        userId: user.id,
        sessionId: session.id,
        lane: 'hot',
        modelId: event.result.modelId,
        promptVersion: prompt.promptVersion,
        usage: event.result.usage,
        latencyMs: event.result.latencyMs,
        costUsd: event.result.costUsd,
        isLive: event.result.isLive,
      });

      await getDb().insert(turns).values({
        id: coachTurnId,
        sessionId: session.id,
        userId: user.id,
        index,
        role: 'coach',
        text,
        directive: directive.text,
        directiveKind: directive.kind,
        llmCallId,
        createdAt: now,
      });

      yield { ...event, coachTurnId };
    }
  }
}

/** The coach opens the conversation, so the user is not staring at silence. */
export async function* streamOpeningTurn(
  user: AuthUser,
  session: SessionRecord,
): AsyncGenerator<StreamEvent & { coachTurnId?: string }> {
  yield* streamCoachReply(user, session, NO_DIRECTIVE);
}

export { SEGMENT_TURNS, segmentIndex, nextShortTurnCount, sessions };
