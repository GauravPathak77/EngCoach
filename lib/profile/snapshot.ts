/**
 * The learner snapshot — prompt layer L2 (ARCHITECTURE.md §3.1, ADR-007).
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 *
 * This is the entire long-term memory the conversation model sees. It is generated ONCE at
 * session start and FROZEN for the session — mutating it mid-session would invalidate the
 * prompt cache on every turn and roughly triple the hot-lane cost (COSTS.md §5). Anything that
 * needs to change mid-session rides in layer L4 (the turn directive) instead.
 *
 * Compact by design: ≤ ~300 tokens. A model given a wall of history will start referencing it,
 * which reads as surveillance rather than coaching.
 */

import type { SkillEstimate, VocabStateRecord } from '@/lib/types';
import { difficultyGuidance, elicitationFor } from '@/lib/coaching/focus';
import { isDisplayable } from './estimate';

export type SnapshotInput = {
  levelCefr: string | null;
  nativeLanguage: string | null;
  interests: readonly string[];
  goals: readonly string[];
  difficulty: number;
  focus: { primary: string | null; secondary: string | null };
  /** Label for each focus rule, resolved by the caller from the taxonomy. */
  focusLabels: Record<string, string>;
  /** Fallback steering when there is no evidence-backed focus yet. */
  warmUpElicitation: string | null;
  /** Vocabulary items the coach should seed into its own speech this session. */
  vocabToSeed: readonly VocabStateRecord[];
  /** Vocabulary items to steer toward so the user has a chance to produce them. */
  vocabToElicit: readonly VocabStateRecord[];
  /** Rules the user disputed or muted — the coach must not act on these. */
  suppressedRuleTags: readonly string[];
  /** Displayable skill estimates only; `insufficient` ones are filtered by the caller. */
  skills: readonly SkillEstimate[];
  sessionCount: number;
};

/**
 * Build the L2 text.
 *
 * Deterministic: the same input always produces byte-identical output. That matters more than
 * it looks — a snapshot that varies (a timestamp, a shuffled list) silently destroys the cache
 * prefix and the cost model with it (ARCHITECTURE.md §5.2).
 */
export function buildSnapshot(input: SnapshotInput): string {
  const lines: string[] = ['## Learner notes'];

  if (input.sessionCount === 0) {
    lines.push(
      'This is their first session. You know nothing about them yet — be curious and let them lead.',
    );
  }

  const identity: string[] = [];
  if (input.levelCefr) identity.push(`Level: ${input.levelCefr}`);
  if (input.nativeLanguage) identity.push(`First language: ${input.nativeLanguage}`);
  if (identity.length > 0) lines.push(identity.join('. ') + '.');

  // Focus is expressed as a TOPIC DIRECTION, never as a grammar target the coach announces.
  // AI_BEHAVIOR.md §6.2: elicitation, not instruction.
  const primaryElicitation = elicitationFor(input.focus.primary);
  const secondaryElicitation = elicitationFor(input.focus.secondary);
  const steer = primaryElicitation ?? input.warmUpElicitation;

  if (steer) {
    lines.push(`Steer the conversation toward this kind of talk: ${steer}`);
    if (secondaryElicitation && secondaryElicitation !== steer) {
      lines.push(`If it fits naturally, also: ${secondaryElicitation}`);
    }
    lines.push(
      'Do NOT mention that you are steering, and do NOT name any grammar point. Make it feel like your own curiosity.',
    );
  }

  if (input.interests.length > 0) {
    lines.push(`Things they are interested in: ${input.interests.slice(0, 6).join(', ')}.`);
  }
  if (input.goals.length > 0) {
    lines.push(`What they use English for: ${input.goals.slice(0, 3).join('; ')}.`);
  }

  if (input.vocabToSeed.length > 0) {
    const words = input.vocabToSeed.map((v) => `"${v.lemma}"`).join(', ');
    lines.push(
      `Use ${words} naturally somewhere in your next few turns, as if you just happened to. Do not define or highlight them.`,
    );
  }
  if (input.vocabToElicit.length > 0) {
    const words = input.vocabToElicit.map((v) => `"${v.lemma}"`).join(', ');
    lines.push(
      `Try to create a moment where ${words} would be the natural thing for them to say. Do not prompt for them directly.`,
    );
  }

  if (input.suppressedRuleTags.length > 0) {
    const labels = input.suppressedRuleTags
      .map((tag) => input.focusLabels[tag] ?? tag)
      .slice(0, 5)
      .join(', ');
    lines.push(`Never comment on: ${labels}. They have told us to leave these alone.`);
  }

  const displayable = input.skills.filter(isDisplayable);
  const strengths = displayable
    .filter((s) => s.value >= 0.75)
    .slice(0, 2)
    .map((s) => s.skill.split('.').slice(-1)[0]);
  if (strengths.length > 0) {
    lines.push(`They are solid on: ${strengths.join(', ')}.`);
  }

  lines.push(difficultyGuidance(input.difficulty));

  return lines.join('\n');
}

/**
 * A compact estimate of the snapshot's token cost, so the caller can assert the ≤300 token
 * budget in a test. Roughly 4 characters per token for English prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
