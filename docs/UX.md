# UX.md — Interface design

Three surfaces. Everything else is settings.

## The governing rule

**Nothing on screen may compete for attention while the user is speaking or thinking.**

Speaking a second language is cognitively expensive. A badge, a highlight, a sound, or a card
sliding in mid-utterance will break the sentence the user is building. So:

- Correction cards animate in **only while the coach is speaking**.
- No sounds, ever, other than the coach's voice.
- No modals during a session.
- No red. Corrections are neutral-toned, never error-coloured. This is a conversation, not a
  linter.

## 1. Session screen

```
┌──────────────────────────────────────────────────────────┬─────────────────┐
│                                                          │  NOTES      (3) │
│                                                          │                 │
│                      ╭─────────╮                         │  ┌───────────┐  │
│                      │  MAYA   │   ← coach avatar        │  │ went, not │  │
│                      ╰─────────╯      (idle / listening  │  │ have went │  │
│                     "Listening…"       / thinking /      │  │ ·········  │  │
│                                        speaking / error) │  └───────────┘  │
│                                                          │  ┌───────────┐  │
│    "I have went to the market yesterday and I buy        │  │ take a    │  │
│     some clothes"                          ← your words  │  │ photo ↗   │  │
│                                                    [↑]   │  └───────────┘  │
│                                                          │                 │
│    Oh nice — so you went to the market yesterday and     │                 │
│    bought some clothes. What did you pick up?            │                 │
│                                                          │                 │
├──────────────────────────────────────────────────────────┤                 │
│  ●  09:24        ▓▓▓▓▓▓▓░░░ you 71%          [ End ]     │                 │
└──────────────────────────────────────────────────────────┴─────────────────┘
```

**The coach.** *(Revised by ADR-021. The original argument is kept below, because most of it
still holds.)*

The session screen shows **Maya**, a fictional female English coach, drawn as inline SVG. Five
states — idle, listening (the halo responds to your input level), thinking, speaking, error —
so whose turn it is reads before any text does. She is attentive while you speak, subtly animated
while thinking, and her mouth and head move while she talks.

**She never reacts to a mistake.** No frowns, no colour changes, no head shakes; her brows are
fixed across every state. Corrections belong on the screen, not on her face.

*Originally this section argued for an abstract orb instead:* a rendered or video avatar costs
real money per minute, sits squarely in the uncanny valley, ages badly, and — most importantly —
a face pulls the eye, when listening is the skill we are training. That reasoning still stands
against **photoreal video** avatars, and ADR-021 respects it. Maya is a hand-drawn vector
character: no per-minute cost, no network fetch, no phoneme-level lip sync, and deliberately
stylised rather than photoreal so she does not become tiring over ten minutes. The orb survives
as the fallback if the avatar ever fails to render.

**Captions.** Your utterance appears as it is transcribed (V1: on completion; V2: streaming
partials). The coach's reply appears as text while it is spoken, word-synced where the TTS gives
us timings. Captions are essential — they let the user *see* the recast land, which is what makes
recasts work.

**The `[↑]` affordance** on your own bubbles is Say It Better on demand. One tap, no menu.

**The talk-time bar** is small, always visible, and the only live "score" on the screen. It is the
one number that is honest in real time and it nudges the right behaviour (talk more) rather than
inducing self-consciousness about correctness.

**The Notes rail** is collapsible, silent, and carries a count badge. Cards are compact:
the fix, one line of why, and the tap target for more. Repeats increment a small counter on the
existing card rather than adding a new one — seeing "×3" is more useful than seeing three cards.

On narrow screens the rail becomes a bottom sheet, collapsed by default, with the same badge.

**Controls.** One primary control. Push-to-talk (hold space / hold the button) and hands-free VAD
mode are the same button with a toggle in settings — hands-free is the better experience but
push-to-talk is the reliable fallback in a noisy room, and both must exist in V1.

**Failure states matter here more than usual.** Mic denied, no speech detected, STT failed,
network dropped mid-turn — each needs a calm in-place message and a retry, never a thrown-away
turn. A lost turn in a spoken conversation is far more disruptive than a failed page load.

## 2. Session report

Shown immediately on End. The design constraint is **sixty seconds** — anything longer is not
read, and a wall of corrections after a nice conversation is actively demotivating.

```
  10:24 with the coach · Casual                            [ ● replay ]

  ─── The three things ─────────────────────────────────────────
  1  Past tense with irregular verbs               ×4 this session
     you said   "I have went to the market"
     better     "I went to the market"
     why        with a finished past time ("yesterday"), use went
                                                    [ this is wrong ]
  2  ...
  3  ...

  ─── Steal these ──────────────────────────────────────────────
     "it slipped my mind"   instead of  "I forgot it"
     "take a photo"         you said    "make a photo"
     "that's on me"         conversational · you had a slot for it when
                            you said "sorry, it was my fault"

  ─── Your numbers ─────────────────────────────────────────────
     Speaking pace   118 wpm     ▁▃▅▆▅   steady
     Fillers         6 / 100 w   ▇▅▄▃▂   down from 9 last week
     You talked      71%         ✓
     Longest run     14 words    ▂▃▄▅▆   up

  ─── One thing that went well ─────────────────────────────────
     Your description of the market was vivid and easy to follow —
     "packed shoulder to shoulder" did a lot of work in three words.
```

Notes on why it is shaped this way:

- **Exactly three fixes.** Not "all 17 findings". The rest are recorded and visible in Progress if
  the user goes looking. Three is what a person can hold.
- **Every fix quotes the user's actual words.** Abstract rules do not stick; your own sentence does.
- **"this is wrong" on every card** is the dispute affordance. It costs one tap, it feeds the
  suppression list and the frustration brake, and it is our precision alarm
  (`AI_BEHAVIOR.md` §3.3). It must be present and easy — a product that cannot be told it is wrong
  will lose the user's trust silently rather than loudly.
- **The numbers carry sparklines against the user's own history**, not against native speakers.
  "118 wpm" alone is meaningless; "118, up from 104" is the whole point.
- **One specific positive, last.** Named and quoted, never "great job". Empty praise trains the
  user to discount all praise, including the useful kind.

## 3. Progress dashboard

Four blocks, in this order:

**a. The headline — an outcome, not a grade.**
> "3 of your top 5 recurring mistakes are down this month."

**b. Recurring mistakes.** The most useful view in the product. Ranked by frequency, each showing
error rate per 100 words with a 4-week trend arrow and the count of obligatory contexts (so the
user can see the denominator). Tapping one shows every instance across every session, with the
quotes. This is the fossilised-error hit list and it is what proves the product works.

**c. Skills.** A radar or bar set over grammar / vocabulary / fluency / clarity / naturalness —
with **confidence bands drawn, and dimensions at `insufficient` evidence rendered as a greyed
"gathering evidence"** rather than a number (`AI_BEHAVIOR.md` §6.1). This is unusual and it is
correct: showing a confident number from two conversations is how a product loses credibility the
first time the user disagrees with it.

Confidence proxies (hedging, self-repair, fillers, response latency) are shown here as a labelled
group of observations, explicitly *not* aggregated into a confidence score (`AI_BEHAVIOR.md` §7.3).

**d. Vocabulary shelf.** Items grouped by state — *learning / recognised / you've used it /
yours now* — with the anchor sentence on each. Watching an item move from "learning" to "yours
now" is the most satisfying progression in the app and it should be the most visually rewarding
thing on the page.

Plus a session history list, and total minutes practised.

## 4. Onboarding — the part that decides whether this gets used

Three screens, then talking. No placement test.

1. **Why + mic permission**, with a plain sentence about what is sent where and that audio is
   deleted within 24 hours.
2. **Two questions**: what do you use English for, and what bothers you most about your English.
   These seed `goals` and give the cold-start conversation something to be about.
3. **Straight into a 3-minute Free Topic conversation.** No settings, no mode picker. The first
   session's real purpose is to gather baseline evidence — which is exactly why the profile must
   render "gathering evidence" afterwards rather than a verdict.

The first report should show the numbers and *one* fix, not three. A first session that returns a
list of everything wrong with you is the fastest way to lose a user.

## 5. Accessibility and practicalities

- Full keyboard operation; space is push-to-talk.
- Captions are the accessibility path for the audio, and they are already core, so this is free.
- Respect `prefers-reduced-motion` — the avatar animations are suppressed, which is why the
  speaking state also carries a static equaliser indicator. The state must never be conveyed by
  motion alone.
- The avatar is `aria-hidden`; the coach state is announced as live text in a `role="status"`
  region, so it is never picture-only.
- Dark mode from the start; this is used in the evening.
- Session state survives a page reload — an interrupted 15-minute session must not be lost.
