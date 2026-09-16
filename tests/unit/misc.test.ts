/**
 * Frustration detection, retention policy, prompt loading, mode registry, and Say It Better
 * selection. Small modules, but each one guards a promise the product makes.
 */

import { describe, expect, it } from 'vitest';
import {
  detectEvents,
  isShortTurn,
  matchesStopIntent,
  nextShortTurnCount,
  rulesToSuppress,
} from '@/lib/coaching/frustration';
import {
  audioPurgeDeadline,
  AUDIO_RETENTION_HOURS,
  llmCallCutoff,
  shouldPurgeAudio,
  USER_SCOPED_TABLES,
} from '@/lib/privacy/retention';
import { allPromptFiles, loadPrompt, promptVersions } from '@/prompts/index';
import { ALL_MODES, DEFAULT_MODE, getMode, isValidMode, MODES } from '@/lib/modes/registry';
import { selectMostInvested } from '@/lib/analysis/sayItBetter';
import { assembleConversationPrompt, renderUtterances } from '@/lib/llm/assemble';
import { buildDirective, NO_DIRECTIVE } from '@/lib/coaching/directive';
import { costOf, modelFor } from '@/lib/llm/models';
import type { SessionState, ScoredFinding } from '@/lib/types';

// ---------------------------------------------------------------------------

describe('stop-intent detection', () => {
  it('catches explicit requests to stop being corrected', () => {
    for (const phrase of [
      'please stop correcting me',
      "don't correct me all the time",
      'can we just talk normally',
      'no more corrections please',
    ]) {
      expect(matchesStopIntent(phrase), phrase).toBe(true);
    }
  });

  it('does not fire on ordinary conversation', () => {
    for (const phrase of [
      'I went to the market yesterday',
      'correct me if I am wrong about the date',
      'that is a good correction to the plan',
    ]) {
      expect(matchesStopIntent(phrase), phrase).toBe(false);
    }
  });
});

describe('disengagement counting', () => {
  it('only accumulates after a correction has been surfaced', () => {
    // Short turns during ordinary chat are not a signal of anything.
    expect(nextShortTurnCount(0, 2, false)).toBe(0);
    expect(nextShortTurnCount(2, 2, false)).toBe(0);
  });

  it('increments on short turns and resets on a substantial one', () => {
    expect(nextShortTurnCount(1, 2, true)).toBe(2);
    expect(nextShortTurnCount(2, 30, true)).toBe(0);
  });

  it('uses the documented short-turn threshold', () => {
    expect(isShortTurn(4)).toBe(true);
    expect(isShortTurn(5)).toBe(false);
  });
});

describe('frustration events', () => {
  const state = (over: Partial<SessionState>): SessionState => ({
    turnIndex: 5,
    userTurnCount: 5,
    spokenCount: 0,
    lastSpokenTurnIndex: null,
    microTeachCount: 0,
    drillCount: 0,
    disputesThisSession: 0,
    stopIntentRaised: false,
    consecutiveShortTurns: 0,
    suppressedRuleTags: [],
    focusSkills: { primary: null, secondary: null },
    ruleTagCountsThisSession: {},
    shownRuleTagsThisSegment: [],
    visualCardsThisSegment: 0,
    atTopicBoundary: false,
    ...over,
  });

  it('reports nothing in a healthy session', () => {
    expect(detectEvents(state({}))).toHaveLength(0);
  });

  it('reports each trigger distinctly', () => {
    expect(detectEvents(state({ disputesThisSession: 2 }))[0]?.kind).toBe('disputes');
    expect(detectEvents(state({ stopIntentRaised: true }))[0]?.kind).toBe('stop_intent');
    expect(detectEvents(state({ consecutiveShortTurns: 3 }))[0]?.kind).toBe('disengagement');
  });
});

describe('persistent rule suppression', () => {
  it('suppresses a rule disputed twice — the user is allowed to be right', () => {
    expect(rulesToSuppress({ 'grammar.countability': 2, 'lexical.collocation': 1 })).toEqual([
      'grammar.countability',
    ]);
  });

  it('returns a stable sorted list', () => {
    expect(rulesToSuppress({ b: 3, a: 2 })).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------

describe('retention policy', () => {
  const now = new Date('2026-08-22T12:00:00Z');

  it('sets the audio deadline at the documented window', () => {
    const transcribed = new Date('2026-08-22T00:00:00Z');
    const deadline = audioPurgeDeadline(transcribed);
    expect(deadline.getTime() - transcribed.getTime()).toBe(AUDIO_RETENTION_HOURS * 3600 * 1000);
  });

  it('purges expired audio', () => {
    expect(
      shouldPurgeAudio(
        { audioKey: 'k', pinned: false, audioPurgeAfter: new Date('2026-08-21T00:00:00Z') },
        now,
      ),
    ).toBe(true);
  });

  it('spares pinned clips the user asked to keep', () => {
    expect(
      shouldPurgeAudio(
        { audioKey: 'k', pinned: true, audioPurgeAfter: new Date('2026-08-01T00:00:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('leaves audio that has not expired', () => {
    expect(
      shouldPurgeAudio(
        { audioKey: 'k', pinned: false, audioPurgeAfter: new Date('2026-08-23T00:00:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('is a no-op when the audio is already gone', () => {
    expect(shouldPurgeAudio({ audioKey: null, pinned: false, audioPurgeAfter: null }, now)).toBe(false);
  });

  it('enumerates every user-scoped table so deletion cannot silently miss one', () => {
    expect(USER_SCOPED_TABLES).toContain('findings');
    expect(USER_SCOPED_TABLES).toContain('skill_estimates');
    expect(USER_SCOPED_TABLES).toContain('user_vocab_states');
    expect(USER_SCOPED_TABLES).toContain('users');
  });

  it('rolls telemetry off on the documented schedule', () => {
    expect(llmCallCutoff(now).getTime()).toBeLessThan(now.getTime());
  });
});

// ---------------------------------------------------------------------------

describe('prompt loading and versioning', () => {
  it('loads every prompt file with valid front-matter', () => {
    const files = allPromptFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const prompt = loadPrompt(file);
      expect(prompt.frontMatter.id, file).toBeTruthy();
      expect(prompt.frontMatter.version, file).toBeGreaterThan(0);
      expect(prompt.body.length, file).toBeGreaterThan(50);
    }
  });

  it('produces a version key that gets persisted with every record', () => {
    // CLAUDE.md invariant 4: without this the eval harness cannot re-score history.
    const prompt = loadPrompt('analyzers/error-analyzer.md');
    expect(prompt.versionKey).toBe(`${prompt.frontMatter.id}@${prompt.frontMatter.version}`);
  });

  it('exposes a manifest of every prompt version', () => {
    const versions = promptVersions();
    expect(versions['core/identity']).toBeGreaterThan(0);
    expect(versions['analyzers/error-analyzer']).toBeGreaterThan(0);
  });

  it('states the never-do rules in the core identity prompt', () => {
    const core = loadPrompt('core/identity.md').body;
    expect(core).toContain('Never interrupt');
    expect(core).toContain('Never ask two questions');
    expect(core.toLowerCase()).toContain('never give empty praise');
  });

  it('tells the error analyzer to prefer precision over recall', () => {
    // RISKS.md R2: a missed error costs almost nothing; a false one destroys trust.
    const body = loadPrompt('analyzers/error-analyzer.md').body;
    expect(body).toContain('Precision over recall');
    expect(body.toLowerCase()).toContain('transcri');
  });
});

describe('prompt assembly ordering', () => {
  it('puts the stable layers first and the volatile directive last', () => {
    // ARCHITECTURE.md §3.1 / ADR-007. Get this wrong and the hot lane costs 3-4x more.
    const assembled = assembleConversationPrompt({
      mode: MODES.casual,
      snapshot: '## Learner notes\nLevel: B2.',
      history: [{ role: 'user', content: 'Hello' }],
      directive: NO_DIRECTIVE,
    });

    expect(assembled.system).toHaveLength(4);
    expect(assembled.system.slice(0, 3).every((b) => b.cacheable)).toBe(true);
    expect(assembled.system[3]?.cacheable).toBe(false);
    expect(assembled.system[3]?.text).toContain('DIRECTIVE');
    expect(assembled.system[2]?.text).toContain('Learner notes');
  });

  it('records the prompt versions that produced the turn', () => {
    const assembled = assembleConversationPrompt({
      mode: MODES.coach,
      snapshot: 'x',
      history: [],
      directive: NO_DIRECTIVE,
    });
    expect(assembled.promptVersion).toContain('core/identity@');
    expect(assembled.promptVersion).toContain('modes/coach@');
  });

  it('renders utterances in the [id] form the analyzers and fixtures share', () => {
    expect(renderUtterances([{ id: 'u1', text: 'I have went' }])).toBe('[u1] I have went');
  });
});

describe('turn directives', () => {
  const finding = {
    originalSpanText: 'have went',
    suggestedSpanText: 'went',
    suggestedUtterance: 'I went to the market',
    ruleTag: 'grammar.tense.past_simple.irregular',
  } as ScoredFinding;

  it('tells the coach to recast WITHOUT naming the mistake', () => {
    const directive = buildDirective('recast', finding);
    expect(directive.text).toContain('RECAST');
    expect(directive.text).toContain('Do NOT point out the mistake');
    expect(directive.text).toContain('went');
  });

  it('keeps a micro-teach to one sentence plus an example', () => {
    const directive = buildDirective('micro_teach', finding);
    expect(directive.text).toContain('one short');
    expect(directive.text).toContain('No grammar jargon');
  });

  it('stays within the ~40 token L4 budget', () => {
    for (const kind of ['recast', 'micro_teach', 'drill'] as const) {
      const directive = buildDirective(kind, finding);
      // Roughly 4 chars per token; generous ceiling so a rewrite has room but not licence.
      expect(directive.text.length, kind).toBeLessThan(400);
    }
  });

  it('still instructs the coach when there is nothing to correct', () => {
    expect(NO_DIRECTIVE.kind).toBe('none');
    expect(NO_DIRECTIVE.text).toContain('follow-up question');
  });
});

// ---------------------------------------------------------------------------

describe('mode registry', () => {
  it('ships exactly the three V1 modes', () => {
    // Storytelling, Interview and Negotiation are V2/V3 and must not appear.
    expect(ALL_MODES).toHaveLength(3);
    expect(ALL_MODES.map((m) => m.id).sort()).toEqual(['casual', 'coach', 'free_topic']);
  });

  it('rejects a V2/V3 mode name', () => {
    expect(isValidMode('negotiation')).toBe(false);
    expect(isValidMode('interview')).toBe(false);
    expect(() => getMode('storytelling')).toThrow();
  });

  it('differs by configuration rather than by code path', () => {
    // ADR-011. Casual and Coach share one engine and differ in these numbers.
    expect(MODES.casual.recastInterval).toBeGreaterThan(MODES.coach.recastInterval);
    expect(MODES.casual.allowMicroTeach).toBe(false);
    expect(MODES.coach.allowMicroTeach).toBe(true);
  });

  it('keeps casual Say It Better to natural only — not everything should be professionalised', () => {
    expect(MODES.casual.sayItBetterRegisters).toEqual(['natural']);
    expect(MODES.coach.sayItBetterRegisters).toContain('professional');
  });

  it('caps coach replies short enough to leave the user most of the talking time', () => {
    for (const mode of ALL_MODES) {
      expect(mode.maxReplyWords, mode.id).toBeLessThanOrEqual(60);
    }
  });

  it('has a sensible default', () => {
    expect(isValidMode(DEFAULT_MODE)).toBe(true);
  });
});

describe('say it better selection', () => {
  it('picks the most invested utterance, weighting improvement headroom', () => {
    const chosen = selectMostInvested([
      { id: 'a', text: 'short one here ok', wordCount: 9, polishFindingCount: 0 },
      { id: 'b', text: 'a longer more considered thought', wordCount: 12, polishFindingCount: 2 },
    ]);
    expect(chosen?.id).toBe('b');
  });

  it('ignores utterances too short to be worth rewriting', () => {
    expect(selectMostInvested([{ id: 'a', text: 'yes', wordCount: 1, polishFindingCount: 0 }])).toBeNull();
  });

  it('is empty-safe', () => {
    expect(selectMostInvested([])).toBeNull();
  });
});

describe('cost accounting', () => {
  it('charges cached input at the reduced rate', () => {
    const full = costOf('claude-opus-5', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 });
    const cached = costOf('claude-opus-5', { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 });
    expect(cached).toBeLessThan(full);
    expect(cached).toBeCloseTo(full * 0.1, 6);
  });

  it('returns zero for an unknown model rather than throwing', () => {
    expect(costOf('scripted:whatever', { inputTokens: 100, cachedInputTokens: 0, outputTokens: 100 })).toBe(0);
  });

  it('assigns a model to every lane', () => {
    for (const lane of ['hot', 'cold', 'session'] as const) {
      expect(modelFor(lane)).toBeTruthy();
    }
  });
});
