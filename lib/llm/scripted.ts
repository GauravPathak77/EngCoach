/**
 * Scripted development provider.
 *
 * ⚠️  THIS IS NOT THE PRODUCT. It is a deterministic stand-in used ONLY when ANTHROPIC_API_KEY
 * is absent, so that the conversation loop, the policy engine, persistence and the UI can be
 * developed and tested without credentials.
 *
 * It is honest about itself everywhere it surfaces:
 *   - every response carries `isLive: false`
 *   - `modelId` is prefixed "scripted:"
 *   - the session UI shows a persistent "development mode" banner
 *   - `npm run eval:analyzers` REFUSES to report a precision figure against it
 *
 * The pattern matching below produces realistic, schema-valid findings for a handful of very
 * common learner errors. That makes the pipeline exercisable. It is emphatically not an error
 * analyzer, and no quality claim in the blueprint is satisfied by it.
 */

import type { CompletionRequest, CompletionResult, StreamEvent } from './types';

const ZERO_USAGE = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

function result(raw: string, modelId: string, started: number): CompletionResult<string> {
  return {
    content: raw,
    raw,
    modelId: `scripted:${modelId}`,
    usage: ZERO_USAGE,
    costUsd: 0,
    latencyMs: Date.now() - started,
    isLive: false,
  };
}

/** Which prompt is calling decides what shape of scripted response is needed. */
function kindOf(request: CompletionRequest): string {
  const v = request.promptVersion;
  if (v.startsWith('analyzers/error')) return 'error';
  if (v.startsWith('analyzers/vocab')) return 'vocab';
  if (v.startsWith('analyzers/say-it-better')) return 'sayItBetter';
  if (v.startsWith('report/')) return 'report';
  return 'conversation';
}

export async function scriptedComplete(
  request: CompletionRequest,
): Promise<Omit<CompletionResult<string>, 'modelId' | 'latencyMs'>> {
  const raw = buildResponse(request);
  return { content: raw, raw, usage: ZERO_USAGE, costUsd: 0, isLive: false };
}

export async function* scriptedStream(
  request: CompletionRequest,
  modelId: string,
  started: number,
): AsyncGenerator<StreamEvent> {
  const raw = buildResponse(request);
  // Emit in sentence-sized pieces so the client's chunker and audio queue get exercised.
  const pieces = raw.match(/[^.!?]+[.!?]*\s*/g) ?? [raw];
  for (const piece of pieces) {
    yield { type: 'text', delta: piece };
    await new Promise((r) => setTimeout(r, 40));
  }
  yield { type: 'done', result: result(raw, modelId, started) };
}

function buildResponse(request: CompletionRequest): string {
  switch (kindOf(request)) {
    case 'error':
      return JSON.stringify(scriptedFindings(request));
    case 'vocab':
      return JSON.stringify(scriptedVocab(request));
    case 'sayItBetter':
      return JSON.stringify(scriptedSayItBetter(request));
    case 'report':
      return JSON.stringify(scriptedReport());
    default:
      return scriptedReply(request);
  }
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const OPENERS = [
  "That's interesting — tell me more about that.",
  'Oh nice. What made you decide to do that?',
  'I like that. How did it turn out in the end?',
  'Really? What was the hardest part of it?',
  'Got it. And how do you feel about it now?',
];

function scriptedReply(request: CompletionRequest): string {
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser?.content ?? '';
  const directive = request.system.find((b) => b.text.includes('RECAST'))?.text ?? '';

  // Honour a recast directive so the policy engine's effect is visible even in dev mode.
  const recast = /the correct form is "([^"]+)"/.exec(directive);
  if (recast?.[1]) {
    return `Ah, so you ${recast[1]} — that sounds good. What happened next?`;
  }

  // Deterministic pick so tests are stable: hash the input rather than using randomness.
  const index = [...text].reduce((a, c) => a + c.charCodeAt(0), 0) % OPENERS.length;
  return OPENERS[index] ?? OPENERS[0]!;
}

// ---------------------------------------------------------------------------
// Error findings — simple, well-known learner patterns
// ---------------------------------------------------------------------------

type Pattern = {
  re: RegExp;
  ruleTag: string;
  severity: 'blocking' | 'notable' | 'polish';
  fix: (m: RegExpExecArray) => string;
  explain: string;
};

const PATTERNS: Pattern[] = [
  {
    re: /\bhave\s+went\b/i,
    ruleTag: 'grammar.tense.past_simple.irregular',
    severity: 'notable',
    fix: () => 'went',
    explain: 'With a finished past time, use "went".',
  },
  {
    re: /\bhas\s+went\b/i,
    ruleTag: 'grammar.tense.past_simple.irregular',
    severity: 'notable',
    fix: () => 'gone',
    explain: 'After "has", the form is "gone".',
  },
  {
    re: /\b(am|is|are)\s+having\s+a\s+(plan|idea|doubt)\b/i,
    ruleTag: 'naturalness.calque',
    severity: 'notable',
    fix: (m) => `have a ${m[2]}`,
    explain: 'English uses "have a plan", not "am having a plan".',
  },
  {
    re: /\bdiscuss\s+about\b/i,
    ruleTag: 'grammar.preposition.dependent',
    severity: 'notable',
    fix: () => 'discuss',
    explain: '"Discuss" does not take "about".',
  },
  {
    re: /\bdepends?\s+of\b/i,
    ruleTag: 'grammar.preposition.dependent',
    severity: 'notable',
    fix: () => 'depends on',
    explain: 'The verb is "depend on".',
  },
  {
    re: /\binformations\b/i,
    ruleTag: 'grammar.countability',
    severity: 'notable',
    fix: () => 'information',
    explain: '"Information" is uncountable in English.',
  },
  {
    re: /\badvices\b/i,
    ruleTag: 'grammar.countability',
    severity: 'notable',
    fix: () => 'advice',
    explain: '"Advice" is uncountable in English.',
  },
  {
    re: /\bmake\s+a\s+photo\b/i,
    ruleTag: 'lexical.collocation',
    severity: 'notable',
    fix: () => 'take a photo',
    explain: 'English pairs "take" with "photo".',
  },
  {
    re: /\byesterday\s+I\s+have\b/i,
    ruleTag: 'grammar.tense.present_perfect.vs_past',
    severity: 'notable',
    fix: () => 'yesterday I',
    explain: 'A finished time word takes the past simple, not the present perfect.',
  },
];

function scriptedFindings(request: CompletionRequest): unknown {
  const utterances = extractUtterances(request);
  const findings: unknown[] = [];
  const observations: unknown[] = [];

  for (const { id, text } of utterances) {
    const words = text.split(/\s+/);
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(text);
      if (!match) continue;
      const before = text.slice(0, match.index).trim();
      const wordStart = before.length === 0 ? 0 : before.split(/\s+/).length;
      const spanText = match[0];
      const wordEnd = Math.min(words.length - 1, wordStart + spanText.split(/\s+/).length - 1);
      const fixed = pattern.fix(match);

      findings.push({
        utteranceId: id,
        ruleTag: pattern.ruleTag,
        severity: pattern.severity,
        wordStart,
        wordEnd: Math.max(wordStart, wordEnd),
        originalSpanText: spanText,
        suggestedSpanText: fixed,
        suggestedUtterance: text.replace(pattern.re, fixed),
        explanationShort: pattern.explain,
        // Deliberately not 1.0: the scripted provider must not look more certain than a model.
        llmConfidence: 0.88,
      });

      observations.push({
        utteranceId: id,
        ruleTag: pattern.ruleTag,
        obligatoryContext: true,
        produced: true,
        correct: false,
      });
    }

    // A correct past-tense production, so the denominator is not always failures.
    if (/\b(went|bought|took|saw|made|did|had|came|got)\b/i.test(text) && !/\bhave\s+went\b/i.test(text)) {
      observations.push({
        utteranceId: id,
        ruleTag: 'grammar.tense.past_simple.irregular',
        obligatoryContext: true,
        produced: true,
        correct: true,
      });
    }
  }

  return { findings: findings.slice(0, 20), observations: observations.slice(0, 30) };
}

// ---------------------------------------------------------------------------
// Vocabulary / Say It Better / Report
// ---------------------------------------------------------------------------

const OVERUSED: Record<string, { lemma: string; definition: string }> = {
  good: { lemma: 'solid', definition: 'reliably good; dependable' },
  nice: { lemma: 'lovely', definition: 'very pleasant or enjoyable' },
  big: { lemma: 'substantial', definition: 'large in size or importance' },
  thing: { lemma: 'aspect', definition: 'a particular part or feature of something' },
  very: { lemma: 'genuinely', definition: 'really; in a true sense' },
};

function scriptedVocab(request: CompletionRequest): unknown {
  const utterances = extractUtterances(request);
  const candidates: unknown[] = [];

  for (const { text } of utterances) {
    for (const [word, upgrade] of Object.entries(OVERUSED)) {
      if (candidates.length >= 3) break;
      if (!new RegExp(`\\b${word}\\b`, 'i').test(text)) continue;
      if (candidates.some((c) => (c as { replacesText: string }).replacesText === word)) continue;
      candidates.push({
        lemma: upgrade.lemma,
        sense: `alternative to "${word}"`,
        definition: upgrade.definition,
        register: 'neutral',
        cefrLevel: 'B2',
        examples: [`That was a ${upgrade.lemma} result.`],
        anchorUtterance: text,
        replacesText: word,
        reason: 'overuse',
      });
    }
  }
  return { candidates: candidates.slice(0, 3) };
}

function scriptedSayItBetter(request: CompletionRequest): unknown {
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const original = (lastUser?.content ?? '').replace(/^.*?"([^"]*)".*$/s, '$1') || 'your sentence';
  return {
    variants: [
      {
        register: 'natural',
        text: original.replace(/\bmany people\b/i, 'a lot of people').replace(/\bis good\b/i, "'s a good idea"),
        why: 'more idiomatic in spoken English',
      },
      {
        register: 'professional',
        text: `I believe ${original.charAt(0).toLowerCase()}${original.slice(1)}`,
        why: 'more measured for a work setting',
      },
    ],
    meaningPreserved: true,
  };
}

function scriptedReport(): unknown {
  return {
    topFixes: [],
    phrasesToSteal: [],
    oneThingThatWentWell:
      'You kept the conversation going without switching languages, which is the hard part.',
    focusNext: 'Keep practising past-tense storytelling about recent events.',
  };
}

// ---------------------------------------------------------------------------

/**
 * Analyzer prompts embed utterances as `[id] text` lines in the user message. Parsing them back
 * out keeps the scripted provider aligned with the real prompt contract.
 */
function extractUtterances(request: CompletionRequest): Array<{ id: string; text: string }> {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  if (!last) return [];
  const out: Array<{ id: string; text: string }> = [];
  for (const line of last.content.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) out.push({ id: match[1], text: match[2] });
  }
  return out;
}
