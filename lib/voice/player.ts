'use client';

/**
 * Audio playback queue — ROADMAP.md M3.
 *
 * Plays chunk N while chunk N+1 is still being synthesised. Chunks are enqueued by sequence
 * number and played strictly in order even when they arrive out of order, which they will:
 * a short second sentence often synthesises faster than a long first one.
 *
 * No barge-in in V1 (CLAUDE.md scope). Interrupting is expected to fail gracefully — `stop()`
 * exists so the End button and navigation can silence playback, not so the user can talk over it.
 */

import {
  BROWSER_VOICE_CHARS_PER_SECOND,
  BROWSER_VOICE_PITCH,
  BROWSER_VOICE_RATE,
  BROWSER_VOICE_WATCHDOG_SLACK_MS,
  pickBrowserVoice,
} from './browserVoice';
import type { VoicePresentation } from './tts/voices';

export type PlayerCallbacks = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  /** Fired when the requested coach voice was not available on this platform (ADR-020). */
  onVoiceFallback?: (reason: string) => void;
};

type QueueEntry = { seq: number; play: () => Promise<void> };

export class AudioQueue {
  private queue: QueueEntry[] = [];
  private nextSeq = 0;
  private playing = false;
  private stopped = false;
  private current: HTMLAudioElement | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private started = false;
  private browserVoice: SpeechSynthesisVoice | null = null;
  private browserVoiceResolved = false;

  constructor(
    private readonly callbacks: PlayerCallbacks = {},
    /** Which coach voice to look for in the browser fallback. ADR-020. */
    private readonly presentation: VoicePresentation = 'female',
  ) {}

  /** Server-synthesised audio (OpenAI path). */
  enqueueAudio(seq: number, blob: Blob): void {
    this.enqueue(seq, () => this.playBlob(blob));
  }

  /** Browser speech synthesis (no TTS credentials). */
  enqueueSpeech(seq: number, text: string): void {
    this.enqueue(seq, () => this.speak(text));
  }

  private enqueue(seq: number, play: () => Promise<void>): void {
    if (this.stopped) return;
    this.queue.push({ seq, play });
    this.queue.sort((a, b) => a.seq - b.seq);
    void this.drain();
  }

  /**
   * Play everything that is contiguous from `nextSeq`. A gap means an earlier chunk is still in
   * flight, so we wait rather than playing sentence three before sentence two.
   */
  private async drain(): Promise<void> {
    if (this.playing || this.stopped) return;

    const head = this.queue[0];
    if (!head || head.seq !== this.nextSeq) return;

    this.playing = true;
    this.queue.shift();
    this.nextSeq += 1;

    if (!this.started) {
      this.started = true;
      this.callbacks.onStart?.();
    }

    try {
      await head.play();
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.playing = false;
    }

    if (this.queue.length > 0) void this.drain();
    else if (!this.stopped) this.callbacks.onEnd?.();
  }

  private playBlob(blob: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.current = audio;

      const cleanup = (): void => {
        URL.revokeObjectURL(url);
        this.current = null;
      };

      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error('Could not play the coach audio.'));
      };
      audio.play().catch((error: unknown) => {
        cleanup();
        // Autoplay policy: the browser wants a user gesture first. The session screen starts
        // from a button press, so this is rare, but it must not kill the turn.
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * Resolve the browser voice once per queue.
   *
   * `getVoices()` is asynchronous on Chrome — it returns an empty array until the engine has
   * loaded — so this is called lazily at first speak rather than in the constructor, and a miss
   * simply leaves the platform default in place.
   */
  private resolveBrowserVoice(): SpeechSynthesisVoice | null {
    if (this.browserVoiceResolved) return this.browserVoice;
    if (typeof speechSynthesis === 'undefined') return null;

    const available = speechSynthesis.getVoices();
    if (available.length === 0) return null; // Try again on the next chunk.

    const choice = pickBrowserVoice(available, this.presentation);
    this.browserVoice = choice.voice;
    this.browserVoiceResolved = true;
    if (!choice.matched) {
      // Honest, not silent: the platform had no voice matching the requested presentation.
      this.callbacks.onVoiceFallback?.(choice.reason);
    }
    return this.browserVoice;
  }

  private speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof speechSynthesis === 'undefined') return resolve();

      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.resolveBrowserVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = 'en-US';
      }
      utterance.rate = BROWSER_VOICE_RATE;
      utterance.pitch = BROWSER_VOICE_PITCH;
      this.currentUtterance = utterance;

      /**
       * Watchdog. `onend` is not reliable: headless and virtualised environments fire it late or
       * never, and Chrome has a long-standing bug where synthesis stalls on long utterances.
       * Without this the avatar sticks in SPEAKING and the Talk button stays disabled — the user
       * loses the session with no way back. Resolving early is harmless; hanging is not.
       */
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this.currentUtterance = null;
        resolve();
      };

      const estimatedMs = (text.length / BROWSER_VOICE_CHARS_PER_SECOND) * 1000;
      const watchdog = setTimeout(finish, estimatedMs * 2 + BROWSER_VOICE_WATCHDOG_SLACK_MS);

      utterance.onend = finish;
      utterance.onerror = finish;

      speechSynthesis.speak(utterance);
    });
  }

  /** Silence playback and drop anything queued. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    if (typeof speechSynthesis !== 'undefined' && this.currentUtterance) {
      speechSynthesis.cancel();
      this.currentUtterance = null;
    }
  }

  /** Start a fresh reply. */
  reset(): void {
    this.stop();
    this.stopped = false;
    this.queue = [];
    this.nextSeq = 0;
    this.playing = false;
    this.started = false;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
