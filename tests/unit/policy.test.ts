/**
 * lib/coaching/policy — AI_BEHAVIOR.md §3, ADR-002.
 *
 * Every rule in §3 gets a named test here, because this module is the difference between a
 * coach and an annoyance. The property test at the bottom is the one that matters most: it
 * asserts the voice budget can never be exceeded, across a thousand generated sessions.
 */

import { describe, expect, it } from 'vitest';
import { applyGate1, decide, scoreFinding, MIN_COMBINED_CONFIDENCE } from '@/lib/coaching/policy';
import { MODES } from '@/lib/modes/registry';
import { WARMUP_TURNS, MAX_VISUAL_CARDS_PER_SEGMENT } from '@/lib/coaching/budgets';
import type { CandidateFinding, SessionState, UserSettings, Word } from '@/lib/types';

const SETTINGS: UserSettings = {
  voiceCorrectionsEnabled: true,
  drillsOptIn: false,
  difficulty: 5,
};

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    turnIndex: 10,
    userTurnCount: 10,
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
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: 'f1',
    utteranceId: 'u1',
    type: 'grammar',
    ruleTag: 'grammar.tense.past_simple.irregular',
    span: { wordStart: 0, wordEnd: 1 },
    originalSpanText: 'have went',
    originalUtterance: 'I have went to the market',
    suggestedSpanText: 'went',
    suggestedUtterance: 'I went to the market',
    explanationShort: 'Use "went" with a finished past time.',
    severity: 'notable',
    llmConfidence: 0.95,
    ...overrides,
  };
}

function words(confidence = 0.95, count = 6): Word[] {
  return Array.from({ length: count }, (_, i) => ({
    w: `w${i}`,
    s: i * 0.3,
    e: i * 0.3 + 0.25,
    c: confidence,
  }));
}

// ---------------------------------------------------------------------------
// Gate 1 — the safety filter
// ---------------------------------------------------------------------------

describe('Gate 1: ASR-suspect suppression (the false-correction guard)', () => {
  it('discounts an asr-prone rule by the confidence of the words it is about', () => {
    // past_simple.irregular is asr_prone: recognisers drop verb endings constantly.
    const scored = scoreFinding(candidate({ llmConfidence: 1 }), words(0.6), null);
    expect(scored.combinedConfidence).toBeCloseTo(0.6, 5);
    expect(scored.isAsrSuspect).toBe(true);
  });

  it('does not penalise a rule the recogniser cannot affect', () => {
    // Word order is not something ASR mangles the way it mangles articles.
    const scored = scoreFinding(
      candidate({ ruleTag: 'grammar.word_order.question', llmConfidence: 0.9 }),
      words(0.6),
      null,
    );
    expect(scored.combinedConfidence).toBeCloseTo(0.9, 5);
    expect(scored.isAsrSuspect).toBe(false);
  });

  it('takes the WEAKEST word in the span, not the average', () => {
    const mixed = words(0.99);
    mixed[1] = { w: 'went', s: 0.3, e: 0.55, c: 0.4 };
    expect(scoreFinding(candidate(), mixed, null).asrConfidence).toBeCloseTo(0.4, 5);
  });

  it('drops asr-suspect findings BEFORE they are recorded, not merely before they are shown', () => {
    // A finding we are unsure about must not pollute the learning profile either, or the
    // adaptive engine starts steering at a weakness the user does not have.
    const scored = [scoreFinding(candidate(), words(0.5), null)];
    const { kept, dropped } = applyGate1(scored, []);
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.status).toBe('suppressed');
    expect(dropped[0]?.reason).toContain('asr-suspect');
  });

  it('drops findings below the combined-confidence floor', () => {
    const scored = [
      scoreFinding(
        candidate({ ruleTag: 'lexical.collocation', llmConfidence: MIN_COMBINED_CONFIDENCE - 0.05 }),
        words(1),
        null,
      ),
    ];
    expect(applyGate1(scored, []).kept).toHaveLength(0);
  });

  it('drops findings for rules the user has suppressed', () => {
    const scored = [scoreFinding(candidate({ ruleTag: 'grammar.countability' }), words(1), null)];
    const { kept, dropped } = applyGate1(scored, ['grammar.countability']);
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toContain('suppression list');
  });

  it('drops unknown rule tags, which cannot be aggregated', () => {
    const scored = [scoreFinding(candidate({ ruleTag: 'grammar.invented.nonsense' }), words(1), null)];
    expect(applyGate1(scored, []).kept).toHaveLength(0);
  });

  it('treats low-SNR audio as suspect regardless of rule', () => {
    const scored = scoreFinding(candidate({ ruleTag: 'lexical.collocation' }), words(1), 0.1);
    expect(scored.isAsrSuspect).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — channel budgets
// ---------------------------------------------------------------------------

describe('Gate 2: the voice channel is rationed', () => {
  const base = {
    words: words(0.99),
    snrEstimate: null,
    settings: SETTINGS,
  };

  it('never corrects during the warm-up turns', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: state({ turnIndex: WARMUP_TURNS - 1 }),
      mode: MODES.coach,
    });
    expect(decision.turnDirective.kind).toBe('none');
  });

  it('speaks a blocking finding once the warm-up is over', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: state({ turnIndex: 6 }),
      mode: MODES.coach,
    });
    expect(decision.turnDirective.kind).toBe('recast');
    expect(decision.recorded.find((f) => f.id === 'f1')?.status).toBe('spoken');
  });

  it('stays silent about a non-blocking finding that is not a focus skill', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'polish' })],
      state: state({ turnIndex: 6 }),
      mode: MODES.casual,
    });
    expect(decision.turnDirective.kind).toBe('none');
    // ...but it is still recorded, and still eligible for a silent card.
    expect(decision.recorded).toHaveLength(1);
  });

  it('speaks a non-blocking finding when it IS the session focus', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'notable' })],
      state: state({
        turnIndex: 6,
        focusSkills: { primary: 'grammar.tense.past_simple.irregular', secondary: null },
      }),
      mode: MODES.coach,
    });
    expect(decision.turnDirective.kind).toBe('recast');
  });

  it('respects the spacing interval since the last spoken correction', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      // Coach interval is 3; only 1 turn has passed.
      state: state({ turnIndex: 7, spokenCount: 1, lastSpokenTurnIndex: 6 }),
      mode: MODES.coach,
    });
    expect(decision.turnDirective.kind).toBe('none');
  });

  it('silences the voice channel entirely when the user turned it off', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: state({ turnIndex: 8 }),
      mode: MODES.coach,
      settings: { ...SETTINGS, voiceCorrectionsEnabled: false },
    });
    expect(decision.turnDirective.kind).toBe('none');
  });

  it('corrects less often in casual mode than in coach mode', () => {
    expect(MODES.casual.recastInterval).toBeGreaterThan(MODES.coach.recastInterval);
  });
});

describe('Gate 2: micro-teach and drills', () => {
  const base = { words: words(0.99), snrEstimate: null };

  it('is refused in casual mode', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: state({
        turnIndex: 8,
        atTopicBoundary: true,
        focusSkills: { primary: 'grammar.tense.past_simple.irregular', secondary: null },
        ruleTagCountsThisSession: { 'grammar.tense.past_simple.irregular': 3 },
      }),
      mode: MODES.casual,
      settings: SETTINGS,
    });
    expect(decision.turnDirective.kind).toBe('recast');
  });

  it('needs the rule to have happened at least twice, at a topic boundary, on the primary focus', () => {
    const ready = state({
      turnIndex: 8,
      atTopicBoundary: true,
      focusSkills: { primary: 'grammar.tense.past_simple.irregular', secondary: null },
      ruleTagCountsThisSession: { 'grammar.tense.past_simple.irregular': 2 },
    });

    const decision = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: ready,
      mode: MODES.coach,
      settings: SETTINGS,
    });
    expect(decision.turnDirective.kind).toBe('micro_teach');

    // One occurrence is not a pattern.
    const notYet = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: { ...ready, ruleTagCountsThisSession: { 'grammar.tense.past_simple.irregular': 1 } },
      mode: MODES.coach,
      settings: SETTINGS,
    });
    expect(notYet.turnDirective.kind).toBe('recast');

    // Not at a boundary: interrupting mid-topic to teach is exactly the classroom feel we avoid.
    const midTopic = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: { ...ready, atTopicBoundary: false },
      mode: MODES.coach,
      settings: SETTINGS,
    });
    expect(midTopic.turnDirective.kind).toBe('recast');
  });

  it('only drills when the user has explicitly opted in', () => {
    const focused = state({
      turnIndex: 8,
      focusSkills: { primary: 'grammar.tense.past_simple.irregular', secondary: null },
    });

    const off = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: focused,
      mode: MODES.coach,
      settings: SETTINGS,
    });
    expect(off.turnDirective.kind).not.toBe('drill');

    const on = decide({
      ...base,
      candidates: [candidate({ severity: 'blocking' })],
      state: focused,
      mode: MODES.coach,
      settings: { ...SETTINGS, drillsOptIn: true },
    });
    expect(on.turnDirective.kind).toBe('drill');
  });
});

describe('Gate 2: the visual channel', () => {
  const base = { words: words(0.99), snrEstimate: null, settings: SETTINGS, mode: MODES.casual };

  it('caps cards per segment', () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate({ id: `f${i}`, ruleTag: `lexical.collocation`, severity: 'polish' }),
    ).map((c, i) => ({ ...c, ruleTag: i % 2 === 0 ? 'lexical.collocation' : 'naturalness.calque' }));

    const decision = decide({ ...base, candidates, state: state({ turnIndex: 6 }) });
    expect(decision.visualCards.length).toBeLessThanOrEqual(MAX_VISUAL_CARDS_PER_SEGMENT);
  });

  it('shows one card per rule and counts the repeats instead of stacking cards', () => {
    const candidates = [
      candidate({ id: 'a', ruleTag: 'naturalness.calque', severity: 'polish' }),
      candidate({ id: 'b', ruleTag: 'naturalness.calque', severity: 'polish' }),
      candidate({ id: 'c', ruleTag: 'naturalness.calque', severity: 'polish' }),
    ];
    const decision = decide({ ...base, candidates, state: state({ turnIndex: 6 }) });

    expect(decision.visualCards).toHaveLength(1);
    expect(decision.visualCards[0]?.repeatCount).toBe(3);
  });

  it('does not re-show a rule already carded this segment', () => {
    const decision = decide({
      ...base,
      candidates: [candidate({ ruleTag: 'naturalness.calque', severity: 'polish' })],
      state: state({ turnIndex: 6, shownRuleTagsThisSegment: ['naturalness.calque'] }),
    });
    expect(decision.visualCards).toHaveLength(0);
  });

  it('prefers the canonical explanation over the model text where the taxonomy has one', () => {
    // RISKS.md R4: the model fills slots rather than authoring grammar.
    const decision = decide({
      ...base,
      candidates: [candidate({ explanationShort: 'MODEL WROTE THIS' })],
      state: state({ turnIndex: 6 }),
    });
    expect(decision.visualCards[0]?.explanationShort).not.toBe('MODEL WROTE THIS');
    expect(decision.visualCards[0]?.explanationShort).toContain('went');
  });

  it('records everything that passes Gate 1, whether or not it is ever surfaced', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      candidate({ id: `f${i}`, ruleTag: 'lexical.collocation', severity: 'polish' }),
    );
    const decision = decide({ ...base, candidates, state: state({ turnIndex: 6 }) });
    expect(decision.recorded).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — the frustration brake
// ---------------------------------------------------------------------------

describe('Gate 3: the frustration brake', () => {
  const base = {
    words: words(0.99),
    snrEstimate: null,
    settings: SETTINGS,
    mode: MODES.coach,
    candidates: [candidate({ severity: 'blocking' })],
  };

  it('fires after two disputes and silences the voice channel', () => {
    const decision = decide({ ...base, state: state({ turnIndex: 8, disputesThisSession: 2 }) });
    expect(decision.brakeEngaged).toBe(true);
    expect(decision.turnDirective.kind).toBe('none');
  });

  it('fires on an explicit stop-correcting intent', () => {
    const decision = decide({ ...base, state: state({ turnIndex: 8, stopIntentRaised: true }) });
    expect(decision.brakeEngaged).toBe(true);
    expect(decision.turnDirective.kind).toBe('none');
  });

  it('fires on disengagement (consecutive very short turns after a correction)', () => {
    const decision = decide({ ...base, state: state({ turnIndex: 8, consecutiveShortTurns: 3 }) });
    expect(decision.brakeEngaged).toBe(true);
  });

  it('keeps recording silently while braked — the user still gets a report', () => {
    const decision = decide({ ...base, state: state({ turnIndex: 8, disputesThisSession: 2 }) });
    expect(decision.recorded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The property that matters most
// ---------------------------------------------------------------------------

describe('property: the voice budget is never exceeded', () => {
  it('holds across 1000 generated sessions', () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let run = 0; run < 1000; run++) {
      const mode = random() > 0.5 ? MODES.casual : MODES.coach;
      const turnCount = 5 + Math.floor(random() * 40);

      let spokenCount = 0;
      let lastSpokenTurnIndex: number | null = null;

      for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
        const n = Math.floor(random() * 5);
        const candidates = Array.from({ length: n }, (_, i) =>
          candidate({
            id: `t${turnIndex}f${i}`,
            severity: random() > 0.7 ? 'blocking' : random() > 0.4 ? 'notable' : 'polish',
            llmConfidence: 0.8 + random() * 0.2,
          }),
        );

        const decision = decide({
          candidates,
          words: words(0.99),
          snrEstimate: null,
          state: state({ turnIndex, userTurnCount: turnCount, spokenCount, lastSpokenTurnIndex }),
          mode,
          settings: SETTINGS,
        });

        if (decision.turnDirective.kind !== 'none') {
          spokenCount += 1;
          lastSpokenTurnIndex = turnIndex;
        }
      }

      const allowed = Math.ceil(turnCount / mode.recastInterval);
      expect(spokenCount).toBeLessThanOrEqual(allowed);
    }
  });

  it('holds the specific case from the roadmap: 20 turns, 14 candidates, at most 3 spoken', () => {
    // ROADMAP.md M6 definition of done.
    let spokenCount = 0;
    let lastSpokenTurnIndex: number | null = null;
    let recorded = 0;

    for (let turnIndex = 0; turnIndex < 20; turnIndex++) {
      // 14 candidates spread over 20 turns.
      const n = turnIndex < 14 ? 1 : 0;
      const candidates = Array.from({ length: n }, () =>
        candidate({ id: `t${turnIndex}`, severity: 'blocking' }),
      );

      const decision = decide({
        candidates,
        words: words(0.99),
        snrEstimate: null,
        state: state({ turnIndex, userTurnCount: 20, spokenCount, lastSpokenTurnIndex }),
        mode: MODES.casual,
        settings: SETTINGS,
      });

      recorded += decision.recorded.length;
      if (decision.turnDirective.kind !== 'none') {
        spokenCount += 1;
        lastSpokenTurnIndex = turnIndex;
      }
    }

    expect(spokenCount).toBeLessThanOrEqual(3);
    expect(recorded).toBe(14);
  });
});
