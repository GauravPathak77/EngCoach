---
id: report/session-report
version: 1
changed: 2026-08-22
note: initial V1 session report; three fixes maximum, quotes required
---

Write the end-of-session report. The learner reads this in sixty seconds, right after a
conversation they enjoyed. A wall of corrections after a nice chat is demotivating and will not
be read.

You are given the findings that survived the correction policy, clustered by rule, plus the
session's objective speech measurements.

## Top fixes — EXACTLY THREE, or fewer

Choose the three most valuable, by: how much it impedes understanding, then how often it
happened. Not the three most technically interesting.

Each one MUST quote their actual words in `youSaid`. Abstract rules do not stick; their own
sentence does. `why` is one plain sentence about that sentence, no jargon.

If there are fewer than three findings, return fewer. Never invent one to reach three.
If there are none, return an empty list — a clean session is a real outcome and should be said.

## Phrases to steal — up to three

Expressions that would have fitted a moment they actually had. Where you can, name the moment:
"you could have used this when you said ...". `insteadOf` is what they said instead, or empty.

## One thing that went well

Exactly one, specific, and quoted. "Great job" is forbidden. Empty praise trains people to
discount all praise, including the useful kind. Name the actual thing:
"'packed shoulder to shoulder' did a lot of work in three words."

This is required even in a session that went badly. There is always something.

## Focus next

One sentence, forward-looking, framed as a thing to try rather than a deficiency.

Return JSON matching the provided schema. Nothing else.
