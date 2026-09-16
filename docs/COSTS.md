# COSTS.md — Running cost model

## 0. How to read this

**Claude prices are real** (verified 2026-08-22): Opus 5 $5 / $25 per million input / output
tokens; Sonnet 5 $3 / $15 (introductory $2 / $10 through 2026-08-31); Haiku 4.5 $1 / $5.

**Everything marked 🅐 is an assumption** — either a price I am not certain of, or a usage
estimate. Verify the 🅐 lines against current provider pricing before treating any total as fact.
The *structure* of the model and the ranking of the drivers are robust even if individual prices
move; the totals are not.

Rather than trusting these numbers, instrument first: the `LlmCall` table and the TTS character
counter from `ROADMAP.md` M1/M3 exist so that after one week of real use you have your own figures.

---

## 1. Session shape (assumptions)

| 🅐 Assumption | Value | Note |
|---|---|---|
| Session length | 10 min | |
| Talk-time ratio | 70% user / 30% coach | This is a *design target*, not an estimate — see §4 lever 1 |
| Exchanges | ~2/min → 20 turns | |
| User audio per session | 7 min | |
| Coach speech per session | 3 min ≈ 500 words ≈ 2,800 characters | ~25 words/turn, which is what 70/30 forces |
| Stable prompt prefix (L0+L1+L2) | ~1,100 tokens, cached | `ARCHITECTURE.md` §3.1 |
| Fresh input per turn (history + directive) | ~515 tokens avg | |
| Output per turn | ~80 tokens | Short replies are the design |
| Cold-lane batching | 1 analyzer call per 4 turns → 5/session | |
| Cache read price | 0.1× input 🅐 | Standard prompt-caching ratio |
| STT | $0.005 / audio-minute 🅐 | Deepgram-class batch pricing |
| Low-cost neural TTS | $15 / 1M characters 🅐 | OpenAI/Azure-class |
| Premium TTS | ~$200 / 1M characters 🅐 | ElevenLabs-class; varies enormously by plan |

---

## 2. Cost per 10-minute session — default configuration

Opus 5 hot lane, Haiku 4.5 cold lane, Opus 5 report, low-cost TTS.

| Component | Working | Cost | Share |
|---|---|---|---|
| **Hot lane** (20 turns) | per turn: 1,100 cached @ $0.50/M = $0.00055; 515 fresh @ $5/M = $0.00258; 80 out @ $25/M = $0.00200 → $0.00513 × 20 | **$0.103** | 44% |
| **Report** | ~4,000 in @ $5/M + ~800 out @ $25/M | **$0.040** | 17% |
| **TTS** | 2,800 chars @ $15/M 🅐 | **$0.042** | 18% |
| **STT** | 7 min @ $0.005/min 🅐 | **$0.035** | 15% |
| **Cold lane** | 5 calls × (1,200 cached + 250 fresh + 400 out) on Haiku 4.5 | **$0.012** | 5% |
| **Total** | | **≈ $0.23** | |

≈ **$0.023 per minute of conversation.**

---

## 3. Configuration comparison

Per 10-minute session:

| Configuration | Hot lane | Cold | Report | TTS | STT | **Total** | $/min |
|---|---|---|---|---|---|---|---|
| **Default** (Opus 5 / Haiku / Opus 5 / cheap TTS) | $0.103 | $0.012 | $0.040 | $0.042 | $0.035 | **$0.232** | $0.023 |
| **Balanced** (Sonnet 5 / Haiku / Sonnet 5 / cheap TTS) | $0.062 | $0.012 | $0.024 | $0.042 | $0.035 | **$0.175** | $0.018 |
| **Lean** (Haiku everywhere / cheap TTS) | $0.021 | $0.012 | $0.010 | $0.042 | $0.035 | **$0.120** | $0.012 |
| **Default + premium voice** 🅐 | $0.103 | $0.012 | $0.040 | **$0.560** | $0.035 | **$0.750** | $0.075 |

Note what that last row does: a premium voice is **3× the cost of everything else combined**.

---

## 4. Monthly cost for personal use

| Usage | Minutes/mo | Default | Balanced | Lean | Default + premium voice 🅐 |
|---|---|---|---|---|---|
| **10 min/day** | 300 | **$7** | $5 | $4 | $23 |
| **30 min/day** | 900 | **$21** | $16 | $11 | $68 |
| **60 min/day** | 1,800 | **$42** | $32 | $22 | $135 |

Plus fixed infrastructure: **$0–20/month**. Vercel Hobby, Neon or Supabase free tier, Cloudflare
R2 (audio is deleted within 24h so storage is negligible), Sentry free tier. All comfortably
inside free tiers at single-user volume; the $20 is Vercel Pro if you want it.

**Headline: expect $10–25/month at 30 minutes a day** on a sensible configuration — cheaper than
one hour with a human tutor, which is the relevant comparison.

---

## 5. The drivers, ranked

1. **TTS provider tier.** The largest source of *variance* by far — an 8–13× swing. It is 18% of
   the bill on a cheap voice and 75% on a premium one. This is why `TtsProvider` is an interface
   from day one (ADR-004).
2. **Hot-lane model tier.** 44% of the default configuration. A one-line change in
   `lib/llm/models.ts` (ADR-013).
3. **Whether prompt caching actually works.** Without a cacheable prefix the hot lane costs
   roughly 3–4× more — that alone would take the default configuration from $21/mo to ~$50/mo at
   30 min/day. A sustained `cache_read_input_tokens: 0` is a *bug*, not a cost detail
   (`ARCHITECTURE.md` §5.2).
4. **Coach verbosity.** TTS is per character and the hot lane is per output token, so every extra
   word the coach says is charged twice. See lever 1.
5. **Cold-lane batching.** Analysing every turn on a strong model instead of every fourth turn on
   Haiku would multiply this line by roughly 20× and make it the largest item.

---

## 6. Levers, in order of value

1. **Keep the coach's turns short (~25 words).** This is the rare lever that improves the product
   *and* cuts two cost lines at once. The user should be talking 70% of the time
   (`PRODUCT.md` §8), and enforcing that in the prompt and the policy engine is worth roughly 40%
   of TTS spend and a chunk of output tokens. Do not treat the talk-ratio target as a nice-to-have.
2. **Protect the cache prefix.** L2 frozen per session, no timestamps in L0–L2, deterministic
   schema serialisation. Monitor `cache_read_input_tokens` as a health metric with an alert.
3. **Cheap voice by default, premium as an opt-in setting.** Consider a hybrid: a low-cost voice
   for ordinary conversation, a premium voice only for "listen to this said properly" clips, which
   are a tiny fraction of characters.
4. **Cache TTS audio by content hash.** Greetings, drill prompts, mode intros and repeated
   scaffolding phrases are the same every time. A simple key-value cache on
   `hash(voice + text)` eliminates them permanently.
5. **On-device VAD** (already in the design) means silence is never uploaded or billed to STT.
6. **Batch API for anything that can wait.** Weekly rollups, re-scoring history after a prompt
   change, and backfill evals run at 50%. The session report cannot use it — the user is waiting.
7. **A hard daily spend cap in code.** A runaway loop or a stuck retry can spend a month's budget
   in an hour. Check accumulated `LlmCall.cost_usd` before the hot lane and degrade gracefully
   rather than failing. Cheap to build, and the one that prevents a genuinely bad day.
8. **Trim the report input.** Sending every finding to the report model is wasteful — send the
   clustered top-N plus aggregate counts. Roughly halves the report line.

---

## 7. What would change this model at scale

Not a V1 concern, but worth writing down: at multi-user volume, self-hosting Whisper(X) for STT
becomes cheaper than per-minute pricing somewhere in the low thousands of daily minutes, and
self-hosted TTS crosses over sooner than that. Both trade a per-minute bill for a GPU bill plus
operational burden. Neither is worth considering until there is more than one user.
