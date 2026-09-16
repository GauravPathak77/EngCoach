/**
 * Architecture guard — ADR-014.
 *
 * The purity boundary in CLAUDE.md invariant 1 is enforced here, not remembered.
 * `npm run check:arch` fails the build on an illegal import.
 *
 * If a genuinely necessary new edge appears: change the rule here AND write an ADR.
 */

/** Modules that must stay pure: no I/O, no network, no LLM, no clock, no randomness. */
const PURE = [
  '^lib/coaching',
  '^lib/metrics',
  '^lib/profile',
  '^lib/analysis/taxonomy\\.ts$',
  '^lib/analysis/rules\\.ts$',
];

/** Things a pure module may never reach for. */
const IMPURE_TARGETS = [
  '^lib/llm',
  '^lib/voice',
  '^db',
  '^server',
  '^app',
  '^components',
  '^node_modules/(next|react|react-dom|@anthropic-ai|drizzle-orm|pg|@electric-sql)',
];

module.exports = {
  forbidden: [
    {
      name: 'purity-boundary',
      comment:
        'CLAUDE.md invariant 1 / ADR-014: the pedagogy modules (coaching, metrics, profile, ' +
        'taxonomy) must be pure functions. No I/O, no network, no LLM, no framework. ' +
        'Clock and RNG are injected parameters.',
      severity: 'error',
      from: { path: PURE },
      to: { path: IMPURE_TARGETS },
    },
    {
      name: 'purity-no-node-builtins',
      comment:
        'CLAUDE.md invariant 1: pure pedagogy modules may not touch node builtins. ' +
        'That would mean filesystem, crypto randomness, or timers.',
      severity: 'error',
      from: { path: PURE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-llm-in-components',
      comment:
        'CLAUDE.md invariant 2: LLM calls live in lib/llm (transport) and ' +
        'server/services + lib/analysis/*Analyzer.ts (callers). Never in React components.',
      severity: 'error',
      from: { path: '^components' },
      to: { path: ['^lib/llm', '^server', '^db', '^node_modules/@anthropic-ai'] },
    },
    {
      name: 'no-llm-in-metrics',
      comment: 'CLAUDE.md invariant 2: metrics are computed from word timings, never by a model.',
      severity: 'error',
      from: { path: '^lib/metrics' },
      to: { path: ['^lib/llm', '^lib/analysis'] },
    },
    {
      name: 'api-routes-do-not-import-components',
      comment: 'Route handlers are server-side; importing UI drags React into the API bundle.',
      severity: 'error',
      from: { path: '^app/api' },
      to: { path: '^components' },
    },
    {
      name: 'analyzers-do-not-persist',
      comment:
        'ARCHITECTURE.md §7: analyzers return structured data; services persist it. ' +
        'This keeps analyzers runnable inside the eval harness with no database.',
      severity: 'error',
      from: { path: '^lib/analysis/.*Analyzer\\.ts$' },
      to: { path: '^db' },
    },
    {
      name: 'prompts-are-data',
      comment: 'prompts/ loads prompt files. It must not depend on application logic.',
      severity: 'error',
      from: { path: '^prompts' },
      to: { path: ['^server', '^db', '^components', '^lib/analysis', '^lib/coaching'] },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies make the layering unenforceable.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)(babel|postcss|tailwind|drizzle|next|eslint|vitest)\\.config\\.(js|cjs|mjs|ts)$',
          '^app/',
          '^tests/',
          '^db/(push|reset|seed)',
          '^server/jobs/runPurge\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.next|coverage|tests/evals/fixtures)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
