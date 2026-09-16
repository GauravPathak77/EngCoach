# PRODUCT.md — What we are building and why

## 1. The problem

Adults who already *know* English grammar plateau anyway. The specific failure is not knowledge,
it is **production under real-time pressure with no feedback loop**:

- You speak English in meetings but nobody ever corrects you, because correcting adults is rude.
- Your errors have become *fossilised* — "I have went", "I am having a plan", "discuss about" —
  because nothing has ever interrupted the habit.
- You have a working vocabulary of a few hundred content words and reach for the same ones.
- You avoid structures you are unsure of (perfect tenses, conditionals, passives), so you never
  practise them, so they stay weak. **Avoidance is invisible to every existing tool.**
- You do not know what your actual weaknesses are. Self-assessment is unreliable.

The gap is not "somewhere to practise". It is **an interlocutor with memory, measurement, and a
teaching plan.**

## 2. The user

Primary (and, for V1, only): a working professional, non-native English speaker, roughly B1–C1,
who uses English at work, is not preparing for an exam, and wants to sound more fluent, natural
and persuasive. Motivated, self-directed, will use it 10–30 minutes a day. Has no teacher.

Not the user in V1: absolute beginners (need first-language scaffolding and a different UX),
children (safety and consent), IELTS/TOEFL candidates (score-optimisation is a different product).

## 3. Why this is not ChatGPT voice mode

| | LLM voice mode | Generic learning app | EngCoach |
|---|---|---|---|
| Conversation | Excellent, unbounded | Scripted, shallow | Excellent, but *steered* |
| Notices your errors | Only if asked, then over-corrects | Only inside fixed exercises | Always, silently, with a taxonomy |
| Remembers your errors | No | Only exercise scores | Longitudinal per-rule error rates |
| Notices avoidance | No | No | Yes — tracks obligatory contexts you dodge |
| Objective speech metrics | No | No | wpm, pause profile, filler rate, lexical diversity |
| Plans next session | No | Fixed syllabus | Derived from *your* evidence |
| Talks less than you | No, it dominates | N/A | Targets 70/30 in your favour |

The honest framing: **a general LLM is already a better conversationalist than we will build.
Our edge is entirely in the measurement layer and the policy layer that steers the conversation.**
If we build a slightly-worse chatbot with a grammar checker attached, the project has failed.

## 4. What the experience should feel like

Open the site, press one button, and be talking within two seconds. The coach is warm, curious,
a bit funny, and genuinely interested in your answer — it asks follow-ups about the content of
what you said, not about your grammar. It talks less than you do. Occasionally it will echo your
sentence back correctly without making a thing of it. Sometimes a small card slides into a side
panel while the coach is speaking; you can ignore it entirely.

At the end you press stop and get sixty seconds of genuinely useful feedback: three things to
fix, three phrases worth stealing, and the numbers.

Over weeks, the topics start conspiring against your weaknesses, and you notice you are being
asked about last weekend rather a lot.

**Emotional target:** you should look forward to it and never feel graded during it.

## 5. What the AI does during a conversation

**Does:**
- Listen, and respond to the *meaning* — including meaning you expressed badly.
- Ask one follow-up question per turn, about content.
- Keep its own turns to 2–3 sentences (~40 words) unless deliberately modelling a story.
- Choose topics and scenarios that create obligatory contexts for your weak structures.
- Recast — reuse your sentence correctly inside a natural reply — when policy allows.
- Naturally use the vocabulary items that are due for review.
- Silently accumulate findings for the notes rail and the report.

**Does not:**
- Interrupt mid-utterance (V1: technically cannot; V2+: policy forbids it).
- Say "that is incorrect", "you made a mistake", or use grammar jargon unprompted.
- Correct more than the policy budget allows, ever.
- Ask two questions in one turn.
- Praise emptily. Praise must name a specific thing you did.
- Dominate the conversation, monologue, or explain at length.
- Switch to your first language.
- Invent facts about your history — it only knows the learner snapshot it was given.
- Break character to discuss the app.

## 6. Conversation modes

A "mode" is not a separate engine. It is a tuple:
`{ persona, scenario, correction_intensity, evaluation_rubrics, topic_strategy, turn_length }`.
One conversation engine, one prompt assembly pipeline, a registry of mode configs.
This is the single biggest scope saving in the design — **do not build modes as separate code paths.**

### V1 (MVP)

| Mode | Persona | Correction intensity | Why V1 |
|---|---|---|---|
| **Casual Conversation** | Friendly peer | Low (1 voice correction / ~6 turns) | The default. Proves the core loop. |
| **English Coach** | Warm teacher | Medium (1 / ~3 turns, 1 micro-teach allowed) | Same engine, different config. Nearly free to add. |
| **Free Topic** | Curious host, picks the topic | Follows the above | Solves the cold-start problem — not knowing what to talk about is the top reason practice apps get abandoned. |

### V2

| Mode | Why later |
|---|---|
| **Storytelling Practice** | Needs a discourse-level rubric (structure, arc, redundancy) and a different turn shape — the user speaks for 60–120s uninterrupted, which breaks the turn-taking assumptions of V1. |
| **Job Interview** | High value, crisp well-understood rubric, easy to simulate. Needs a role-consistency mechanism and a scoring pass over the whole session. |

### V3

| Mode | Why last |
|---|---|
| **Negotiation** | Requires the AI to hold a *hidden position, BATNA and concession plan* consistently over 20+ turns, and to score negotiation strategy — a competency orthogonal to English. Genuinely hard to get right and easy to do badly. |
| **Professional Communication** (meetings, presentations, difficult conversations) | Mostly a scenario library over the V2 machinery — cheap once V2 exists, valueless before. |
| **Pronunciation Lab** | Depends on a dedicated pronunciation-assessment service and scripted read-aloud tasks, not free conversation. See `AI_BEHAVIOR.md` §7. |

## 7. MVP definition (V1)

**The V1 promise:** *"Have a real 10-minute spoken conversation in English, and get a report that
tells you three true things about how you speak that you did not already know."*

In scope:

1. Sign in.
2. Pick a mode (3 available), press one button, start talking.
3. Push-to-talk or automatic end-of-turn detection (on-device VAD).
4. Coach replies in voice, ~1.5s after you stop. Streamed.
5. Live captions of both sides.
6. Findings accumulate silently in a Notes rail; policy-selected recasts happen in voice.
7. "Say it better" on demand on any of your sentences.
8. End session → report: top 3 fixes with your actual quotes, 3 better phrasings, 2 vocabulary
   items, objective stats (wpm, fillers per 100 words, talk-time ratio, pause profile).
9. Progress page: session history, recurring mistakes by rule with trend, vocabulary shelf,
   skill estimates *with evidence gating*.
10. Delete-my-data and export.

Explicitly out of V1: streaming STT, barge-in, pronunciation scoring, exercises beyond
"repeat this sentence", storytelling/interview/negotiation modes, mobile app, sharing, payments.

### V2

Streaming STT with partial captions; barge-in; sub-second latency; Storytelling and Interview
modes; pronunciation assessment on scripted tasks; the exercise generator; richer adaptive topic
selection; audio replay of your sentence against the improved version.

### V3

Negotiation and professional-communication scenario library; discourse-level long-form
evaluation; optional speech-to-speech realtime path for Casual mode; multi-voice roleplay (panel
interview); spaced-repetition notifications; possibly a mobile wrapper.

## 8. Success metrics for the product itself

Vanity metrics (sessions, streak) are not evidence the thing works. Track:

- **Talk-time ratio** ≥ 0.65 in the user's favour. If the coach is doing the talking, we failed.
- **Correction acceptance rate**: share of surfaced findings the user does not dispute.
  Target ≥ 0.9. This is our false-positive alarm.
- **Fossilised-error decay**: for the top 3 recurring `rule_tag`s, error rate per 100 words over a
  4-week window should trend down. This is the only real proof of learning.
- **Elicited-structure production**: when the adaptive engine engineers an obligatory context for
  a weak structure, does the user produce it, and correctly? This tracks avoidance breaking down.
- **Voluntary return rate** at day 7 and day 30.
