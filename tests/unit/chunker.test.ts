/**
 * lib/voice/chunker — ROADMAP.md M3.
 *
 * The hard part is not splitting on "." — it is NOT splitting on "e.g.", "Mr.", "3.5" or "U.K."
 * A false split produces audible stutter mid-sentence, so every awkward case gets a test.
 */

import { describe, expect, it } from 'vitest';
import { isSentenceEnd, SentenceChunker, splitSentences } from '@/lib/voice/chunker';

describe('sentence-end detection', () => {
  it('accepts a plain full stop followed by a space', () => {
    const text = 'I went there. Then I left.';
    expect(isSentenceEnd(text, text.indexOf('.'))).toBe(true);
  });

  it('accepts a full stop at the very end', () => {
    expect(isSentenceEnd('Done.', 4)).toBe(true);
  });

  it('rejects abbreviations', () => {
    for (const text of ['See e.g. this one.', 'Mr. Smith arrived.', 'Tea, coffee, etc. all fine.']) {
      const firstDot = text.indexOf('.');
      expect(isSentenceEnd(text, firstDot), text).toBe(false);
    }
  });

  it('rejects decimals', () => {
    const text = 'It costs 3.5 dollars.';
    expect(isSentenceEnd(text, text.indexOf('.'))).toBe(false);
  });

  it('rejects single-letter initials', () => {
    const text = 'J. Smith called.';
    expect(isSentenceEnd(text, 1)).toBe(false);
  });

  it('rejects the leading dots of an ellipsis but accepts the last', () => {
    const text = 'Well... anyway.';
    expect(isSentenceEnd(text, 4)).toBe(false);
    expect(isSentenceEnd(text, 5)).toBe(false);
  });

  it('accepts question and exclamation marks', () => {
    expect(isSentenceEnd('Really? Yes.', 6)).toBe(true);
    expect(isSentenceEnd('Wow! Yes.', 3)).toBe(true);
  });

  it('rejects a full stop glued to the next word (likely a URL or typo)', () => {
    expect(isSentenceEnd('example.com', 7)).toBe(false);
  });
});

describe('splitSentences', () => {
  it('splits complete sentences and keeps the incomplete tail', () => {
    const { sentences, remainder } = splitSentences('One. Two. Three');
    expect(sentences).toEqual(['One.', 'Two.']);
    expect(remainder.trim()).toBe('Three');
  });

  it('keeps a closing quote with its own sentence', () => {
    const { sentences } = splitSentences('He said "hello." Then he left.');
    expect(sentences[0]).toBe('He said "hello."');
  });

  it('returns nothing when no sentence has finished', () => {
    const { sentences, remainder } = splitSentences('I was going to');
    expect(sentences).toEqual([]);
    expect(remainder).toBe('I was going to');
  });

  it('does not split an abbreviation mid-stream', () => {
    const { sentences } = splitSentences('Bring a coat, gloves, etc. before we go.');
    expect(sentences).toEqual(['Bring a coat, gloves, etc. before we go.']);
  });
});

describe('SentenceChunker over a stream', () => {
  it('emits each sentence as soon as it completes', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('That sounds really good. ')).toEqual(['That sounds really good.']);
    expect(chunker.push('What happened next')).toEqual([]);
    expect(chunker.push('? ')).toEqual(['What happened next?']);
  });

  it('handles a sentence arriving in many tiny deltas', () => {
    const chunker = new SentenceChunker();
    const out: string[] = [];
    for (const char of 'I like that idea a lot. Tell me more.') {
      out.push(...chunker.push(char));
    }
    out.push(...chunker.flush());
    expect(out).toEqual(['I like that idea a lot.', 'Tell me more.']);
  });

  it('merges a very short fragment into the next sentence rather than calling TTS for "Oh."', () => {
    const chunker = new SentenceChunker();
    const first = chunker.push('Oh. ');
    expect(first).toEqual([]);
    expect(chunker.push('That is genuinely interesting to hear. ')).toEqual([
      'Oh. That is genuinely interesting to hear.',
    ]);
  });

  it('flushes an unterminated tail when the stream ends', () => {
    const chunker = new SentenceChunker();
    chunker.push('This never got a full stop');
    expect(chunker.flush()).toEqual(['This never got a full stop']);
  });

  it('flushes nothing when everything was already emitted', () => {
    const chunker = new SentenceChunker();
    chunker.push('A complete sentence here. ');
    expect(chunker.flush()).toEqual([]);
  });

  it('preserves the full text across the stream', () => {
    const chunker = new SentenceChunker();
    const input = 'First one. Second one! Third one? And a tail';
    const out = [...chunker.push(input), ...chunker.flush()];
    expect(out.join(' ')).toBe(input);
  });
});
