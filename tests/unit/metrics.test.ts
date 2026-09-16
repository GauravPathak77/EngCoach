/**
 * lib/metrics — AI_BEHAVIOR.md §6.1 Layer A.
 *
 * These are the FACTS that back every fluency number the product shows, so the fixtures below
 * are hand-computed rather than snapshotted. A snapshot test here would happily lock in a bug.
 */

import { describe, expect, it } from 'vitest';
import {
  computeUtteranceMetrics,
  contentWords,
  countRepairs,
  findPauses,
  isFiller,
  meanLengthOfRun,
  totalPauseTime,
} from '@/lib/metrics/fluency';
import { advancedWordRatio, lemmas, mtld, overusedLemmas, fillerRatePer100Words } from '@/lib/metrics/lexical';
import { computeSessionMetrics } from '@/lib/metrics/session';
import type { Word } from '@/lib/types';

/** Build words with explicit gaps: [word, duration, gapAfter]. */
function build(spec: Array<[string, number, number]>): Word[] {
  const words: Word[] = [];
  let t = 0;
  for (const [w, duration, gap] of spec) {
    words.push({ w, s: t, e: t + duration, c: 0.95 });
    t += duration + gap;
  }
  return words;
}

describe('filler detection', () => {
  it('honours the recogniser flag', () => {
    expect(isFiller({ w: 'like', s: 0, e: 1, c: 1, filler: true })).toBe(true);
  });

  it('falls back to a known filler list when the recogniser does not tag', () => {
    expect(isFiller({ w: 'um', s: 0, e: 1, c: 1 })).toBe(true);
    expect(isFiller({ w: 'Uh,', s: 0, e: 1, c: 1 })).toBe(true);
    expect(isFiller({ w: 'market', s: 0, e: 1, c: 1 })).toBe(false);
  });

  it('excludes fillers from the content word count', () => {
    const words = build([['I', 0.2, 0], ['um', 0.3, 0], ['went', 0.3, 0]]);
    expect(contentWords(words)).toHaveLength(2);
  });
});

describe('pause classification', () => {
  it('separates mid-clause from clause-boundary pauses', () => {
    // "I went to the ___ market and ___ bought"
    // The first pause follows "the" (mid-clause), the second follows "and" (a boundary word).
    const words = build([
      ['I', 0.2, 0.05],
      ['went', 0.3, 0.05],
      ['to', 0.15, 0.05],
      ['the', 0.15, 0.9],
      ['market', 0.4, 0.05],
      ['and', 0.2, 0.8],
      ['bought', 0.4, 0],
    ]);

    const pauses = findPauses(words);
    expect(pauses).toHaveLength(2);
    expect(pauses.filter((p) => p.midClause)).toHaveLength(1);
    expect(pauses.filter((p) => !p.midClause)).toHaveLength(1);
  });

  it('treats trailing punctuation as a clause boundary', () => {
    const words: Word[] = [
      { w: 'Yes.', s: 0, e: 0.4, c: 1 },
      { w: 'Then', s: 1.4, e: 1.8, c: 1 },
    ];
    expect(findPauses(words)[0]?.midClause).toBe(false);
  });

  it('ignores gaps below the threshold', () => {
    const words = build([['a', 0.2, 0.3], ['b', 0.2, 0]]);
    expect(findPauses(words)).toHaveLength(0);
  });

  it('sums pause time above the articulation threshold', () => {
    const words = build([['a', 0.2, 0.5], ['b', 0.2, 0.1], ['c', 0.2, 0]]);
    // Only the 0.5s gap clears the 0.25s articulation threshold.
    expect(totalPauseTime(words)).toBeCloseTo(0.5, 5);
  });
});

describe('mean length of run', () => {
  it('is the whole utterance when there are no pauses or fillers', () => {
    const words = build([['a', 0.2, 0], ['b', 0.2, 0], ['c', 0.2, 0], ['d', 0.2, 0]]);
    expect(meanLengthOfRun(words)).toBe(4);
  });

  it('breaks runs at pauses', () => {
    // Two words, pause, two words -> runs of 2 and 2.
    const words = build([['a', 0.2, 0], ['b', 0.2, 0.6], ['c', 0.2, 0], ['d', 0.2, 0]]);
    expect(meanLengthOfRun(words)).toBe(2);
  });

  it('breaks runs at fillers and does not count them', () => {
    const words: Word[] = [
      { w: 'I', s: 0, e: 0.2, c: 1 },
      { w: 'went', s: 0.2, e: 0.4, c: 1 },
      { w: 'um', s: 0.4, e: 0.7, c: 1, filler: true },
      { w: 'there', s: 0.7, e: 0.9, c: 1 },
    ];
    // Runs: [I, went] = 2, [there] = 1 -> mean 1.5
    expect(meanLengthOfRun(words)).toBe(1.5);
  });

  it('returns 0 for an empty utterance', () => {
    expect(meanLengthOfRun([])).toBe(0);
  });
});

describe('repairs', () => {
  it('counts immediate repetitions', () => {
    const words = build([['I', 0.2, 0], ['I', 0.2, 0], ['went', 0.3, 0]]);
    expect(countRepairs(words)).toBe(1);
  });

  it('counts abandoned starts where a prefix is restarted', () => {
    const words = build([['wen', 0.2, 0], ['went', 0.3, 0]]);
    expect(countRepairs(words)).toBe(1);
  });

  it('does not count unrelated consecutive words', () => {
    const words = build([['I', 0.2, 0], ['went', 0.3, 0], ['home', 0.3, 0]]);
    expect(countRepairs(words)).toBe(0);
  });
});

describe('computeUtteranceMetrics', () => {
  it('returns zeros for an empty utterance without throwing', () => {
    const metrics = computeUtteranceMetrics([]);
    expect(metrics.wordCount).toBe(0);
    expect(metrics.speechRate).toBe(0);
    expect(metrics.mlr).toBe(0);
  });

  it('handles a single-word utterance (articulation rate has no pause to subtract)', () => {
    const words: Word[] = [{ w: 'yes', s: 0, e: 0.5, c: 1 }];
    const metrics = computeUtteranceMetrics(words);
    expect(metrics.wordCount).toBe(1);
    expect(metrics.durationMs).toBe(500);
    // 1 word in 0.5s = 120 wpm.
    expect(metrics.speechRate).toBeCloseTo(120, 1);
    expect(metrics.articulationRate).toBeCloseTo(120, 1);
  });

  it('computes articulation rate above speech rate when there are pauses', () => {
    const words = build([['one', 0.3, 0], ['two', 0.3, 1.0], ['three', 0.3, 0]]);
    const metrics = computeUtteranceMetrics(words);
    expect(metrics.articulationRate).toBeGreaterThan(metrics.speechRate);
  });

  it('carries the injected response latency through', () => {
    const words = build([['hi', 0.2, 0]]);
    expect(computeUtteranceMetrics(words, { responseLatencyMs: 640 }).responseLatencyMs).toBe(640);
  });

  /**
   * ADR-018: without real word timings we must not invent a pause profile. Reporting zero
   * pauses would read as "perfectly fluent", so the flag is what consumers branch on.
   */
  it('zeroes timing-derived fields and flags them when timings are unreliable', () => {
    const words: Word[] = [
      { w: 'I', s: 0, e: 0, c: 0.5 },
      { w: 'went', s: 1, e: 1, c: 0.5 },
      { w: 'there', s: 2, e: 2, c: 0.5 },
    ];
    const metrics = computeUtteranceMetrics(words, {
      timingsReliable: false,
      fallbackDurationMs: 2000,
    });

    expect(metrics.timingsReliable).toBe(false);
    expect(metrics.articulationRate).toBe(0);
    expect(metrics.pauseCountMidclause).toBe(0);
    expect(metrics.mlr).toBe(0);

    // But word count, duration and speech rate stay real.
    expect(metrics.wordCount).toBe(3);
    expect(metrics.durationMs).toBe(2000);
    expect(metrics.speechRate).toBeCloseTo(90, 1);
  });
});

describe('lexical measures', () => {
  it('returns 0 for MTLD on samples too short to mean anything', () => {
    // Under ~15 tokens the measure is noise, and reporting noise as a metric is exactly what
    // AI_BEHAVIOR.md §7.1 forbids.
    expect(mtld(['one', 'two', 'three'])).toBe(0);
  });

  it('scores varied text above repetitive text of the same length', () => {
    const varied = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ');
    const repetitive = 'good good good nice nice nice thing thing thing good nice thing good nice thing good'.split(' ');
    expect(mtld(varied)).toBeGreaterThan(mtld(repetitive));
  });

  it('counts content lemmas outside the high-frequency band', () => {
    expect(advancedWordRatio(['the', 'good', 'thing'])).toBe(0);
    expect(advancedWordRatio(['quixotic', 'perambulate'])).toBe(1);
  });

  it('finds overused lemmas above the threshold, most frequent first', () => {
    const tokens = 'good good good nice nice market'.split(' ');
    const overused = overusedLemmas(tokens, { minCount: 2 });
    expect(overused[0]).toEqual({ lemma: 'good', count: 3 });
    expect(overused.map((o) => o.lemma)).not.toContain('market');
  });

  it('drops fillers and pure function words from the lemma stream', () => {
    const words: Word[] = [
      { w: 'the', s: 0, e: 1, c: 1 },
      { w: 'um', s: 1, e: 2, c: 1, filler: true },
      { w: 'market', s: 2, e: 3, c: 1 },
    ];
    expect(lemmas(words)).toEqual(['market']);
  });

  it('computes filler rate per 100 content words', () => {
    const words: Word[] = [
      { w: 'one', s: 0, e: 1, c: 1 },
      { w: 'two', s: 1, e: 2, c: 1 },
      { w: 'um', s: 2, e: 3, c: 1, filler: true },
      { w: 'three', s: 3, e: 4, c: 1 },
      { w: 'four', s: 4, e: 5, c: 1 },
    ];
    // 1 filler / 4 content words = 25 per 100.
    expect(fillerRatePer100Words(words)).toBe(25);
  });
});

describe('session aggregation', () => {
  it('computes the talk-time ratio in the user favour', () => {
    const metrics = computeSessionMetrics({
      utterances: [computeUtteranceMetrics(build([['a', 1, 0]]))],
      allUserWords: build([['a', 1, 0]]),
      coachSpeechMs: 0,
    });
    expect(metrics.talkTimeRatio).toBe(1);
  });

  it('taints the session flag when any turn lacked timings', () => {
    // A mean articulation rate computed over a mix of real and absent timings is not a
    // measurement of anything.
    const good = computeUtteranceMetrics(build([['a', 0.3, 0], ['b', 0.3, 0]]));
    const bad = computeUtteranceMetrics(build([['c', 0.3, 0]]), {
      timingsReliable: false,
      fallbackDurationMs: 500,
    });

    expect(computeSessionMetrics({ utterances: [good], allUserWords: [], coachSpeechMs: 0 }).timingsReliable).toBe(true);
    expect(computeSessionMetrics({ utterances: [good, bad], allUserWords: [], coachSpeechMs: 0 }).timingsReliable).toBe(false);
  });

  it('is empty-safe', () => {
    const metrics = computeSessionMetrics({ utterances: [], allUserWords: [], coachSpeechMs: 0 });
    expect(metrics.turnCount).toBe(0);
    expect(metrics.talkTimeRatio).toBe(0);
    expect(metrics.timingsReliable).toBe(false);
  });
});

describe('unsupported numbers are not dressed up as feedback', () => {
  it('reports zero speech duration when every turn was typed', () => {
    // A typed session has no measured speech time. The consumer must render the talk-time
    // ratio as "gathering evidence" rather than "0% — aim higher", which would be an
    // unsupported number presented as a judgement (AI_BEHAVIOR.md §7.1).
    const typed = computeUtteranceMetrics(
      [
        { w: 'I', s: 0, e: 0, c: 1 },
        { w: 'typed', s: 1, e: 1, c: 1 },
        { w: 'this', s: 2, e: 2, c: 1 },
      ],
      { timingsReliable: false, fallbackDurationMs: 0 },
    );

    expect(typed.durationMs).toBe(0);
    expect(typed.wordCount).toBe(3);

    const session = computeSessionMetrics({
      utterances: [typed],
      allUserWords: [],
      coachSpeechMs: 18000,
    });

    expect(session.userSpeechMs).toBe(0);
    // The ratio is arithmetically 0, which is exactly why the UI must gate on userSpeechMs
    // rather than trusting the ratio.
    expect(session.talkTimeRatio).toBe(0);
    expect(session.timingsReliable).toBe(false);
  });

  it('reports a real ratio when speech was actually measured', () => {
    const spoken = computeUtteranceMetrics(build([['a', 1, 0], ['b', 1, 0]]));
    const session = computeSessionMetrics({
      utterances: [spoken],
      allUserWords: [],
      coachSpeechMs: 1000,
    });
    expect(session.userSpeechMs).toBeGreaterThan(0);
    expect(session.talkTimeRatio).toBeGreaterThan(0);
  });
});
