# STATE.md — Live handoff

**Update this at the end of every task, not every milestone.** If it is stale, stop and
reconstruct it from git log before writing code.

---

## Current phase

**V1 implemented, plus the post-V1 voice + avatar enhancement.** All twelve V1 milestones are built, wired together, and verified end to end
against a running server. `npm run verify` passes: 383 tests, typecheck, lint, architecture guard.

## Milestone status

| # | Milestone | Status | Note |
|---|---|---|---|
| M0 | Foundation | ✅ | Architecture guard set up first and **proven** to fail on a deliberate purity violation, then reverted. CI workflow added. |
| M1 | Conversation loop (text) | ✅ | SSE streaming, L0–L4 prompt assembly, three modes, `LlmCall` telemetry with cache-hit tracking. |
| M2 | Ears | ✅ | Mic capture + on-device level VAD + Deepgram adapter. Browser-speech fallback per ADR-018. |
| M3 | Voice | ✅ | Sentence chunker, ordered audio queue, OpenAI TTS adapter + browser fallback, TTS character counting. |
| M4 | Metrics (pure) | ✅ | Fluency + lexical + session aggregation. 30 unit tests, hand-computed fixtures. |
| M5 | Error analysis + eval harness | ⚠️ | Built and running. **155 fixtures** (105 error / 50 correct). Precision gate **UNVERIFIED** — needs `ANTHROPIC_API_KEY`. |
| M6 | Policy engine | ✅ | All of AI_BEHAVIOR §3 implemented. 29 tests incl. the 1000-session property test. |
| M7 | Notes rail + report | ✅ | Verified in the browser: 3 cards surfaced, dispute affordance works, report renders. |
| M8 | Vocabulary engine | ✅ | Mining, SRS ladder, seeding into L2, production detection (prompted vs spontaneous). |
| M9 | Profile + progress | ✅ | Wilson bounds, evidence gates, "Gathering evidence" rendering, denominators shown. |
| M10 | Adaptive engine | ✅ | 7 integration tests prove the loop closes, incl. avoidance outranking error. |
| M11 | Say It Better | ✅ | On-demand ↑ affordance + one automatic per session, mode-dependent registers. |
| M12 | Privacy + retention | ✅ | 24h audio purge, pinned clips survive, export, hard delete verified empty across 18 tables. |

## Post-V1 enhancements

| Change | Status | Note |
|---|---|---|
| Female coach voice by default | ✅ | ADR-020. Provider-agnostic key ('female' | 'male') in `lib/voice/tts/voices.ts`; OpenAI `sage` for female. Legacy raw voice ids migrate on read. Settings exposes the choice. |
| Browser-voice fallback | ✅ | Name-hint matching with a word-boundary guard; reports honestly when the platform has no matching voice instead of pretending. |
| Coach avatar ("Maya") | ✅ | ADR-021. Hand-authored inline SVG, no new dependency, no image asset. Five states driven by the real TTS lifecycle. Error boundary falls back to the original orb. |
| Local models via Ollama | ✅ | ADR-022. Per-lane provider AND model selection from env (`ENGCOACH_OLLAMA_MODEL[_LANE]`); JSON-schema constrained decoding preserves invariant 3. Never auto-selected. Quality **unmeasured** — no model pulled on this machine. |
| Scripts load .env.local | ✅ | ADR-024. `tsx` does not load env files, so the eval harness silently reported on the scripted stand-in while the user's config said otherwise. Plus `--provider/--model/--limit` flags, because `FOO=bar npm run` is bash-only. |
| **Local analyzer MEASURED and rejected** | ✅ | ADR-025. qwen2.5:7b-instruct: **5.6% precision, 9 of 10 clean sentences falsely flagged.** Cold lane now defaults to the scripted stand-in. |
| Session banner is per-lane | ✅ | It said "the coach is running on scripted replies" whenever ANY lane was scripted, misdescribing a working local conversation. |
| Provider/model lookup unified | ✅ | ADR-023. `providers.ts` and `models.ts` each read the provider env separately and only one validated it, so an invalid per-lane value routed a lane to Ollama while asking for a Claude model. Now share `providerNames.ts`. |
| Default local model is llama3.2:3b | ✅ | ADR-026. The 7B was in the config only to serve the analyzer, which ADR-025 rejected. Session report **29s -> 6.3s**; nothing shipped now needs a model above 3B. |
| Speaking watchdog | ✅ | A speech engine that never fires `onend` used to strand the avatar in SPEAKING with the Talk button disabled. Length-based timeout now guarantees the return to idle. |

## Next

Two things, in order:

1. **Add `ANTHROPIC_API_KEY` and run `npm run eval:analyzers -- --gate`.** This is the only V1
   definition-of-done still open. If blocking precision lands below 0.90, ROADMAP.md M5 is
   explicit: narrow the taxonomy until it clears, and record the decision as an ADR.
2. **Have a real 10-minute spoken conversation** with a Deepgram key attached (ROADMAP.md M3's
   instruction). Record the measured latency and cost in the table below.
3. **The analyzer needs a hosted key.** ADR-025 measured the local option and it is not viable.
   The cold lane is the *cheapest* hosted lane (~5% of spend, COSTS.md §2), so buying just that
   one keeps almost all the saving from running the conversation locally. Set
   `ENGCOACH_PROVIDER_COLD=anthropic` once `ANTHROPIC_API_KEY` is present.
4. **If going local (ADR-022):** `ollama pull llama3.2:3b` (the default), then
   `npm run eval:analyzers -- --provider=ollama --model=<name> --limit=20 --gate` before letting
   a local model near the analyzer (flags, not `FOO=bar` prefixes — ADR-024). Hot-lane-local needs
   no gate — just talk to it and judge the latency.

Then V2 begins with barge-in.

## Open questions

| # | Question | Status |
|---|---|---|
| 1 | Neon or Supabase? | **Resolved** — neither is required. Embedded PGlite by default, `DATABASE_URL` swaps to either (ADR-016). |
| 2 | Confirm STT provider | Deepgram adapter implemented and is the documented default (ADR-005). Needs a real accent test with credentials. |
| 3 | Which TTS voice, premium worth it? | **Partly resolved** — the default is now female (`Maya`, OpenAI `sage`) per ADR-020. Whether a premium provider is worth the multiple in `COSTS.md` §3 is still open, and is a one-line change behind `TtsProvider`. |
| 4 | Model tier: Opus 5 or Sonnet 5 for the hot lane? | **Open by design** (ADR-013). One-line change in `lib/llm/models.ts`; decide from your own `LlmCall` rows after a week. |
| 5 | Native language / target accent | Assumed Hindi L1, neutral target. Set per-user at onboarding; affects nothing structural. |
| 6 | Where do eval fixtures come from? | **Resolved** — 155 hand-written and checked in. Grow the set from real disputes: every dispute is a free labelled negative. |

## Deferred / parked

- Barge-in, streaming STT — V2, first in the queue
- Pronunciation assessment service selection — V2, ADR-009
- Password reset — single-user V1, `npm run db:reset` exists
- Voice gateway service — only if the ephemeral-token path fails (`ARCHITECTURE.md` §4.3)

## Measurements

| Metric | Target | Actual | When |
|---|---|---|---|
| user-stop → transcript p50 | < 1.0s | **not measured** — needs Deepgram credentials | M2 |
| user-stop → first audio p50 | < 2.0s | **not measured** — needs TTS credentials | M3 |
| analyzer precision (`blocking`) | ≥ 0.90 | **UNVERIFIED** — scripted provider cannot satisfy the gate | M5 |
| analyzer false positives on clean speech | 0 | **0 / 50** (scripted provider; re-run live) | M5 |
| cache hit rate (hot lane) | > 0 sustained | **not measured** — scripted provider reports 0 tokens | M1 |
| observed cost per 10-min session | ~$0.23 | **$0.00** (scripted) | M3 |
| local model analyzer precision | ≥ 0.90 | **not measured** — no Ollama model pulled | ADR-022 |
| local model hot-lane latency | < 2.0s | **~650ms warm** (llama3.2:3b, first token ~180-220ms); qwen2.5:3b ~200-400ms. Cold start after Ollama unloads the model is **~6.0s** | ADR-022 / 026 |
| local session-report latency | (none set) | **6.3s** (llama3.2:3b), down from **29s** (qwen2.5:7b-instruct) | ADR-026 |
| local model analyzer precision | ≥ 0.90 | **5.6% — FAILED** (qwen2.5:7b-instruct, 20-case subset). 9/10 clean utterances falsely flagged. | ADR-025 |
| voice budget never exceeded | always | ✅ property-tested over 1000 generated sessions | M6 |
| policy: 20 turns / 14 candidates → ≤3 spoken | ≤ 3 | ✅ 3 spoken, 14 recorded | M6 |

## Implementation notes worth knowing

- **PGlite is single-writer.** `npm run job:purge` and `scripts/inspect.ts` must not run while
  `npm run dev` holds the same data directory. Both scripts warn in their header. Setting
  `DATABASE_URL` removes the constraint.
- **Typed input is not speech input.** The turn request carries `source: 'speech' | 'typed'`.
  Conflating them silently suppressed every ASR-prone correction on typed turns until end-to-end
  testing caught it.
- **The talk-time ratio needs measured speech duration.** A typed session has none, and the report
  renders "Gathering evidence" rather than "0% — aim higher".
- **Model names resolve at call time, not module load.** They used to be module-level consts
  reading `process.env` once at import, which silently ignored a late-loaded `.env.local` while
  the provider check read env fresh — an inconsistency waiting to bite. Blank values are treated
  as unset, because `.env` files are full of `FOO=`.
- **Ollama unloads an idle model after ~5 minutes**, so the first turn of a session pays a
  ~3.9s model-load penalty while warm turns run at ~200-400ms. `OLLAMA_KEEP_ALIVE=30m` on the
  Ollama server avoids it. This is an Ollama setting, not an app one.
- **Ollama is never auto-selected.** A running local server is not consent to route the product
  through it; `ENGCOACH_LLM_PROVIDER` or a per-lane override must say so explicitly.
- Seven ADRs were added after the blueprint: **016** (PGlite), **017** (forced tool use for
  structured output), **018** (browser-speech honesty), **019** (email/password auth),
  **020** (coach voice registry, female default), **021** (inline-SVG coach avatar),
  **022** (local models via Ollama, per-lane).
- **The avatar never reacts to mistakes.** Her brows are fixed across every state and a test
  asserts it. Corrections stay on the screen, never on her face.
- **The ERROR coach state is derived, not stored** — `error && machine === 'idle'`. A stored
  error state would have needed a transition at every failure site and could get stuck.
- `npx tsx --tsconfig scripts/tsconfig.json scripts/previewAvatar.ts` renders all five avatar
  states to `.data/avatar-preview.html` — the one part of the app a test assertion cannot review.
