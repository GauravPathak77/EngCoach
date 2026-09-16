/**
 * End-to-end service flow against a real (embedded) Postgres.
 *
 * This exercises the actual persistence layer, not mocks: session start -> user turns ->
 * cold-lane analysis -> policy decisions -> profile recomputation -> report -> deletion.
 *
 * Runs on PGlite in memory, so it is hermetic and needs no credentials. The LLM is the scripted
 * provider — which means this proves the PLUMBING, not the analyzer quality. Analyzer quality is
 * the eval harness's job and it says so loudly.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

process.env.ENGCOACH_IN_MEMORY_DB = '1';
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import('@/db/client');
const { ensureSchema } = await import('@/db/migrate');
const schema = await import('@/db/schema');
const { newId } = await import('@/lib/ids');
const { DEFAULT_SETTINGS } = await import('@/server/auth');
const sessionService = await import('@/server/services/sessionService');
const turnService = await import('@/server/services/turnService');
const analysisService = await import('@/server/services/analysisService');
const profileService = await import('@/server/services/profileService');
const vocabService = await import('@/server/services/vocabService');
const reportService = await import('@/server/services/reportService');
const policyState = await import('@/server/services/policyState');
const purgeJob = await import('@/server/jobs/audioPurgeJob');
const { USER_SCOPED_TABLES } = await import('@/lib/privacy/retention');

import type { AuthUser } from '@/server/auth';
import type { Word } from '@/lib/types';

let user: AuthUser;

/** Realistic word timings so the metrics layer has something true to compute from. */
function speak(text: string, confidence = 0.95): { words: Word[]; durationMs: number } {
  const tokens = text.split(/\s+/);
  const words: Word[] = tokens.map((w, i) => ({
    w,
    s: i * 0.35,
    e: i * 0.35 + 0.3,
    c: confidence,
  }));
  return { words, durationMs: Math.round(tokens.length * 350) };
}

async function createUser(): Promise<AuthUser> {
  const id = newId();
  const email = `${id}@example.test`;
  await getDb().insert(schema.users).values({
    id,
    email,
    passwordHash: 'scrypt$00$00',
    settings: DEFAULT_SETTINGS,
    goals: ['work meetings'],
    interests: ['cricket'],
    nativeLanguage: 'Hindi',
    selfReportedLevel: 'B2',
    onboardedAt: new Date(),
  });
  await getDb().insert(schema.learningProfiles).values({ userId: id }).onConflictDoNothing();

  return {
    id,
    email,
    displayName: null,
    nativeLanguage: 'Hindi',
    selfReportedLevel: 'B2',
    goals: ['work meetings'],
    interests: ['cricket'],
    settings: DEFAULT_SETTINGS,
    onboardedAt: new Date(),
  };
}

beforeAll(async () => {
  await ensureSchema(true);
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  user = await createUser();
});

// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  it('starts a session and freezes the learner snapshot on it', async () => {
    const started = await sessionService.startSession(user, 'casual');

    expect(started.id).toBeTruthy();
    expect(started.snapshotText).toContain('Learner notes');

    // ADR-007: the exact long-term memory the model saw is stored, which makes any past
    // session reproducible and debuggable.
    const stored = await sessionService.getSession(started.id, user.id);
    expect(stored?.snapshotText).toBe(started.snapshotText);
  });

  it('has no focus skill on a first session — no evidence, nothing to target', async () => {
    const started = await sessionService.startSession(user, 'casual');
    expect(started.focus.primary).toBeNull();
    expect(started.snapshotText).toContain('first session');
  });

  it('scopes sessions to their owner', async () => {
    const started = await sessionService.startSession(user, 'casual');
    const other = await createUser();
    expect(await sessionService.getSession(started.id, other.id)).toBeNull();
  });
});

describe('a full turn', () => {
  it('persists the turn, the speech segment, and its metrics', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);
    const { words, durationMs } = speak('I have went to the market yesterday and bought clothes');

    const { turnId } = await turnService.recordUserTurn(user, record!, {
      text: 'I have went to the market yesterday and bought clothes',
      words,
      durationMs,
      meanConfidence: 0.95,
      snrEstimate: 0.9,
      timingsReliable: true,
      sttProvider: 'test',
      sttModel: 'test',
      audioKey: null,
      responseLatencyMs: 620,
    });

    const db = getDb();
    const segments = await db
      .select()
      .from(schema.speechSegments)
      .where(eq(schema.speechSegments.turnId, turnId));
    expect(segments).toHaveLength(1);
    expect(segments[0]?.words.length).toBe(words.length);

    const metrics = await db
      .select()
      .from(schema.utteranceMetrics)
      .where(eq(schema.utteranceMetrics.turnId, turnId));
    expect(metrics[0]?.wordCount).toBe(10);
    expect(metrics[0]?.responseLatencyMs).toBe(620);
    expect(metrics[0]?.speechRate).toBeGreaterThan(0);
  });

  it('sets an audio purge deadline 24 hours out (ADR-015)', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);
    const { words, durationMs } = speak('Hello there my friend');
    const now = new Date('2026-08-22T10:00:00Z');

    const { turnId } = await turnService.recordUserTurn(
      user,
      record!,
      {
        text: 'Hello there my friend',
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: 'some/key.webm',
        responseLatencyMs: null,
      },
      now,
    );

    const segments = await getDb()
      .select()
      .from(schema.speechSegments)
      .where(eq(schema.speechSegments.turnId, turnId));

    const deadline = segments[0]?.audioPurgeAfter;
    expect(deadline).toBeTruthy();
    expect(new Date(deadline!).getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('the cold lane', () => {
  async function runTurns(sessionId: string, texts: string[]): Promise<void> {
    const record = await sessionService.getSession(sessionId, user.id);
    for (const text of texts) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }
  }

  it('batches: it does not analyse until enough turns have accumulated', async () => {
    const session = await sessionService.startSession(user, 'casual');
    await runTurns(session.id, ['I have went there', 'It was good']);

    const result = await analysisService.runColdLane(user.id, session.id);
    expect(result.skipped).toContain('batching');
    expect(result.analysedTurns).toBe(0);
  });

  it('analyses once the batch fills, and records provenance on every row', async () => {
    const session = await sessionService.startSession(user, 'casual');
    await runTurns(session.id, [
      'I have went to the market yesterday',
      'We need to discuss about the budget',
      'I need more informations about it',
      'Can you make a photo of this',
    ]);

    const result = await analysisService.runColdLane(user.id, session.id);
    expect(result.analysedTurns).toBe(4);
    expect(result.findingsRecorded).toBeGreaterThan(0);

    const findings = await getDb()
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.sessionId, session.id));

    // CLAUDE.md invariant 4 — every persisted analysis record carries prompt and model.
    for (const finding of findings) {
      expect(finding.promptVersion).toContain('error-analyzer@');
      expect(finding.modelId).toBeTruthy();
      expect(finding.asrConfidence).toBeGreaterThan(0);
      expect(finding.combinedConfidence).toBeGreaterThan(0);
    }
  });

  it('records structure observations — the denominator', async () => {
    const session = await sessionService.startSession(user, 'casual');
    await runTurns(session.id, [
      'I have went to the market',
      'Yesterday I went to the shop',
      'I bought some bread there',
      'It was a good day overall',
    ]);
    await analysisService.runColdLane(user.id, session.id);

    const observations = await getDb()
      .select()
      .from(schema.structureObservations)
      .where(eq(schema.structureObservations.sessionId, session.id));

    expect(observations.length).toBeGreaterThan(0);
    // AI_BEHAVIOR.md §2.1: correct productions matter as much as errors.
    expect(observations.some((o) => o.correct)).toBe(true);
  });

  it('suppresses asr-suspect findings at persistence time, not merely at display time', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    // Low per-word confidence on an asr-prone rule: we may simply have misheard.
    for (const text of [
      'I have went to the market yesterday',
      'We need to discuss about the budget',
      'I need more informations about it',
      'Can you make a photo of this',
    ]) {
      const { words, durationMs } = speak(text, 0.4);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.4,
        snrEstimate: 0.5,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }

    await analysisService.runColdLane(user.id, session.id);

    const findings = await getDb()
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.sessionId, session.id));

    const asrProneRules = findings.filter((f) => f.ruleTag.startsWith('grammar.tense.past_simple'));
    for (const finding of asrProneRules) {
      expect(finding.isAsrSuspect).toBe(true);
      expect(finding.status).toBe('suppressed');
    }
  });
});

describe('evidence and the profile', () => {
  it('refuses to grade a skill from one session, however much evidence', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (let i = 0; i < 6; i++) {
      const text = 'Yesterday I went to the market and bought some fresh bread';
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }

    await analysisService.runColdLane(user.id, session.id, { force: true });
    const estimates = await profileService.recomputeSkills(user.id);

    // ADR-010: a single conversation cannot produce a verdict, structurally.
    for (const estimate of estimates.filter((e) => e.skill.startsWith('grammar.'))) {
      expect(estimate.confidence).toBe('insufficient');
    }
  });

  it('reports the denominator alongside the errors', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'I have went to the market yesterday',
      'Yesterday I went to the shop and bought bread',
      'I have went there again this morning',
      'It was good and I came home early',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }
    await analysisService.runColdLane(user.id, session.id, { force: true });

    const accuracies = await profileService.ruleAccuracies(user.id);
    const pastTense = accuracies.find((a) => a.ruleTag === 'grammar.tense.past_simple.irregular');

    expect(pastTense).toBeTruthy();
    // "2 errors out of 3 opportunities" and "2 out of 30" are different facts.
    expect(pastTense!.obligatoryContexts).toBeGreaterThan(0);
  });

  it('removes disputed findings from the evidence — the user is allowed to be right', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'I need more informations about it',
      'She gave me many advices today',
      'I have went there yesterday',
      'It was a good day overall',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }
    await analysisService.runColdLane(user.id, session.id, { force: true });

    const countable = await getDb()
      .select()
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.userId, user.id),
          eq(schema.findings.ruleTag, 'grammar.countability'),
        ),
      );

    expect(countable.length).toBeGreaterThanOrEqual(2);

    const before = await profileService.ruleAccuracies(user.id);
    const beforeErrors =
      before.find((a) => a.ruleTag === 'grammar.countability')?.errors ?? 0;

    await policyState.disputeFinding(user.id, countable[0]!.id);

    const after = await profileService.ruleAccuracies(user.id);
    const afterErrors = after.find((a) => a.ruleTag === 'grammar.countability')?.errors ?? 0;
    expect(afterErrors).toBe(beforeErrors - 1);
  });

  it('adds a rule to the persistent suppression list after two disputes', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'I need more informations about it',
      'She gave me many advices today',
      'I have many informations here',
      'It was a good day overall',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }
    await analysisService.runColdLane(user.id, session.id, { force: true });

    const countable = await getDb()
      .select()
      .from(schema.findings)
      .where(
        and(eq(schema.findings.userId, user.id), eq(schema.findings.ruleTag, 'grammar.countability')),
      );

    await policyState.disputeFinding(user.id, countable[0]!.id);
    await policyState.disputeFinding(user.id, countable[1]!.id);

    const suppressed = await profileService.getSuppressedRuleTags(user.id);
    expect(suppressed).toContain('grammar.countability');
  });
});

describe('vocabulary', () => {
  it('introduces at most three items per session and anchors each to real speech', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'It was a good day and the food was good',
      'The place was very nice and very big',
      'It was a nice thing to do',
      'I had a good time with good people',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }

    const result = await analysisService.runColdLane(user.id, session.id, { force: true });
    expect(result.vocabIntroduced).toBeLessThanOrEqual(3);

    const rows = await vocabService.getVocabRows(user.id);
    for (const row of rows) {
      // AI_BEHAVIOR.md §5.4 — an item without the user's own sentence is a flashcard.
      expect(row.anchorUtterance.length).toBeGreaterThan(0);
      expect(row.state).toBe('introduced');
    }
  });

  it('advances an item to spontaneous use when the learner produces it unprompted', async () => {
    const session = await sessionService.startSession(user, 'casual');

    const itemId = newId();
    await getDb().insert(schema.vocabularyItems).values({
      id: itemId,
      lemma: 'haggle',
      sense: 'negotiate',
      definition: 'to argue over a price',
      register: 'conversational',
      cefrLevel: 'B2',
      examples: ['We haggled over the price.'],
    });
    await getDb().insert(schema.userVocabStates).values({
      userId: user.id,
      itemId,
      state: 'introduced',
      anchorUtterance: 'I tried to make the price lower',
      srsIntervalDays: 1,
      srsDueAt: new Date(Date.now() - 1000),
    });

    const record = await sessionService.getSession(session.id, user.id);
    const text = 'I had to haggle with the seller for ten minutes';
    const { words, durationMs } = speak(text);

    await turnService.recordUserTurn(user, record!, {
      text,
      words,
      durationMs,
      meanConfidence: 0.95,
      snrEstimate: 0.9,
      timingsReliable: true,
      sttProvider: 'test',
      sttModel: 'test',
      audioKey: null,
      responseLatencyMs: 500,
    });

    const rows = await vocabService.getVocabRows(user.id);
    const haggle = rows.find((r) => r.lemma === 'haggle');
    expect(haggle?.state).toBe('used_spontaneous');
    expect(haggle?.spontaneousUses).toBe(1);
  });
});

describe('the session report', () => {
  it('builds a report with at most three fixes and stores it', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'I have went to the market yesterday',
      'We need to discuss about the budget',
      'I need more informations about it',
      'Can you make a photo of this',
      'It depends of the weather tomorrow',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }

    await sessionService.endSession(session.id, user.id);
    const ended = await sessionService.getSession(session.id, user.id);
    const report = await reportService.generateReport(user, ended!);

    // UX.md §2: three is what a person can hold.
    expect(report.topFixes.length).toBeLessThanOrEqual(3);
    expect(report.oneThingThatWentWell.length).toBeGreaterThan(0);
    expect(report.metrics.wordCount).toBeGreaterThan(0);

    // Every fix quotes the learner's own words and links back to a real finding row so the
    // dispute affordance works.
    for (const fix of report.topFixes) {
      expect(fix.youSaid.length).toBeGreaterThan(0);
      expect(fix.findingId).toBeTruthy();
    }

    const reloaded = await reportService.loadReport(session.id, user.id);
    expect(reloaded?.topFixes.length).toBe(report.topFixes.length);
  });

  it('handles a clean session without inventing a fix to reach three', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'Yesterday I went to the market and bought some bread',
      'The weather was lovely so we walked home',
      'I have been meaning to visit that place for ages',
      'It turned out much better than I expected',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }

    await sessionService.endSession(session.id, user.id);
    const ended = await sessionService.getSession(session.id, user.id);
    const report = await reportService.generateReport(user, ended!);

    expect(report.topFixes).toHaveLength(0);
    expect(report.oneThingThatWentWell.length).toBeGreaterThan(0);
  });
});

describe('privacy', () => {
  it('purges expired audio but keeps the word timings', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);
    const { words, durationMs } = speak('Hello there my friend how are you');

    const { turnId } = await turnService.recordUserTurn(
      user,
      record!,
      {
        text: 'Hello there my friend how are you',
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: `${user.id}/test.webm`,
        responseLatencyMs: null,
      },
      new Date('2026-08-22T10:00:00Z'),
    );

    // 25 hours later.
    await purgeJob.runPurge(new Date('2026-08-23T11:00:00Z'));

    const segments = await getDb()
      .select()
      .from(schema.speechSegments)
      .where(eq(schema.speechSegments.turnId, turnId));

    expect(segments[0]?.audioKey).toBeNull();
    // ADR-015: the row survives and carries 100% of the analytical value.
    expect(segments[0]?.words.length).toBe(words.length);
  });

  it('spares pinned clips', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);
    const { words, durationMs } = speak('Keep this one please');

    const { turnId } = await turnService.recordUserTurn(
      user,
      record!,
      {
        text: 'Keep this one please',
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: `${user.id}/pinned.webm`,
        responseLatencyMs: null,
      },
      new Date('2026-08-22T10:00:00Z'),
    );

    await getDb()
      .update(schema.speechSegments)
      .set({ pinned: true })
      .where(eq(schema.speechSegments.turnId, turnId));

    await purgeJob.runPurge(new Date('2026-08-25T11:00:00Z'));

    const segments = await getDb()
      .select()
      .from(schema.speechSegments)
      .where(eq(schema.speechSegments.turnId, turnId));
    expect(segments[0]?.audioKey).not.toBeNull();
  });

  it('deletes everything, leaving no row in any user-scoped table', async () => {
    const session = await sessionService.startSession(user, 'casual');
    const record = await sessionService.getSession(session.id, user.id);

    for (const text of [
      'I have went to the market yesterday',
      'I need more informations about it',
      'It was a good day and a good evening',
      'We should discuss about the plan',
    ]) {
      const { words, durationMs } = speak(text);
      await turnService.recordUserTurn(user, record!, {
        text,
        words,
        durationMs,
        meanConfidence: 0.95,
        snrEstimate: 0.9,
        timingsReliable: true,
        sttProvider: 'test',
        sttModel: 'test',
        audioKey: null,
        responseLatencyMs: 500,
      });
    }
    await analysisService.runColdLane(user.id, session.id, { force: true });
    await sessionService.endSession(session.id, user.id);
    await profileService.recomputeSkills(user.id);

    await purgeJob.deleteAllUserData(user.id);

    // ARCHITECTURE.md §6: no soft delete, no tombstones. Assert against the enumerated list so
    // adding a table without adding it to the deletion path is a visible failure.
    for (const table of USER_SCOPED_TABLES) {
      // `users` keys the owner on `id`; every other table on `user_id`.
      const column = table === 'users' ? 'id' : 'user_id';
      const rows = await getDb().execute(
        sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = '${user.id}'`),
      );
      const count = Number((rows.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
      expect(count, `${table} still has rows after deletion`).toBe(0);
    }
  });
});

describe('spend cap', () => {
  it('blocks a lane once the daily cap is reached', async () => {
    const { assertUnderSpendCap, SpendCapExceededError } = await import(
      '@/server/services/telemetry'
    );

    await getDb().insert(schema.llmCalls).values({
      id: newId(),
      userId: user.id,
      sessionId: null,
      lane: 'hot',
      modelId: 'claude-opus-5',
      promptVersion: 'x@1',
      costUsd: 999,
      isLive: true,
    });

    await expect(assertUnderSpendCap(user.id)).rejects.toBeInstanceOf(SpendCapExceededError);
  });
});
