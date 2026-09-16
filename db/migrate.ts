/**
 * Schema creation.
 *
 * Idempotent CREATE TABLE IF NOT EXISTS statements rather than a generated migration chain.
 * Rationale: this is a single-user V1 with one schema version, and the same code has to run
 * against both PGlite and node-postgres. A migration chain is the right answer once the schema
 * starts evolving in production; `npm run db:generate` (drizzle-kit) is wired up for that day.
 */

import { execRaw } from './client';

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  native_language TEXT,
  self_reported_level TEXT,
  goals JSONB NOT NULL DEFAULT '[]',
  interests JSONB NOT NULL DEFAULT '[]',
  settings JSONB NOT NULL DEFAULT '{}',
  onboarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  difficulty_level INTEGER NOT NULL DEFAULT 5,
  primary_focus_rule_tag TEXT,
  secondary_focus_rule_tag TEXT,
  snapshot_text TEXT NOT NULL DEFAULT '',
  core_prompt_version TEXT NOT NULL DEFAULT '',
  mode_prompt_version TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user_started_idx ON sessions (user_id, started_at);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  index INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  directive TEXT,
  directive_kind TEXT,
  intent_flags JSONB,
  llm_call_id TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id, index);

CREATE TABLE IF NOT EXISTS speech_segments (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  audio_key TEXT,
  duration_ms INTEGER NOT NULL,
  sample_rate INTEGER,
  stt_provider TEXT NOT NULL,
  stt_model TEXT NOT NULL,
  words JSONB NOT NULL,
  mean_confidence REAL NOT NULL,
  snr_estimate REAL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  audio_purge_after TIMESTAMPTZ,
  transcribed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  utterance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  rule_tag TEXT NOT NULL,
  subtype TEXT,
  word_start INTEGER NOT NULL,
  word_end INTEGER NOT NULL,
  original_span_text TEXT NOT NULL,
  original_utterance TEXT NOT NULL,
  suggested_span_text TEXT,
  suggested_utterance TEXT,
  explanation_short TEXT NOT NULL,
  explanation_long TEXT,
  example TEXT,
  severity TEXT NOT NULL,
  llm_confidence REAL NOT NULL,
  asr_confidence REAL NOT NULL,
  combined_confidence REAL NOT NULL,
  is_asr_suspect BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  policy_reason TEXT NOT NULL DEFAULT '',
  surfaced_at TIMESTAMPTZ,
  user_feedback TEXT,
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_user_rule_created_idx ON findings (user_id, rule_tag, created_at);
CREATE INDEX IF NOT EXISTS findings_session_status_idx ON findings (session_id, status);
CREATE INDEX IF NOT EXISTS findings_feedback_idx ON findings (user_id, user_feedback);

CREATE TABLE IF NOT EXISTS structure_observations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  utterance_id TEXT NOT NULL,
  rule_tag TEXT NOT NULL,
  obligatory_context BOOLEAN NOT NULL,
  produced BOOLEAN NOT NULL,
  correct BOOLEAN NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS structobs_user_rule_idx ON structure_observations (user_id, rule_tag, created_at);

CREATE TABLE IF NOT EXISTS utterance_metrics (
  turn_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  word_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  speech_rate REAL NOT NULL,
  articulation_rate REAL NOT NULL,
  pause_count_midclause INTEGER NOT NULL,
  pause_count_boundary INTEGER NOT NULL,
  pause_ms_total INTEGER NOT NULL,
  filler_count INTEGER NOT NULL,
  mlr REAL NOT NULL,
  repair_count INTEGER NOT NULL,
  response_latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  turn_count INTEGER NOT NULL,
  user_speech_ms INTEGER NOT NULL,
  coach_speech_ms INTEGER NOT NULL,
  talk_time_ratio REAL NOT NULL,
  word_count INTEGER NOT NULL,
  speech_rate REAL NOT NULL,
  articulation_rate REAL NOT NULL,
  fillers_per_100_words REAL NOT NULL,
  repairs_per_100_words REAL NOT NULL,
  mean_mlr REAL NOT NULL,
  mtld REAL NOT NULL,
  advanced_word_ratio REAL NOT NULL,
  mean_response_latency_ms INTEGER,
  hedge_density_per_100_words REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_estimates (
  user_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  evidence_count INTEGER NOT NULL,
  sessions_contributing INTEGER NOT NULL,
  variance DOUBLE PRECISION NOT NULL,
  confidence TEXT NOT NULL,
  trend_28d DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill)
);

CREATE TABLE IF NOT EXISTS learning_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level_cefr TEXT,
  level_confidence TEXT NOT NULL DEFAULT 'insufficient',
  difficulty_level INTEGER NOT NULL DEFAULT 5,
  avoidance_flags JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocabulary_items (
  id TEXT PRIMARY KEY,
  lemma TEXT NOT NULL,
  sense TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,
  register TEXT NOT NULL,
  cefr_level TEXT NOT NULL,
  examples JSONB NOT NULL DEFAULT '[]',
  part_of_speech TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS vocab_lemma_sense_idx ON vocabulary_items (lemma, sense);

CREATE TABLE IF NOT EXISTS user_vocab_states (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  introduced_session_id TEXT,
  anchor_utterance TEXT NOT NULL,
  replaces_text TEXT,
  srs_interval_days INTEGER NOT NULL DEFAULT 1,
  srs_due_at TIMESTAMPTZ NOT NULL,
  exposures INTEGER NOT NULL DEFAULT 0,
  spontaneous_uses INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  last_produced_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS uvs_user_due_idx ON user_vocab_states (user_id, srs_due_at);

CREATE TABLE IF NOT EXISTS suppressed_rules (
  user_id TEXT NOT NULL,
  rule_tag TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rule_tag)
);

CREATE TABLE IF NOT EXISTS frustration_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_reports (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  top_fixes JSONB NOT NULL DEFAULT '[]',
  phrases_to_steal JSONB NOT NULL DEFAULT '[]',
  vocab_items JSONB NOT NULL DEFAULT '[]',
  say_it_better JSONB,
  one_thing_that_went_well TEXT NOT NULL DEFAULT '',
  focus_next TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progress_snapshots (
  user_id TEXT NOT NULL,
  week_start TIMESTAMPTZ NOT NULL,
  skill_values JSONB NOT NULL DEFAULT '{}',
  error_rates_by_rule JSONB NOT NULL DEFAULT '{}',
  vocab_counts JSONB NOT NULL DEFAULT '{}',
  minutes_practised REAL NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  lane TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_calls_user_created_idx ON llm_calls (user_id, created_at);

CREATE TABLE IF NOT EXISTS tts_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  provider TEXT NOT NULL,
  voice TEXT NOT NULL,
  characters INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cached BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let applied = false;

/** Idempotent. Safe to call on every server start and at the top of every integration test. */
export async function ensureSchema(force = false): Promise<void> {
  if (applied && !force) return;
  await execRaw(DDL);
  applied = true;
}

export function resetSchemaFlagForTests(): void {
  applied = false;
}
