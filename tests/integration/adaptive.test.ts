/**
 * The adaptive loop, end to end — ROADMAP.md M10.
 *
 *   Conversation → observation → evidence → weakness → targeted opportunity → practice
 *
 * The claim being tested is the product's central one: after enough evidence accumulates ACROSS
 * SESSIONS, the conversation starts steering toward contexts that force the weak structure —
 * without ever naming it.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

process.env.ENGCOACH_IN_MEMORY_DB = '1';
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import('@/db/client');
const { ensureSchema } = await import('@/db/migrate');
const schema = await import('@/db/schema');
const { newId } = await import('@/lib/ids');
const { DEFAULT_SETTINGS } = await import('@/server/auth');
const sessionService = await import('@/server/services/sessionService');
const profileService = await import('@/server/services/profileService');

import type { AuthUser } from '@/server/auth';

let user: AuthUser;

async function createUser(): Promise<AuthUser> {
  const id = newId();
  await getDb().insert(schema.users).values({
    id,
    email: `${id}@example.test`,
    passwordHash: 'scrypt$00$00',
    settings: DEFAULT_SETTINGS,
    goals: [],
    interests: [],
    onboardedAt: new Date(),
  });
  await getDb().insert(schema.learningProfiles).values({ userId: id }).onConflictDoNothing();
  return {
    id,
    email: `${id}@example.test`,
    displayName: null,
    nativeLanguage: 'Hindi',
    selfReportedLevel: 'B2',
    goals: [],
    interests: [],
    settings: DEFAULT_SETTINGS,
    onboardedAt: new Date(),
  };
}

/**
 * Seed a completed session's worth of evidence for a rule, directly. This stands in for many
 * real conversations without needing a model — the adaptive engine reads rows, not transcripts.
 */
async function seedEvidence(
  userId: string,
  ruleTag: string,
  options: { contexts: number; correct: number; avoided?: number; errors?: number },
): Promise<string> {
  const db = getDb();
  const sessionId = newId();

  await db.insert(schema.sessions).values({
    id: sessionId,
    userId,
    mode: 'casual',
    status: 'ended',
    startedAt: new Date(),
    endedAt: new Date(),
  });

  for (let i = 0; i < options.contexts; i++) {
    const correct = i < options.correct;
    const avoided = options.avoided !== undefined && i >= options.contexts - options.avoided;
    await db.insert(schema.structureObservations).values({
      id: newId(),
      userId,
      sessionId,
      utteranceId: `u${i}`,
      ruleTag,
      obligatoryContext: true,
      produced: !avoided,
      correct: correct && !avoided,
      promptVersion: 'test@1',
      modelId: 'test',
    });
  }

  for (let i = 0; i < (options.errors ?? 0); i++) {
    await db.insert(schema.findings).values({
      id: newId(),
      userId,
      sessionId,
      turnId: `t${i}`,
      utteranceId: `u${i}`,
      type: 'grammar',
      ruleTag,
      wordStart: 0,
      wordEnd: 1,
      originalSpanText: 'have went',
      originalUtterance: 'I have went there',
      suggestedSpanText: 'went',
      suggestedUtterance: 'I went there',
      explanationShort: 'Use went.',
      severity: 'notable',
      llmConfidence: 0.95,
      asrConfidence: 1,
      combinedConfidence: 0.95,
      isAsrSuspect: false,
      status: 'recorded',
      promptVersion: 'test@1',
      modelId: 'test',
    });
  }

  return sessionId;
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

describe('the loop closes', () => {
  const WEAK_RULE = 'grammar.tense.past_simple.irregular';

  it('does not target anything after ONE session, however bad it looked', async () => {
    await seedEvidence(user.id, WEAK_RULE, { contexts: 10, correct: 1, errors: 6 });

    const focus = await profileService.chooseFocus(user.id, new Date());
    // ADR-010 / AI_BEHAVIOR.md §6.2: one conversation is not evidence.
    expect(focus.primary).toBeNull();
  });

  it('targets the weak structure once evidence spans two sessions', async () => {
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 1, errors: 4 });
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 1, errors: 4 });

    const focus = await profileService.chooseFocus(user.id, new Date());
    expect(focus.primary).toBe(WEAK_RULE);
  });

  it('turns the focus into TOPIC STEERING in the snapshot, never into a grammar lecture', async () => {
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 1, errors: 4 });
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 1, errors: 4 });

    const started = await sessionService.startSession(user, 'casual');

    expect(started.focus.primary).toBe(WEAK_RULE);
    expect(started.snapshotText).toContain('Steer the conversation toward');
    // The learner must never see the machinery.
    expect(started.snapshotText).not.toContain('past_simple');
    expect(started.snapshotText).not.toContain('grammar.');
    expect(started.snapshotText).toContain('do NOT name any grammar point');
  });

  it('steers toward personal narrative for a past-tense weakness', async () => {
    // ROADMAP.md M10 definition of done.
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 1, errors: 4 });
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 1, errors: 4 });

    let steered = 0;
    for (let i = 0; i < 5; i++) {
      const started = await sessionService.startSession(user, 'casual');
      if (/weekend|trip|finished event|specific finished/i.test(started.snapshotText)) steered += 1;
      await sessionService.endSession(started.id, user.id);
    }
    expect(steered).toBeGreaterThanOrEqual(3);
  });

  it('ranks an AVOIDED structure above an equally-wrong one that is at least attempted', async () => {
    const avoidedRule = 'grammar.conditional.second';

    // Same mastery, but one is being dodged rather than attempted.
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 2, errors: 4 });
    await seedEvidence(user.id, WEAK_RULE, { contexts: 6, correct: 2, errors: 4 });
    await seedEvidence(user.id, avoidedRule, { contexts: 6, correct: 2, errors: 4, avoided: 4 });
    await seedEvidence(user.id, avoidedRule, { contexts: 6, correct: 2, errors: 4, avoided: 4 });

    const accuracies = await profileService.ruleAccuracies(user.id);
    const avoided = accuracies.find((a) => a.ruleTag === avoidedRule);
    expect(avoided?.avoidanceCount).toBeGreaterThan(0);

    const focus = await profileService.chooseFocus(user.id, new Date());
    // Avoidance is a stronger signal of weakness than error.
    expect(focus.primary).toBe(avoidedRule);
  });

  it('does not pick the same primary focus three sessions running', async () => {
    await seedEvidence(user.id, WEAK_RULE, { contexts: 8, correct: 1, errors: 5 });
    await seedEvidence(user.id, WEAK_RULE, { contexts: 8, correct: 1, errors: 5 });
    await seedEvidence(user.id, 'grammar.preposition.dependent', { contexts: 8, correct: 2, errors: 5 });
    await seedEvidence(user.id, 'grammar.preposition.dependent', { contexts: 8, correct: 2, errors: 5 });

    const first = await sessionService.startSession(user, 'casual');
    await sessionService.endSession(first.id, user.id);
    const second = await sessionService.startSession(user, 'casual');
    await sessionService.endSession(second.id, user.id);
    const third = await sessionService.startSession(user, 'casual');

    // The novelty penalty makes the engine rotate rather than drilling one thing forever.
    expect(new Set([first.focus.primary, second.focus.primary, third.focus.primary]).size).toBeGreaterThan(1);
  });

  it('gives a brand-new learner a rotating warm-up topic rather than silence', async () => {
    const first = await sessionService.startSession(user, 'free_topic');
    expect(first.focus.primary).toBeNull();
    expect(first.snapshotText).toContain('Steer the conversation toward');
  });
});
