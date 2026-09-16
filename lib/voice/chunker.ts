/**
 * Sentence chunker — ROADMAP.md M3.
 *
 * PURE. Splits a streaming reply at sentence boundaries so TTS can start synthesising the first
 * sentence while the model is still writing the second. This is the largest perceived-latency
 * win in the pipeline (ARCHITECTURE.md §1.3): synthesising the whole reply first would add the
 * entire generation time to time-to-first-audio.
 *
 * The hard part is not splitting on ".", it is NOT splitting on "e.g.", "Mr.", "3.5" or "U.K.".
 * Getting that wrong produces audible stutter mid-sentence, so it is heavily tested.
 */

/** Abbreviations that end in a period but do not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'fig', 'no',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'a.m', 'p.m', 'u.s', 'u.k', 'e.u',
]);

/**
 * True when the period at `index` genuinely ends a sentence.
 * Exported for direct testing of the tricky cases.
 */
export function isSentenceEnd(text: string, index: number): boolean {
  const char = text[index];
  if (char !== '.' && char !== '!' && char !== '?') return false;

  // "..." — only the last dot of an ellipsis can end a sentence.
  if (char === '.' && text[index + 1] === '.') return false;

  if (char === '.') {
    // Decimal number: 3.5
    const prev = text[index - 1];
    const next = text[index + 1];
    if (prev && next && /\d/.test(prev) && /\d/.test(next)) return false;

    // Abbreviation: walk back over the token preceding the period.
    let start = index - 1;
    while (start >= 0) {
      const c = text[start];
      if (!c || !/[A-Za-z.]/.test(c)) break;
      start--;
    }
    const token = text.slice(start + 1, index).toLowerCase();
    if (ABBREVIATIONS.has(token)) return false;

    // Single-letter initial: "J. Smith"
    if (token.length === 1) return false;
  }

  // A sentence end must be followed by end-of-text, whitespace, or a closing quote.
  const after = text.slice(index + 1);
  if (after.length === 0) return true;
  return /^["'”’)\]]*(\s|$)/.test(after);
}

/**
 * Split complete sentences out of a growing buffer.
 * Returns the finished sentences and whatever remains incomplete, which the caller keeps
 * accumulating until the stream ends.
 */
export function splitSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (!isSentenceEnd(buffer, i)) continue;

    // Include trailing quotes/brackets that belong to this sentence.
    let end = i + 1;
    while (end < buffer.length && /["'”’)\]]/.test(buffer[end] ?? '')) end++;

    const sentence = buffer.slice(start, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    start = end;
  }

  return { sentences, remainder: buffer.slice(start) };
}

/** Below this a "sentence" is usually an artefact; merge it into the next one. */
const MIN_CHUNK_CHARS = 12;

/**
 * Stateful chunker for a streaming reply.
 *
 * `push` returns any newly completed chunks; `flush` returns whatever is left when the stream
 * ends. Very short sentences are held back and merged so TTS is not called for "Oh." — each
 * call has fixed overhead, and a two-word clip sounds clipped.
 */
export class SentenceChunker {
  private buffer = '';
  private pending = '';

  push(delta: string): string[] {
    this.buffer += delta;
    const { sentences, remainder } = splitSentences(this.buffer);
    this.buffer = remainder;

    const out: string[] = [];
    for (const sentence of sentences) {
      const combined = join(this.pending, sentence);
      if (combined.length < MIN_CHUNK_CHARS) {
        this.pending = combined;
      } else {
        out.push(combined);
        this.pending = '';
      }
    }
    return out;
  }

  flush(): string[] {
    const tail = join(this.pending, this.buffer);
    this.pending = '';
    this.buffer = '';
    return tail.length > 0 ? [tail] : [];
  }
}

/**
 * Join two fragments with exactly one space.
 *
 * Naive template interpolation leaves a double space when the second fragment already carries
 * the leading whitespace from the split, and that reaches the TTS input verbatim.
 */
function join(left: string, right: string): string {
  const a = left.trim();
  const b = right.trim();
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return `${a} ${b}`;
}
