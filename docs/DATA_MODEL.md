# DATA_MODEL.md — Entities, relationships, retention

Postgres + Drizzle. Every table carries `user_id` and every repository query filters on it.
Timestamps are `timestamptz`. Ids are `uuid v7` (time-sortable, which makes the transcript and
findings queries cheap).

## 1. Entity map

```
User ─┬─< Session ─┬─< Turn ─┬─< SpeechSegment (user turns only)  [audio, purged 24h]
      │            │         ├─< Finding ─────────┐
      │            │         ├─< StructureObservation
      │            │         └─< UtteranceMetrics  │
      │            ├─< SessionMetrics              │
      │            ├─< SessionReport               │
      │            └─< FrustrationEvent            │
      │                                            │
      ├─< LearningProfile (1:1)                    │
      ├─< SkillEstimate      (per skill)  <────────┘ aggregated from findings + observations
      ├─< UserVocabState ──> VocabularyItem
      ├─< SuppressedRule     (rules the user disputed)
      ├─< ProgressSnapshot   (weekly rollup)
      ├─< Exercise           (V2)
      └─< LlmCall            (cost + latency + prompt_version telemetry)
```

## 2. Tables

### User
`id, email, created_at, display_name, native_language, self_reported_level, goals[] (jsonb),
settings (jsonb), deleted_at`

`settings` holds correction intensity override, drill opt-in, voice choice, audio retention
preference, difficulty override. Kept as jsonb because it is read whole and never queried on.

### Session
`id, user_id, mode, started_at, ended_at, status, difficulty_level,
primary_focus_rule_tag, secondary_focus_rule_tag, snapshot_text (the frozen L2),
snapshot_prompt_version, mode_prompt_version, core_prompt_version`

Storing the **frozen L2 snapshot text** on the session is deliberate: it is the exact long-term
memory the model saw, which makes any past session reproducible and debuggable. It is also what
`ARCHITECTURE.md` §5.2 requires to stay stable for caching.

### Turn
`id, session_id, user_id, index, role ('user'|'coach'), text, created_at,
started_at, ended_at, directive (the L4 text, coach turns only),
llm_call_id, intent_flags (jsonb — the side-channel from ARCHITECTURE §2.2)`

### SpeechSegment — user turns only
`id, turn_id, user_id, audio_key (storage path, nullable after purge), duration_ms,
sample_rate, stt_provider, stt_model, words (jsonb), mean_confidence, snr_estimate,
pinned boolean default false, audio_purge_after (timestamptz), transcribed_at`

`words` is the load-bearing column — everything in `lib/metrics` reads it:

```json
[{"w":"I","s":0.12,"e":0.24,"c":0.99},
 {"w":"have","s":0.24,"e":0.41,"c":0.97},
 {"w":"went","s":0.41,"e":0.68,"c":0.88},
 {"w":"umm","s":0.68,"e":0.95,"c":0.71,"filler":true}]
```

`s`/`e` = start/end seconds, `c` = confidence. Keep it compact — this is the highest-row-count
jsonb in the system.

`audio_key` is nulled by the purge job at `audio_purge_after` unless `pinned`. The row survives;
only the audio goes.

### Finding
Full schema and rationale in `AI_BEHAVIOR.md` §2. Indexes that matter:

```sql
CREATE INDEX ON finding (user_id, rule_tag, created_at DESC);   -- recurring mistakes, trends
CREATE INDEX ON finding (session_id, status);                   -- report + notes rail
CREATE INDEX ON finding (user_id, user_feedback) WHERE user_feedback = 'disagreed';  -- precision alarm
```

The first index is the one that makes the whole progress dashboard fast, and it only exists
because `rule_tag` comes from a closed taxonomy.

### StructureObservation
`id, user_id, session_id, utterance_id, rule_tag, obligatory_context bool, produced bool,
correct bool, created_at`

The denominator (`AI_BEHAVIOR.md` §2.1). Small, high-volume, append-only.

### UtteranceMetrics — one row per user turn
`turn_id, user_id, word_count, duration_ms, speech_rate, articulation_rate,
pause_count_midclause, pause_count_boundary, pause_ms_total, filler_count, mlr,
repair_count, response_latency_ms`

Denormalised deliberately: computed once by a pure function, read constantly by the dashboard.
Recomputable from `SpeechSegment.words` at any time, which makes it safe to change the formulas.

### SessionMetrics — one row per session
Aggregates of the above plus `talk_time_ratio, user_speech_ms, coach_speech_ms, mtld,
freq_band_profile (jsonb), turn_count`.

### SkillEstimate
`user_id, skill, value, evidence_count, sessions_contributing, variance, confidence,
trend_28d, last_updated`  — PK `(user_id, skill)`.

`confidence = 'insufficient'` is a first-class state the UI must handle
(`AI_BEHAVIOR.md` §6.1). Never render a number for it.

### LearningProfile — 1:1 with User
`user_id, level_cefr, level_confidence, difficulty_level, interests (jsonb),
avoidance_flags (jsonb), updated_at`

Thin on purpose. The profile is mostly *derived* from `SkillEstimate` and `UserVocabState`;
duplicating it here would create two sources of truth. This table holds only what cannot be
derived.

### VocabularyItem (global) / UserVocabState (per user)
```
VocabularyItem: id, lemma, sense, definition, register, cefr_level, examples (jsonb),
                collocations (jsonb), part_of_speech
UserVocabState: user_id, item_id, state, introduced_session_id, anchor_utterance,
                srs_interval_days, srs_due_at, exposures, spontaneous_uses,
                last_seen_at, last_produced_at
```

`anchor_utterance` is the user's own sentence that the item was mined from — required
(`AI_BEHAVIOR.md` §5.4) and what makes the card memorable.

### SuppressedRule
`user_id, rule_tag, reason ('disputed'|'muted'), created_at` — read by the policy engine's Gate 1.

### FrustrationEvent
`id, user_id, session_id, turn_index, kind, created_at` — feeds the brake and is a product-health
metric.

### SessionReport
`session_id, user_id, top_fixes (jsonb), better_phrasings (jsonb), vocab_items (jsonb),
narrative, model_id, prompt_version, generated_at`

### ProgressSnapshot — weekly rollup
`user_id, week_start, skill_values (jsonb), error_rates_by_rule (jsonb), vocab_counts (jsonb),
minutes_practised, sessions`

Exists so the progress charts do not aggregate six months of findings on every page load, and so
history is stable even if a taxonomy change re-classifies old findings.

### Exercise (V2)
`id, user_id, kind, target_rule_tag, prompt, expected_features (jsonb), result (jsonb),
srs_due_at, created_at`

### LlmCall — telemetry
`id, user_id, session_id, lane ('hot'|'cold'|'session'), model_id, prompt_version,
input_tokens, cached_input_tokens, output_tokens, latency_ms, cost_usd, error, created_at`

Not optional. `cached_input_tokens` sustained at zero is a caching bug
(`ARCHITECTURE.md` §5.2), and per-session cost is a number the product itself displays.

## 3. Retention

| Data | Retention | Mechanism |
|---|---|---|
| Raw audio | 24h from transcription, unless pinned | `audioPurgeJob` on a schedule, driven by `audio_purge_after` |
| `SpeechSegment.words` | Kept | Small, and all metrics derive from it |
| Transcripts, findings, observations | Kept until user deletion | — |
| `LlmCall` | 90 days | Rolling delete |
| Deleted user | Hard delete, cascade, storage objects removed | Integration test asserts empty |

Retention constants live only in `lib/privacy/retention.ts`. See `ARCHITECTURE.md` §6.

## 4. Two modelling notes worth defending

**Findings are immutable, status is not.** A finding is never edited after creation — `status` and
`user_feedback` change, the content does not. If a re-analysis produces a different judgement it
creates a *new* finding with a new `prompt_version`. This keeps the eval harness able to compare
prompt versions on identical inputs.

**Everything aggregates on `rule_tag`, never on free text.** `subtype` and explanations exist for
humans; no query groups by them. The moment an analyzer is allowed to invent a category, the
progress dashboard stops being able to count anything.
