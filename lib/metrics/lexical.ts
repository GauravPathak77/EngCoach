/**
 * Lexical measurement — AI_BEHAVIOR.md §6.1 Layer A.
 *
 * PURE MODULE (CLAUDE.md invariant 1).
 *
 * MTLD rather than raw type-token ratio: TTR falls as a sample gets longer, so comparing a
 * 40-word turn against a 400-word session with TTR would report a decline that is purely an
 * artefact of length. MTLD is length-independent, which is the whole reason it exists.
 */

import type { Word } from '@/lib/types';
import { contentWords, isFiller, normalise } from './fluency';

/**
 * The ~250 most frequent English words. Content lemmas *outside* this set are what we count
 * as "advanced" for the frequency-band profile. A full 2000-word band list would be better and
 * is a V2 refinement; this subset is enough to distinguish "good/nice/thing" speech from
 * genuinely varied speech, which is what the metric is for.
 */
const HIGH_FREQUENCY = new Set([
  'the','be','to','of','and','a','in','that','have','i','it','for','not','on','with','he','as',
  'you','do','at','this','but','his','by','from','they','we','say','her','she','or','an','will',
  'my','one','all','would','there','their','what','so','up','out','if','about','who','get','which',
  'go','me','when','make','can','like','time','no','just','him','know','take','people','into',
  'year','your','good','some','could','them','see','other','than','then','now','look','only',
  'come','its','over','think','also','back','after','use','two','how','our','work','first','well',
  'way','even','new','want','because','any','these','give','day','most','us','is','was','are',
  'were','been','has','had','did','said','very','thing','things','really','much','many','more',
  'lot','nice','big','small','little','great','bad','need','try','feel','find','tell','ask','seem',
  'leave','put','mean','keep','let','begin','help','talk','turn','start','show','hear','play','run',
  'move','live','believe','bring','happen','write','sit','stand','lose','pay','meet','include',
  'continue','set','learn','change','lead','understand','watch','follow','stop','create','speak',
  'read','allow','add','spend','grow','open','walk','win','offer','remember','love','consider',
  'appear','buy','wait','serve','die','send','build','stay','fall','cut','reach','kill','remain',
  'today','yesterday','tomorrow','here','where','why','again','still','too','never','always',
  'sometimes','often','maybe','yes','okay','ok','well','right','sure','thank','thanks','please',
  'am','being','doing','going','got','went','made','told','came','took','gave','said','saw','felt',
  'am','and','he','she','it','we','they','you','i','one','two','three','some','every','each','own',
  'same','such','both','few','last','next','long','old','high','different','following','without',
]);

/** Discourse markers that stand in for content and should not count as vocabulary range. */
const FUNCTION_ONLY = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but']);

export function lemmas(words: Word[]): string[] {
  return contentWords(words)
    .map((w) => normalise(w.w))
    .filter((t) => t.length > 0 && !FUNCTION_ONLY.has(t));
}

/**
 * Measure of Textual Lexical Diversity.
 *
 * Walk the token stream accumulating a running type-token ratio; each time it drops below
 * 0.72, close a "factor" and reset. MTLD is the mean number of tokens per factor. Computed
 * forwards and backwards and averaged, which is the standard formulation.
 *
 * Returns 0 for samples too short to be meaningful rather than a misleading number — under
 * about 15 tokens the measure is noise, and reporting noise as a metric is exactly what
 * AI_BEHAVIOR.md §7.1 forbids.
 */
export function mtld(tokens: string[], threshold = 0.72): number {
  if (tokens.length < 15) return 0;
  const forward = mtldPass(tokens, threshold);
  const backward = mtldPass([...tokens].reverse(), threshold);
  return round2((forward + backward) / 2);
}

function mtldPass(tokens: string[], threshold: number): number {
  let factors = 0;
  let types = new Set<string>();
  let tokenCount = 0;

  for (const token of tokens) {
    tokenCount += 1;
    types.add(token);
    const ttr = types.size / tokenCount;
    if (ttr <= threshold) {
      factors += 1;
      types = new Set<string>();
      tokenCount = 0;
    }
  }

  // A trailing partial factor counts proportionally, otherwise short tails are discarded.
  if (tokenCount > 0) {
    const ttr = types.size / tokenCount;
    const remainder = (1 - ttr) / (1 - threshold);
    factors += Number.isFinite(remainder) ? remainder : 0;
  }

  if (factors === 0) return tokens.length;
  return tokens.length / factors;
}

/** Share of content lemmas outside the high-frequency band. 0..1. */
export function advancedWordRatio(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const advanced = tokens.filter((t) => !HIGH_FREQUENCY.has(t)).length;
  return round2(advanced / tokens.length);
}

/**
 * Content lemmas the speaker leans on, most frequent first. Feeds the vocabulary engine's
 * overuse detection (AI_BEHAVIOR.md §5.1) — every vocabulary item is mined from something the
 * user actually said.
 */
export function overusedLemmas(
  tokens: string[],
  options: { minCount?: number; limit?: number } = {},
): Array<{ lemma: string; count: number }> {
  const minCount = options.minCount ?? 3;
  const limit = options.limit ?? 10;
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.length < 3) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([lemma, count]) => ({ lemma, count }))
    .sort((a, b) => b.count - a.count || a.lemma.localeCompare(b.lemma))
    .slice(0, limit);
}

/** Distinct-word count, excluding fillers. */
export function typeCount(words: Word[]): number {
  return new Set(lemmas(words)).size;
}

export function fillerRatePer100Words(words: Word[]): number {
  const content = contentWords(words).length;
  if (content === 0) return 0;
  const fillers = words.filter(isFiller).length;
  return round2((fillers / content) * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
