/**
 * The closed rule_tag taxonomy — ADR-003, AI_BEHAVIOR.md §2.2.
 *
 * PURE MODULE. No I/O, no network, no LLM, no clock, no randomness (CLAUDE.md invariant 1).
 *
 * Every finding aggregates on `id`. Free-text categories cannot be counted, and without counting
 * there is no "you did this 14 times this month", and therefore no product.
 *
 * `asrProne` is the flag that drives the Gate 1 suppression in AI_BEHAVIOR.md §3.1. It marks the
 * categories a speech recogniser routinely mangles — articles, plurals, verb inflections — which
 * are exactly the errors we look for. It is not optional.
 *
 * `elicitation` describes a conversational context that makes the structure *obligatory*. The
 * adaptive engine (AI_BEHAVIOR.md §6.2) turns focus skills into topic steering, not into lectures.
 */

import type { FindingType, Severity } from '@/lib/types';

export type TaxonomyEntry = {
  id: string;
  label: string;
  category: FindingType;
  defaultSeverity: Severity;
  /** Speech recognisers routinely get this wrong; Gate 1 suppresses it at low ASR confidence. */
  asrProne: boolean;
  /**
   * A context that forces this structure. Null when the rule has no natural elicitation
   * (you cannot engineer a conversation that forces someone to overuse "good").
   */
  elicitation: string | null;
  /**
   * A canonical, human-written explanation template for the top rules — RISKS.md R4.
   * The model fills slots rather than authoring grammar, which removes hallucinated-rule risk
   * on the common cases. `{original}` and `{corrected}` are substituted.
   */
  explanationTemplate: string | null;
};

export const TAXONOMY: readonly TaxonomyEntry[] = [
  // --- Grammar: tense -------------------------------------------------------
  {
    id: 'grammar.tense.past_simple.irregular',
    label: 'Past simple, irregular verb',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: 'Ask about a specific finished event: the weekend, a trip, yesterday.',
    explanationTemplate:
      'With a finished past time, use the past simple: "{corrected}".',
  },
  {
    id: 'grammar.tense.past_simple.regular',
    label: 'Past simple, regular verb',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: 'Ask them to recount a sequence of events that already finished.',
    explanationTemplate: 'A finished past action takes the -ed form: "{corrected}".',
  },
  {
    id: 'grammar.tense.present_perfect.vs_past',
    label: 'Present perfect vs past simple',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask what has changed recently, or about life experience without a fixed time.',
    explanationTemplate:
      'With a finished time word, use the past simple; keep the present perfect for unfinished time: "{corrected}".',
  },
  {
    id: 'grammar.tense.consistency',
    label: 'Tense consistency in a narrative',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask for a story told start to finish.',
    explanationTemplate: 'Keep the narrative in one tense: "{corrected}".',
  },
  {
    id: 'grammar.tense.continuous_misuse',
    label: 'Continuous used with a stative verb',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask about opinions, preferences, and states rather than actions.',
    explanationTemplate:
      'State verbs like have, know, want are not usually continuous: "{corrected}".',
  },

  // --- Grammar: articles and determiners ------------------------------------
  {
    id: 'grammar.article.definite',
    label: 'Definite article',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: true,
    elicitation: 'Ask them to describe a process or give directions.',
    explanationTemplate: 'This noun is specific, so it takes "the": "{corrected}".',
  },
  {
    id: 'grammar.article.indefinite',
    label: 'Indefinite article',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: true,
    elicitation: 'Ask them to describe an object or a role for the first time.',
    explanationTemplate: 'A singular countable noun mentioned first takes a/an: "{corrected}".',
  },
  {
    id: 'grammar.article.omitted',
    label: 'Missing article',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: true,
    elicitation: 'Ask them to describe a place or a physical scene.',
    explanationTemplate: 'English needs an article here: "{corrected}".',
  },

  // --- Grammar: agreement, number, countability -----------------------------
  {
    id: 'grammar.agreement.subject_verb',
    label: 'Subject-verb agreement',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: 'Ask about groups of people or things, forcing plural subjects.',
    explanationTemplate: 'The verb has to match the subject: "{corrected}".',
  },
  {
    id: 'grammar.countability',
    label: 'Countable / uncountable',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: 'Ask about advice, information, work, research — classic uncountables.',
    explanationTemplate: 'This noun is uncountable in English: "{corrected}".',
  },
  {
    id: 'grammar.plural.form',
    label: 'Plural form',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: true,
    elicitation: null,
    explanationTemplate: 'The plural here is "{corrected}".',
  },

  // --- Grammar: prepositions ------------------------------------------------
  {
    id: 'grammar.preposition.dependent',
    label: 'Dependent preposition',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask opinion questions that pull verbs like depend on, apply for, discuss.',
    explanationTemplate: 'This verb takes a different preposition: "{corrected}".',
  },
  {
    id: 'grammar.preposition.time_place',
    label: 'Preposition of time or place',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: 'Ask about schedules, locations, and routines.',
    explanationTemplate: 'Use "{corrected}" for this time/place expression.',
  },

  // --- Grammar: clause structure -------------------------------------------
  {
    id: 'grammar.conditional.second',
    label: 'Second conditional',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Pose a hypothetical: what would you do if…',
    explanationTemplate:
      'An unreal present situation takes "if + past, would + base": "{corrected}".',
  },
  {
    id: 'grammar.conditional.first',
    label: 'First conditional',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask about plans and their likely consequences.',
    explanationTemplate: 'A likely future condition takes "if + present, will": "{corrected}".',
  },
  {
    id: 'grammar.word_order.question',
    label: 'Question word order',
    category: 'grammar',
    defaultSeverity: 'blocking',
    asrProne: false,
    elicitation: 'Invite them to ask you questions.',
    explanationTemplate: 'Questions invert the subject and auxiliary: "{corrected}".',
  },
  {
    id: 'grammar.word_order.adverb',
    label: 'Adverb placement',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'The adverb sits here in English: "{corrected}".',
  },
  {
    id: 'grammar.relative_clause',
    label: 'Relative clause',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask them to describe a person or thing in detail.',
    explanationTemplate: 'Use "{corrected}" to join these clauses.',
  },
  {
    id: 'grammar.modal',
    label: 'Modal verb',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask for advice or for a judgement about obligation.',
    explanationTemplate: 'The modal here should be "{corrected}".',
  },
  {
    id: 'grammar.infinitive_gerund',
    label: 'Infinitive vs gerund',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask about likes, plans, and things they avoid.',
    explanationTemplate: 'This verb is followed by "{corrected}".',
  },
  {
    id: 'grammar.passive',
    label: 'Passive voice form',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: 'Ask how something is made or processed, where the agent is unimportant.',
    explanationTemplate: 'The passive needs "be + past participle": "{corrected}".',
  },
  {
    id: 'grammar.comparative',
    label: 'Comparative / superlative',
    category: 'grammar',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: 'Ask them to compare two options, tools, or places.',
    explanationTemplate: 'The comparative form is "{corrected}".',
  },
  {
    id: 'grammar.pronoun',
    label: 'Pronoun form or reference',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: null,
    explanationTemplate: 'The pronoun here should be "{corrected}".',
  },
  {
    id: 'grammar.negation',
    label: 'Negation',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: null,
    explanationTemplate: 'Negate it like this: "{corrected}".',
  },
  {
    id: 'grammar.auxiliary',
    label: 'Auxiliary verb',
    category: 'grammar',
    defaultSeverity: 'notable',
    asrProne: true,
    elicitation: null,
    explanationTemplate: 'This needs the auxiliary: "{corrected}".',
  },

  // --- Lexis ----------------------------------------------------------------
  {
    id: 'lexical.overuse',
    label: 'Overused simple word',
    category: 'lexical_choice',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: null,
  },
  {
    id: 'lexical.collocation',
    label: 'Collocation',
    category: 'lexical_choice',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'English pairs these words differently: "{corrected}".',
  },
  {
    id: 'lexical.wrong_word',
    label: 'Wrong word for the meaning',
    category: 'lexical_choice',
    defaultSeverity: 'blocking',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'The word you want here is "{corrected}".',
  },
  {
    id: 'lexical.register_mismatch',
    label: 'Register mismatch',
    category: 'register',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: null,
    explanationTemplate: null,
  },
  {
    id: 'lexical.false_friend',
    label: 'False friend',
    category: 'lexical_choice',
    defaultSeverity: 'blocking',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'That word means something else in English; you want "{corrected}".',
  },

  // --- Naturalness ----------------------------------------------------------
  {
    id: 'naturalness.calque',
    label: 'Translated directly from another language',
    category: 'naturalness',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'A native speaker would say "{corrected}".',
  },
  {
    id: 'naturalness.wordiness',
    label: 'Wordy phrasing',
    category: 'naturalness',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'Shorter and more natural: "{corrected}".',
  },
  {
    id: 'naturalness.phrasing',
    label: 'Unnatural phrasing',
    category: 'naturalness',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'More idiomatic: "{corrected}".',
  },

  // --- Discourse and clarity ------------------------------------------------
  {
    id: 'discourse.missing_connective',
    label: 'Missing connective',
    category: 'discourse',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: 'Ask for an explanation with several reasons.',
    explanationTemplate: 'Joining these ideas makes it easier to follow: "{corrected}".',
  },
  {
    id: 'clarity.run_on',
    label: 'Run-on sentence',
    category: 'clarity',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'Splitting this into shorter sentences makes it land better.',
  },
  {
    id: 'clarity.abandoned_clause',
    label: 'Abandoned clause',
    category: 'clarity',
    defaultSeverity: 'notable',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'This sentence starts one idea and switches; finish the first one.',
  },
  {
    id: 'clarity.ambiguous_reference',
    label: 'Ambiguous reference',
    category: 'clarity',
    defaultSeverity: 'blocking',
    asrProne: false,
    elicitation: null,
    explanationTemplate: 'It is not clear what this refers to; naming it helps.',
  },

  // --- Repetition and fillers ----------------------------------------------
  {
    id: 'repetition.lexical',
    label: 'Repeated word',
    category: 'repetition',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: null,
  },
  {
    id: 'filler.hedge_density',
    label: 'Heavy hedging',
    category: 'filler',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: null,
  },
  {
    id: 'filler.verbal',
    label: 'Filler words',
    category: 'filler',
    defaultSeverity: 'polish',
    asrProne: false,
    elicitation: null,
    explanationTemplate: null,
  },
] as const;

/** Fast lookup. Built once at module load from the frozen array above — still pure. */
const BY_ID = new Map<string, TaxonomyEntry>(TAXONOMY.map((t) => [t.id, t]));

export const RULE_TAGS: readonly string[] = TAXONOMY.map((t) => t.id);

export function getRule(ruleTag: string): TaxonomyEntry | undefined {
  return BY_ID.get(ruleTag);
}

export function isKnownRuleTag(ruleTag: string): boolean {
  return BY_ID.has(ruleTag);
}

/** Rules the recogniser routinely mangles. Gate 1 (AI_BEHAVIOR.md §3.1) reads this. */
export function isAsrProne(ruleTag: string): boolean {
  return BY_ID.get(ruleTag)?.asrProne ?? false;
}

export function defaultSeverity(ruleTag: string): Severity {
  return BY_ID.get(ruleTag)?.defaultSeverity ?? 'polish';
}

/**
 * Rules that can be practised by steering the conversation. The adaptive engine only
 * selects a focus skill from this set — a focus you cannot engineer a context for is useless.
 */
export function elicitableRules(): readonly TaxonomyEntry[] {
  return TAXONOMY.filter((t) => t.elicitation !== null);
}

/**
 * Render the canonical explanation for a rule, if it has one (RISKS.md R4).
 * Returns null when the rule has no template and the analyzer's own text should be used.
 */
export function renderExplanation(
  ruleTag: string,
  original: string,
  corrected: string | null,
): string | null {
  const tpl = BY_ID.get(ruleTag)?.explanationTemplate;
  if (!tpl) return null;
  return tpl.replace('{original}', original).replace('{corrected}', corrected ?? original);
}

/** Human-readable category label, for grouping in the report and dashboard. */
export function categoryOf(ruleTag: string): FindingType | null {
  return BY_ID.get(ruleTag)?.category ?? null;
}

/** Top-level grammar family, e.g. 'grammar.tense.past_simple.irregular' -> 'grammar.tense'. */
export function familyOf(ruleTag: string): string {
  const parts = ruleTag.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : ruleTag;
}
