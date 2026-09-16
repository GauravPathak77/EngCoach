# ROADMAP.md — Implementation plan

Each milestone is 1–3 coding sessions. Each has an objective, the files it touches, its
dependencies, required tests, and a definition of done that is *checkable*, not "it works".

Do them in order. The ordering is deliberate: **the conversation loop is proven before any
analysis exists, and the analysis is proven against fixtures before it is allowed to speak.**

---

## V1 — MVP

### M0 · Foundation
**Objective** A deployable, authenticated, empty app with the guardrails already in place.

**Touches** repo init, `package.json`, `tsconfig` (strict), Tailwind + shadcn, Drizzle + Neon/Supabase,
Auth, `app/(auth)`, `app/(app)/page.tsx`, `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`,
`db/schema.ts` (User only), `lib/types/`

**Depends on** nothing

**Tests** CI runs `npm run verify` = `typecheck && lint && test && check:arch`. One trivial unit
test so the runner is wired.

**Done when** a signed-in user reaches an empty dashboard on a deployed URL; CI is green;
`check:arch` fails on a deliberately-added illegal import (prove the guard works, then revert).

> Set the architecture guard up **first**, not last. Retrofitting a purity boundary onto an
> existing codebase never happens.

---

### M1 · Conversation loop, text only
**Objective** A real coach conversation you can type to. No audio anywhere.

**Touches** `prompts/core/identity.md`, `prompts/modes/{casual,coach,free-topic}.md`,
`prompts/index.ts`, `lib/modes/registry.ts`, `lib/llm/{client,models,stream,schemas}.ts`,
`app/api/turn/route.ts` (SSE), `server/services/turnService.ts`, `db/schema.ts` (Session, Turn,
LlmCall), a minimal session UI

**Depends on** M0

**Tests** Prompt assembly is a pure function with unit tests over layer ordering. Contract test
that `/api/turn` streams and persists a Turn. Mock the model in tests; never hit the API in CI.

**Done when** you can hold a 10-turn typed conversation in each of the 3 modes; the coach obeys
its turn-length limit (assert ≤60 words in 9 of 10 turns); `LlmCall` rows record tokens, latency,
cost and `cache_read_input_tokens`; the modes are visibly different in persona.

---

### M2 · Ears
**Objective** Speak, and see an accurate transcript with word-level timings.

**Touches** `lib/voice/{capture,vad}.ts`, `lib/voice/stt/{provider,deepgram}.ts`,
`db/schema.ts` (SpeechSegment), `app/api/turn/route.ts` (accept audio), session UI mic control

**Depends on** M1

**Tests** `SttProvider` contract test against a recorded fixture (checked-in wav + expected word
array). VAD tuning verified manually against 5 recordings incl. one noisy.

**Done when** speaking produces a transcript with per-word `s/e/c` persisted; both push-to-talk
and hands-free VAD work; measured user-stop → transcript p50 < 1.0s, logged.

---

### M3 · Voice
**Objective** The full spoken loop. This is the first moment the product exists.

**Touches** `lib/voice/tts/{provider,openai,cache}.ts`, `lib/voice/{chunker,player}.ts`,
`app/api/tts/route.ts`, session UI orb + playback queue

**Depends on** M2

**Tests** Sentence chunker unit tests (abbreviations, decimals, quotes, ellipses — it will get
"e.g." wrong if you let it). Audio queue ordering test under out-of-order chunk arrival.

**Done when** a full spoken conversation works end to end; **user-stop → first audio p50 < 2.0s**,
measured and recorded in `STATE.md`; TTS character count logged per turn (cost visibility from
day one); no barge-in — interrupting is expected to fail gracefully.

> **Ship a session to yourself here.** Have a real 10-minute conversation before building any
> analysis. If the conversation is not enjoyable at M3, no amount of analysis will save it, and
> that is a much cheaper thing to learn now.

---

### M4 · Metrics (pure)
**Objective** Objective speech measurement. No LLM involved.

**Touches** `lib/metrics/{fluency,lexical}.ts`, `db/schema.ts` (UtteranceMetrics, SessionMetrics),
`server/services/turnService.ts`, a dev-only debug panel

**Depends on** M2

**Tests** **100% branch coverage** on `lib/metrics`. Hand-computed fixtures for each metric,
including the nasty ones: MLR with zero pauses, MTLD on a 20-word sample, mid-clause vs boundary
pause classification, articulation rate when the whole utterance is one word.

**Done when** every user turn has metrics; the debug panel shows wpm, pause profile, filler rate,
MLR, talk ratio live; metrics are recomputable from stored `words` (assert equality after a
recompute).

---

### M5 · Error analysis + the eval harness
**Objective** Findings that are *trustworthy*. The riskiest milestone in the project.

**Touches** `lib/analysis/taxonomy.ts`, `lib/analysis/errorAnalyzer.ts`,
`prompts/analyzers/error-analyzer.md`, `lib/llm/schemas.ts`, `db/schema.ts` (Finding,
StructureObservation), `server/jobs/coldLaneJob.ts`, `app/api/analysis/route.ts`,
`tests/evals/**`

**Depends on** M4

**Tests** The eval harness itself, plus **≥100 annotated fixtures** including **≥30 fully correct
utterances that must yield zero findings**. Precision and recall reported per `rule_tag`.

**Done when** `npm run eval:analyzers` runs in CI and reports; **precision ≥ 0.90 on
`severity: blocking`**; zero findings on the correct-utterance set; every finding carries
`prompt_version`, `model_id`, span indices and `asr_confidence`; structure observations are
emitted with obligatory-context detection.

> Do **not** move on if precision is below target. Every later milestone amplifies this number.
> If it will not reach 0.90, narrow the taxonomy until it does — a system that reliably catches
> 20 error types beats one that unreliably catches 80.

---

### M6 · Policy engine
**Objective** The coach decides *when* to correct, in code.

**Touches** `lib/coaching/{policy,budgets,frustration,focus,directive}.ts`,
`db/schema.ts` (SuppressedRule, FrustrationEvent), wiring into `turnService`

**Depends on** M5

**Tests** Every rule in `AI_BEHAVIOR.md` §3 gets a named test. Property test: over 1000 randomly
generated sessions, the voice-correction budget is **never** exceeded. Explicit tests for the
ASR-suspect gate and the frustration brake.

**Done when** in a scripted 20-turn Casual session with 14 candidate findings, ≤3 are spoken and
all 14 are recorded; recasts appear in the coach's replies and read naturally; disputing two
findings silences voice corrections for the rest of the session.

---

### M7 · Notes rail + session report
**Objective** The user finally sees the value.

**Touches** `components/session/NotesRail.tsx`, `app/(app)/report/[id]`,
`prompts/report/session-report.md`, `server/services/reportService.ts`,
`db/schema.ts` (SessionReport)

**Depends on** M6

**Tests** Snapshot test of report assembly from a fixture session. Test that cards only render
in the coach-speaking state. Dispute action writes `user_feedback` and `SuppressedRule`.

**Done when** a real session produces a report matching the `UX.md` §2 shape — exactly 3 fixes,
each quoting the user, sparklines against history, one specific positive, dispute affordance on
every card.

---

### M8 · Vocabulary engine
**Objective** Words that come from your own mouth and come back later.

**Touches** `lib/analysis/vocabAnalyzer.ts`, `prompts/analyzers/vocab-analyzer.md`,
`lib/profile/srs.ts`, `db/schema.ts` (VocabularyItem, UserVocabState),
`lib/profile/snapshot.ts` (seeding into L2), `components/progress/VocabShelf.tsx`

**Depends on** M7

**Tests** `srs.ts` pure unit tests over the full interval ladder incl. demotion. Test that an
item's `anchor_utterance` is required by the schema. Test that ≤3 new items are introduced per
session.

**Done when** an item introduced in session 1 is seeded into the coach's speech at its due
session, and producing it unprompted advances it to `used_spontaneous`. Verify this by running
three sessions with a shortened SRS interval.

---

### M9 · Learning profile + progress dashboard
**Objective** Longitudinal truth, honestly presented.

**Touches** `lib/profile/{estimate,snapshot}.ts`, `db/schema.ts` (SkillEstimate,
LearningProfile, ProgressSnapshot), `app/(app)/progress`, `server/jobs/rollupJob.ts`

**Depends on** M8

**Tests** Wilson lower bound and EWMA against hand-computed values. **Evidence-gate test: a
skill with 3 observations must return `confidence: 'insufficient'` and the UI must render
"gathering evidence".** Outlier damping test.

**Done when** the dashboard shows recurring mistakes with error rate *and denominator* and a
trend, skills with confidence bands, insufficient-evidence dimensions greyed, and the vocabulary
shelf by state. Seeding one bad session must not move any skill more than the damping allows.

---

### M10 · Adaptive engine
**Objective** The conversation starts working on your weaknesses without saying so.

**Touches** `lib/coaching/focus.ts`, `lib/analysis/taxonomy.ts` (elicitation strategies),
`lib/profile/snapshot.ts` (topic steering into L2), difficulty dial

**Depends on** M9

**Tests** Focus selection is a pure function — test the priority formula, the novelty penalty,
and that avoidance *raises* priority. Test that exactly one primary and one secondary focus are
chosen.

**Done when** with a seeded past-tense-weak profile, ≥3 of 5 generated session openings steer
toward personal narrative; avoidance events are detected and recorded; the difficulty dial
visibly changes the coach's lexical level.

---

### M11 · Say It Better
**Objective** The feature the user will show other people.

**Touches** `lib/analysis/sayItBetter.ts`, `prompts/analyzers/say-it-better.md`,
`components/session/CaptionBubble.tsx`

**Depends on** M7

**Tests** Meaning-preservation eval fixtures: rewrites that add facts the user did not say must
fail. Mode-dependent variant selection.

**Done when** the `[↑]` affordance works on any user bubble, returns 2 variants with a one-clause
why, expandable to 4; one automatic instance per session lands in the report.

---

### M12 · Privacy, retention, and shipping
**Objective** Keep the promises in `ARCHITECTURE.md` §6.

**Touches** `lib/privacy/retention.ts`, `server/jobs/audioPurgeJob.ts`,
`app/(app)/settings`, export + delete endpoints

**Depends on** M3 (audio exists)

**Tests** Integration test: create a user with sessions and audio, delete, assert every table and
the storage bucket are empty. Purge-job test with a clock injected at +25h.

**Done when** audio older than 24h is verifiably gone, pinned clips survive, export produces
valid JSON, delete leaves nothing.

---

## V2 (in rough priority order)

| # | Item | Note |
|---|---|---|
| 1 | **Barge-in** | The single biggest "feels real" improvement. Needs duplex audio, echo cancellation, TTS cancellation protocol. Do it first in V2. |
| 2 | Streaming STT + partial captions | Read `ARCHITECTURE.md` §4.3 before starting — decide the ephemeral-token path vs a voice gateway |
| 3 | Job Interview mode | Highest-value mode; needs role consistency + whole-session scoring |
| 4 | Storytelling mode | Different turn shape (60–120s uninterrupted) + discourse rubric |
| 5 | Pronunciation Lab | Scripted read-aloud + a real pronunciation-assessment service (`AI_BEHAVIOR.md` §7.4) |
| 6 | Exercise generator | Micro-drills targeting focus rules, SRS-scheduled |
| 7 | Audio replay: your sentence vs the improved version | Requires pinning; high perceived value |

## V3

Negotiation mode (with a hidden-position engine); professional-communication scenario library;
optional speech-to-speech path for Casual mode; multi-voice roleplay; notifications; mobile.

---

## How to sequence a coding session

1. Read `CLAUDE.md`, `docs/STATE.md`, and this milestone.
2. Split the milestone into slices of ≤ ~8 files. Announce the split before coding.
3. Implement one slice. Run `npm run verify`.
4. Update `STATE.md` and `DECISIONS.md`.
5. Emit the Task Report from `CLAUDE.md`.

**Never work on two milestones at once**, and never start a milestone whose dependency's
definition of done is not fully met — especially M5.
