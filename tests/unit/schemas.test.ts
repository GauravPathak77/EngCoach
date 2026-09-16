/**
 * lib/llm/schemas — CLAUDE.md invariant 3.
 *
 * These schemas are the boundary between a model's output and application data. A malformed or
 * hostile response must be rejected here rather than becoming a finding the user sees.
 */

import { describe, expect, it } from 'vitest';
import {
  candidateFindingSchema,
  errorAnalyzerOutputSchema,
  sayItBetterOutputSchema,
  sessionReportOutputSchema,
  toJsonSchema,
  vocabAnalyzerOutputSchema,
} from '@/lib/llm/schemas';
import { RULE_TAGS } from '@/lib/analysis/taxonomy';

const validFinding = {
  utteranceId: 'u1',
  ruleTag: 'grammar.tense.past_simple.irregular',
  severity: 'notable',
  wordStart: 1,
  wordEnd: 2,
  originalSpanText: 'have went',
  suggestedSpanText: 'went',
  suggestedUtterance: 'I went there',
  explanationShort: 'Use "went".',
  llmConfidence: 0.9,
};

describe('candidate finding schema', () => {
  it('accepts a well-formed finding', () => {
    expect(candidateFindingSchema.safeParse(validFinding).success).toBe(true);
  });

  it('REJECTS a rule tag outside the closed taxonomy', () => {
    // ADR-003: the moment a model can invent a category, nothing can be counted.
    const result = candidateFindingSchema.safeParse({
      ...validFinding,
      ruleTag: 'grammar.something.i.made.up',
    });
    expect(result.success).toBe(false);
  });

  it('accepts every tag that IS in the taxonomy', () => {
    for (const ruleTag of RULE_TAGS) {
      expect(
        candidateFindingSchema.safeParse({ ...validFinding, ruleTag }).success,
        ruleTag,
      ).toBe(true);
    }
  });

  it('rejects a confidence outside 0..1', () => {
    expect(candidateFindingSchema.safeParse({ ...validFinding, llmConfidence: 1.5 }).success).toBe(false);
    expect(candidateFindingSchema.safeParse({ ...validFinding, llmConfidence: -0.1 }).success).toBe(false);
  });

  it('rejects negative word indices, which cannot anchor to a transcript', () => {
    expect(candidateFindingSchema.safeParse({ ...validFinding, wordStart: -1 }).success).toBe(false);
  });

  it('rejects an unknown severity', () => {
    expect(candidateFindingSchema.safeParse({ ...validFinding, severity: 'critical' }).success).toBe(false);
  });

  it('caps the explanation length so it stays a sentence, not a lecture', () => {
    const result = candidateFindingSchema.safeParse({
      ...validFinding,
      explanationShort: 'x'.repeat(200),
    });
    expect(result.success).toBe(false);
  });
});

describe('error analyzer output', () => {
  it('accepts an empty result — reporting nothing is a normal, correct outcome', () => {
    const result = errorAnalyzerOutputSchema.safeParse({ findings: [], observations: [] });
    expect(result.success).toBe(true);
  });

  it('caps the number of findings so one bad response cannot flood a session', () => {
    const flood = { findings: Array.from({ length: 40 }, () => validFinding), observations: [] };
    expect(errorAnalyzerOutputSchema.safeParse(flood).success).toBe(false);
  });

  it('requires the structure-observation shape that gives us the denominator', () => {
    const good = {
      findings: [],
      observations: [
        {
          utteranceId: 'u1',
          ruleTag: 'grammar.tense.past_simple.irregular',
          obligatoryContext: true,
          produced: false,
          correct: false,
        },
      ],
    };
    expect(errorAnalyzerOutputSchema.safeParse(good).success).toBe(true);

    const missingFields = { findings: [], observations: [{ utteranceId: 'u1', ruleTag: 'x' }] };
    expect(errorAnalyzerOutputSchema.safeParse(missingFields).success).toBe(false);
  });
});

describe('vocabulary analyzer output', () => {
  const item = {
    lemma: 'haggle',
    sense: 'negotiate a price',
    definition: 'to argue over a price',
    register: 'conversational',
    cefrLevel: 'B2',
    examples: ['We haggled over the price.'],
    anchorUtterance: 'I tried to make the price lower',
    replacesText: 'make the price lower',
    reason: 'circumlocution',
  };

  it('accepts a well-formed item', () => {
    expect(vocabAnalyzerOutputSchema.safeParse({ candidates: [item] }).success).toBe(true);
  });

  it('enforces the three-item cap, which is a design decision not a limit', () => {
    const four = { candidates: [item, item, item, item] };
    expect(vocabAnalyzerOutputSchema.safeParse(four).success).toBe(false);
  });

  it('REQUIRES an anchor utterance — an item without one is a flashcard', () => {
    // AI_BEHAVIOR.md §5.4: flashcards do not produce speech.
    const orphan = { candidates: [{ ...item, anchorUtterance: '' }] };
    expect(vocabAnalyzerOutputSchema.safeParse(orphan).success).toBe(false);
  });

  it('requires a register, because appropriateness is part of the teaching', () => {
    const noRegister = { candidates: [{ ...item, register: 'fancy' }] };
    expect(vocabAnalyzerOutputSchema.safeParse(noRegister).success).toBe(false);
  });

  it('requires at least one example', () => {
    expect(vocabAnalyzerOutputSchema.safeParse({ candidates: [{ ...item, examples: [] }] }).success).toBe(false);
  });
});

describe('say it better output', () => {
  it('carries the meaning-preservation tripwire', () => {
    const result = sayItBetterOutputSchema.safeParse({
      variants: [{ register: 'natural', text: 'A better line.', why: 'more idiomatic' }],
      meaningPreserved: true,
    });
    expect(result.success).toBe(true);
  });

  it('caps at four variants — never a ladder where the last rung is "best"', () => {
    const variant = { register: 'natural', text: 'x', why: 'y' };
    const five = { variants: Array.from({ length: 5 }, () => variant), meaningPreserved: true };
    expect(sayItBetterOutputSchema.safeParse(five).success).toBe(false);
  });

  it('requires at least one variant', () => {
    expect(sayItBetterOutputSchema.safeParse({ variants: [], meaningPreserved: true }).success).toBe(false);
  });
});

describe('session report output', () => {
  it('caps top fixes at three — what a person can hold', () => {
    const fix = {
      ruleTag: 'grammar.countability',
      youSaid: 'many informations',
      better: 'a lot of information',
      why: 'uncountable',
      occurrences: 1,
    };
    expect(sessionReportOutputSchema.safeParse({
      topFixes: [fix, fix, fix, fix],
      phrasesToSteal: [],
      oneThingThatWentWell: 'good',
      focusNext: 'next',
    }).success).toBe(false);
  });

  it('accepts an empty fix list — a clean session is a real outcome', () => {
    expect(sessionReportOutputSchema.safeParse({
      topFixes: [],
      phrasesToSteal: [],
      oneThingThatWentWell: 'You kept going without switching languages.',
      focusNext: 'Keep telling stories about last week.',
    }).success).toBe(true);
  });

  it('requires the specific positive — empty praise is forbidden by construction', () => {
    expect(sessionReportOutputSchema.safeParse({
      topFixes: [],
      phrasesToSteal: [],
      oneThingThatWentWell: '',
      focusNext: 'next',
    }).success).toBe(false);
  });
});

describe('JSON Schema conversion', () => {
  it('produces an object schema with sorted, stable keys', () => {
    // A non-deterministic tool serialisation silently breaks the prompt cache
    // (ARCHITECTURE.md §5.2).
    const first = JSON.stringify(toJsonSchema(errorAnalyzerOutputSchema));
    const second = JSON.stringify(toJsonSchema(errorAnalyzerOutputSchema));
    expect(first).toBe(second);
  });

  it('emits the rule tag enum so the model is constrained at the API boundary', () => {
    const schema = toJsonSchema(errorAnalyzerOutputSchema);
    const ruleTag = schema.properties?.findings?.items?.properties?.ruleTag;
    expect(ruleTag?.enum).toBeDefined();
    expect(ruleTag?.enum?.length).toBe(RULE_TAGS.length);
  });

  it('marks objects closed so extra keys are rejected', () => {
    expect(toJsonSchema(errorAnalyzerOutputSchema).additionalProperties).toBe(false);
  });

  it('carries array caps through to the schema', () => {
    const schema = toJsonSchema(vocabAnalyzerOutputSchema);
    expect(schema.properties?.candidates?.maxItems).toBe(3);
  });
});
