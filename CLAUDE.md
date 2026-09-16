# CLAUDE.md — Operating contract for AI coding sessions

Read this file, then `docs/STATE.md`, then the milestone you are working on in
`docs/ROADMAP.md`. Do not start coding before you know which milestone you are in.

## Project in one line

Voice-first English communication coach: real conversation + evidence-backed measurement +
adaptive practice. See `README.md`.

## Non-negotiable architectural invariants

These exist to stop architectural drift. Violating one is a bug even if the tests pass.

1. **Purity boundary.** `lib/coaching/`, `lib/metrics/`, `lib/profile/`, `lib/analysis/taxonomy.ts`
   contain **no I/O, no network calls, no LLM calls, no `Date.now()`, no randomness**. Pure
   functions of their inputs. Clock and RNG are injected. These modules are the pedagogy and must
   be deterministic and exhaustively testable.
2. **LLM calls live only in `lib/llm/` (transport) and `server/services/` + `lib/analysis/*Analyzer.ts`
   (callers).** No component, no route handler, no `lib/metrics` file may call a model.
3. **Every LLM call that is not free-form conversation uses structured output** (`output_config.format`
   with a Zod-derived JSON schema from `lib/llm/schemas.ts`). Never parse prose into data.
4. **Every persisted analysis record stores `prompt_version` and `model_id`.** This is what makes
   the eval harness able to re-score history when a prompt changes.
5. **Prompts are files under `prompts/`, versioned via front-matter.** Never inline a multi-line
   prompt string in a `.ts` file. Bumping a prompt's semantics means bumping its `version`.
6. **The correction decision is made by `lib/coaching/policy.ts`, never by a model.** Analyzers
   emit candidate findings with confidence; the policy engine decides what is suppressed,
   recorded, shown on screen, spoken, or drilled.
7. **No new runtime dependency without an ADR entry** in `docs/DECISIONS.md`.
8. **Layering is enforced, not remembered.** `npm run check:arch` (dependency-cruiser) fails the
   build on an illegal import. If you need a new edge, change the rule *and* write an ADR.

## Definition of done for any task

A task is done when **all** of these are true. Do not report completion otherwise.

- [ ] `npm run verify` passes (`typecheck` + `lint` + `test` + `check:arch`)
- [ ] New pure logic in `lib/coaching|metrics|profile` has unit tests covering every branch
- [ ] Anything touching analyzer prompts has been run through `npm run eval:analyzers` and the
      precision/recall numbers are reported in your summary (a regression is a blocker)
- [ ] `docs/STATE.md` updated: what you completed, what is next, any new open question
- [ ] Any non-obvious choice appended to `docs/DECISIONS.md` as a numbered ADR
- [ ] Your final message contains the **Task Report** below

## Task Report format (end every coding task with this)

```
## Changes
- <file>: <what and why>

## Decisions
- <choice made, alternative rejected, reason>  (mirror into DECISIONS.md if architectural)

## Deviations from the blueprint
- <none, or: what and why — this is the drift alarm, be honest>

## Test evidence
- npm run verify: <pass/fail, key output>
- new tests: <names, what they pin down>
- eval:analyzers (if touched): precision <x> recall <y> vs baseline <a>/<b>
```

## How to give me work (for the human)

- **One task = one vertical slice, ≤ ~8 files.** "Implement M5" is too big. "M5.2: analyzer
  service + prompt + schema, no UI" is right.
- Use this prompt shape:
  ```
  Task: <id + one line>
  Read first: CLAUDE.md, docs/STATE.md, docs/ROADMAP.md#<milestone>, <2-3 relevant docs sections>
  Constraints: <invariants that apply>
  Files expected to change: <list>
  Tests required: <list>
  Definition of done: <copy from ROADMAP>
  Do NOT touch: <adjacent areas>
  ```
- Reviewing: read the Task Report first, then diff against the DoD, then run
  `/code-review` on the branch. Do not review line-by-line before checking the DoD.

## Context between sessions

`docs/STATE.md` is the handoff. It is updated at the end of *every* task, not every milestone.
If `STATE.md` is stale, stop and reconstruct it from git log before writing code.

## Style

- TypeScript strict. No `any` outside a documented boundary adapter.
- Prefer pure functions and plain data over classes. Classes only for provider adapters.
- Comment *why*, not *what*. The pedagogy modules should carry references to the rule in
  `docs/AI_BEHAVIOR.md` they implement, e.g. `// AI_BEHAVIOR.md §3.2 rule 4 (voice budget)`.
- No premature abstraction: a second provider is when you extract an interface, not the first.
  (Exception: `TtsProvider` and `SttProvider` are interfaces from day one — see ADR-004/005.)

## Things that are deliberately NOT in scope for V1

Do not build these even if they seem easy: barge-in, streaming STT, pronunciation scoring,
negotiation mode, mobile app, multi-user/social, payments, native-speaker marketplace,
gamified streaks beyond a session count. See `docs/PRODUCT.md` §7.
