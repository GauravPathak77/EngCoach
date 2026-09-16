/**
 * The correction policy engine — AI_BEHAVIOR.md §3, ADR-002.
 *
 * PURE MODULE (CLAUDE.md invariant 1 and 6). No I/O, no clock, no randomness, no model.
 *
 * The analyzer proposes candidate findings with a confidence. THIS decides what happens to each
 * one: suppressed, recorded, shown on screen, spoken, or drilled. That decision must never move
 * back into a prompt — prompt-based restraint drifts turn to turn, cannot be unit-tested, and
 * turns "correct a bit less" into a prompt rewrite instead of a config change (AI_BEHAVIOR.md §3.4).
 */

import type {
  CandidateFinding,
  DecidedFinding,
  ModeConfig,
  PolicyDecision,
  ScoredFinding,
  SessionState,
  TurnDirective,
  UserSettings,
  VisualCard,
  Word,
} from '@/lib/types';
import { getRule, isAsrProne, renderExplanation } from '@/lib/analysis/taxonomy';
import {
  brakeEngaged,
  drillAllowed,
  microTeachAllowed,
  visualCardsRemaining,
  voiceChannelOpen,
} from './budgets';
import { buildDirective, NO_DIRECTIVE } from './directive';

/** Below this, we are not confident enough to record the finding at all. AI_BEHAVIOR.md §3.1. */
export const MIN_COMBINED_CONFIDENCE = 0.7;

/** An asr-prone rule whose words came back below this confidence is presumed misheard. */
export const ASR_SUSPECT_THRESHOLD = 0.8;

/** Audio below this signal-to-noise estimate makes every finding on it unsafe. */
export const MIN_SNR = 0.35;

/**
 * Gate 1 — safety filtering. AI_BEHAVIOR.md §3.1.
 *
 * This is the difference between a coach and an annoyance. Note that it runs before the finding
 * is *recorded*, not merely before it is shown: a finding we are unsure about must not pollute
 * the learning profile either, or the adaptive engine will start steering the conversation at a
 * weakness the user does not have.
 */
export function scoreFinding(
  candidate: CandidateFinding,
  words: Word[],
  snrEstimate: number | null,
): ScoredFinding {
  const asrConfidence = spanConfidence(candidate, words);
  const asrProne = isAsrProne(candidate.ruleTag);

  // An asr-prone rule is discounted by how well we heard the words it is about; a rule the
  // recogniser does not affect (word order, collocation) is not penalised for audio quality.
  const combinedConfidence = asrProne
    ? candidate.llmConfidence * asrConfidence
    : candidate.llmConfidence;

  const lowSnr = snrEstimate !== null && snrEstimate < MIN_SNR;
  const isAsrSuspect = (asrProne && asrConfidence < ASR_SUSPECT_THRESHOLD) || lowSnr;

  return {
    ...candidate,
    asrConfidence: round3(asrConfidence),
    combinedConfidence: round3(combinedConfidence),
    isAsrSuspect,
  };
}

/** Lowest per-word confidence across the finding's span — the weakest link decides. */
function spanConfidence(candidate: CandidateFinding, words: Word[]): number {
  const { wordStart, wordEnd } = candidate.span;
  if (words.length === 0) return 1;
  const start = Math.max(0, Math.min(wordStart, words.length - 1));
  const end = Math.max(start, Math.min(wordEnd, words.length - 1));
  let min = 1;
  for (let i = start; i <= end; i++) {
    const word = words[i];
    if (word && word.c < min) min = word.c;
  }
  return min;
}

type Gate1Result = { kept: ScoredFinding[]; dropped: DecidedFinding[] };

export function applyGate1(
  scored: ScoredFinding[],
  suppressedRuleTags: readonly string[],
): Gate1Result {
  const suppressed = new Set(suppressedRuleTags);
  const kept: ScoredFinding[] = [];
  const dropped: DecidedFinding[] = [];

  for (const finding of scored) {
    const reason = gate1Rejection(finding, suppressed);
    if (reason === null) {
      kept.push(finding);
    } else {
      dropped.push({ ...finding, status: 'suppressed', reason });
    }
  }
  return { kept, dropped };
}

function gate1Rejection(finding: ScoredFinding, suppressed: Set<string>): string | null {
  if (!getRule(finding.ruleTag)) {
    // ADR-003: the analyzer is schema-constrained to the taxonomy, but a schema can be
    // bypassed by a malformed response. An unknown tag cannot be aggregated, so it is useless.
    return `unknown rule_tag "${finding.ruleTag}"`;
  }
  if (finding.isAsrSuspect) {
    return `asr-suspect: word confidence ${finding.asrConfidence} on an asr-prone rule`;
  }
  if (finding.combinedConfidence < MIN_COMBINED_CONFIDENCE) {
    return `combined confidence ${finding.combinedConfidence} below ${MIN_COMBINED_CONFIDENCE}`;
  }
  if (suppressed.has(finding.ruleTag)) {
    return 'rule is on the user suppression list';
  }
  return null;
}

/**
 * Rank findings for surfacing: severity first, then how sure we are, then document order.
 * Focus-skill alignment promotes a finding one severity step for the visual channel only.
 */
const SEVERITY_RANK = { blocking: 0, notable: 1, polish: 2 } as const;

function compareForSurfacing(
  a: ScoredFinding,
  b: ScoredFinding,
  focusSkills: SessionState['focusSkills'],
): number {
  const aFocus = isFocus(a.ruleTag, focusSkills) ? 1 : 0;
  const bFocus = isFocus(b.ruleTag, focusSkills) ? 1 : 0;
  const aRank = SEVERITY_RANK[a.severity] - aFocus * 0.5;
  const bRank = SEVERITY_RANK[b.severity] - bFocus * 0.5;
  if (aRank !== bRank) return aRank - bRank;
  if (a.combinedConfidence !== b.combinedConfidence) {
    return b.combinedConfidence - a.combinedConfidence;
  }
  return a.span.wordStart - b.span.wordStart;
}

function isFocus(ruleTag: string, focusSkills: SessionState['focusSkills']): boolean {
  return focusSkills.primary === ruleTag || focusSkills.secondary === ruleTag;
}

export type PolicyInput = {
  candidates: CandidateFinding[];
  /** Words of the utterance the candidates were found in — needed for span confidence. */
  words: Word[];
  snrEstimate: number | null;
  state: SessionState;
  mode: ModeConfig;
  settings: UserSettings;
};

/**
 * The single decision point. Deterministic: same inputs, same outputs, every time — which is
 * what lets us assert "in a 20-turn Casual session with 14 candidates, at most 3 are spoken".
 */
export function decide(input: PolicyInput): PolicyDecision {
  const { candidates, words, snrEstimate, state, mode, settings } = input;

  const scored = candidates.map((c) => scoreFinding(c, words, snrEstimate));
  const { kept, dropped } = applyGate1(scored, state.suppressedRuleTags);

  const brake = brakeEngaged(state);

  // Gate 2. Everything past Gate 1 is recorded regardless of whether it is ever surfaced;
  // the end-of-session report is built from recorded findings, not from what was spoken.
  const recorded: DecidedFinding[] = kept.map((f) => ({
    ...f,
    status: 'recorded',
    reason: 'passed gate 1',
  }));

  const ranked = [...kept].sort((a, b) => compareForSurfacing(a, b, state.focusSkills));

  // --- Voice channel -------------------------------------------------------
  let directive: TurnDirective = NO_DIRECTIVE;
  let spokenId: string | null = null;

  const voice = voiceChannelOpen(state, mode, settings);
  if (voice.open) {
    const eligible = ranked.filter(
      (f) => f.severity === 'blocking' || isFocus(f.ruleTag, state.focusSkills),
    );
    const chosen = eligible[0];
    if (chosen) {
      const drill = drillAllowed(state, mode, settings, chosen.ruleTag);
      const micro = microTeachAllowed(state, mode, chosen.ruleTag);

      if (drill.allowed) {
        directive = buildDirective('drill', chosen);
        spokenId = chosen.id;
      } else if (micro.allowed) {
        directive = buildDirective('micro_teach', chosen);
        spokenId = chosen.id;
      } else {
        directive = buildDirective('recast', chosen);
        spokenId = chosen.id;
      }
    }
  }

  if (spokenId !== null) {
    const target = recorded.find((f) => f.id === spokenId);
    if (target) {
      target.status = directive.kind === 'drill' ? 'drilled' : 'spoken';
      target.reason = `voice channel: ${directive.kind}`;
    }
  }

  // --- Visual channel ------------------------------------------------------
  // Silent, non-interrupting, therefore generous. Deduped by rule_tag within the segment so
  // three instances of the same mistake read as "x3" rather than three separate cards.
  const cardBudget = visualCardsRemaining(state);
  const alreadyShown = new Set(state.shownRuleTagsThisSegment);
  const visualCards: VisualCard[] = [];
  const cardCounts = new Map<string, number>();

  for (const finding of ranked) {
    if (finding.id === spokenId) continue; // already handled in voice
    cardCounts.set(finding.ruleTag, (cardCounts.get(finding.ruleTag) ?? 0) + 1);
  }

  for (const finding of ranked) {
    if (visualCards.length >= cardBudget) break;
    if (finding.id === spokenId) continue;
    if (alreadyShown.has(finding.ruleTag)) continue;
    if (visualCards.some((c) => c.ruleTag === finding.ruleTag)) continue;

    alreadyShown.add(finding.ruleTag);
    visualCards.push(toCard(finding, cardCounts.get(finding.ruleTag) ?? 1));

    const target = recorded.find((f) => f.id === finding.id);
    if (target) {
      target.status = 'shown_visual';
      target.reason = 'visual channel';
    }
  }

  return {
    suppressed: dropped,
    recorded,
    visualCards,
    turnDirective: directive,
    brakeEngaged: brake.engaged,
    brakeReason: brake.reason,
  };
}

function toCard(finding: ScoredFinding, repeatCount: number): VisualCard {
  // Prefer the canonical, human-written explanation where the taxonomy has one (RISKS.md R4):
  // the model fills slots rather than authoring grammar, which removes hallucinated-rule risk
  // on the common cases.
  const canonical = renderExplanation(
    finding.ruleTag,
    finding.originalSpanText,
    finding.suggestedSpanText,
  );
  return {
    findingId: finding.id,
    ruleTag: finding.ruleTag,
    originalUtterance: finding.originalUtterance,
    originalSpanText: finding.originalSpanText,
    suggestedUtterance: finding.suggestedUtterance,
    explanationShort: canonical ?? finding.explanationShort,
    severity: finding.severity,
    repeatCount,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
