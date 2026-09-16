/**
 * Structured-output schemas — CLAUDE.md invariant 3.
 *
 * Every LLM call that is not free-form conversation validates against one of these. We never
 * parse prose into application data: an analyzer that returns "I found a past tense error" is
 * unusable, and one that returns text we regex is a source of silent corruption.
 *
 * `ruleTag` is constrained to the closed taxonomy (ADR-003). The moment a model can invent a
 * category, the progress dashboard stops being able to count anything.
 */

import { z } from 'zod';
import { RULE_TAGS } from '@/lib/analysis/taxonomy';
import { SAY_IT_BETTER_REGISTERS, SEVERITIES, VOCAB_REGISTERS } from '@/lib/types';

/** Non-empty tuple form required by z.enum. */
function enumOf<T extends string>(values: readonly T[]): z.ZodEnum<[T, ...T[]]> {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('enumOf requires at least one value');
  return z.enum([first, ...rest]);
}

export const ruleTagSchema = enumOf(RULE_TAGS as string[]);
export const severitySchema = enumOf(SEVERITIES as unknown as string[]);

// ---------------------------------------------------------------------------
// Error analyzer — the cold lane's main output
// ---------------------------------------------------------------------------

export const candidateFindingSchema = z.object({
  utteranceId: z.string(),
  ruleTag: ruleTagSchema,
  severity: severitySchema,
  wordStart: z.number().int().min(0),
  wordEnd: z.number().int().min(0),
  originalSpanText: z.string().min(1),
  suggestedSpanText: z.string().nullable(),
  suggestedUtterance: z.string().nullable(),
  explanationShort: z.string().max(140),
  llmConfidence: z.number().min(0).max(1),
});

export const structureObservationSchema = z.object({
  utteranceId: z.string(),
  ruleTag: ruleTagSchema,
  obligatoryContext: z.boolean(),
  produced: z.boolean(),
  correct: z.boolean(),
});

export const errorAnalyzerOutputSchema = z.object({
  findings: z.array(candidateFindingSchema).max(20),
  observations: z.array(structureObservationSchema).max(30),
});

export type ErrorAnalyzerOutput = z.infer<typeof errorAnalyzerOutputSchema>;

// ---------------------------------------------------------------------------
// Vocabulary analyzer
// ---------------------------------------------------------------------------

export const vocabCandidateSchema = z.object({
  lemma: z.string().min(1).max(40),
  sense: z.string().max(120),
  definition: z.string().min(1).max(200),
  register: enumOf(VOCAB_REGISTERS as unknown as string[]),
  cefrLevel: z.enum(['A2', 'B1', 'B2', 'C1', 'C2']),
  examples: z.array(z.string().max(200)).min(1).max(3),
  // Required: an item without the user's own sentence attached is not memorable
  // (AI_BEHAVIOR.md §5.4).
  anchorUtterance: z.string().min(1),
  replacesText: z.string().nullable(),
  reason: z.enum(['overuse', 'circumlocution', 'register_mismatch']),
});

export const vocabAnalyzerOutputSchema = z.object({
  // Volume cap is a design decision, not a limitation: 3 words genuinely acquired per session
  // is about a thousand a year (AI_BEHAVIOR.md §5.1).
  candidates: z.array(vocabCandidateSchema).max(3),
});

export type VocabAnalyzerOutput = z.infer<typeof vocabAnalyzerOutputSchema>;

// ---------------------------------------------------------------------------
// Say It Better
// ---------------------------------------------------------------------------

export const sayItBetterVariantSchema = z.object({
  register: enumOf(SAY_IT_BETTER_REGISTERS as unknown as string[]),
  text: z.string().min(1).max(400),
  why: z.string().min(1).max(160),
});

export const sayItBetterOutputSchema = z.object({
  variants: z.array(sayItBetterVariantSchema).min(1).max(4),
  /**
   * The model self-reports whether it preserved the user's meaning. This is a cheap tripwire for
   * the meaning-drift failure the eval fixtures test for (M11) — a rewrite that asserts something
   * the user did not say is a bug, not a better sentence.
   */
  meaningPreserved: z.boolean(),
});

export type SayItBetterOutput = z.infer<typeof sayItBetterOutputSchema>;

// ---------------------------------------------------------------------------
// Conversation side-channel — ARCHITECTURE.md §2.2
// ---------------------------------------------------------------------------

/**
 * The conversation model emits this alongside its spoken reply, in the SAME call. It feeds the
 * frustration brake without a second round trip, which the latency budget would not allow.
 */
export const conversationIntentSchema = z.object({
  wantsToStopCorrections: z.boolean(),
  changedTopic: z.boolean(),
  askedAboutEnglish: z.boolean(),
  atTopicBoundary: z.boolean(),
  emotionalState: z.enum(['engaged', 'neutral', 'frustrated', 'confused']),
});

export type ConversationIntent = z.infer<typeof conversationIntentSchema>;

export const DEFAULT_INTENT: ConversationIntent = {
  wantsToStopCorrections: false,
  changedTopic: false,
  askedAboutEnglish: false,
  atTopicBoundary: false,
  emotionalState: 'neutral',
};

// ---------------------------------------------------------------------------
// Session report — the session lane
// ---------------------------------------------------------------------------

export const reportFixSchema = z.object({
  ruleTag: ruleTagSchema,
  youSaid: z.string().min(1),
  better: z.string().min(1),
  why: z.string().min(1).max(200),
  occurrences: z.number().int().min(1),
});

export const reportPhraseSchema = z.object({
  phrase: z.string().min(1),
  insteadOf: z.string().nullable(),
  note: z.string().max(200),
});

export const sessionReportOutputSchema = z.object({
  // Exactly three. Not "all 17 findings" — three is what a person can hold (UX.md §2).
  topFixes: z.array(reportFixSchema).max(3),
  phrasesToSteal: z.array(reportPhraseSchema).max(3),
  /** Named and quoted. Empty praise trains the user to discount all praise. */
  oneThingThatWentWell: z.string().min(1).max(300),
  focusNext: z.string().min(1).max(200),
});

export type SessionReportOutput = z.infer<typeof sessionReportOutputSchema>;

// ---------------------------------------------------------------------------
// JSON Schema conversion for the API's structured-output parameter
// ---------------------------------------------------------------------------

/**
 * Hand-rolled Zod -> JSON Schema for the small, closed set of shapes above.
 *
 * Deliberately not a dependency: zod-to-json-schema would be a new runtime dep requiring an ADR
 * for four object shapes we control entirely. Key order is stable, which matters — a
 * non-deterministic tool serialisation silently breaks the prompt cache (ARCHITECTURE.md §5.2).
 */
export type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  maxItems?: number;
  minItems?: number;
  description?: string;
};

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape).sort()) {
        const child = shape[key];
        if (!child) continue;
        properties[key] = toJsonSchema(child);
        if (!child.isOptional()) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray': {
      const inner = (def as { type: z.ZodTypeAny }).type;
      const out: JsonSchema = { type: 'array', items: toJsonSchema(inner) };
      const exact = def.exactLength as { value: number } | null | undefined;
      const max = def.maxLength as { value: number } | null | undefined;
      const min = def.minLength as { value: number } | null | undefined;
      if (max) out.maxItems = max.value;
      if (min) out.minItems = min.value;
      if (exact) {
        out.maxItems = exact.value;
        out.minItems = exact.value;
      }
      return out;
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...((def.values as string[]) ?? [])] };
    case 'ZodNullable': {
      const inner = toJsonSchema((def as { innerType: z.ZodTypeAny }).innerType);
      // The API's strict mode has no union support here; a nullable string is modelled as a
      // string and the analyzer prompt is explicit that "none" means an empty string.
      return inner;
    }
    case 'ZodOptional':
      return toJsonSchema((def as { innerType: z.ZodTypeAny }).innerType);
    default:
      return { type: 'string' };
  }
}
