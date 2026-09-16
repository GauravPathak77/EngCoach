/**
 * Database schema — DATA_MODEL.md.
 *
 * Postgres (ADR-006). Every table carries `user_id` and every repository query filters on it.
 * Ids are uuid v7-ish (time-sortable), which makes the transcript and findings queries cheap.
 */

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  nativeLanguage: text('native_language'),
  selfReportedLevel: text('self_reported_level'),
  goals: jsonb('goals').$type<string[]>().default([]).notNull(),
  interests: jsonb('interests').$type<string[]>().default([]).notNull(),
  settings: jsonb('settings')
    .$type<{
      voiceCorrectionsEnabled: boolean;
      drillsOptIn: boolean;
      difficulty: number;
      coachVoice: string;
      ttsVoice?: string;
      handsFree: boolean;
      retainAudio: boolean;
    }>()
    .notNull(),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const authSessions = pgTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    status: text('status').$type<'active' | 'ended'>().notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    difficultyLevel: integer('difficulty_level').notNull().default(5),
    primaryFocusRuleTag: text('primary_focus_rule_tag'),
    secondaryFocusRuleTag: text('secondary_focus_rule_tag'),
    /**
     * The frozen L2 text, stored verbatim. This is the exact long-term memory the model saw,
     * which makes any past session reproducible and debuggable (DATA_MODEL.md §2).
     */
    snapshotText: text('snapshot_text').notNull().default(''),
    corePromptVersion: text('core_prompt_version').notNull().default(''),
    modePromptVersion: text('mode_prompt_version').notNull().default(''),
  },
  (t) => [index('sessions_user_started_idx').on(t.userId, t.startedAt)],
);

export const turns = pgTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    index: integer('index').notNull(),
    role: text('role').$type<'user' | 'coach'>().notNull(),
    text: text('text').notNull(),
    /** The L4 directive text, coach turns only. */
    directive: text('directive'),
    directiveKind: text('directive_kind'),
    intentFlags: jsonb('intent_flags').$type<Record<string, unknown>>(),
    llmCallId: text('llm_call_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('turns_session_idx').on(t.sessionId, t.index)],
);

export const speechSegments = pgTable('speech_segments', {
  id: text('id').primaryKey(),
  turnId: text('turn_id')
    .notNull()
    .references(() => turns.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  /** Storage path. Nulled by the purge job at `audioPurgeAfter` unless pinned (ADR-015). */
  audioKey: text('audio_key'),
  durationMs: integer('duration_ms').notNull(),
  sampleRate: integer('sample_rate'),
  sttProvider: text('stt_provider').notNull(),
  sttModel: text('stt_model').notNull(),
  /** The load-bearing column: everything in lib/metrics reads this. */
  words: jsonb('words')
    .$type<Array<{ w: string; s: number; e: number; c: number; filler?: boolean }>>()
    .notNull(),
  meanConfidence: real('mean_confidence').notNull(),
  snrEstimate: real('snr_estimate'),
  pinned: boolean('pinned').notNull().default(false),
  audioPurgeAfter: timestamp('audio_purge_after', { withTimezone: true }),
  transcribedAt: timestamp('transcribed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------

export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    utteranceId: text('utterance_id').notNull(),

    type: text('type').notNull(),
    ruleTag: text('rule_tag').notNull(),
    subtype: text('subtype'),

    wordStart: integer('word_start').notNull(),
    wordEnd: integer('word_end').notNull(),
    originalSpanText: text('original_span_text').notNull(),
    originalUtterance: text('original_utterance').notNull(),
    suggestedSpanText: text('suggested_span_text'),
    suggestedUtterance: text('suggested_utterance'),

    explanationShort: text('explanation_short').notNull(),
    explanationLong: text('explanation_long'),
    example: text('example'),

    severity: text('severity').notNull(),
    llmConfidence: real('llm_confidence').notNull(),
    asrConfidence: real('asr_confidence').notNull(),
    combinedConfidence: real('combined_confidence').notNull(),
    isAsrSuspect: boolean('is_asr_suspect').notNull(),

    status: text('status').notNull(),
    policyReason: text('policy_reason').notNull().default(''),
    surfacedAt: timestamp('surfaced_at', { withTimezone: true }),
    /** The user disputing a correction is the highest-value signal in the system. */
    userFeedback: text('user_feedback').$type<'agreed' | 'disagreed' | null>(),

    // CLAUDE.md invariant 4 — provenance, so the eval harness can re-score history.
    promptVersion: text('prompt_version').notNull(),
    modelId: text('model_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The index that makes the whole progress dashboard fast. Only possible because
    // rule_tag comes from a closed taxonomy (ADR-003).
    index('findings_user_rule_created_idx').on(t.userId, t.ruleTag, t.createdAt),
    index('findings_session_status_idx').on(t.sessionId, t.status),
    index('findings_feedback_idx').on(t.userId, t.userFeedback),
  ],
);

export const structureObservations = pgTable(
  'structure_observations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    utteranceId: text('utterance_id').notNull(),
    ruleTag: text('rule_tag').notNull(),
    obligatoryContext: boolean('obligatory_context').notNull(),
    produced: boolean('produced').notNull(),
    correct: boolean('correct').notNull(),
    promptVersion: text('prompt_version').notNull(),
    modelId: text('model_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('structobs_user_rule_idx').on(t.userId, t.ruleTag, t.createdAt)],
);

// ---------------------------------------------------------------------------

export const utteranceMetrics = pgTable('utterance_metrics', {
  turnId: text('turn_id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  wordCount: integer('word_count').notNull(),
  durationMs: integer('duration_ms').notNull(),
  speechRate: real('speech_rate').notNull(),
  articulationRate: real('articulation_rate').notNull(),
  pauseCountMidclause: integer('pause_count_midclause').notNull(),
  pauseCountBoundary: integer('pause_count_boundary').notNull(),
  pauseMsTotal: integer('pause_ms_total').notNull(),
  fillerCount: integer('filler_count').notNull(),
  mlr: real('mlr').notNull(),
  repairCount: integer('repair_count').notNull(),
  responseLatencyMs: integer('response_latency_ms'),
});

export const sessionMetrics = pgTable('session_metrics', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  turnCount: integer('turn_count').notNull(),
  userSpeechMs: integer('user_speech_ms').notNull(),
  coachSpeechMs: integer('coach_speech_ms').notNull(),
  talkTimeRatio: real('talk_time_ratio').notNull(),
  wordCount: integer('word_count').notNull(),
  speechRate: real('speech_rate').notNull(),
  articulationRate: real('articulation_rate').notNull(),
  fillersPer100Words: real('fillers_per_100_words').notNull(),
  repairsPer100Words: real('repairs_per_100_words').notNull(),
  meanMlr: real('mean_mlr').notNull(),
  mtld: real('mtld').notNull(),
  advancedWordRatio: real('advanced_word_ratio').notNull(),
  meanResponseLatencyMs: integer('mean_response_latency_ms'),
  hedgeDensityPer100Words: real('hedge_density_per_100_words').notNull(),
});

// ---------------------------------------------------------------------------

export const skillEstimates = pgTable(
  'skill_estimates',
  {
    userId: text('user_id').notNull(),
    skill: text('skill').notNull(),
    value: doublePrecision('value').notNull(),
    evidenceCount: integer('evidence_count').notNull(),
    sessionsContributing: integer('sessions_contributing').notNull(),
    variance: doublePrecision('variance').notNull(),
    /** 'insufficient' is a first-class state the UI must render as "gathering evidence". */
    confidence: text('confidence').notNull(),
    trend28d: doublePrecision('trend_28d').notNull().default(0),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.skill] })],
);

export const learningProfiles = pgTable('learning_profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  levelCefr: text('level_cefr'),
  levelConfidence: text('level_confidence').notNull().default('insufficient'),
  difficultyLevel: integer('difficulty_level').notNull().default(5),
  avoidanceFlags: jsonb('avoidance_flags').$type<Record<string, number>>().default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------

export const vocabularyItems = pgTable(
  'vocabulary_items',
  {
    id: text('id').primaryKey(),
    lemma: text('lemma').notNull(),
    sense: text('sense').notNull().default(''),
    definition: text('definition').notNull(),
    register: text('register').notNull(),
    cefrLevel: text('cefr_level').notNull(),
    examples: jsonb('examples').$type<string[]>().notNull().default([]),
    partOfSpeech: text('part_of_speech'),
  },
  (t) => [uniqueIndex('vocab_lemma_sense_idx').on(t.lemma, t.sense)],
);

export const userVocabStates = pgTable(
  'user_vocab_states',
  {
    userId: text('user_id').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => vocabularyItems.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    introducedSessionId: text('introduced_session_id'),
    /** The user's own sentence this was mined from. Required — AI_BEHAVIOR.md §5.4. */
    anchorUtterance: text('anchor_utterance').notNull(),
    replacesText: text('replaces_text'),
    srsIntervalDays: integer('srs_interval_days').notNull().default(1),
    srsDueAt: timestamp('srs_due_at', { withTimezone: true }).notNull(),
    exposures: integer('exposures').notNull().default(0),
    spontaneousUses: integer('spontaneous_uses').notNull().default(0),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastProducedAt: timestamp('last_produced_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.itemId] }),
    index('uvs_user_due_idx').on(t.userId, t.srsDueAt),
  ],
);

// ---------------------------------------------------------------------------

export const suppressedRules = pgTable(
  'suppressed_rules',
  {
    userId: text('user_id').notNull(),
    ruleTag: text('rule_tag').notNull(),
    reason: text('reason').$type<'disputed' | 'muted'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ruleTag] })],
);

export const frustrationEvents = pgTable('frustration_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  turnIndex: integer('turn_index').notNull(),
  kind: text('kind').notNull(),
  detail: text('detail').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessionReports = pgTable('session_reports', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  topFixes: jsonb('top_fixes').$type<unknown[]>().notNull().default([]),
  phrasesToSteal: jsonb('phrases_to_steal').$type<unknown[]>().notNull().default([]),
  vocabItems: jsonb('vocab_items').$type<unknown[]>().notNull().default([]),
  sayItBetter: jsonb('say_it_better').$type<unknown | null>(),
  oneThingThatWentWell: text('one_thing_that_went_well').notNull().default(''),
  focusNext: text('focus_next').notNull().default(''),
  modelId: text('model_id').notNull(),
  promptVersion: text('prompt_version').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const progressSnapshots = pgTable(
  'progress_snapshots',
  {
    userId: text('user_id').notNull(),
    weekStart: timestamp('week_start', { withTimezone: true }).notNull(),
    skillValues: jsonb('skill_values').$type<Record<string, number>>().notNull().default({}),
    errorRatesByRule: jsonb('error_rates_by_rule')
      .$type<Record<string, { errors: number; contexts: number }>>()
      .notNull()
      .default({}),
    vocabCounts: jsonb('vocab_counts').$type<Record<string, number>>().notNull().default({}),
    minutesPractised: real('minutes_practised').notNull().default(0),
    sessions: integer('sessions').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weekStart] })],
);

// ---------------------------------------------------------------------------

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id'),
    lane: text('lane').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    /** Sustained zero here is a caching bug, not a cost detail (ARCHITECTURE.md §5.2). */
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    isLive: boolean('is_live').notNull().default(false),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_calls_user_created_idx').on(t.userId, t.createdAt)],
);

/** TTS character counting, for cost visibility from day one (ROADMAP.md M3). */
export const ttsCalls = pgTable('tts_calls', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id'),
  provider: text('provider').notNull(),
  voice: text('voice').notNull(),
  characters: integer('characters').notNull(),
  latencyMs: integer('latency_ms').notNull().default(0),
  cached: boolean('cached').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
