# EngCoach — Personal AI English Communication Coach

A voice-first web app that holds real English conversations with you, quietly measures how
you actually speak, and turns that into targeted practice over weeks — not a chatbot with a
grammar checker bolted on.

**Status: V1 implemented.** All twelve V1 milestones in `docs/ROADMAP.md` are built and verified.
See "Known limitations" at the bottom for what needs credentials and what is deliberately V2.

---

## Quick start

**Windows — just double-click `start.bat`.** It installs dependencies on first run, starts the
server, and opens your browser. Close the window to stop it.

Optionally run `setup-keys.bat` first to paste in your API keys.

Any platform:

```bash
npm install
npm run dev
```

Open http://localhost:3000, create an account, and start talking.

That is genuinely the whole setup — no database to provision, no API keys required to see the
product work end to end. The embedded database creates itself at `./.data/engcoach` on first run.

**But read "Running without credentials" below before you judge the coach's replies.** With no
API keys the app runs on clearly-labelled development providers and tells you so in a banner on
every session screen.

## Getting the real experience

Run `setup-keys.bat` (Windows), or copy the template by hand:

```bash
cp .env.example .env.local
```

Then fill in what you have:

| Variable | Needed for | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | **The coach itself.** Conversation, error analysis, vocabulary, reports. | Scripted canned replies and pattern-matched findings. Not the product. |
| `DEEPGRAM_API_KEY` | Speech recognition with word-level timings. | Browser Web Speech API: you can talk, but pace / pause profile / run length are unavailable and every ASR-prone correction is suppressed (ADR-018). |
| `OPENAI_API_KEY` | The coach's voice (female by default). | Your browser's built-in speech synthesis — we pick the closest female voice it offers and say so when it has none. |
| `DATABASE_URL` | Pointing at Neon / Supabase / your own Postgres. | Embedded PGlite on disk — real Postgres, zero setup (ADR-016). |

### Or run the models locally, for free

If you have [Ollama](https://ollama.com), you can serve any lane from your own machine — zero
cost, and no transcript leaves the device:

```bash
ollama pull llama3.2:3b   # ~2GB, the built-in default

# the sensible first experiment: local conversation, hosted analyzer
ENGCOACH_PROVIDER_HOT=ollama
ENGCOACH_OLLAMA_MODEL=llama3.2:3b

# or go fully local
ENGCOACH_LLM_PROVIDER=ollama
```

The model name is configurable per lane, most specific winning:

```text
ENGCOACH_OLLAMA_MODEL_<LANE>  >  ENGCOACH_OLLAMA_MODEL  >  built-in default
ENGCOACH_MODEL_<LANE>         >  ENGCOACH_MODEL         >  built-in tiered default
```

So one variable covers the usual case, and you can still split — a small fast model for talking,
a bigger one for the analyzer where accuracy matters and latency does not:

```bash
ENGCOACH_OLLAMA_MODEL_HOT=llama3.2:3b
ENGCOACH_OLLAMA_MODEL_COLD=qwen2.5:14b-instruct   # but see the measured result below
```

Names must match `ollama list` exactly.

**Why hot-lane-first.** The conversation is one call per turn and therefore where nearly all the
cost is, and if a small model drifts off persona you notice within a minute. The *analyzer* is the
opposite: it costs almost nothing to run hosted, and a weak model there invents corrections for
English you got right — which is the one failure this product cannot absorb (RISKS.md R2).

So before you point the analyzer at a local model, **measure it** — that is what the eval harness
is for:

```bash
npm run eval:analyzers -- --provider=ollama --model=qwen2.5:7b-instruct --gate
```

Flags rather than `FOO=bar npm run ...`, because that is bash syntax and silently does nothing on
Windows `cmd`. `--limit=20` gives you a fast read before committing to a full run (155 cases
against a local 7B takes ~50 minutes). The harness loads `.env.local` itself (ADR-024).

The gate applies to a local model exactly as it does to a hosted one. Watch the false-positive
guard more closely than the precision figure: small models tend to over-flag.

**A measured result, so you do not have to repeat it:** `qwen2.5:7b-instruct` scored **5.6%
precision** and produced spurious findings on **9 of 10 correct sentences** (ADR-025). It is not
usable as the analyzer. The conversation lane on a local model is a different story — `qwen2.5:3b`
and `llama3.2:3b` both reply well under a second and read fine. Hot-local + cold-hosted keeps ~95% of the cost saving, since
the analyzer is only ~5% of hosted spend.

The trade you are accepting is **latency**, and it depends entirely on your hardware. On a decent
GPU a 7B model keeps inside the ~2s budget; on CPU-only it may not, and you will feel it in every
turn. `npx tsx --tsconfig scripts/tsconfig.json scripts/checkOllama.ts` shows what is pulled and
how each lane is currently routed. See ADR-022.

Restart `npm run dev` after changing `.env.local`. The Settings page shows exactly which
providers are live.

**`ANTHROPIC_API_KEY` is the one that matters.** The other two degrade gracefully; without this
one you are looking at a skeleton.

## Running without credentials

The app is fully functional with no API keys — the conversation loop, policy engine, persistence,
notes rail, report, progress dashboard and adaptive engine all work. What you get instead of a
model is `lib/llm/scripted.ts`: a deterministic stand-in that returns schema-valid responses using
simple pattern matching over about nine very common learner errors.

It is honest about itself everywhere it surfaces:

- every response carries `isLive: false` and a `scripted:` model id
- a persistent banner on the session screen names every degraded provider
- `npm run eval:analyzers` **refuses to report a precision figure** against it and exits non-zero
  under `--gate`

It exists so the machinery can be developed and tested without burning tokens. It is not the
product, and no quality claim in the blueprint is satisfied by it.

---

## Commands

Windows shortcuts:

```text
start.bat        install if needed, start the server, open the browser
setup-keys.bat   create .env.local and open it to paste your API keys
```

```bash
npm run dev              # start the app on :3000
npm run build            # production build
npm start                # run the production build

npm run verify           # typecheck + lint + test + architecture check — the gate
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run check:arch       # dependency-cruiser: enforces the purity boundary (ADR-014)

npm run eval:analyzers            # analyzer precision/recall against the golden fixtures
npm run eval:analyzers -- --verbose --gate

npm run db:push          # create the schema (automatic on first request too)
npm run db:reset         # delete the embedded database entirely
npm run job:purge        # run audio retention purge (ADR-015)
```

> **PGlite is single-writer.** `npm run job:purge` and `npx tsx scripts/inspect.ts` open the same
> data directory as the dev server and will abort each other. Stop `npm run dev` first, or set
> `DATABASE_URL` to a real Postgres. This does not affect normal use of the app.

## Using it

1. **Sign up**, answer two questions, and you are in.
2. **Pick a mode** — Casual (light touch), Coach (more active teaching), or Free Topic (the coach
   picks the subject; good when you are stuck).
3. **Meet Maya.** Your coach is on screen and shows whose turn it is: attentive while you speak,
   subtly animated while thinking, mouth and head moving while she talks. She never reacts to a
   mistake — corrections go to the Notes rail, never to her face. Her voice is female by default;
   swap it in Settings if you prefer.
4. **Talk.** Hands-free ends your turn after a short silence; toggle to hold-to-talk in a noisy
   room, or hold the spacebar. There is a "Type instead" box if the microphone is unavailable —
   it opens automatically when speech recognition is degraded or the mic fails.
5. **Ignore the Notes rail** if you want. Corrections accumulate there silently and never
   interrupt you. Tap "This is wrong" on any of them — that genuinely changes what the coach does.
6. **Tap ↑ on anything you said** to see how it could land better.
7. **End the session** for a sixty-second report: three fixes quoting your own words, phrases
   worth stealing, new vocabulary anchored to the moment it came from, and your numbers.
8. **Progress** shows recurring patterns *with their denominators*, skills with confidence bands,
   and your vocabulary shelf. Anything with too little evidence says "Gathering evidence" rather
   than showing a number it cannot support.

---

## The five design commitments

1. **The pedagogy lives in code, not in prompts.** When to correct, how to score, what to
   practise next — all pure, unit-tested TypeScript in `lib/coaching`, `lib/metrics`,
   `lib/profile`. LLMs *propose candidates*; code *decides*. `npm run check:arch` enforces it.
2. **The voice channel stays conversational; the screen carries the corrections.** At most one
   spoken correction per 3–6 turns, none in the first three, and a frustration brake that
   silences the voice channel entirely after two disputes.
3. **No score without evidence.** Every number traces to a measurement from word-level timings or
   a rubric judgement with a quoted span. Skills below 5 observations across 2 sessions render as
   "gathering evidence", never as a number.
4. **A false correction is worse than a missed one.** Speech recognition drops articles, plurals
   and verb endings — exactly the errors we look for. Dual-confidence gating plus 155 annotated
   eval fixtures exist to stop us confidently correcting things you said correctly.
5. **You should be talking ~70% of the time.** Good pedagogy and, not coincidentally, the largest
   cost lever in the system.

## Document map

| File | What it answers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The operating contract for AI coding sessions. Read before writing code. |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Problem, user, differentiation, modes, MVP/V2/V3 scope |
| [docs/AI_BEHAVIOR.md](docs/AI_BEHAVIOR.md) | **The heart.** Correction policy, error taxonomy, vocabulary engine, learning profile, adaptive engine, scoring |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Voice pipeline, AI lane architecture, prompt architecture, tech stack, repo structure, privacy |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Entities, fields, relationships, retention |
| [docs/UX.md](docs/UX.md) | Session screen, feedback surfaces, report, progress dashboard |
| [docs/ROADMAP.md](docs/ROADMAP.md) | M0–M12 milestones with dependencies, tests, definition of done |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 25 ADRs. Every non-obvious choice, with its alternatives |
| [docs/COSTS.md](docs/COSTS.md) | Cost model, drivers, levers. Assumptions marked. |
| [docs/RISKS.md](docs/RISKS.md) | What will go wrong and what we do about it |
| [docs/STATE.md](docs/STATE.md) | Live handoff — what is built, what is next, open questions |

## Repository layout

```
app/            Next.js routes. app/api/turn is the hot lane (SSE).
components/     UI. session/ is the conversation screen (CoachAvatar + CoachStage).
lib/
  coaching/     PURE. Policy engine, budgets, frustration brake, adaptive focus.
  metrics/      PURE. Fluency and lexical measurement from word timings. No LLM.
  profile/      PURE. Wilson bounds, EWMA, evidence gates, spaced repetition, L2 snapshot.
  analysis/     taxonomy.ts is PURE; the *Analyzer.ts files call models and return data.
  llm/          The only module that talks to a model. Providers (anthropic | ollama |
                scripted), prompt assembly, schemas, per-lane routing.
  voice/        Mic capture, VAD, STT/TTS providers, coach voice registry, chunker, audio queue.
  modes/        Mode registry — configuration, not code paths.
prompts/        Versioned .md with front-matter. Never inline a prompt in a .ts file.
db/             Drizzle schema, client (PGlite | node-postgres), idempotent DDL.
server/         services/ (the three lanes), jobs/, auth.
tests/
  unit/         Heavy on coaching, metrics, profile.
  integration/  Full service flow against a real embedded Postgres.
  evals/        155 annotated learner utterances + the precision harness.
```

## Cost

Roughly **$7–$42/month** at 10–60 minutes a day on a sensible configuration, dominated by the TTS
tier and the hot-lane model. A hard daily spend cap (`ENGCOACH_DAILY_SPEND_CAP_USD`, default
$5.00) is enforced in code before every billable call. Full model in [docs/COSTS.md](docs/COSTS.md).

## Known limitations

**Deliberately out of V1** (see `CLAUDE.md`): barge-in, streaming STT, pronunciation scoring,
negotiation / interview / storytelling modes, mobile app, multi-user, payments.

**Needs credentials to be real:** the coach's replies, analyzer quality, and the voice. The
analyzer precision gate (≥0.90 on blocking findings) is **unverified** — it cannot be measured
without `ANTHROPIC_API_KEY`. Run `npm run eval:analyzers -- --gate` once you have one.

**Environment constraints:** PGlite is single-writer (see the note under Commands). Password reset
is not implemented — single user, and `npm run db:reset` exists.
