# ARCHITECTURE.md — Technical design

## 1. Voice architecture

### 1.1 The two viable paths

| | **A. Pipeline** (STT → LLM → TTS) | **B. Speech-to-speech realtime API** |
|---|---|---|
| Latency | ~1.2–2.0s (V1 batch STT), ~600–900ms (V2 streaming) | ~300–600ms |
| Barge-in | Must be built | Built in |
| Naturalness of voice | Good to excellent | Excellent (prosody, laughter, hesitation) |
| **Word-level timings + per-word confidence** | **Yes — first class** | Generally not exposed |
| **Disfluency / filler detection** | Yes (provider flag) | No |
| Provider independence | Full — swap any stage | Locked to one vendor for all three stages |
| Cost control | Per-stage; analysis on a cheap model | Coupled, higher, less tunable |
| Complexity | Higher (three integrations) | Lower |

### 1.2 Decision: pipeline for V1 and V2

The deciding factor is not latency, it is **evidence**. Everything in `AI_BEHAVIOR.md` §6.1
Layer A — articulation rate, mid-clause pause profile, mean length of run, filler rate, repair
rate — is computed from **word-level timings and per-word confidence**. The ASR-suspect gate in
§3.1, which is the thing standing between us and confidently correcting things the user said
correctly, needs per-word confidence. A speech-to-speech model gives us a lovely conversation and
none of that data. It would make us a slightly-worse ChatGPT voice mode, which `PRODUCT.md` §3
identifies as project failure.

Latency is also less critical here than in a general assistant: a coach that pauses briefly
before responding reads as *listening*. We are not optimising for 300ms.

**But design for the swap.** `lib/voice/` exposes `SttProvider`, `TtsProvider` and a
`VoiceTransport` seam so a realtime speech-to-speech path can be added in V3 for Casual mode only,
with the pipeline retained for Coach mode.

### 1.3 The V1 loop (concrete)

```
 Browser                                         Server
 ───────                                         ──────
 getUserMedia → AudioWorklet (16kHz PCM)
        │
        ├─ Silero VAD on-device (@ricky0123/vad-web)
        │     detects speech start / 700ms trailing silence
        │
        └─ on turn end: encode opus ──POST /api/turn (multipart)──┐
                                                                   │
                                              ┌────────────────────▼─────────────────┐
                                              │ 1. STT (batch, word timings)  ~400ms │
                                              │ 2. metrics (pure)              <5ms  │
                                              │ 3. assemble prompt L0..L4      <5ms  │
                                              │ 4. Claude, streamed                  │
                                              └────────────┬─────────────────────────┘
                                                           │ SSE: transcript, then text deltas
        ┌──────────────────────────────────────────────────┘
        │
   sentence chunker ──POST /api/tts (per sentence)──> TTS ──> audio chunk
        │
   AudioQueue plays chunk N while chunk N+1 is synthesised
        │
        └─ meanwhile, fire-and-forget: /api/analysis (cold lane, batched every 3–4 turns)
```

**Why on-device VAD rather than server-side turn detection:** it is free, has no network round
trip, works with batch STT, and it means we never stream silence to a paid API. Silero via ONNX
in the browser is mature and small.

**Why sentence-chunked TTS:** synthesising the whole reply before playing it adds the full
generation time to perceived latency. Chunking at the first sentence boundary gets audio playing
while the rest is still being written. This is the single largest perceived-latency win in the
pipeline and it belongs in V1.

**Latency budget (V1 target, p50, user stop → first audio):**

| Stage | Budget |
|---|---|
| VAD trailing silence | 700ms (tunable; this is *deliberate* padding, not waste) |
| Upload + STT | 400ms |
| Prompt assembly | 10ms |
| LLM first sentence | 500ms |
| TTS first chunk | 300ms |
| **Total after VAD** | **~1.2s** |

### 1.4 What belongs in V2, not V1

| Feature | Why deferred |
|---|---|
| Streaming STT + partial captions | Real UX gain (live captions feel alive) but needs a WebSocket path and ephemeral credentials; the batch path proves the loop first |
| Barge-in | The biggest single "feels real" improvement. Needs duplex audio, echo cancellation tuning, and a cancel-mid-TTS protocol. Do it *early* in V2. |
| Server-side turn detection | Only worth it once STT is streaming |
| Filler audio while thinking | Small win, easy, do it with barge-in |

**Do not build barge-in in V1.** It touches audio capture, playback, transport and the policy
engine simultaneously, and getting it wrong makes the product feel broken rather than slow.

---

## 2. AI lane architecture

Not agents. **Three lanes with different latency budgets**, which is a much simpler and more
honest framing than an agent tree.

```
                    ┌──── HOT LANE ── in-turn, <2s, 1 LLM call ───────────────┐
 mic → VAD → STT ───┤   ContextAssembler → Conversation LLM (streamed)        │──→ TTS → speaker
        │           └──────────────────────▲──────────────────────────────────┘
        │                                  │ turn_directive (≤40 tokens)
        │                        ┌─────────┴──────────┐
        │                        │   POLICY ENGINE    │   pure TS · no LLM · no I/O
        │                        │  lib/coaching/     │   AI_BEHAVIOR.md §3
        │                        └─────────▲──────────┘
        │                                  │ candidate findings
        ├──── COLD LANE ── async, batched every 3–4 turns, cheap model ────────┤
        │        Analyzer LLM (structured output, one call):                   │
        │          · error findings + structure observations                   │
        │          · vocabulary candidates                                     │
        │          · clarity / discourse notes                                 │
        │        Metrics (pure TS, from word timings) — no LLM                 │
        │                          ↓                                            │
        │                   persist → Notes rail (silent) → next turn_directive│
        │                                                                       │
        └──── SESSION LANE ── once, at session end, strong model ──────────────┘
                 Report LLM over aggregated findings + metrics
                          ↓
                 Profile Updater (pure TS) — applies deltas under evidence gates
```

### 2.1 Why not separate agents

- **Latency forbids it.** Chaining LLM calls inside the turn blows the budget in §1.3. The hot
  lane gets exactly one call.
- **The decisions that must be consistent must not be model judgements.** When to correct, how to
  score, what to practise next — these need to be identical on Tuesday and Thursday, and they need
  unit tests. That is code, not a prompt.
- **Cost.** One analyzer call per 3–4 turns on a cheap model costs a fraction of an analyzer call
  per turn on a strong one, and the analysis is *better* with more context around it.

The brief's diagram (Conversation Agent with Error Analyzer, Vocabulary Analyzer, etc. as
children) is right about the *responsibilities* and wrong about the *runtime shape*. They are
processing stages, most of them not even LLM-backed.

### 2.2 The one exception worth knowing about

The conversation LLM emits, alongside its spoken text, a small structured side-channel
(user intent flags: `wants_to_stop_corrections`, `changed_topic`, `asked_a_question_about_english`,
`emotional_state`). This is one call, not two — it rides in the same structured response. It feeds
the frustration brake (§3.3) without a second round trip.

---

## 3. Prompt architecture

### 3.1 Layered assembly

Never one giant system prompt. Five layers, assembled per turn, ordered **most stable first** so
prompt caching works (see §5.2):

| Layer | Source | Volatility | Size |
|---|---|---|---|
| **L0 Core identity** | `prompts/core/identity.md` | Frozen per deploy | ~500 tok |
| **L1 Mode** | `prompts/modes/<mode>.md` | Frozen per session | ~300 tok |
| **L2 Learner snapshot** | *generated* at session start | Frozen per session | ≤300 tok |
| **L3 Conversation history** | messages | Grows each turn | variable |
| **L4 Turn directive** | policy engine, appended last | Every turn | ≤40 tok |

L0+L1+L2 form a stable cacheable prefix for the whole session. **L2 is generated once at session
start and never mutated mid-session** — this is a deliberate cost decision, not an oversight
(mutating it would invalidate the cache on every turn). Mid-session changes ride in L4 instead.

**L2, the learner snapshot**, is the entire long-term memory the model sees. Compact by design:

```
Level: B2. First language: Hindi.
Working on: past simple with irregular verbs (primary); dependent prepositions (secondary).
Steer toward: personal narrative about recent events; opinion questions.
Vocabulary due: haggle (seed it), put off (elicit it).
Interests: cricket, product management, travel.
Do NOT correct: countable/uncountable (user disputed this twice).
Difficulty: 6/10 — moderate pace, avoid rare idioms.
```

**L4, the turn directive**, is the policy engine's entire influence over the conversation. Terse
and imperative:

```
RECAST grammar.past_simple.irregular naturally in your reply. Do not explain it.
```
```
No corrections this turn. Ask a follow-up that invites a past-tense narrative.
```
```
MICRO-TEACH: one sentence on "discuss about" -> "discuss", one example, then continue.
```

### 3.2 Analyzer prompts

Separate, single-purpose, **always schema-constrained output** (`output_config.format` with a
Zod-derived JSON schema). One file per analyzer under `prompts/analyzers/`. Never share a prompt
between conversation and analysis — the two need opposite dispositions (generous vs sceptical).

### 3.3 Versioning — the thing that makes prompts maintainable

Every prompt file carries front-matter:

```yaml
---
id: analyzers/error-analyzer
version: 7
changed: 2026-08-22
note: tightened the article rule to require an explicit determiner slot
---
```

`prompts/index.ts` loads them and exports `PROMPT_VERSIONS`. **Every persisted record stores the
version that produced it.** That is what makes the eval loop possible: change a prompt, re-run the
golden fixtures, diff precision/recall against the previous version, and optionally re-score
history. Without versioning, prompt changes are unfalsifiable and the analyzer quietly rots.

`prompts/CHANGELOG.md` records why each bump happened and what the eval numbers did.

---

## 4. Tech stack

Every choice states *why this* and *what else*. Optimised in order for: low cost, fast solo
development, maintainability, ability to scale later.

| Layer | Choice | Why this | Alternatives considered |
|---|---|---|---|
| **Frontend + API** | **Next.js 15 (App Router) + TypeScript strict + Tailwind + shadcn/ui** | One repo, one language, one deploy; route handlers give us streaming SSE for free; shadcn means no component-library lock-in. Solo-developer velocity dominates here. | Vite SPA + Fastify (cleaner separation, two deploys, more work); Remix (fine, smaller ecosystem) |
| **Audio capture** | Web Audio API + AudioWorklet | Only real option for raw PCM at a controlled sample rate | MediaRecorder alone (no sample-level control) |
| **Turn detection** | `@ricky0123/vad-web` (Silero VAD, ONNX, on-device) | Free, no round trip, no silence sent to paid APIs, well maintained | Server-side VAD (needs streaming); energy threshold (fails in noise) |
| **STT** | **Deepgram Nova** (batch V1 → streaming V2) | Decided by our requirements, not by brand: we need **word-level timings, per-word confidence, and filler-word detection** in one API, with the *same* provider for batch and streaming so V2 is a swap not a rewrite. Low per-minute cost. | **AssemblyAI** — excellent disfluency handling, strong second choice, slightly pricier. **OpenAI transcription** — great accuracy, weaker word-level metadata, which breaks Layer A metrics. **Self-hosted Whisper** — free per-minute but you own a GPU, and word timings need WhisperX on top |
| **LLM** | **Claude** — `claude-opus-5` for conversation and the session report; `claude-haiku-4-5` for high-volume cold-lane analysis | Structured outputs with strict schemas (every analyzer depends on this); prompt caching (§5.2 — the difference between viable and not); Batch API at 50% for end-of-session work; strong rubric-following, which is what judged scoring needs | See §4.1 for the cost tiering decision — this is a live choice for you to make |
| **TTS** | `TtsProvider` interface, **start with a low-cost neural TTS** (OpenAI or Azure), evaluate premium later. Voice identity is a provider-agnostic key resolved inside the layer (ADR-020); the default coach voice is female. | TTS is the **largest and most variable cost in the system** (a 10–20× spread between providers) and voice identity is a late polish decision. Do not marry a voice before the loop works. | **Cartesia Sonic** — latency leader, best if barge-in becomes the priority. **ElevenLabs** — best quality, an order of magnitude more expensive; revisit once the product is worth a great voice |
| **Database** | **Postgres** (Neon or Supabase) + **Drizzle ORM** | The workload is relational and aggregation-heavy — "error rate by rule_tag per week over 6 months" is a GROUP BY, not a document scan. JSONB for flexible analyzer payloads, `pgvector` available later for semantic topic/vocab retrieval. Drizzle: typed SQL, migrations in-repo, tiny runtime, no codegen step | Prisma (heavier runtime, worse edge story); SQLite/Turso (great for single-user, worse for the analytics queries); Mongo (wrong shape for this data) |
| **Auth** | Supabase Auth *or* Auth.js — one provider (Google) + email magic link | It is single-user today but every row is user-scoped from day one; retrofitting auth is miserable. Keep it to one provider. | Clerk (excellent, costs money for a feature we barely use) |
| **Object storage** | Supabase Storage or Cloudflare R2 | Short-lived audio only (see §6). R2 has no egress fees, which matters if audio replay ships in V2 | S3 (fine, egress costs) |
| **Hosting** | Vercel | Zero-config Next.js, streaming SSE supported, generous free tier for personal use | Fly.io (needed anyway if a voice gateway appears — see the caveat below) |
| **Background jobs** | Vercel Cron + a `jobs` table with a claim/lease pattern | The cold lane and retention purge are the only async work; a queue product is overkill at this size | Inngest / Trigger.dev (adopt if the job graph grows past ~5 job types) |
| **Observability** | Sentry for errors + a first-party `llm_calls` table (model, prompt_version, tokens, latency, cost) | We need cost-per-session *inside the product* anyway (§ COSTS), so rolling it ourselves is strictly better than a vendor dashboard we would have to duplicate | Langfuse — worth adding in V2 if prompt-level tracing and eval UI become painful |
| **Testing** | Vitest (unit) + Playwright (one E2E happy path) + **a golden-fixture analyzer eval harness** | See §4.2 | — |

### 4.1 The model tier decision — yours to make

The default in `lib/llm/models.ts` is `claude-opus-5` for the hot lane. It gives the best
conversational judgement and rubric adherence, which is exactly where quality is most visible.

Because you listed low cost as a priority, the tiering is a **one-line config change** and the
cost consequences are laid out in `COSTS.md` §3. Rough shape, per minute of session:
Opus 5 hot lane ≈ $0.013, Sonnet 5 ≈ $0.008, Haiku 4.5 ≈ $0.004. Analysis stays on Haiku 4.5 in
every configuration. Start on Opus 5, run a week, look at your own numbers, then decide — that is
a better basis than a table.

### 4.2 The most important test asset: the analyzer eval harness

`tests/evals/` holds **annotated learner utterances** — real transcripts with hand-labelled
expected findings (rule_tag, span, severity), plus a deliberate set of *correct* utterances that
must produce **zero** findings. `npm run eval:analyzers` runs the current analyzer prompt over
them and reports precision and recall, overall and per `rule_tag`.

This is how we control the project's biggest product risk (false corrections, `RISKS.md` R2).
Target for V1: **precision ≥ 0.90 on `severity: blocking`**, recall secondary. It is far better to
miss an error than to invent one. Start with ~100 fixtures, grow it every time the user disputes
a finding — a dispute is a free labelled negative example, and wiring that loop is worth doing
early.

### 4.3 The Vercel WebSocket caveat (read before V2)

Vercel's serverless functions do not host long-lived WebSocket connections. V1 avoids the problem
entirely by using batch STT over plain HTTP. When streaming STT arrives in V2, there are two
options:

1. **Browser connects directly to the STT provider** using a short-lived ephemeral token minted by
   `/api/stt/token`. Simplest; both Deepgram and AssemblyAI support this. Recommended.
2. **A small long-running Node service** (`apps/voice-gateway`) on Fly.io or Railway, if we need
   server-side control of the audio stream.

Choose (1) unless there is a concrete reason not to. This is written down now so it is not
discovered mid-V2.

---

## 5. Cross-cutting design rules

### 5.1 The purity boundary

`lib/coaching/`, `lib/metrics/`, `lib/profile/` and `lib/analysis/taxonomy.ts` are **pure**: no
I/O, no network, no LLM, no clock, no randomness. Clock and RNG are injected parameters.

This is not stylistic. It means the entire pedagogy — every rule in `AI_BEHAVIOR.md` — is
deterministic and exhaustively testable, and it prevents the failure mode where "the AI decides"
becomes the answer to every design question and the system's behaviour stops being explicable.
Enforced by `npm run check:arch` (dependency-cruiser), not by memory.

### 5.2 Prompt caching is an architectural constraint, not an optimisation

The L0→L4 ordering in §3.1 exists to keep a stable cacheable prefix. Consequences that are
**binding on implementation**:

- L2 (learner snapshot) is generated at session start and **frozen for the session**. Anything
  that needs to change mid-session goes in L4.
- No timestamps, no request IDs, no session-varying text anywhere in L0–L2.
- Tool/schema definitions must be serialised deterministically (stable key order).
- `usage.cache_read_input_tokens` is logged on every call; a sustained zero means something is
  silently invalidating the prefix and it is a bug, not a cost detail.

Without caching the hot lane costs roughly 3–4× more. See `COSTS.md` §4.

### 5.3 Structured output everywhere except conversation

Every analyzer, evaluator and report generator returns schema-constrained JSON validated against
a Zod schema in `lib/llm/schemas.ts`. Never parse prose into data. Unparseable output is a
retry-once-then-drop, logged, never a silent partial.

---

## 6. Privacy and security

Voice is unusually sensitive data — it is biometric-adjacent, it captures whoever else is in the
room, and transcripts of practice conversations are personal by nature.

| Concern | Decision |
|---|---|
| **Microphone** | Explicit browser permission plus an in-app first-run explanation of what is sent where. Unambiguous recording indicator whenever the mic is live. Mic released the moment a session ends. |
| **Raw audio retention** | **Deleted within 24 hours by default**, by a scheduled purge job, once transcription and analysis are complete. Users may explicitly pin individual clips (for pronunciation review) which then persist until unpinned. Permanent audio retention is the default in most products of this kind and it is the wrong default. |
| **Audio at rest** | Object storage with server-side encryption, private bucket, access only via short-lived signed URLs. Never a public URL. |
| **Transcripts and findings** | Retained — they *are* the product. Encrypted at rest by the database provider. Every table is user-scoped; every query filters by user id at the repository layer (enforced by a lint rule and, if on Supabase, by row-level security as defence in depth). |
| **Third-party processing** | STT, LLM and TTS providers see audio and text. Named explicitly in a plain-language sub-processor list in-app. Where the provider offers zero-retention or no-training options, they are enabled and the setting is recorded in `DECISIONS.md`. |
| **Secrets** | All provider keys server-side only, never in the client bundle. If V2 uses direct browser→STT connections, the browser receives a **scoped, ≤60s ephemeral token**, never the account key. |
| **Auth** | Real auth from day one even as a single user, because every row is user-scoped. Sessions httpOnly, secure, SameSite=Lax. |
| **Deletion** | One-click "delete everything": hard-deletes database rows and storage objects, no soft delete, no tombstones beyond an anonymous audit line. Verified by an integration test that asserts the tables are empty afterwards. |
| **Export** | Full JSON export of transcripts, findings, vocabulary and profile. It is the user's learning history. |
| **Retention config** | One file, `lib/privacy/retention.ts`, enforced by a scheduled job, unit-tested. Retention rules scattered across the codebase is how retention promises get quietly broken. |
| **Analytics** | None on the session page. No third-party scripts anywhere audio is live. |

---

## 7. Repository structure

Derived from the lanes in §2 and the purity boundary in §5.1 — the top-level split is *by
architectural role*, and the boundaries are machine-enforced.

```
engcoach/
├── app/                              # Next.js App Router
│   ├── (auth)/
│   ├── (app)/
│   │   ├── session/[id]/page.tsx     # the conversation screen
│   │   ├── report/[id]/page.tsx      # end-of-session report
│   │   ├── progress/page.tsx         # dashboard
│   │   └── settings/page.tsx         # incl. privacy + delete/export
│   └── api/
│       ├── session/route.ts          # start / end
│       ├── turn/route.ts             # HOT LANE — STT + LLM, streams SSE
│       ├── tts/route.ts              # sentence → audio chunk
│       ├── analysis/route.ts         # COLD LANE trigger (fire and forget)
│       ├── report/route.ts           # SESSION LANE
│       └── stt/token/route.ts        # V2: ephemeral STT credentials
│
├── components/
│   ├── session/                      # Orb, Captions, NotesRail, MicButton, TalkRatioBar
│   ├── report/
│   ├── progress/                     # SkillRadar, RecurringMistakes, VocabShelf
│   └── ui/                           # shadcn primitives
│
├── lib/
│   ├── voice/
│   │   ├── capture.ts  vad.ts  player.ts  chunker.ts
│   │   ├── stt/  { provider.ts, deepgram.ts }
│   │   └── tts/  { provider.ts, openai.ts, elevenlabs.ts, cache.ts }
│   │
│   ├── llm/
│   │   ├── client.ts          # the single entry point; dispatches by lane
│   │   ├── providers.ts       # per-lane provider selection (ADR-022)
│   │   ├── anthropic.ts  ollama.ts  scripted.ts   # the adapters
│   │   ├── models.ts  schemas.ts  assemble.ts  types.ts  errors.ts
│   │
│   ├── coaching/          ← PURE. no I/O, no LLM.  AI_BEHAVIOR.md §3, §6.2
│   │   ├── policy.ts             # decide(): suppress/record/show/speak/drill
│   │   ├── budgets.ts  frustration.ts  focus.ts  directive.ts
│   │
│   ├── metrics/           ← PURE.  AI_BEHAVIOR.md §6.1 Layer A
│   │   ├── fluency.ts            # wpm, articulation rate, pauses, MLR, repairs
│   │   └── lexical.ts            # MTLD, frequency bands
│   │
│   ├── profile/           ← PURE.  AI_BEHAVIOR.md §6.1
│   │   ├── estimate.ts           # Wilson bound, EWMA, evidence gates
│   │   ├── srs.ts                # spaced repetition
│   │   └── snapshot.ts           # builds prompt layer L2
│   │
│   ├── analysis/          ← LLM callers + the pure taxonomy
│   │   ├── taxonomy.ts    ← PURE. the closed rule_tag list
│   │   ├── errorAnalyzer.ts  vocabAnalyzer.ts
│   │   ├── communicationEvaluator.ts  sayItBetter.ts
│   │
│   ├── modes/
│   │   └── registry.ts           # ModeConfig tuples — see PRODUCT.md §6
│   │
│   └── privacy/retention.ts
│
├── prompts/                          # versioned .md with front-matter
│   ├── core/identity.md
│   ├── modes/{casual,coach,free-topic}.md
│   ├── analyzers/*.md
│   ├── report/session-report.md
│   ├── index.ts                      # loader + PROMPT_VERSIONS
│   └── CHANGELOG.md
│
├── db/
│   ├── schema.ts  migrations/  queries/  seed/
│
├── server/
│   ├── services/                     # turnService, sessionService, analysisService, reportService
│   └── jobs/                         # coldLaneJob, reportJob, audioPurgeJob
│
├── tests/
│   ├── unit/                         # heavy on coaching/, metrics/, profile/
│   ├── e2e/                          # one Playwright happy path
│   └── evals/
│       ├── fixtures/*.json           # annotated learner utterances — the golden set
│       ├── runAnalyzerEval.ts
│       └── README.md
│
├── docs/
├── CLAUDE.md
└── .dependency-cruiser.cjs           # enforces the purity boundary
```

**The layering rules encoded in `.dependency-cruiser.cjs`:**

```
lib/coaching, lib/metrics, lib/profile, lib/analysis/taxonomy.ts
    → may import: nothing outside themselves and lib/types
    → may NOT import: lib/llm, lib/voice, db, server, next/*, node:*

components/**  → may NOT import: server/**, db/**, lib/llm/**
app/api/**     → may NOT import: components/**
lib/analysis/*Analyzer.ts → may import lib/llm; may NOT import db (services persist, analyzers return)
```
