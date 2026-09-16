/**
 * The eval harness itself — ADR-012.
 *
 * The harness is a quality instrument, so it needs its own tests: if the scoring maths is wrong,
 * a prompt regression sails through CI. These check the fixture set is well-formed and that the
 * report shape carries the honesty markers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReport, PRECISION_TARGET, type EvalReport } from '@/tests/evals/runAnalyzerEval';
import { isKnownRuleTag } from '@/lib/analysis/taxonomy';

const FIXTURES = join(process.cwd(), 'tests/evals/fixtures');

type ErrorCase = { id: string; text: string; expected: string[]; note?: string };
type CorrectCase = { id: string; text: string; note?: string };

const errors = JSON.parse(readFileSync(join(FIXTURES, 'errors.json'), 'utf8')) as {
  cases: ErrorCase[];
};
const correct = JSON.parse(readFileSync(join(FIXTURES, 'correct.json'), 'utf8')) as {
  cases: CorrectCase[];
};

describe('fixture set meets the roadmap requirements', () => {
  it('has at least 100 annotated error cases', () => {
    // ROADMAP.md M5.
    expect(errors.cases.length).toBeGreaterThanOrEqual(100);
  });

  it('has at least 30 fully correct utterances that must yield zero findings', () => {
    // The false-positive guard. This is the set that protects RISKS.md R2.
    expect(correct.cases.length).toBeGreaterThanOrEqual(30);
  });

  it('uses only rule tags that exist in the closed taxonomy', () => {
    for (const testCase of errors.cases) {
      for (const ruleTag of testCase.expected) {
        expect(isKnownRuleTag(ruleTag), `${testCase.id}: ${ruleTag}`).toBe(true);
      }
    }
  });

  it('gives every error case at least one expected finding', () => {
    for (const testCase of errors.cases) {
      expect(testCase.expected.length, testCase.id).toBeGreaterThan(0);
    }
  });

  it('has unique ids across both sets', () => {
    const ids = [...errors.cases.map((c) => c.id), ...correct.cases.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-trivial text in every case', () => {
    for (const testCase of [...errors.cases, ...correct.cases]) {
      expect(testCase.text.trim().split(/\s+/).length, testCase.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('covers a broad spread of rules rather than testing one thing repeatedly', () => {
    const covered = new Set(errors.cases.flatMap((c) => c.expected));
    expect(covered.size).toBeGreaterThanOrEqual(20);
  });

  it('includes the over-flagging traps: contractions, fragments, regional variation', () => {
    const texts = correct.cases.map((c) => c.text);
    // A pedantic analyzer flags all of these, and every one is correct English.
    expect(texts.some((t) => /n't|'ve|'ll|'d /.test(t))).toBe(true);
    expect(texts.some((t) => t.split(/\s+/).length <= 3)).toBe(true);
    expect(correct.cases.some((c) => (c.note ?? '').toLowerCase().includes('regional'))).toBe(true);
    expect(correct.cases.some((c) => (c.note ?? '').toLowerCase().includes('fragment'))).toBe(true);
  });

  it('includes the corrected form of the canonical brief example', () => {
    expect(correct.cases.some((c) => /I went to the market yesterday and bought/.test(c.text))).toBe(true);
  });
});

describe('report formatting carries the honesty markers', () => {
  const base: EvalReport = {
    isLive: false,
    model: 'scripted:claude-haiku-4-5',
    promptVersion: 'analyzers/error-analyzer@1',
    errorCases: 105,
    correctCases: 50,
    falsePositivesOnCorrect: 0,
    cleanUtterancesPassed: 50,
    overall: { truePositives: 8, falsePositives: 0, falseNegatives: 97, precision: 1, recall: 0.076 },
    blockingPrecision: null,
    byRule: [],
    failures: [],
  };

  it('shouts UNVERIFIED when only the scripted stand-in is configured', () => {
    // A precision figure from the scripted provider is not evidence about the product.
    const text = formatReport(base);
    expect(text).toContain('UNVERIFIED');
    expect(text).toContain('SCRIPTED');
    expect(text).toContain('cannot be satisfied');
  });

  it('points at both ways to configure a real analyzer', () => {
    const text = formatReport(base);
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('ENGCOACH_PROVIDER_COLD=ollama');
  });

  it('does not shout when the run was live', () => {
    const text = formatReport({ ...base, isLive: true, model: 'claude-haiku-4-5' });
    expect(text).not.toContain('UNVERIFIED');
  });

  it('treats a LOCAL model as a real measurement, and warns about over-flagging', () => {
    // ADR-022: running the gate against Ollama is exactly how you answer "is a small local
    // model good enough for the analyzer?" — so it must not be dismissed as unverified.
    const text = formatReport({ ...base, isLive: true, model: 'ollama:qwen2.5:7b-instruct' });
    expect(text).not.toContain('UNVERIFIED');
    expect(text).toContain('LOCAL MODEL');
    expect(text).toContain('the gate applies');
    expect(text).toContain('over-flag');
  });

  it('leads with the false-positive guard, not with recall', () => {
    const text = formatReport(base);
    const guardIndex = text.indexOf('FALSE-POSITIVE GUARD');
    const overallIndex = text.indexOf('OVERALL');
    expect(guardIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeLessThan(overallIndex);
  });

  it('states the precision target and marks recall as secondary', () => {
    const text = formatReport(base);
    expect(text).toContain('90.0%');
    expect(text).toContain('secondary');
  });

  it('lists the worst false-positive offenders when there are any', () => {
    const text = formatReport({
      ...base,
      byRule: [
        {
          ruleTag: 'grammar.article.definite',
          truePositives: 1,
          falsePositives: 9,
          falseNegatives: 0,
          precision: 0.1,
          recall: 1,
        },
      ],
    });
    expect(text).toContain('WORST OFFENDERS');
    expect(text).toContain('grammar.article.definite');
  });
});

describe('the gate', () => {
  it('targets 90% precision on blocking findings', () => {
    expect(PRECISION_TARGET).toBe(0.9);
  });
});
