/**
 * Deepgram batch STT adapter — ADR-005, ROADMAP.md M2.
 *
 * Real adapter, called over plain HTTP (the vendor SDK would be a dependency for one endpoint).
 * V1 uses the batch endpoint; V2 swaps to the streaming endpoint on the same vendor, which is
 * exactly why the vendor choice required batch and streaming parity.
 *
 * Query flags that are NOT optional for this product:
 *   punctuate=true      clause-boundary detection in lib/metrics reads trailing punctuation
 *   filler_words=true   filler rate is a headline metric and a report line
 *   utterances / words  per-word timings and confidence drive every Layer A metric and the
 *                       ASR-suspect gate
 */

import type { Word } from '@/lib/types';
import { meanConfidence, SttError, type SttProvider, type SttResult } from './provider';

const ENDPOINT = 'https://api.deepgram.com/v1/listen';

type DeepgramWord = {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
};

type DeepgramResponse = {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        words?: DeepgramWord[];
      }>;
    }>;
  };
};

const FILLER_SET = new Set(['um', 'uh', 'umm', 'uhh', 'mhm', 'mm', 'hmm', 'er', 'erm']);

export class DeepgramStt implements SttProvider {
  readonly name = 'deepgram';
  readonly isLive = true;

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.DEEPGRAM_MODEL ?? 'nova-2',
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<SttResult> {
    const params = new URLSearchParams({
      model: this.model,
      punctuate: 'true',
      filler_words: 'true',
      smart_format: 'false',
      language: 'en',
    });

    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': mimeType },
        body: new Uint8Array(audio),
      });
    } catch (error) {
      throw new SttError(`Could not reach Deepgram: ${String(error)}`, true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SttError(
        `Deepgram returned ${response.status}: ${body.slice(0, 200)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const json = (await response.json()) as DeepgramResponse;
    const alternative = json.results?.channels?.[0]?.alternatives?.[0];
    if (!alternative) {
      throw new SttError('Deepgram response contained no transcript alternative', false);
    }

    const words: Word[] = (alternative.words ?? []).map((w) => {
      const surface = w.punctuated_word ?? w.word;
      const bare = w.word.toLowerCase().replace(/[^a-z']/g, '');
      const word: Word = { w: surface, s: w.start, e: w.end, c: w.confidence };
      if (FILLER_SET.has(bare)) word.filler = true;
      return word;
    });

    const first = words[0];
    const last = words[words.length - 1];
    const durationMs = first && last ? Math.round((last.e - first.s) * 1000) : 0;

    return {
      text: alternative.transcript ?? '',
      words,
      durationMs,
      meanConfidence: meanConfidence(words),
      provider: this.name,
      model: this.model,
      // Deepgram does not report SNR; overall alternative confidence is the closest usable
      // proxy for "was this audio clean enough to trust".
      snrEstimate: alternative.confidence ?? null,
      isLive: true,
      timingsReliable: true,
    };
  }
}
