/**
 * Shared domain types.
 *
 * This module is imported by the pure pedagogy layer (lib/coaching, lib/metrics, lib/profile),
 * so it must contain types and constants only — no runtime behaviour, no imports.
 * See CLAUDE.md invariant 1.
 */

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

/** One recognised word with its timing and confidence. DATA_MODEL.md § SpeechSegment. */
export type Word = {
  /** The word as recognised. */
  w: string;
  /** Start time in seconds, relative to the utterance. */
  s: number;
  /** End time in seconds. */
  e: number;
  /** Recogniser confidence, 0..1. Drives the ASR-suspect gate (AI_BEHAVIOR.md §3.1). */
  c: number;
  /** True when the recogniser tagged this as a filler ("um", "uh", "like"). */
  filler?: boolean;
};

export type Transcript = {
  text: string;
  words: Word[];
  durationMs: number;
  meanConfidence: number;
  /**
   * True when `words` carries genuine recogniser timings and confidences. False for the
   * browser-speech fallback, which yields text only — see ADR-018. Consumers must not display
   * timing-derived metrics when this is false.
   */
  timingsReliable: boolean;
};

// ---------------------------------------------------------------------------
// Findings — AI_BEHAVIOR.md §2
// ---------------------------------------------------------------------------

export const FINDING_TYPES = [
  'grammar',
  'lexical_choice',
  'naturalness',
  'register',
  'discourse',
  'clarity',
  'repetition',
  'filler',
  'fluency',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const SEVERITIES = ['blocking', 'notable', 'polish'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATUSES = [
  'suppressed',
  'recorded',
  'shown_visual',
  'spoken',
  'drilled',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * A candidate finding as produced by the analyzer, before the policy engine has seen it.
 * The analyzer never sets status — that is the policy engine's job (CLAUDE.md invariant 6).
 */
export type CandidateFinding = {
  id: string;
  utteranceId: string;
  type: FindingType;
  ruleTag: string;
  subtype?: string;
  span: { wordStart: number; wordEnd: number };
  originalSpanText: string;
  originalUtterance: string;
  suggestedSpanText: string | null;
  suggestedUtterance: string | null;
  explanationShort: string;
  explanationLong?: string;
  example?: string;
  severity: Severity;
  llmConfidence: number;
};

/** A candidate after Gate 1 has computed its safety numbers. AI_BEHAVIOR.md §3.1. */
export type ScoredFinding = CandidateFinding & {
  asrConfidence: number;
  combinedConfidence: number;
  isAsrSuspect: boolean;
};

/** A finding that has been through the policy engine and carries a decision. */
export type DecidedFinding = ScoredFinding & {
  status: FindingStatus;
  /** Why the policy engine decided this, for debugging and for the dev panel. */
  reason: string;
};

// ---------------------------------------------------------------------------
// Structure observations — AI_BEHAVIOR.md §2.1 (the denominator)
// ---------------------------------------------------------------------------

export type StructureObservation = {
  utteranceId: string;
  ruleTag: string;
  /** The sentence required this structure. */
  obligatoryContext: boolean;
  /** The user attempted it (false + obligatoryContext = avoidance). */
  produced: boolean;
  /** And got it right. */
  correct: boolean;
};

// ---------------------------------------------------------------------------
// Modes — PRODUCT.md §6, ADR-011. A mode is configuration, not a code path.
// ---------------------------------------------------------------------------

export const V1_MODES = ['casual', 'coach', 'free_topic'] as const;
export type ModeId = (typeof V1_MODES)[number];

export type ModeConfig = {
  id: ModeId;
  label: string;
  blurb: string;
  /** Prompt file under prompts/modes/. */
  promptFile: string;
  /** Turns between eligible voice recasts. Infinity disables the voice channel. */
  recastInterval: number;
  /** Coach mode only: an explicit spoken micro-teach is permitted. AI_BEHAVIOR.md §3.2. */
  allowMicroTeach: boolean;
  /** Coach mode only, opt-in: repeat-after-me drills. */
  allowDrill: boolean;
  /** Which registers Say It Better offers beyond "natural". AI_BEHAVIOR.md §4. */
  sayItBetterRegisters: SayItBetterRegister[];
  /** Soft cap on coach turn length, in words. Cost lever and pedagogy (COSTS.md §6). */
  maxReplyWords: number;
};

export const SAY_IT_BETTER_REGISTERS = [
  'natural',
  'professional',
  'persuasive',
  'formal',
] as const;
export type SayItBetterRegister = (typeof SAY_IT_BETTER_REGISTERS)[number];

// ---------------------------------------------------------------------------
// Session state seen by the policy engine
// ---------------------------------------------------------------------------

export type SessionState = {
  /** Zero-based index of the turn being decided. */
  turnIndex: number;
  /** Total user turns so far this session. */
  userTurnCount: number;
  /** Voice corrections already spoken this session. */
  spokenCount: number;
  /** Turn index of the most recent spoken correction, or null. Enforces spacing. */
  lastSpokenTurnIndex: number | null;
  /** Micro-teaches already spoken this session. */
  microTeachCount: number;
  /** Drills already issued this session. */
  drillCount: number;
  /** Findings disputed by the user this session. Feeds the frustration brake. */
  disputesThisSession: number;
  /** The conversation model raised a stop-correcting intent. */
  stopIntentRaised: boolean;
  /** Count of consecutive very short user turns following a correction. */
  consecutiveShortTurns: number;
  /** rule_tags the user has muted or disputed twice. Gate 1 drops these. */
  suppressedRuleTags: string[];
  /** This session's focus skills, from the adaptive engine. AI_BEHAVIOR.md §6.2. */
  focusSkills: { primary: string | null; secondary: string | null };
  /** rule_tag -> occurrences so far this session. Micro-teach needs >= 2. */
  ruleTagCountsThisSession: Record<string, number>;
  /** rule_tags already shown as a visual card in the current 8-turn segment. */
  shownRuleTagsThisSegment: string[];
  /** Visual cards shown in the current 8-turn segment. */
  visualCardsThisSegment: number;
  /** The last user turn looked like a topic boundary (micro-teach precondition). */
  atTopicBoundary: boolean;
};

export type UserSettings = {
  /** User has turned the voice channel off entirely. */
  voiceCorrectionsEnabled: boolean;
  /** Repeat-after-me drills require explicit opt-in. AI_BEHAVIOR.md §3.2. */
  drillsOptIn: boolean;
  /** Difficulty dial 1..10. One dial, not four (AI_BEHAVIOR.md §6.2). */
  difficulty: number;
};

// ---------------------------------------------------------------------------
// Policy output
// ---------------------------------------------------------------------------

export type TurnDirective = {
  /** The literal text appended as prompt layer L4. ARCHITECTURE.md §3.1. */
  text: string;
  kind: 'none' | 'recast' | 'micro_teach' | 'drill';
  /** The rule_tag this directive acts on, if any. */
  ruleTag: string | null;
};

export type VisualCard = {
  findingId: string;
  ruleTag: string;
  originalUtterance: string;
  originalSpanText: string;
  suggestedUtterance: string | null;
  explanationShort: string;
  severity: Severity;
  /** Repeats increment this rather than adding a card. AI_BEHAVIOR.md §3.2. */
  repeatCount: number;
};

export type PolicyDecision = {
  /** Dropped by Gate 1. Never recorded, never shown, never in the profile. */
  suppressed: DecidedFinding[];
  /** Survived Gate 1. All of these are persisted. */
  recorded: DecidedFinding[];
  /** Subset of recorded that becomes a silent on-screen card this segment. */
  visualCards: VisualCard[];
  /** The L4 directive for the next coach turn. */
  turnDirective: TurnDirective;
  /** True when the frustration brake fired this turn. */
  brakeEngaged: boolean;
  brakeReason: string | null;
};

// ---------------------------------------------------------------------------
// Metrics — AI_BEHAVIOR.md §6.1 Layer A
// ---------------------------------------------------------------------------

export type UtteranceMetrics = {
  /**
   * False when the speech source could not give us per-word timings (the browser-speech
   * fallback). The timing-derived fields below are then meaningless and MUST NOT be displayed —
   * a fabricated pause profile is exactly the unsupported number AI_BEHAVIOR.md §7.1 forbids.
   * `wordCount`, `durationMs` and `speechRate` stay real in both cases.
   */
  timingsReliable: boolean;
  wordCount: number;
  durationMs: number;
  /** Words per minute over the whole utterance including pauses. */
  speechRate: number;
  /** Words per minute excluding pauses > 250ms. Fluency without the hesitation confound. */
  articulationRate: number;
  pauseCountMidclause: number;
  pauseCountBoundary: number;
  pauseMsTotal: number;
  fillerCount: number;
  /** Mean Length of Run: words between pauses/disfluencies. Classic L2 fluency measure. */
  mlr: number;
  repairCount: number;
  responseLatencyMs: number | null;
};

export type SessionMetrics = {
  /** See UtteranceMetrics.timingsReliable. False if ANY contributing turn lacked timings. */
  timingsReliable: boolean;
  turnCount: number;
  userSpeechMs: number;
  coachSpeechMs: number;
  talkTimeRatio: number;
  wordCount: number;
  speechRate: number;
  articulationRate: number;
  fillersPer100Words: number;
  repairsPer100Words: number;
  meanMlr: number;
  /** Measure of Textual Lexical Diversity. Length-independent, unlike raw TTR. */
  mtld: number;
  /** Share of content lemmas outside the top-2000 frequency band. */
  advancedWordRatio: number;
  meanResponseLatencyMs: number | null;
  hedgeDensityPer100Words: number;
};

// ---------------------------------------------------------------------------
// Profile — AI_BEHAVIOR.md §6.1, ADR-010
// ---------------------------------------------------------------------------

export const CONFIDENCE_LEVELS = ['insufficient', 'low', 'medium', 'high'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type SkillEstimate = {
  skill: string;
  /** 0..1. For accuracy skills this is the Wilson lower bound, not the raw proportion. */
  value: number;
  evidenceCount: number;
  sessionsContributing: number;
  variance: number;
  confidence: ConfidenceLevel;
  trend28d: number;
};

/** An accuracy observation for a grammar rule: successes out of obligatory contexts. */
export type AccuracyObservation = {
  skill: string;
  successes: number;
  attempts: number;
  sessionId: string;
};

/** A continuous observation (fluency, lexical diversity) normalised to 0..1. */
export type ContinuousObservation = {
  skill: string;
  value: number;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// Vocabulary — AI_BEHAVIOR.md §5
// ---------------------------------------------------------------------------

export const VOCAB_STATES = [
  'candidate',
  'introduced',
  'recognised',
  'used_prompted',
  'used_spontaneous',
  'retained',
] as const;
export type VocabState = (typeof VOCAB_STATES)[number];

export const VOCAB_REGISTERS = [
  'neutral',
  'conversational',
  'professional',
  'formal',
  'slang',
  'sensitive',
] as const;
export type VocabRegister = (typeof VOCAB_REGISTERS)[number];

export type VocabCandidate = {
  lemma: string;
  sense: string;
  definition: string;
  register: VocabRegister;
  cefrLevel: string;
  examples: string[];
  /** The user's own sentence this was mined from. Required — AI_BEHAVIOR.md §5.4. */
  anchorUtterance: string;
  /** What the user said instead (the overused or circumlocuted form). */
  replacesText: string | null;
  reason: 'overuse' | 'circumlocution' | 'register_mismatch';
};

export type VocabStateRecord = {
  itemId: string;
  lemma: string;
  state: VocabState;
  srsIntervalDays: number;
  srsDueAt: Date;
  exposures: number;
  spontaneousUses: number;
  lastSeenAt: Date | null;
  lastProducedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Say It Better — AI_BEHAVIOR.md §4
// ---------------------------------------------------------------------------

export type SayItBetterVariant = {
  register: SayItBetterRegister;
  text: string;
  /** One clause. Names a concrete lever: "more idiomatic", "more specific". */
  why: string;
};

export type SayItBetterResult = {
  originalText: string;
  variants: SayItBetterVariant[];
};

// ---------------------------------------------------------------------------
// Injected capabilities — CLAUDE.md invariant 1 (no clock, no RNG in pure modules)
// ---------------------------------------------------------------------------

export type Clock = () => Date;
export type Rng = () => number;
