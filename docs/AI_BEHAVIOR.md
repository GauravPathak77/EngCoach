# AI_BEHAVIOR.md — The pedagogy specification

This is the most important document in the project. Everything here is implemented as **pure,
unit-tested TypeScript** in `lib/coaching/`, `lib/metrics/`, `lib/profile/` and
`lib/analysis/taxonomy.ts`. The LLM proposes; this code decides.

Section numbers here are referenced from code comments. If you change a rule, change the number
and the comment together.

---

## 1. The conversation loop

Worked example. User says:

> "I have went to the market yesterday and I buy some clothes."

What happens, in order:

| Stage | Where | Latency budget | Output |
|---|---|---|---|
| 1. Transcribe | STT | ~400ms | Words + timings + per-word confidence + fillers |
| 2. Metrics | `lib/metrics` (pure) | <5ms | wpm 118, 1 pause 640ms, 0 fillers, MLR 11 |
| 3. Assemble context | `lib/llm` | <5ms | L0–L4 prompt stack (§8) |
| 4. Reply | Conversation LLM, streamed | ~600ms to first token | Natural reply, shaped by turn directive |
| 5. Speak | TTS, sentence-chunked | ~300ms to first audio | Audio |
| 6. **Analyse** | Cold lane, async, batched | off critical path | Candidate findings + structure observations |
| 7. **Decide** | `lib/coaching/policy.ts` (pure) | <1ms | suppress / record / show / speak / drill |
| 8. Surface | Notes rail or next turn directive | — | Silent card, or a recast next turn |

**Steps 6–8 never block steps 4–5.** The user's experience is a conversation; the analysis
catches up behind it.

The reply the user hears is something like:

> "Oh nice — so you **went** to the market yesterday and **bought** some clothes. What did you pick up?"

That is a **corrective recast**: the coach reuses the corrected form inside a natural,
content-focused reply. No metalanguage, no interruption, no "actually". This is the single most
valuable technique in the product and it is what makes it feel like a person rather than a
checker. It is also cheap — it is one line in the turn directive.

Meanwhile, silently: two findings recorded (`past_simple/irregular_verb`,
`tense_consistency/narrative_past`), plus a structure observation that a past-narrative
obligatory context occurred and was attempted.

---

## 2. Findings: the error detection schema

The schema in the brief is a good start but is missing the things that make the system safe and
aggregatable. Improved:

```ts
type Finding = {
  id: string
  session_id: string
  turn_id: string
  utterance_id: string

  // --- classification ---
  type: 'grammar' | 'lexical_choice' | 'naturalness' | 'register'
      | 'discourse' | 'clarity' | 'repetition' | 'filler'
      | 'fluency' | 'pronunciation'
  rule_tag: string          // canonical taxonomy id — THE aggregation key. e.g. 'grammar.past_simple.irregular'
  subtype?: string          // free-text nuance, never aggregated on

  // --- anchoring (so the UI can highlight, and so we can re-evaluate) ---
  span: { word_start: number; word_end: number }   // indices into the utterance word array
  original_span_text: string
  original_utterance: string
  suggested_span_text: string | null               // minimal fix
  suggested_utterance: string | null               // full corrected sentence

  // --- teaching ---
  explanation_short: string    // <= 90 chars, learner-facing, no jargon
  explanation_long?: string    // fetched on demand only
  example?: string             // one contrasting example

  // --- confidence and safety ---
  severity: 'blocking' | 'notable' | 'polish'
  llm_confidence: number       // 0..1, reported by the analyzer
  asr_confidence: number       // 0..1, min per-word confidence over the span
  combined_confidence: number  // computed in code, §3.1
  is_asr_suspect: boolean      // computed in code, §3.1

  // --- lifecycle ---
  status: 'suppressed' | 'recorded' | 'shown_visual' | 'spoken' | 'drilled'
  surfaced_at?: Date
  user_feedback?: 'agreed' | 'disagreed' | null    // the user can dispute. CRITICAL.

  // --- provenance ---
  prompt_version: string
  model_id: string
  created_at: Date
}
```

**What changed and why:**

| Addition | Why it matters |
|---|---|
| `rule_tag` from a closed taxonomy | Free-text categories cannot be counted. Without a closed vocabulary there is no "you did this 14 times this month", and therefore no product. |
| `span` word indices | Enables inline highlighting, and lets us join a finding to the exact ASR confidence of the words involved. |
| `asr_confidence` + `is_asr_suspect` | Speech recognition systematically drops articles, plurals and verb inflections — precisely our error categories. Without this we will confidently correct things the user said correctly. See §3.1. |
| `severity` defined by *comprehensibility* | Not "how wrong". `blocking` = a listener would misunderstand or stall. This is what makes prioritisation meaningful. |
| `status` lifecycle | Separates *detected* from *shown*. Most findings are never shown. The report is built from `recorded`, not from what was spoken. |
| `user_feedback` | The user disputing a correction is the highest-value signal in the system: it feeds the frustration brake, the suppression list, and our precision metric. |
| `prompt_version` + `model_id` | Lets the eval harness re-run history when a prompt changes and diff the findings. Without this, prompt changes are unverifiable. |

### 2.1 Structure observations — the missing denominator

A finding table alone measures **errors**, not **error rate**. A talkative user looks worse than a
quiet one. So the analyzer must also emit, for the structures we track:

```ts
type StructureObservation = {
  utterance_id: string
  rule_tag: string        // same taxonomy
  obligatory_context: boolean  // the sentence *required* this structure
  produced: boolean            // the user attempted it
  correct: boolean             // and got it right
}
```

This gives us three things nothing else does:
- **Error rate** = errors / obligatory contexts, per rule.
- **Avoidance detection**: `obligatory_context && !produced` — the user restructured the sentence
  to dodge the form. Fossilised avoidance is invisible to every competing product.
- **Mastery evidence**: correct productions, which is what actually moves a skill estimate up.

### 2.2 The taxonomy (`lib/analysis/taxonomy.ts`)

A closed, versioned list of `rule_tag`s, each with: id, human label, parent category, default
severity, `asr_prone: boolean`, and an `elicitation_strategy` (see §6.2). Roughly 60–90 tags at
V1. Illustrative:

```
grammar.tense.past_simple.irregular       asr_prone: true   elicits: personal narrative
grammar.tense.present_perfect.vs_past     asr_prone: false  elicits: life experience, recent changes
grammar.article.definite                  asr_prone: true   elicits: describing a process / a picture
grammar.article.indefinite                asr_prone: true
grammar.preposition.dependent             asr_prone: false  ("discuss about", "depend of")
grammar.agreement.subject_verb            asr_prone: true
grammar.countability                      asr_prone: true   ("informations", "many advice")
grammar.conditional.second                asr_prone: false  elicits: hypotheticals, negotiation
grammar.word_order.question               asr_prone: false
lexical.overuse                           asr_prone: false  (good, nice, very, thing, get, do)
lexical.collocation                       asr_prone: false  ("make a photo" -> "take a photo")
lexical.register_mismatch                 asr_prone: false
naturalness.calque                        asr_prone: false  ("I am having a plan")
naturalness.wordiness                     asr_prone: false
discourse.missing_connective              asr_prone: false
discourse.no_topic_sentence               asr_prone: false
clarity.run_on                            asr_prone: false
clarity.abandoned_clause                  asr_prone: false
filler.hedge_density                      asr_prone: false
```

`asr_prone` is the flag that drives §3.1 suppression. It is not optional.

---

## 3. Correction policy — immediate vs delayed

Implemented in `lib/coaching/policy.ts`. **Pure function**:

```ts
decide(
  candidates: Finding[],
  state: SessionState,     // turn index, budgets spent, mode, disputes, focus skills
  config: ModeConfig,
  settings: UserSettings,
): PolicyDecision            // { suppressed[], recorded[], visualCards[], turnDirective, drill? }
```

### 3.1 Gate 1 — safety filtering (runs before anything else)

```
combined_confidence = llm_confidence * (asr_prone ? asr_confidence : 1)

is_asr_suspect     = asr_prone && asr_confidence < 0.80

DROP entirely if:
  - is_asr_suspect                                    // never correct what we may have misheard
  - combined_confidence < 0.70
  - rule_tag is on the user's suppression list        // disputed twice, or manually muted
  - the span overlaps an audio region flagged low-SNR
```

This gate is the difference between a coach and an annoyance. **It runs before the finding is
recorded, not before it is shown** — a finding we are not confident about should not pollute the
learning profile either.

### 3.2 Gate 2 — channel budgets

Everything surviving Gate 1 gets `status: 'recorded'`. Then:

**Voice channel** (interrupts the flow, so it is rationed hard):

| Rule | V1 value |
|---|---|
| Max recasts per session | `ceil(turns / recast_interval)`, `recast_interval` = 3 (Coach) / 6 (Casual) / ∞ (user opted out) |
| Recast eligibility | `severity == 'blocking'` **OR** `rule_tag ∈ session.focus_skills` |
| Selection among eligible | highest severity, then highest combined_confidence, then oldest |
| Explicit micro-teach (one sentence + one example, spoken) | Max **1 per session**. Coach mode only. Only for the *primary* focus skill. Only after the same `rule_tag` has occurred ≥2 times this session. Only at a topic boundary. |
| Repeat-after-me drill | Max **2 per session**, Coach mode only, opt-in only, focus skill only |
| Never | mid-utterance, two corrections in one turn, or any correction in the first 3 turns (warm-up) |

**Visual channel** (silent, non-interrupting, therefore generous):

| Rule | V1 value |
|---|---|
| Cards per 8-turn segment | ≤ 3, ranked by severity then focus-alignment |
| Timing | Cards animate in **only while the coach is speaking**, never while the user is speaking or during the silence after their turn |
| Sound | None. Ever. |
| Dedup | One card per `rule_tag` per segment; repeats increment a counter on the existing card |

**End of session:** the report is built from all `recorded` findings, clustered by `rule_tag`,
regardless of what was surfaced live.

### 3.3 Gate 3 — the frustration brake

Any of these sets `voice_corrections_remaining = 0` for the rest of the session and logs a
`FrustrationEvent`:

- The user disputes 2 findings in one session.
- The user says anything matching a stop-intent ("stop correcting me", "just talk normally") —
  detected by the conversation LLM as a structured side-channel flag, not by regex alone.
- Three consecutive user turns shorter than 5 words after a correction (disengagement proxy).

Two disputes of the same `rule_tag` across sessions adds it to the persistent suppression list
and raises a review flag for the eval fixture set. **The user is allowed to be right.**

### 3.4 Why a code policy and not "tell the LLM to be tasteful"

Three reasons, all load-bearing:
1. **Consistency.** Prompt-based restraint drifts turn to turn and model to model.
2. **Tunability.** "Correct less" becomes a config change with a test, not a prompt rewrite.
3. **Testability.** Every rule above has a unit test. `decide()` is deterministic, so we can
   assert "in a 20-turn Casual session with 14 candidates, at most 3 are spoken".

---

## 4. Say It Better

### The problem with the brief's version

Showing My version / Natural / Professional / Persuasive for every sentence would be
overwhelming and would also be *wrong* — most of what you say in casual conversation should not
be professionalised. Register is contextual; four variants imply a ladder where the last rung is
best. It is not.

### The design

**Triggers** (V1):
- **On demand, unlimited** — every user caption bubble has a small "↑" affordance. This is the
  main path and it is user-controlled, which solves overwhelm entirely.
- **Automatic, once per session** — on the user's most *invested* utterance: longest, or highest
  improvement headroom (most `polish`-severity findings + lowest lexical diversity). Appears as a
  card in the Notes rail, never spoken.

**Output shape** — two variants by default, expandable:

```
You said        "I think this idea is good because many people will use it."

More natural    "I think it's a good idea — a lot of people would find it useful."
                why: 'a lot of' is more idiomatic than 'many' in speech;
                     'would find it useful' is more specific than 'will use it'

+ Show professional / persuasive
```

The second variant is chosen by **mode**, not fixed: Casual → natural only; Coach → natural +
one register the user is working on; Interview mode (V2) → professional; Negotiation (V3) →
persuasive.

**Rules:**
- Every variant must preserve the user's *meaning and voice*. If the rewrite says something the
  user did not say, it is a bug — the analyzer prompt states this explicitly and the eval fixtures
  test for meaning drift.
- The `why` line is one clause, no jargon, and names a concrete lever ("more idiomatic",
  "more specific", "shorter").
- Never more than 4 variants. Never a variant labelled "best".
- Saved as an artifact so it lands in the report and can be replayed.

---

## 5. Vocabulary engine

### 5.1 The rule that makes it work

**Every vocabulary item is mined from something the user actually tried to say.** No wordlists, no
"word of the day". The engine looks for three signals in the transcript:

1. **Overuse** — a lemma in the user's top-N content words across the last 5 sessions, or repeated
   ≥3 times within one session (`good`, `nice`, `very`, `thing`, `get`, `do`, `make`, `people`).
2. **Circumlocution** — the user talked *around* a word ("the thing you put the papers in",
   "the person who checks the money"). The analyzer flags these explicitly; they are the highest
   value items because the concept is already in the user's head.
3. **Register mismatch** — the user reached for a word that exists but is wrong for the context.

Then propose an alternative at **level + 1** — comprehensible but not yet productive. Beyond that
it is noise the user will never use.

**Volume caps:** max 3 new items introduced per session, max 2 review items reinforced. This is
not a limitation, it is the design — 3 words genuinely acquired per session is ~1000 a year.

### 5.2 Item states

```
candidate ──introduce──> introduced ──recognised in input──> recognised
    │                                                            │
    │                                            used after prompt│
    │                                                            ▼
    └────────────────────────────────────────────────────> used_prompted
                                                                 │
                                                 used unprompted │
                                                                 ▼
                                                        used_spontaneous
                                                                 │
                                     3 spontaneous uses, ≥14 days│
                                                                 ▼
                                                             retained
```

Demotion: an item at `used_spontaneous` that is not produced across two due reviews drops back to
`recognised`.

### 5.3 Reinforcement — the part everyone skips

Flashcards do not create productive vocabulary. Reinforcement happens **inside the conversation**:

1. **Seeding.** At review time, the item is placed in the learner snapshot (prompt layer L2) with
   a directive: *"use `haggle` naturally in one of your next 3 turns"*. The coach uses it; if the
   user shows comprehension, the item advances to `recognised`.
2. **Eliciting.** The topic strategy steers toward a context where the item is the natural word
   ("so how did the price conversation go?"). If the user produces it unprompted →
   `used_spontaneous`. This is the goal state.
3. **Visual nudge.** At most 2 target words shown quietly at the edge of the session screen. Never
   modal, never required.

**Spaced repetition schedule** (in `lib/profile/srs.ts`): due intervals 1, 3, 7, 16, 35, 90 days.
Success advances one step; failure resets to the previous interval, not to zero. Due items are
selected at *session start* and injected into L2, so the session's cached prompt prefix stays
stable (see `ARCHITECTURE.md` §5.2 — this matters for cost).

### 5.4 Slang, idioms and phrasal verbs

Same engine, plus a mandatory **register label** on every item. `VocabularyItem.register` is one of:

| Register | Example | Coach must say |
|---|---|---|
| `neutral` | *postpone* | — |
| `conversational` | *put off* | "everyday spoken English" |
| `professional` | *defer* | "good in a work email" |
| `formal` | *adjourn* | "quite formal — meetings, writing" |
| `slang` | *ghost (someone)* | "casual, with friends — don't use it with your boss" |
| `sensitive` | mild expletives, loaded idioms | "you'll hear this, but I would not use it at work" |

Rules:
- **An idiom or slang item is only introduced when the user's own utterance had a natural slot
  for it.** Never "here is a cool phrase". Teaching slang for its own sake produces learners who
  sound like a phrasebook — worse, not better.
- Register and appropriateness are part of the item, not an afterthought. An item without a
  register label fails schema validation.
- `sensitive` items are **recognition-only** — explained if the user asks or encounters one, never
  seeded for production.
- Phrasal verbs are the highest-value category for a B1–C1 professional and should be weighted up
  in candidate selection; they are the main gap between "correct" and "native-sounding".

Example card:

```
"That's on me."
Meaning   That's my responsibility / my mistake.
Register  conversational — friendly, common at work too
Contrast  formal: "I take responsibility for that."
You could have used it when you said: "sorry, it was my fault about the report"
```

That last line — anchoring to the user's own utterance — is what makes it stick and is required
on every item.

---

## 6. The learning profile and adaptive engine

### 6.1 What is stored and how proficiency is computed

Two layers. **Do not conflate them.**

**Layer A — objective measurements** (`lib/metrics/`, pure, computed from STT word timings, no
LLM involved). These are facts:

| Metric | Definition | Why it is meaningful |
|---|---|---|
| Speech rate | words / total time | Gross fluency |
| Articulation rate | words / (time − pauses > 250ms) | Fluency without hesitation confound |
| Silent pause profile | count + total duration of pauses > 500ms, split mid-clause vs clause-boundary | **Mid-clause pauses are the real hesitation signal**; boundary pauses are normal |
| Filler rate | fillers per 100 words (needs STT disfluency output) | Directly actionable |
| Mean Length of Run | mean words between pauses/disfluencies | The classic second-language fluency measure |
| Repair rate | self-corrections + restarts per 100 words | Uncertainty proxy |
| Response latency | coach-stop → user-start | Processing load |
| Talk-time ratio | user speech time / total | Product health + engagement |
| Lexical diversity | MTLD over the session (not raw type-token ratio — TTR is length-dependent and will lie) | Vocabulary range |
| Frequency-band profile | share of content lemmas outside the top 2000 most frequent | Vocabulary depth |

**Layer B — judged estimates** (rubric-based, LLM, evidence-quoted): naturalness, clarity,
coherence, storytelling, persuasion. These get **bands, not numbers** (see §7).

**Skill estimate record:**

```ts
type SkillEstimate = {
  skill: string            // 'grammar.tense.past_simple' | 'fluency' | 'clarity' | ...
  value: number            // 0..1
  evidence_count: number   // n observations contributing
  variance: number
  confidence: 'insufficient' | 'low' | 'medium' | 'high'
  last_updated: Date
  trend_28d: number        // signed delta
}
```

**Update rules** (`lib/profile/estimate.ts`, pure):

- *Accuracy-type skills* (any `grammar.*`): the observation is `correct / obligatory_contexts`
  from §2.1. Store as a Beta-Binomial and report the **Wilson lower bound at 90%**, not the raw
  proportion. This is the mathematically correct answer to "don't judge from one conversation":
  with 2 observations the lower bound is near zero regardless of outcome, so the system is
  *automatically* uncertain about new evidence without any special-casing.
- *Continuous metrics* (fluency, lexical): EWMA with an adaptive rate,
  `α = min(0.30, 1 / (n + 1))` — fast adaptation for the first few sessions, stable later.
- *Judged skills*: EWMA over rubric band midpoints, with a hard requirement that each observation
  carried ≥1 quoted evidence span; observations without evidence are discarded at ingest.

**Evidence gating — the rule that prevents nonsense:**

```
confidence = insufficient  if evidence_count < 5 or sessions_contributing < 2
             low           if evidence_count < 12
             medium        if evidence_count < 30
             high          otherwise
```

A skill at `insufficient` is **never displayed as a number, never used to select a focus skill,
and never mentioned in a report.** The UI renders "gathering evidence". A single bad conversation
therefore cannot produce a verdict — structurally, not by convention.

**Outlier damping:** a session whose observation is >2σ from the running estimate is down-weighted
by half. One session with a cold, or a bad microphone, should not move the profile far.

### 6.2 The adaptive engine

**Focus selection** — at session start, `lib/coaching/focus.ts` scores every candidate weakness:

```
priority = severity_weight
         × recency_weight(last_error_at)       // decays over ~21 days
         × (1 - mastery)                        // Wilson lower bound
         × srs_due_multiplier                   // 1.0, or 2.0 if a scheduled review is due
         × goal_alignment                       // user-stated goals, e.g. "interviews"
         × novelty_penalty                      // avoid the same focus 3 sessions running
```

Select exactly **one primary and one secondary focus.** Not five. A session that tries to fix
five things fixes none, and the voice budget only permits a handful of interventions anyway.

**The key move: elicitation, not instruction.** Each `rule_tag` in the taxonomy carries an
`elicitation_strategy` — a description of a conversational context that makes the structure
*obligatory*. The focus skills do not become "tell the user about the past perfect"; they become
topic and question selection in prompt layer L2:

| Weak structure | Engineered context |
|---|---|
| `past_simple`, narrative past | "Tell me what happened at the weekend" / recounting a trip |
| `present_perfect` vs past | "What have you been working on lately?" / changes since last time |
| `conditional.second` | Hypotheticals, advice-giving, "what would you do if…" |
| `article.definite` | Describing a process, giving directions, explaining a diagram |
| `preposition.dependent` | Opinion questions that pull specific verbs (*depend on*, *apply for*) |
| `passive` | Describing how something is made / a process with no clear agent |
| Comparatives | Comparing two options, tools, cities |

Then the **avoidance check**: if the obligatory context occurred and the user restructured to
dodge it (`obligatory_context && !produced`), that is recorded and *raises* the priority of the
structure rather than lowering it. Avoidance is a stronger signal of weakness than error.

**Difficulty control** — one dial, adjusted ±1 notch per session based on recent success, that
simultaneously moves the coach's own lexical level, sentence complexity, speech rate, and the
abstractness of its questions. One dial, not four independent ones — four dials produce incoherent
combinations and are untunable.

---

## 7. Scoring — and what we refuse to score

### 7.1 The rule

**No score is displayed unless we can show the evidence behind it.** Every number on the progress
page is either (a) a direct measurement from Layer A, or (b) a rubric band with quoted spans.
Tapping any score reveals its evidence. If we cannot produce evidence, the dimension does not get
a number.

### 7.2 Dimension by dimension

| Dimension | How | Displayed as |
|---|---|---|
| **Grammar** | Wilson lower bound of correct/obligatory per rule, aggregated by category, weighted by severity | Number + per-rule breakdown |
| **Vocabulary** | MTLD + frequency-band profile + count of items at `used_spontaneous` | Number + word list |
| **Fluency** | Composite of articulation rate, mid-clause pause density, MLR, filler rate — each normalised against the user's own baseline, not against native speakers | Number + the four components |
| **Clarity** | Rubric, 4 bands, requires ≥1 quoted span per judgement; corroborated by `clarity.run_on` / `abandoned_clause` finding density | Band + quotes |
| **Naturalness** | Rubric + density of `naturalness.*` and `lexical.collocation` findings per 100 words | Band + examples |
| **Coherence / Storytelling** | Rubric over a whole long turn (V2 — needs the storytelling mode's turn shape) | Band + structural notes |
| **Persuasion** | Rubric over a whole session, V3 only | Band |
| **Pronunciation** | See §7.4 | V2, scripted tasks only |
| **Confidence** | See §7.3 | **Proxy signals only, never a score** |

### 7.3 Confidence is not scoreable — pushback on the brief

The brief asks for a confidence score. We should not ship one. Hesitancy in a second language is
mostly *processing load*, not personality; a fluent speaker in their strongest topic will read as
"confident" and the same person on an unfamiliar topic will read as "unconfident". A number here
would be both wrong and demoralising, and it is the kind of judgement that erodes trust in every
other number on the page.

What we do instead: display the **observable proxies**, labelled as such, with no aggregate:
hedging density (*maybe, I think, sort of, kind of*), self-repair rate, filler rate, mean response
latency, and mean turn length. These are real, actionable, and the user can draw their own
conclusion. If we later want a single number, it needs validation against something external —
until then, proxies only.

### 7.4 Pronunciation — pushback on the brief

Free-conversation pronunciation scoring is the most over-promised feature in this category. An
LLM reading a transcript cannot assess pronunciation at all — the transcript is already the
recogniser's *best guess at correct English*, so mispronunciations are silently normalised away.

Three honest options:

1. **Proxy signals from STT (V1, free).** Per-word confidence dips, and words the recogniser
   consistently gets wrong for this user but not in general, indicate probable pronunciation
   trouble. Reportable as "these words seem to come out unclearly" — a hint, never a score. Cheap
   and genuinely useful.
2. **Dedicated pronunciation assessment on scripted tasks (V2, correct).** A read-aloud task with
   known reference text scored by a purpose-built service (Azure Speech Pronunciation Assessment
   is the mature option) returning per-phoneme accuracy, fluency, completeness and prosody. This
   is real assessment, but it requires the *reference text to be known*, which is why it belongs
   in a Pronunciation Lab mode rather than in free conversation.
3. **Phoneme scoring of spontaneous speech.** Not reliable enough at any price. Do not attempt.

**Decision: ship (1) in V1 labelled as a hint, ship (2) in V2 as a distinct mode. Never claim
pronunciation scoring on free conversation.**

### 7.5 Session score vs progress score

- **Session score** is a *sample*, and is presented that way: "this session" with the session's
  own numbers, no attempt at a single grand total. Single-session totals invite comparing two
  sessions that had different topics, lengths and moods.
- **Progress score** is the EWMA/Wilson estimate over the trailing window, shown as a trend line
  with a confidence band. The band is the honest part: early on it is wide, and the user can see
  the system is not yet sure.
- **The headline number on the dashboard is not a score at all.** It is
  *"3 of your top 5 recurring mistakes are down this month"* — outcome, not grade.
