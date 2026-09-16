/**
 * Turn directives — prompt layer L4 (ARCHITECTURE.md §3.1).
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 *
 * This is the policy engine's entire influence over what the coach says. Terse and imperative,
 * capped at roughly 40 tokens, and appended *after* the cached prefix so it never invalidates
 * the session's prompt cache (ADR-007).
 */

import type { ScoredFinding, TurnDirective } from '@/lib/types';

export const NO_DIRECTIVE: TurnDirective = {
  text: 'No corrections this turn. Respond to what they said and ask one follow-up question.',
  kind: 'none',
  ruleTag: null,
};

/**
 * A directive that also steers the topic toward an obligatory context for a weak structure.
 * Used when the policy engine has nothing to correct but the adaptive engine has a focus skill
 * (AI_BEHAVIOR.md §6.2 — elicitation, not instruction).
 */
export function elicitationDirective(elicitation: string, ruleTag: string): TurnDirective {
  return {
    text: `No corrections this turn. Ask one follow-up question that naturally invites this: ${elicitation}`,
    kind: 'none',
    ruleTag,
  };
}

export function buildDirective(
  kind: 'recast' | 'micro_teach' | 'drill',
  finding: ScoredFinding,
): TurnDirective {
  const corrected = finding.suggestedSpanText ?? finding.suggestedUtterance ?? '';
  const original = finding.originalSpanText;

  switch (kind) {
    case 'recast':
      // The single most valuable technique in the product: reuse the corrected form inside a
      // natural, content-focused reply. No metalanguage, no interruption, no "actually".
      return {
        text:
          `RECAST: they said "${original}" — the correct form is "${corrected}". ` +
          `Weave the corrected form naturally into your reply as if you were simply ` +
          `responding to them. Do NOT point out the mistake, name a rule, or explain. ` +
          `Then continue the conversation.`,
        kind,
        ruleTag: finding.ruleTag,
      };

    case 'micro_teach':
      return {
        text:
          `MICRO-TEACH: one short, friendly sentence about "${original}" → "${corrected}", ` +
          `plus one quick example. No grammar jargon. Then return to the conversation ` +
          `immediately with a follow-up question.`,
        kind,
        ruleTag: finding.ruleTag,
      };

    case 'drill':
      return {
        text:
          `DRILL: warmly invite them to say this one sentence back to you: "${finding.suggestedUtterance ?? corrected}". ` +
          `Keep it light and brief, then carry on the conversation.`,
        kind,
        ruleTag: finding.ruleTag,
      };
  }
}
