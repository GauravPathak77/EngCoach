# RISKS.md — What will go wrong

Ordered by expected damage. Each risk names the mechanism in the design that addresses it — a
mitigation that is not implemented somewhere is a wish, not a mitigation.

---

## R1 · The conversation is not enjoyable · **critical**

Everything else is downstream of this. If talking to the coach is boring, awkward, or feels like
an interview, no amount of analysis matters — the user simply stops opening the app, and every
other risk becomes moot.

**Signals** Sessions under 4 minutes. Talk-time ratio below 0.5. Day-7 return under 30%.

**Mitigation**
- `ROADMAP.md` M3 mandates a real 10-minute conversation *with yourself* before any analysis is
  built. This is the cheapest possible moment to discover the conversation is bad.
- Turn-length caps, one-question-per-turn, and the "no empty praise" rule in the core prompt.
- Free Topic mode exists specifically to kill the cold-start problem, which is the most common
  cause of abandonment in practice apps.
- Talk-time ratio is a tracked product metric, not a vanity stat.

---

## R2 · False corrections · **critical**

Correcting something the user said correctly is the fastest way to destroy trust, and it is
*likely* rather than possible: speech recognisers systematically drop articles, plurals and verb
inflections — exactly the categories we detect. "I went to the shops" transcribed as "I went to
the shop" becomes a fabricated article error.

**Mitigation**
- `asr_prone` flag on every taxonomy entry, and the ASR-suspect gate (`AI_BEHAVIOR.md` §3.1):
  any `asr_prone` finding with word confidence < 0.80 is dropped **before it is recorded**, not
  merely before it is shown.
- `combined_confidence = llm_confidence × asr_confidence` with a 0.70 floor.
- The eval harness (ADR-012) with ≥30 deliberately-correct utterances that must produce zero
  findings; CI gate at precision ≥ 0.90 on `blocking`. Recall is explicitly secondary.
- A one-tap dispute affordance on every card, feeding the suppression list, the frustration brake,
  and a precision metric.
- Every dispute becomes a new eval fixture, so precision improves with use.

---

## R3 · The coach feels like a classroom · **high**

Over-correction is the default failure mode of every language-learning LLM prompt. One correction
too many per turn and the user stops speaking freely, which destroys the fluency practice that is
the point.

**Mitigation**
- The policy engine (ADR-002) rations the voice channel: ≤1 correction per 3–6 turns, none in the
  first 3 turns, never two in one turn. Property-tested over 1000 generated sessions.
- Channel separation: corrections go to the *screen*, silently; voice is reserved for recasts.
- Recasts rather than metalanguage — the correct form appears inside a natural reply.
- The frustration brake zeroes the voice budget after two disputes or a stop-intent.
- The report shows exactly three fixes, not everything found.

---

## R4 · Hallucinated grammar explanations · **high**

Models are confidently wrong about grammar rules, especially edge cases, and a learner has no way
to detect it. A wrong explanation is worse than none — it plants a false rule.

**Mitigation**
- `explanation_short` is capped at ~90 characters and must describe *this sentence*, not state a
  general rule. Short, concrete explanations have far less room to be wrong.
- The closed taxonomy means each `rule_tag` can carry a **canonical, human-written explanation
  template**; the model fills the slots rather than authoring the grammar. Do this for the top 20
  tags — it removes the risk on the 80% case entirely.
- Meaning-preservation eval fixtures for Say It Better: a rewrite asserting something the user did
  not say is a test failure.
- `explanation_long` is fetched on demand, so the expensive-to-verify content is rare.

---

## R5 · Voice latency makes it feel dead · **high**

Above roughly 2.5 seconds, turn-taking breaks down and users start talking over the coach or
repeating themselves.

**Mitigation**
- Sentence-chunked TTS in V1 — the largest perceived-latency win available, and cheap.
- Streaming LLM output; TTS starts on the first sentence boundary.
- On-device VAD: no network round trip for turn detection.
- M3's definition of done is a *measured* p50 < 2.0s, recorded in `STATE.md`, not "it feels fine".
- Barge-in is first in the V2 queue; it converts the remaining latency from a defect into a
  non-issue because the user can simply talk over it.
- If latency proves unfixable in the pipeline, ADR-001 documents the speech-to-speech escape
  hatch for Casual mode.

---

## R6 · Cost runaway · **medium-high**

A retry loop, a stuck stream, or an accidentally-invalidated prompt cache can multiply the bill
quietly. A caching regression alone is 3–4× on the largest line item.

**Mitigation**
- `LlmCall` telemetry with `cached_input_tokens` from M1 — before there is anything to spend money
  on.
- Alert on sustained `cache_read_input_tokens: 0` (`ARCHITECTURE.md` §5.2).
- A hard daily spend cap checked before the hot lane, degrading gracefully (`COSTS.md` §6 lever 7).
- TTS character counting per turn from M3.
- Model tier and TTS provider both isolated to a single file each.

---

## R7 · Fake-feeling scores destroy credibility · **medium-high**

The first time the app tells the user their "Confidence: 62" and they disagree, every other number
on the page becomes suspect — including the ones that are sound.

**Mitigation**
- No score without evidence; tapping any number reveals the quotes or measurements behind it.
- Evidence gating (ADR-010): fewer than 5 observations across 2 sessions renders as "gathering
  evidence", never a number.
- No confidence score at all (ADR-008) — proxies only, labelled.
- No pronunciation score on free conversation (ADR-009).
- Objective metrics are normalised against the user's own history, not against native speakers.
- The dashboard headline is an outcome ("3 of your top 5 mistakes are down"), not a grade.

---

## R8 · The learning loop does not actually teach · **medium-high**

The quiet risk: everything works, the user enjoys it, and after three months their English is
unchanged. Entirely plausible — conversation practice alone plateaus, which is the premise of the
product.

**Mitigation**
- Fossilised-error decay is a tracked metric (`PRODUCT.md` §8): error rate per 100 words on the top
  3 recurring rules over a 4-week window. If it does not trend down, the pedagogy is wrong and we
  need to know.
- The denominator (`StructureObservation`) makes error *rate* measurable, so improvement is
  distinguishable from talking less.
- Avoidance detection catches the specific failure where the user gets "better" by dodging hard
  structures.
- Elicitation over instruction (`AI_BEHAVIOR.md` §6.2) — engineering obligatory contexts is the
  intervention most likely to actually work, and it is testable.
- Vocabulary items must reach `used_spontaneous`, not just `introduced`.

**Accept honestly:** we cannot validate learning outcomes without either a control or an external
assessment. The metrics above are the best available proxy, not proof.

---

## R9 · Privacy exposure · **medium**

Voice is biometric-adjacent, captures bystanders, and practice transcripts are personal. A breach
here is not recoverable by apology.

**Mitigation**
- Audio purged within 24h by default (ADR-015); `words` retained instead, carrying all the
  analytical value.
- Server-side keys only; ephemeral scoped tokens if the browser ever talks to a provider directly.
- Retention constants in one tested file; a purge job with an injected clock, tested at +25h.
- Hard delete with an integration test asserting empty tables and bucket.
- Named sub-processor list in-app; provider no-training/zero-retention options enabled where
  offered.
- No third-party analytics on any page where the mic is live.

---

## R10 · Architectural drift across many coding sessions · **medium**

Over 12 milestones and dozens of sessions, "just this once" accumulates: an LLM call in a
component, a policy decision moved into a prompt, a free-text category. The specific end state is
a system whose behaviour nobody can explain.

**Mitigation**
- `npm run check:arch` (ADR-014) — the purity boundary is machine-enforced, and set up in M0
  before there is anything to violate.
- `CLAUDE.md` invariants plus the mandatory Task Report with an explicit "Deviations" section.
- `docs/STATE.md` updated every task, not every milestone.
- Append-only `DECISIONS.md`.
- Closed taxonomy enforced by the output schema, so a model *cannot* invent a category.

---

## R11 · Deceptive quality of "understanding" · **medium**

The coach responds fluently to badly-formed input — which is desirable — but this means the user
may believe they were understood clearly when a human would have struggled. We could be training
comprehensibility *downward*.

**Mitigation**
- `severity: blocking` is defined by comprehensibility ("would a listener misunderstand or
  stall?"), not by grammatical wrongness. Blocking findings always surface.
- The coach is instructed to ask a genuine clarifying question when meaning is actually ambiguous,
  rather than guessing — which is both better pedagogy and more realistic.
- V2 candidate: an occasional "how a stranger might have heard that" note.

---

## R12 · Scope explosion · **medium**

The brief describes ten modes, an exercise engine, pronunciation scoring and negotiation
simulation. Building toward all of it produces a shallow version of everything.

**Mitigation**
- `PRODUCT.md` §7 draws a hard V1 line; `CLAUDE.md` lists what is deliberately out of scope.
- Modes are configuration, not code paths (ADR-011), so the *right* kind of breadth stays cheap.
- The roadmap gates each milestone on a checkable definition of done, and M5 explicitly says do
  not proceed if precision is below target.

---

## R13 · Single-user blind spot · **low-medium**

Built by one person for one person, tuned to one accent, one first language, one microphone. Every
threshold — VAD trailing silence, ASR confidence floors, difficulty calibration — will be fitted
to a sample of one.

**Mitigation**
- Keep thresholds in named configuration constants, not scattered literals.
- The eval fixture set should include utterances from more than one accent and first language even
  in V1 — cheap insurance against baking in a personal calibration.
- Treat every threshold as provisional and comment it with how it was chosen.
