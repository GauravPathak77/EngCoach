/**
 * Analyzer evaluation harness — ADR-012, ROADMAP.md M5.
 *
 * This is the most important test asset in the project. It is how we control the biggest
 * product risk (false corrections, RISKS.md R2) and it is what makes a prompt change
 * falsifiable rather than a matter of opinion.
 *
 * Run: npm run eval:analyzers
 *
 * HONESTY RULE: when no real provider is configured the analyzer runs on the scripted
 * development stand-in, which is pattern matching and not a model. In that case this harness
 * reports the numbers but marks the run UNVERIFIED and exits non-zero on `--gate`. A precision
 * figure from the scripted provider is not evidence about the product.
 *
 * A LOCAL model (Ollama, ADR-022) is a real measurement and the gate applies to it normally —
 * that is precisely how you answer "is a small local model good enough for the analyzer?"
 * without guessing. Set ENGCOACH_PROVIDER_COLD=ollama and run this.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from '@/lib/env';
import { analyzeErrors } from '@/lib/analysis/errorAnalyzer';
import { hasLiveCredentials } from '@/lib/llm/client';
import { getRule } from '@/lib/analysis/taxonomy';

const HERE = dirname(fileURLToPath(import.meta.url));

/** V1 gate — ROADMAP.md M5. Recall is explicitly secondary. */
export const PRECISION_TARGET = 0.9;

type ErrorCase = { id: string; text: string; expected: string[]; note?: string };
type CorrectCase = { id: string; text: string; note?: string };

export type RuleScore = {
  ruleTag: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
};

export type EvalReport = {
  isLive: boolean;
  model: string;
  promptVersion: string;
  errorCases: number;
  correctCases: number;
  /** Findings on utterances that are entirely correct. These are the dangerous ones. */
  falsePositivesOnCorrect: number;
  cleanUtterancesPassed: number;
  overall: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
  };
  blockingPrecision: number | null;
  byRule: RuleScore[];
  failures: Array<{ id: string; text: string; expected: string[]; got: string[] }>;
};

function loadFixtures(): { errors: ErrorCase[]; correct: CorrectCase[] } {
  const errors = JSON.parse(readFileSync(join(HERE, 'fixtures/errors.json'), 'utf8')) as {
    cases: ErrorCase[];
  };
  const correct = JSON.parse(readFileSync(join(HERE, 'fixtures/correct.json'), 'utf8')) as {
    cases: CorrectCase[];
  };
  return { errors: errors.cases, correct: correct.cases };
}

/** Batch so the analyzer sees the same shape it sees in production. */
const BATCH_SIZE = 5;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runEval(options: { limit?: number } = {}): Promise<EvalReport> {
  const { errors, correct } = loadFixtures();
  const errorCases = options.limit ? errors.slice(0, options.limit) : errors;
  const correctCases = options.limit ? correct.slice(0, options.limit) : correct;

  const isLive = hasLiveCredentials();

  const gotByCase = new Map<string, string[]>();
  let model = 'unknown';
  let promptVersion = 'unknown';

  const allCases = [
    ...errorCases.map((c) => ({ id: c.id, text: c.text })),
    ...correctCases.map((c) => ({ id: c.id, text: c.text })),
  ];

  for (const batch of chunk(allCases, BATCH_SIZE)) {
    const result = await analyzeErrors(batch, { learnerLevel: 'B2' });
    model = result.modelId;
    promptVersion = result.promptVersion;

    for (const item of batch) gotByCase.set(item.id, []);
    for (const candidate of result.candidates) {
      const list = gotByCase.get(candidate.utteranceId);
      if (list) list.push(candidate.ruleTag);
    }
  }

  // --- Score ---------------------------------------------------------------
  const rules = new Map<string, RuleScore>();
  const bump = (ruleTag: string, field: 'truePositives' | 'falsePositives' | 'falseNegatives') => {
    const existing = rules.get(ruleTag) ?? {
      ruleTag,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: null,
      recall: null,
    };
    existing[field] += 1;
    rules.set(ruleTag, existing);
  };

  const failures: EvalReport['failures'] = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let blockingTruePositives = 0;
  let blockingFalsePositives = 0;

  for (const testCase of errorCases) {
    const got = gotByCase.get(testCase.id) ?? [];
    const expected = new Set(testCase.expected);
    const seen = new Set<string>();

    for (const ruleTag of got) {
      if (seen.has(ruleTag)) continue;
      seen.add(ruleTag);
      const severity = getRule(ruleTag)?.defaultSeverity;
      if (expected.has(ruleTag)) {
        truePositives += 1;
        bump(ruleTag, 'truePositives');
        if (severity === 'blocking') blockingTruePositives += 1;
      } else {
        falsePositives += 1;
        bump(ruleTag, 'falsePositives');
        if (severity === 'blocking') blockingFalsePositives += 1;
      }
    }

    for (const ruleTag of expected) {
      if (!seen.has(ruleTag)) {
        falseNegatives += 1;
        bump(ruleTag, 'falseNegatives');
      }
    }

    if (![...expected].every((r) => seen.has(r)) || [...seen].some((r) => !expected.has(r))) {
      failures.push({ id: testCase.id, text: testCase.text, expected: [...expected], got: [...seen] });
    }
  }

  // The false-positive guard: every one of these must yield nothing at all.
  let falsePositivesOnCorrect = 0;
  let cleanUtterancesPassed = 0;

  for (const testCase of correctCases) {
    const got = gotByCase.get(testCase.id) ?? [];
    if (got.length === 0) {
      cleanUtterancesPassed += 1;
    } else {
      falsePositivesOnCorrect += got.length;
      falsePositives += got.length;
      for (const ruleTag of got) {
        bump(ruleTag, 'falsePositives');
        if (getRule(ruleTag)?.defaultSeverity === 'blocking') blockingFalsePositives += 1;
      }
      failures.push({ id: testCase.id, text: testCase.text, expected: [], got });
    }
  }

  for (const score of rules.values()) {
    const predicted = score.truePositives + score.falsePositives;
    const actual = score.truePositives + score.falseNegatives;
    score.precision = predicted > 0 ? score.truePositives / predicted : null;
    score.recall = actual > 0 ? score.truePositives / actual : null;
  }

  const predicted = truePositives + falsePositives;
  const actual = truePositives + falseNegatives;
  const blockingPredicted = blockingTruePositives + blockingFalsePositives;

  return {
    isLive,
    model,
    promptVersion,
    errorCases: errorCases.length,
    correctCases: correctCases.length,
    falsePositivesOnCorrect,
    cleanUtterancesPassed,
    overall: {
      truePositives,
      falsePositives,
      falseNegatives,
      precision: predicted > 0 ? truePositives / predicted : 0,
      recall: actual > 0 ? truePositives / actual : 0,
    },
    blockingPrecision: blockingPredicted > 0 ? blockingTruePositives / blockingPredicted : null,
    byRule: [...rules.values()].sort((a, b) => b.falsePositives - a.falsePositives),
  failures,
  };
}

function pct(value: number | null): string {
  return value === null ? '  n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  const rule = '─'.repeat(72);

  lines.push('');
  lines.push('ANALYZER EVALUATION');
  lines.push(rule);

  if (!report.isLive) {
    lines.push('');
    lines.push('  ⚠  UNVERIFIED — no real analyzer provider configured.');
    lines.push('     These numbers come from the SCRIPTED development stand-in, which is');
    lines.push('     pattern matching, not a model. They say nothing about the real analyzer.');
    lines.push('     Configure ANTHROPIC_API_KEY, or ENGCOACH_PROVIDER_COLD=ollama for a');
    lines.push('     local model. The M5 precision gate cannot be satisfied without one.');
  } else if (report.model.startsWith('ollama:')) {
    lines.push('');
    lines.push('  ℹ  LOCAL MODEL — this is a real measurement and the gate applies.');
    lines.push('     Small models tend to over-flag: watch the false-positive guard below');
    lines.push('     more closely than the precision figure.');
  }

  lines.push('');
  lines.push(`  model            ${report.model}`);
  lines.push(`  prompt           ${report.promptVersion}`);
  lines.push(`  error cases      ${report.errorCases}`);
  lines.push(`  correct cases    ${report.correctCases}`);
  lines.push('');
  lines.push(rule);
  lines.push('  FALSE-POSITIVE GUARD (the one that matters most)');
  lines.push('');
  lines.push(
    `  clean utterances with zero findings   ${report.cleanUtterancesPassed}/${report.correctCases}` +
      `  ${pct(report.cleanUtterancesPassed / Math.max(1, report.correctCases))}`,
  );
  lines.push(`  spurious findings on clean speech     ${report.falsePositivesOnCorrect}`);
  lines.push('');
  lines.push(rule);
  lines.push('  OVERALL');
  lines.push('');
  lines.push(`  precision        ${pct(report.overall.precision)}   (target ${pct(PRECISION_TARGET)} on blocking)`);
  lines.push(`  recall           ${pct(report.overall.recall)}   (secondary — a missed error is cheap)`);
  lines.push(`  blocking prec.   ${pct(report.blockingPrecision)}`);
  lines.push(
    `  tp/fp/fn         ${report.overall.truePositives}/${report.overall.falsePositives}/${report.overall.falseNegatives}`,
  );

  const worst = report.byRule.filter((r) => r.falsePositives > 0).slice(0, 10);
  if (worst.length > 0) {
    lines.push('');
    lines.push(rule);
    lines.push('  WORST OFFENDERS BY FALSE POSITIVES');
    lines.push('');
    for (const score of worst) {
      lines.push(
        `  ${score.ruleTag.padEnd(42)} fp=${String(score.falsePositives).padStart(3)}  prec=${pct(score.precision)}`,
      );
    }
  }

  lines.push('');
  lines.push(rule);
  lines.push(`  ${report.failures.length} case(s) did not match the annotation exactly.`);
  lines.push('  Run with --verbose to list them.');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * Shell-agnostic overrides.
 *
 * `FOO=bar npm run ...` is bash syntax and silently does nothing on Windows cmd, so the
 * provider and model are settable as flags instead:
 *
 *     npm run eval:analyzers -- --provider=ollama --model=qwen2.5:7b-instruct --gate
 *
 * Applied to the COLD lane, which is the one the analyzer uses.
 */
function applyCliOverrides(argv: string[]): void {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3) || undefined;
  };

  const provider = flag('provider');
  if (provider) process.env.ENGCOACH_PROVIDER_COLD = provider;

  const model = flag('model');
  if (model) {
    // Set both namespaces: whichever the provider resolves to will pick its own up.
    process.env.ENGCOACH_OLLAMA_MODEL_COLD = model;
    process.env.ENGCOACH_MODEL_COLD = model;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const verbose = process.argv.includes('--verbose');
  const gate = process.argv.includes('--gate');

  // CLI first so it beats the files, then the files fill in the rest.
  applyCliOverrides(process.argv);
  const loaded = loadEnvFiles();

  const limitFlag = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitFlag ? Number.parseInt(limitFlag.slice(8), 10) : undefined;

  runEval(Number.isFinite(limit) ? { limit: limit as number } : {})
    .then((report) => {
      console.log(formatReport(report));
      console.log(
        `  env: ${loaded.files.length > 0 ? loaded.files.join(' + ') : 'none found'}
`,
      );

      if (verbose && report.failures.length > 0) {
        console.log('MISMATCHES\n');
        for (const failure of report.failures) {
          console.log(`  [${failure.id}] ${failure.text}`);
          console.log(`     expected: ${failure.expected.join(', ') || '(none)'}`);
          console.log(`     got:      ${failure.got.join(', ') || '(none)'}`);
          console.log('');
        }
      }

      if (gate) {
        if (!report.isLive) {
          console.error('GATE FAILED: cannot verify precision without live credentials.\n');
          process.exit(1);
        }
        const blocking = report.blockingPrecision ?? 0;
        if (blocking < PRECISION_TARGET) {
          console.error(
            `GATE FAILED: blocking precision ${pct(blocking)} is below the ${pct(PRECISION_TARGET)} target.\n`,
          );
          process.exit(1);
        }
        if (report.falsePositivesOnCorrect > 0) {
          console.error(
            `GATE FAILED: ${report.falsePositivesOnCorrect} finding(s) on utterances that are correct.\n`,
          );
          process.exit(1);
        }
        console.log('GATE PASSED\n');
      }
    })
    .catch((error: unknown) => {
      console.error('Eval failed:', error);
      process.exit(1);
    });
}
