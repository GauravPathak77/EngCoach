'use client';

/**
 * Web Speech API recognition — the client half of the browser-speech fallback (ADR-018).
 *
 * Used when DEEPGRAM_API_KEY is absent. Recognition happens in the browser and the resulting
 * text is posted to /api/turn, where BrowserSpeechStt packages it with confidence 0.5 so the
 * policy engine correctly suppresses every asr-prone correction.
 *
 * This is a degraded path. It is labelled in the UI and it does not pretend to produce the word
 * timings the fluency metrics need.
 */

type SpeechRecognitionAlternativeLike = { transcript: string; confidence: number };
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
  length: number;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
};
type SpeechRecognitionErrorEventLike = { error: string; message?: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function ctor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserRecognitionAvailable(): boolean {
  return ctor() !== null;
}

export type RecognitionCallbacks = {
  /** Interim text, for live captions. */
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
};

export class BrowserRecognition {
  private recognition: SpeechRecognitionLike | null = null;
  private finalText = '';
  private running = false;

  constructor(private readonly callbacks: RecognitionCallbacks = {}) {}

  start(): boolean {
    const Ctor = ctor();
    if (!Ctor) return false;

    this.finalText = '';
    this.recognition = new Ctor();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0].transcript;
        if (result.isFinal) this.finalText += `${text} `;
        else interim += text;
      }
      const combined = `${this.finalText}${interim}`.trim();
      if (combined.length > 0) this.callbacks.onPartial?.(combined);
    };

    this.recognition.onerror = (event) => {
      // "no-speech" and "aborted" are normal parts of turn-taking, not failures worth surfacing.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.callbacks.onError?.(
        event.error === 'not-allowed'
          ? 'Speech recognition was blocked. Check your browser microphone permissions.'
          : `Speech recognition error: ${event.error}`,
      );
    };

    this.recognition.onend = () => {
      this.running = false;
    };

    try {
      this.recognition.start();
      this.running = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Stop and return whatever was recognised. */
  async stop(): Promise<string> {
    if (!this.recognition) return '';

    const recognition = this.recognition;
    const text = await new Promise<string>((resolve) => {
      const finish = (): void => resolve(this.finalText.trim());
      recognition.onend = finish;
      try {
        recognition.stop();
      } catch {
        finish();
      }
      // The API does not always fire onend; do not hang the turn waiting for it.
      setTimeout(finish, 1200);
    });

    this.recognition = null;
    this.running = false;
    return text;
  }

  abort(): void {
    try {
      this.recognition?.abort();
    } catch {
      // Already stopped.
    }
    this.recognition = null;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
