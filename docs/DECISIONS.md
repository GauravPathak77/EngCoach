# DECISIONS.md — Architecture decision log

Append-only. Never edit a decision; supersede it with a new numbered entry and mark the old one.
Every non-obvious choice goes here, including ones made during implementation.

Format: **context → decision → alternatives rejected → consequences**.

---

### ADR-001 · Pipeline voice architecture, not speech-to-speech
**Status** Accepted · 2026-08-22

**Context** Two viable voice architectures: a STT→LLM→TTS pipeline, or a single speech-to-speech
realtime API. The realtime APIs are lower latency, handle barge-in natively, and are simpler.

**Decision** Pipeline for V1 and V2. Design `SttProvider`, `TtsProvider` and a `VoiceTransport`
seam so a realtime path can be added later for Casual mode only.

**Rejected** Speech-to-speech realtime. It does not expose word-level timings, per-word
confidence, or disfluency markers. Those three things are the entire input to
`AI_BEHAVIOR.md` §6.1 Layer A metrics and to the ASR-suspect safety gate in §3.1. Without them we
are a slightly worse general voice assistant.

**Consequences** Higher integration complexity, three vendors, ~1.2s latency instead of ~500ms.
Accepted: a coach that pauses briefly before answering reads as listening, not as slow.

---

### ADR-002 · The correction decision is made in code, not by the model
**Status** Accepted · 2026-08-22

**Context** When to correct, how often, in which channel — this could be a prompt instruction
("be tasteful, don't over-correct") or a deterministic policy engine.

**Decision** A pure function `lib/coaching/policy.ts` decides. The analyzer LLM only emits
candidate findings with severity and confidence. The model never chooses whether to correct.

**Rejected** Prompt-based restraint. It drifts turn to turn and model to model, it cannot be
unit-tested, and "correct a bit less" becomes a prompt rewrite instead of a config change.

**Consequences** More code, and the coach's restraint is provable: a property test asserts the
voice budget is never exceeded across 1000 generated sessions. This is the project's central
design commitment — if it erodes, the product becomes an unpredictable chatbot.

---

### ADR-003 · Closed `rule_tag` taxonomy
**Status** Accepted · 2026-08-22

**Context** Findings need a category. The analyzer could emit free-text categories.

**Decision** A closed, versioned taxonomy in `lib/analysis/taxonomy.ts`, ~60–90 tags at V1.
Analyzer output is schema-constrained to that enum. Free text lives in `subtype`, which nothing
aggregates on.

**Rejected** Free-text or model-invented categories — they cannot be counted, so there is no
"you did this 14 times this month", so there is no progress dashboard, so there is no product.

**Consequences** Taxonomy changes are migrations. `ProgressSnapshot` exists partly so history
stays stable when tags are re-classified.

---

### ADR-004 · `TtsProvider` is an interface from day one
**Status** Accepted · 2026-08-22

**Context** Normally you do not abstract before the second implementation.

**Decision** Exception. TTS is the largest and most variable cost in the system (roughly a 10–20×
spread across providers) and voice identity is a late-stage polish decision. Start on a low-cost
neural TTS behind the interface; evaluate premium voices once the loop is proven.

**Consequences** One extra indirection, and the ability to change the single biggest cost driver
without touching the pipeline.

---

### ADR-005 · `SttProvider` is an interface from day one, and the provider is chosen on data, not brand
**Status** Accepted · 2026-08-22

**Decision** Requirements first: word-level timings, per-word confidence, filler/disfluency
detection, and the *same vendor* for batch and streaming so the V2 upgrade is a swap. Deepgram
Nova is the default; AssemblyAI is the documented fallback.

**Rejected** Whisper-family transcription APIs — accuracy is fine, but weak word-level metadata
breaks Layer A metrics. Self-hosted Whisper(X) — free per minute, but it means owning a GPU and
the latency budget.

---

### ADR-006 · Postgres, not a document store
**Status** Accepted · 2026-08-22

**Context** The data is per-session events; a document store is tempting.

**Decision** Postgres + Drizzle. The core queries are aggregations — error rate by `rule_tag` per
week over months — which are GROUP BYs. JSONB covers the flexible analyzer payloads. `pgvector`
is available later for semantic topic and vocabulary retrieval without another datastore.

---

### ADR-007 · Layered prompts ordered for cache stability; L2 frozen per session
**Status** Accepted · 2026-08-22

**Context** Prompt caching requires a byte-stable prefix. The learner snapshot naturally wants to
update mid-session as new findings arrive.

**Decision** L0 (identity) → L1 (mode) → L2 (learner snapshot) → L3 (history) → L4 (turn
directive). **L2 is generated at session start and frozen.** Mid-session influence rides
exclusively in L4, which sits after the cache breakpoint.

**Consequences** Roughly 3–4× cheaper hot lane. Binding constraint on implementation: no
timestamps or varying text in L0–L2, deterministic schema serialisation, and
`cache_read_input_tokens` monitored as a correctness signal rather than a cost detail.

---

### ADR-008 · No confidence score
**Status** Accepted · 2026-08-22

**Context** The brief asks for a confidence dimension in scoring.

**Decision** Do not ship a confidence score. Display the observable proxies — hedging density,
self-repair rate, filler rate, response latency, mean turn length — labelled as proxies, with no
aggregate.

**Rationale** Hesitancy in a second language is mostly processing load, not personality. The same
person reads as confident on a familiar topic and unconfident on an unfamiliar one. A number here
would be wrong, demoralising, and would erode trust in the numbers that *are* sound.

**Revisit if** we find an external validation signal to calibrate against.

---

### ADR-009 · No pronunciation scoring on free conversation
**Status** Accepted · 2026-08-22

**Context** The brief lists pronunciation as a core dimension.

**Decision** Three tiers, and we are explicit about which we ship. V1: ASR-confidence *hints*
("these words seem to come out unclearly"), never a score. V2: real per-phoneme assessment via a
dedicated service, on **scripted read-aloud tasks with known reference text**, in a Pronunciation
Lab mode. Never: phoneme scoring of spontaneous speech.

**Rationale** A transcript is the recogniser's best guess at *correct English* — mispronunciations
are normalised away before any LLM sees them. An LLM cannot assess pronunciation from text, and
claiming otherwise is the most common dishonesty in this product category.

---

### ADR-010 · Evidence gating on every skill estimate
**Status** Accepted · 2026-08-22

**Decision** Accuracy-type skills are stored as Beta-Binomial and reported as the **Wilson lower
bound at 90%**; continuous metrics use EWMA with `α = min(0.30, 1/(n+1))`. Any skill with
`evidence_count < 5` or fewer than 2 contributing sessions is `confidence: 'insufficient'` and is
**never displayed as a number, never used to select a focus skill, never mentioned in a report**.

**Rationale** This is the structural answer to "don't judge the user from one conversation" — the
Wilson bound is automatically pessimistic at low n, so uncertainty falls out of the maths rather
than out of special-case code.

---

### ADR-011 · Modes are configuration, not code paths
**Status** Accepted · 2026-08-22

**Decision** A mode is `{ persona, scenario, correction_intensity, evaluation_rubrics,
topic_strategy, turn_length }` in `lib/modes/registry.ts` plus one prompt file. One conversation
engine.

**Consequences** Casual and Coach cost almost nothing to have both. New V2 modes are a config
entry plus a rubric, not a subsystem. Storytelling is the exception that will need real code — its
turn shape (60–120s uninterrupted) breaks the V1 turn-taking assumptions.

---

### ADR-012 · Analyzer eval harness is a first-class, CI-gating asset
**Status** Accepted · 2026-08-22

**Decision** `tests/evals/` holds hand-annotated learner utterances, including a set of fully
correct utterances that must yield zero findings. `npm run eval:analyzers` reports precision and
recall per `rule_tag` and runs in CI. V1 gate: **precision ≥ 0.90 on `severity: blocking`**.
Recall is explicitly secondary — missing an error is much cheaper than inventing one.

**Consequences** M5 cannot be declared done on vibes. Every user dispute becomes a new labelled
fixture, so precision improves with use.

---

### ADR-013 · Default model tier is `claude-opus-5`; tiering is a config change
**Status** Accepted · 2026-08-22

**Context** Low running cost is a stated project priority; conversational judgement is where
quality is most visible.

**Decision** Default `lib/llm/models.ts` to `claude-opus-5` for the hot lane and the session
report, `claude-haiku-4-5` for the cold lane. Model IDs live in one file so the tier is a one-line
change, and `COSTS.md` §3 lays out what each tier costs so the choice is made on real numbers
after a week of use rather than on a guess now.

**Consequences** The hot lane is the second-largest cost line. `LlmCall` telemetry exists partly
so this decision can be revisited with data.

---

### ADR-014 · Purity boundary enforced by dependency-cruiser
**Status** Accepted · 2026-08-22

**Decision** `lib/coaching`, `lib/metrics`, `lib/profile`, `lib/analysis/taxonomy.ts` may not
import `lib/llm`, `lib/voice`, `db`, `server`, `next/*` or `node:*`. Clock and RNG are injected.
`npm run check:arch` fails the build on violation and runs in CI.

**Rationale** Architectural rules that live only in a document are advisory, and drift is
guaranteed over many coding sessions. This one is load-bearing enough to enforce mechanically.

---

### ADR-015 · Raw audio deleted within 24 hours by default
**Status** Accepted · 2026-08-22

**Decision** Audio is transcribed, analysed, then purged within 24h by a scheduled job. Users may
pin individual clips. Transcripts and word timings are retained — they carry everything the
product needs.

**Rationale** Permanent audio retention is the default in this category and it is the wrong
default: voice is biometric-adjacent and captures bystanders. Retaining `words` rather than audio
gives us 100% of the analytical value at a fraction of the risk.

---

---

### ADR-016 · Embedded PGlite as the default database, Postgres by connection string
**Status** Accepted · 2026-08-22 (implementation)

**Context** ADR-006 specifies Postgres. But the app has to be runnable by cloning the repo, and
requiring a Neon or Supabase signup before the user can say hello to their coach is the wrong
first-run experience for a personal, self-hosted V1.

**Decision** Two drivers behind one Drizzle interface. With no `DATABASE_URL`, use PGlite — real
Postgres compiled to WASM, on disk at `./.data/engcoach`, created automatically. With
`DATABASE_URL` set, use node-postgres against Neon, Supabase, or a local server. Identical schema
and dialect either way, so moving is a connection-string change, not a migration.

**Rejected** SQLite/Turso — a different dialect would have meant maintaining two schemas and
would have broken the aggregation queries ADR-006 was chosen for.

**Consequences** Zero-setup first run. One real constraint: **PGlite is single-writer**, so
`scripts/inspect.ts` and `npm run job:purge` must not run while `npm run dev` holds the same data
directory — two processes will abort each other. Both scripts say so in their header. This
limitation disappears entirely under `DATABASE_URL`.

---

### ADR-017 · Structured output via forced tool use, not `output_config.format`
**Status** Accepted · 2026-08-22 (implementation)

**Context** CLAUDE.md invariant 3 requires schema-constrained output for every non-conversational
call. The blueprint names `output_config.format`; the pinned SDK (`@anthropic-ai/sdk` 0.68.0)
predates that parameter.

**Decision** Implement the constraint with forced tool use: the Zod-derived JSON Schema becomes a
tool `input_schema`, and `tool_choice` forces the model to call it. The payload arrives as the
`tool_use` block's `input`.

**Rationale** The guarantee is identical — the model must emit an object matching our schema, and
we never parse prose into application data. The invariant is about *never parsing prose*, not
about which API field carries the schema.

**Consequences** One deviation from the blueprint's wording, isolated to `lib/llm/client.ts`.
Switching to `output_config.format` on an SDK upgrade is a change to one function.

---

### ADR-018 · Browser-speech fallback is explicitly degraded, and says which metrics it cannot support
**Status** Accepted · 2026-08-22 (implementation)

**Context** Deepgram needs an API key. Without one the product would be unusable by voice — but
faking word timings to keep the metrics looking populated would poison every fluency number, which
is precisely what AI_BEHAVIOR.md §7.1 forbids.

**Decision** A `BrowserSpeechStt` provider using the Web Speech API, with three honesty
mechanisms:
1. `timingsReliable: false` on the transcript. Timing-derived metrics (articulation rate, pause
   profile, mean length of run) are zeroed and the UI renders "Gathering evidence" for them
   instead of a fabricated number, with a line explaining that a Deepgram key unlocks them.
2. Per-word confidence fixed at **0.5, deliberately below the 0.8 ASR-suspect threshold**, so the
   policy engine suppresses every asr-prone correction. That is the correct behaviour: we
   genuinely do not know whether the recogniser heard the articles and verb endings.
3. A persistent banner in the session UI naming every degraded provider.

Word count, recording duration and therefore speech rate remain real in both paths.

**Consequences** The voice loop is usable without a paid key while being honest about what it
cannot measure. A `source: 'speech' | 'typed'` discriminator on the turn request keeps typed input
out of this path — typed text has no recognition uncertainty, and conflating the two silently
suppressed half the corrections until it was caught in end-to-end testing.

---

### ADR-019 · Email + password auth, no OAuth provider
**Status** Accepted · 2026-08-22 (implementation)

**Context** ARCHITECTURE.md §6 requires real auth from day one because every row is user-scoped.
The blueprint suggested Supabase Auth or Auth.js with Google.

**Decision** Email + password with scrypt hashing (`node:crypto`, no dependency) and httpOnly
cookie sessions in an `auth_sessions` table.

**Rationale** It satisfies the actual requirement — every row user-scoped, sessions real,
credentials never stored in plaintext — without making the user register an OAuth application
before their first conversation. This is a personal, self-hosted V1.

**Consequences** No password reset flow in V1 (single user, and `npm run db:reset` exists). Adding
an OAuth provider later is additive: `server/auth.ts` already isolates session creation from
credential verification.

---

### ADR-020 · Coach voice is a provider-agnostic key; the default is female
**Status** Accepted · 2026-08-22 (post-V1 UX)

**Context** The V1 default voice was `'alloy'`, a raw OpenAI voice id stored directly in
`user.settings.ttsVoice` and passed through to the provider. That leaked a vendor identifier into
the settings schema, the API contract and the UI — the exact coupling ADR-004's interface exists
to prevent. The product also wanted a female coach voice by default.

**Decision** A registry in `lib/voice/tts/voices.ts` keyed by presentation (`'female' | 'male'`).
Everything outside the voice layer — settings, the session page, the TTS request body — deals in
that key. `providerVoiceId(voice, providerName)` performs the only translation, inside the layer.

Female is the default (`Maya`), mapped to OpenAI `sage`: calm, warm and conversational. `coral`
and `nova` were auditioned against the brief and rejected as too bright — they read as
advertisement rather than conversation. `shimmer` reads as audiobook narration. Male (`Aaron`)
maps to `ash`.

**Migration** Settings written before this ADR hold a raw provider id. `normaliseSettings` maps
those back to a presentation on read, so an existing account moves to the new default rather
than silently keeping `alloy` forever.

**Browser fallback** The Web Speech API exposes no gender field, so `pickBrowserVoice` matches
against name hints (Samantha, Zira, Aria, …) with a word-boundary guard so "female" cannot match
a request for "male". When nothing matches it returns `matched: false`, falls back to the
platform default, and the session screen says so. We do not claim a female voice the platform
does not have.

**Consequences** Swapping TTS vendor is now a one-line edit to `providerVoiceIds`. Adding a third
voice is a registry entry — deliberately not a voice marketplace, which is out of scope.

---

### ADR-021 · The coach is a hand-authored inline-SVG character, not an orb and not an avatar SDK
**Status** Accepted · 2026-08-22 (post-V1 UX) · Revisits the orb decision in UX.md §1

**Context** UX.md §1 argued against a face: a rendered avatar costs money per minute, sits in the
uncanny valley, ages badly, and pulls the eye away from listening. That reasoning still holds
against *photoreal video* avatars. It does not hold against a static illustrated character, and
the product goal — "I am talking to an English coach", not "I am talking to a coloured orb" —
is worth more than the orb's austerity.

**Decision** `components/session/CoachAvatar.tsx`: a fictional character, "Maya", drawn as inline
SVG in the component. No image asset, no avatar platform, no new dependency.

**Rejected**
- *A third-party avatar/talking-head SDK* — heavyweight, per-minute cost, network dependency in
  the conversation path, and a demo-flashy answer to a presentation problem (task §7, §18).
- *A generated raster portrait* — needs an asset pipeline and a set of sizes, and risks
  resembling a real person. Inline vector has neither problem and is sharp at any viewport.
- *Keeping the orb* — it does not meet the product goal.

**Animation honesty** There is no phoneme-level lip sync and none is faked. While speaking, the
mouth opens and closes on a loop, the head drifts, and eyes blink on an independent cycle. The
result reads as alive without claiming precision we do not have. A static equaliser indicator
carries the SPEAKING state when `prefers-reduced-motion` suppresses the animation.

**States** `idle | listening | thinking | speaking | error`. Driven by the real `AudioQueue`
lifecycle (`onStart` → SPEAKING, `onEnd` → IDLE), never by timers. `error` is *derived* at render
time from the existing error state rather than stored, so it cannot get stuck and no transition
had to be added at every failure site.

**She never reacts to mistakes.** No frowns, no colour change, no head shake. Her brows are
fixed across every state, and a test asserts it. Corrections belong on the screen, not on her
face — the voice channel stays conversational and the screen carries the coaching
(AI_BEHAVIOR.md §3.2). The state enum has no room for a judgemental state.

**Failure** `CoachStage` wraps the avatar in an error boundary that falls back to the original
`Orb`. The status text sits outside the boundary, so the accessible state survives whatever
happens to the picture. The conversation never depends on the avatar rendering.

**Consequences** Stylised rather than photoreal — an honest limit of drawing a character in
vectors, and the right trade for a face that sits on screen for ten minutes. `Orb.tsx` is
retained as the fallback rather than deleted.

---

### ADR-022 · Local models via Ollama, selectable per lane
**Status** Accepted · 2026-08-22 (post-V1)

**Context** The hosted model is the second-largest cost line (COSTS.md §5) and the only one that
sends the learner's transcripts off the machine. Ollama runs small instruct models locally at
zero marginal cost with nothing leaving the device. The question is not whether it is *possible*
but whether it is *good enough*, and that differs sharply by lane.

**Decision** An `LlmProvider` seam in `lib/llm/`: `anthropic.ts`, `ollama.ts` and `scripted.ts`
behind the existing `client.ts` entry point, selected **per lane** by `providers.ts`.

```
ENGCOACH_LLM_PROVIDER=ollama            # all lanes
ENGCOACH_PROVIDER_COLD=anthropic        # ...except this one
ENGCOACH_OLLAMA_MODEL_HOT=llama3.1:8b   # model per lane
```

**Why per lane, not global.** The trade-offs are close to opposite:

| Lane | Calls | Latency | What a weak model costs you |
|---|---|---|---|
| hot | one per turn — **the cost driver** | **<2s to first audio** | Persona drift, rambling past the word cap. Annoying, visible, recoverable. |
| cold | one per ~4 turns — negligible cost | irrelevant | **False corrections.** The product's central safety property (RISKS.md R2). |
| session | one per session | a few seconds is fine | A weaker report. |

So: **hot-lane-local is the sensible first experiment** — it captures nearly all the saving and
its failure mode is obvious within a minute of talking. **Cold-lane-local is gated on evidence**,
because its failure mode is silent and corrosive: a model that confidently "corrects" correct
English destroys trust in everything else the product says.

**Structured output holds.** Ollama's `format` parameter takes a JSON Schema and enforces it with
constrained decoding, so CLAUDE.md invariant 3 is satisfied by the same mechanism as Anthropic's
forced tool use: the model *cannot* emit a rule_tag outside the taxonomy, and we never parse prose
into application data. Requires Ollama 0.5+.

**Schema conformance is not correctness.** A small model will happily return a perfectly-shaped
finding that is nonsense. This is exactly what `npm run eval:analyzers` measures, and the harness
now treats a local model as a real measurement that the 0.90 blocking-precision gate applies to
normally — that is how you answer "is a small local model good enough?" without guessing.

**Rejected**
- *Replacing Anthropic.* The default stays hosted. Local is opt-in.
- *Auto-selecting Ollama when the server is up.* A running local server is not consent to route
  the product through it, and silently switching the analyzer to an unmeasured model is precisely
  how a quality gate gets bypassed without anyone deciding to. `providerFor()` never returns
  `'ollama'` implicitly, and a test pins that.
- *An OpenAI-compatible shim.* Ollama's native `/api/chat` supports the JSON-schema `format`
  parameter more directly than its compatibility endpoint.

**Consequences**
- LLM cost drops to zero on any local lane. `costOf()` returns 0 for unpriced models rather than
  inventing a rate, so the telemetry stays honest.
- Prompt caching (ADR-007) becomes irrelevant on local lanes — there is no billing to save. The
  cache-hit alarm in ARCHITECTURE.md §5.2 applies only to Anthropic lanes.
- Latency becomes hardware-dependent and unmeasured. On CPU-only inference a 7B model may take
  several seconds for a 40-word reply, which blows the <2s budget in ARCHITECTURE.md §1.3. This
  is the main practical risk and it is measurable by talking to it for one minute.
- `hasLiveCredentials()` now means "some real provider is configured", not "an Anthropic key
  exists" — a fully local setup is a live configuration and the UI must not call it degraded.

---

### ADR-023 · One validated lookup for "which provider serves this lane"
**Status** Accepted · 2026-09-05 (bug fix to ADR-022)

**Context** ADR-022 put provider *routing* in `providers.ts` and model *naming* in `models.ts`,
and deliberately did not import one from the other — the comment at the time said models.ts
"has no business knowing about credential checks". So each module read
`ENGCOACH_PROVIDER_<LANE>` and `ENGCOACH_LLM_PROVIDER` for itself.

Only one of them validated the value. `providers.ts` ran it through `isProviderName()` and
ignored anything unrecognised, correctly falling back to the global setting. `models.ts` just
compared the raw string to `'ollama'`.

Found in the wild: a `#` was dropped from a commented example line in `.env.local`, producing

```
ENGCOACH_PROVIDER_COLD=ollama npm run eval:analyzers -- --gate
```

The router ignored the junk and routed the cold lane to Ollama. Model naming saw a string that
was not `'ollama'` and returned `claude-haiku-4-5`. **The lane called the local server asking for
a Claude model**, which 404s. Two modules, same input, opposite conclusions.

**Decision** `lib/llm/providerNames.ts` holds `PROVIDERS`, `isProviderName` and
`configuredProviderFor(lane)` — the validated per-lane-then-global lookup — and has no imports,
so both modules can depend on it without a cycle. Each keeps its own default:

- `providers.ts`: `configuredProviderFor(lane) ?? (hasAnthropicCredentials() ? 'anthropic' : 'scripted')`
- `models.ts`: `configuredProviderFor(lane) === 'ollama'`

`providers.ts` re-exports the names so existing importers are unaffected.

**Rejected** *Duplicating the validation into `models.ts`.* It would have fixed this instance
while leaving the same class of bug one edit away — the precedence rules would still live in two
places and could drift again.

**Consequences** The original separation-of-concerns instinct was right; the mistake was
duplicating the *lookup* rather than sharing it. Four regression tests now assert that routing
and naming agree across every lane, every shape of junk, and every valid combination — verified
by reintroducing the bug and watching them fail.

---

### ADR-024 · Standalone scripts load `.env.local` themselves
**Status** Accepted · 2026-09-05

**Context** Next.js loads `.env.local` for the app. A script run under `tsx` gets none of it. So
`npm run eval:analyzers` ran with an empty configuration, fell back to the scripted stand-in, and
printed a report headed "no real analyzer provider configured" — while the user's `.env.local`
plainly said `ENGCOACH_LLM_PROVIDER=ollama`. The harness was correct and the configuration was
correct; they simply never met.

Worse, the command documented in the README to work around it —
`ENGCOACH_PROVIDER_COLD=ollama npm run eval:analyzers` — is bash syntax that silently does
nothing on Windows `cmd`, which is where this was being run.

**Decision** `lib/env.ts` parses and applies `.env.local` then `.env`, without overwriting
anything already in the real environment (matching Next.js precedence, so `set FOO=... && npm run`
still wins). The eval harness and `scripts/checkOllama.ts` call it at startup and print which
files were loaded, so a silent misconfiguration is visible in the output.

The harness also gained shell-agnostic flags — `--provider=`, `--model=`, `--limit=` — so the
documented workflow does not depend on the reader's shell.

**Rejected** *Adding `dotenv`.* It is ~40 lines for a format we already control, and ADR-007's
no-new-dependency rule applies. The parser handles the one case that actually bit us: an unquoted
value with a trailing comment (`ENGCOACH_LLM_PROVIDER=ollama   # all lanes local`), which a naive
split would read as part of the value.

**Consequences** Any future script that reads configuration must call `loadEnvFiles()`. The
failure mode this fixes is the dangerous kind — not a crash, but a tool confidently reporting on
the wrong thing.

---

### ADR-025 · `qwen2.5:7b-instruct` is not usable for the analyzer
**Status** Accepted · 2026-09-05 · **Measurement, not a preference**

**Context** ADR-022 said local-model quality on the cold lane was "gated on evidence, not on
preference", and that the eval harness existed to produce that evidence. With ADR-024 the harness
could finally see the configuration, so it was run.

**Measurement** `qwen2.5:7b-instruct`, `analyzers/error-analyzer@1`, 20-case subset
(10 annotated errors + 10 known-correct utterances):

| | |
|---|---|
| precision | **5.6%** (target ≥ 0.90) |
| recall | 10.0% |
| tp / fp / fn | 1 / 17 / 9 |
| **spurious findings on CLEAN speech** | **9 of 10 utterances** |
| worst offenders | `naturalness.wordiness` fp=5, `discourse.missing_connective` fp=4 |
| wall time | 3m10s for 20 cases (~19s/case; a full 155-case run is ~49 min) |

Roughly seventeen of every eighteen corrections it produced were wrong, and it flagged almost
every sentence that was already correct.

**Decision** Local models are not used for the analyzer. The cold lane defaults to the scripted
stand-in when no hosted key is present — it detects only ~8 hardcoded patterns, but it is never
wrong, which is strictly better than an analyzer that fabricates.

**Considered and rejected: narrowing the taxonomy.** ROADMAP.md M5 says to narrow rather than
lower the gate, and the two vaguest categories accounted for 9 of 17 false positives. But removing
both would lift precision only from ~6% to ~11%, and would not touch the core failure: flagging
clean English. This is a capability gap, not a taxonomy gap.

**What this does NOT say.** The *conversation* lane on a local model is good — `qwen2.5:3b`
answers in ~200-400ms warm with sensible coaching replies. The two lanes have opposite
requirements, exactly as ADR-022 predicted; this measurement confirms the prediction rather than
overturning it. The cheapest lane to buy is also the one that most needs a strong model: the cold
lane is ~5% of hosted cost (COSTS.md §2), so hot-local + cold-hosted keeps ~95% of the saving.

**Revisit when** a materially stronger local model is available, or the analyzer prompt is
restructured for small models (e.g. one rule per call rather than an open taxonomy). Re-run
`npm run eval:analyzers -- --provider=ollama --model=<name> --gate`.

<!-- Append new decisions below. Number sequentially. Never edit an accepted entry — supersede it. -->

---

### ADR-026 · `llama3.2:3b` is the default local model, and the 7B is dropped from the config

**Date** 2026-09-05 · **Status** Accepted

**Context.** The local setup carried `qwen2.5:7b-instruct` as `DEFAULT_OLLAMA_MODEL` and on the
session lane. That size was chosen for one reason: the analyzer, where accuracy matters more than
latency. ADR-025 then measured the 7B on the analyzer and rejected it (5.6% precision, 9 of 10
correct sentences falsely flagged), and the cold lane moved to the scripted stand-in.

That left a 4.7GB model in the config with no job that needed its weight. It was still generating
the end-of-session report, which took **29s** — long enough that the user watches a spinner at the
one moment the product is supposed to feel like a payoff.

**Decision.** Default `DEFAULT_OLLAMA_MODEL` to `llama3.2:3b` (~2GB) and point every Ollama lane
at it. Nothing in the shipped configuration depends on a model larger than 3B any more.

**Measurement** (same machine, same three-turn typed session, cold lane scripted):

| | qwen2.5:7b-instruct | llama3.2:3b |
|---|---|---|
| session report | 29s | **6.3s** |
| conversation turn, warm | — | **638ms / 690ms** (first token ~180-220ms) |
| conversation turn, cold start | — | 6.0s (model load) |
| disk | 4.68GB | 2.02GB |

Reply quality on the conversation lane is unchanged to the eye: on-persona, asks a follow-up
question, does not lecture. The report still produced a usable `phrasesToSteal` entry quoting the
user's own wording.

**Why not keep the 7B for the session lane only.** The report is one call at the end of a session,
so its cost is negligible and the argument for a bigger model is "it might write a better summary".
That is exactly the kind of unmeasured intuition ADR-025 punished. 6.3s versus 29s is measured; the
quality difference is not. If someone later measures a real difference, it is one env var.

**Consequence.** The 7B stays valid as an explicit `ENGCOACH_OLLAMA_MODEL` override, and the
cold-lane guidance is unchanged: measure before trusting any local model on the analyzer.
