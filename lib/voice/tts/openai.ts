/**
 * OpenAI TTS adapter — the low-cost neural default (ADR-004, ARCHITECTURE.md §4).
 *
 * Called over plain HTTP: one endpoint does not justify a second vendor SDK in the bundle.
 * Swapping to Azure, Cartesia or ElevenLabs later means adding a sibling file and one line in
 * index.ts — that is the whole point of the interface.
 */

import { TtsError, type TtsAudio, type TtsProvider } from './provider';

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';

export class OpenAiTts implements TtsProvider {
  readonly name = 'openai';
  readonly isServerSide = true;

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
  ) {}

  async synthesize(text: string, voice: string): Promise<TtsAudio> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          voice,
          input: text,
          // mp3 rather than wav: roughly a tenth the bytes, and every browser decodes it.
          response_format: 'mp3',
        }),
      });
    } catch (error) {
      throw new TtsError(`Could not reach the speech service: ${String(error)}`, true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new TtsError(
        `Speech service returned ${response.status}: ${body.slice(0, 200)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const audio = Buffer.from(await response.arrayBuffer());
    return {
      audio,
      mimeType: 'audio/mpeg',
      characters: text.length,
      provider: this.name,
      voice,
      cached: false,
    };
  }
}
