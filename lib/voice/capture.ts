'use client';

/**
 * Microphone capture and turn detection — ROADMAP.md M2.
 *
 * Two ways to end a turn:
 *   - push-to-talk (hold), the reliable fallback in a noisy room
 *   - hands-free, which watches the input level and ends the turn after a trailing silence
 *
 * Both must exist in V1 (UX.md §1). Hands-free is the better experience; push-to-talk is what
 * works when the room is loud.
 *
 * The 700ms trailing silence is deliberate padding, not waste (ARCHITECTURE.md §1.3): cutting a
 * speaker off mid-thought is far more disruptive than waiting a beat.
 */

export const TRAILING_SILENCE_MS = 700;
export const MIN_UTTERANCE_MS = 400;

/** RMS below this counts as silence. Tuned against a quiet room with a laptop microphone. */
export const SILENCE_THRESHOLD = 0.012;

export type CaptureError =
  | 'permission_denied'
  | 'no_device'
  | 'insecure_context'
  | 'unsupported'
  | 'unknown';

export class MicError extends Error {
  constructor(
    readonly kind: CaptureError,
    message: string,
  ) {
    super(message);
    this.name = 'MicError';
  }
}

export function micErrorMessage(kind: CaptureError): string {
  switch (kind) {
    case 'permission_denied':
      return 'Microphone access was blocked. Allow it in your browser settings, then try again.';
    case 'no_device':
      return 'No microphone found. Plug one in or check your system sound settings.';
    case 'insecure_context':
      return 'Microphones only work over HTTPS or on localhost.';
    case 'unsupported':
      return 'This browser cannot record audio. Try Chrome, Edge, or Safari.';
    default:
      return 'Could not start the microphone.';
  }
}

function classify(error: unknown): CaptureError {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure_context';
  if (!(error instanceof Error)) return 'unknown';
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'permission_denied';
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'no_device';
  if (error.name === 'NotSupportedError') return 'unsupported';
  return 'unknown';
}

export type CaptureCallbacks = {
  /** Input level 0..1, for the orb. Called on every animation frame while recording. */
  onLevel?: (level: number) => void;
  /** Hands-free only: fired when trailing silence ends the turn. */
  onSilenceEnd?: () => void;
  onSpeechStart?: () => void;
};

export type CaptureResult = {
  blob: Blob;
  durationMs: number;
  mimeType: string;
};

export class MicCapture {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Blob[] = [];
  private rafId: number | null = null;
  private startedAt = 0;
  private silenceStart: number | null = null;
  private sawSpeech = false;
  private handsFree = false;

  constructor(private readonly callbacks: CaptureCallbacks = {}) {}

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(handsFree: boolean): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new MicError('unsupported', micErrorMessage('unsupported'));
    }

    this.handsFree = handsFree;
    this.sawSpeech = false;
    this.silenceStart = null;
    this.chunks = [];

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      const kind = classify(error);
      throw new MicError(kind, micErrorMessage(kind));
    }

    this.context = new AudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(100);
    this.startedAt = performance.now();

    this.monitor();
  }

  /** Level monitoring drives both the orb and hands-free turn detection. */
  private monitor = (): void => {
    if (!this.analyser) return;

    const buffer = new Float32Array(this.analyser.fftSize);
    const tick = (): void => {
      if (!this.analyser || !this.isRecording) return;

      this.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      const rms = Math.sqrt(sum / buffer.length);

      this.callbacks.onLevel?.(Math.min(1, rms * 8));

      if (this.handsFree) {
        const now = performance.now();
        if (rms > SILENCE_THRESHOLD) {
          if (!this.sawSpeech) {
            this.sawSpeech = true;
            this.callbacks.onSpeechStart?.();
          }
          this.silenceStart = null;
        } else if (this.sawSpeech) {
          if (this.silenceStart === null) this.silenceStart = now;
          else if (now - this.silenceStart >= TRAILING_SILENCE_MS) {
            this.callbacks.onSilenceEnd?.();
            return;
          }
        }
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  };

  async stop(): Promise<CaptureResult | null> {
    if (!this.recorder || this.recorder.state === 'inactive') {
      this.teardown();
      return null;
    }

    const durationMs = performance.now() - this.startedAt;
    const mimeType = this.recorder.mimeType || 'audio/webm';

    const blob = await new Promise<Blob>((resolve) => {
      const recorder = this.recorder;
      if (!recorder) return resolve(new Blob([]));
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: mimeType }));
      recorder.stop();
    });

    this.teardown();

    // Too short to be speech — the caller re-arms the mic rather than sending noise upstream.
    if (durationMs < MIN_UTTERANCE_MS || blob.size === 0) return null;

    return { blob, durationMs, mimeType };
  }

  private teardown(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    // Release the microphone the moment the turn ends — the recording indicator going dark
    // when we are not recording is a promise the product should keep (ARCHITECTURE.md §6).
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    this.recorder = null;
  }
}

function pickMimeType(): string | null {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}
