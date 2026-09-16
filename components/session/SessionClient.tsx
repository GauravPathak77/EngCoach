'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CoachStage, type CoachState } from './CoachStage';
import { NotesRail, SayItBetterPanel, type Note } from './NotesRail';
import { Banner, Button } from '@/components/ui/primitives';
import { MicCapture, MicError } from '@/lib/voice/capture';
import { BrowserRecognition, browserRecognitionAvailable } from '@/lib/voice/browserRecognition';
import { AudioQueue } from '@/lib/voice/player';
import { SentenceChunker } from '@/lib/voice/chunker';
import { cn } from '@/lib/cn';
import type { VoicePresentation } from '@/lib/voice/tts/voices';

type Turn = { id: string; role: 'user' | 'coach'; text: string };

type Config = {
  llm: string;
  stt: string;
  tts: string;
  db: string;
  /** Provider-agnostic coach voice, resolved from user settings server-side (ADR-020). */
  coachVoice: { id: VoicePresentation; displayName: string; presentation: VoicePresentation };
  /**
   * Which provider serves each lane (ADR-022). Reported per lane because a mixed setup is
   * normal — a local conversation with a hosted analyzer, say — and a single "is it live"
   * flag would misdescribe it.
   */
  lanes: { hot: string; cold: string; session: string };
};

type SayItBetterState = {
  originalText: string;
  variants: Array<{ register: string; text: string; why: string }>;
  canExpand: boolean;
} | null;

export function SessionClient({
  sessionId,
  mode,
  config,
  initialTurns,
}: {
  sessionId: string;
  mode: string;
  config: Config;
  initialTurns: Turn[];
}) {
  const router = useRouter();

  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [notes, setNotes] = useState<Note[]>([]);
  const [orbState, setOrbState] = useState<Exclude<CoachState, 'error'>>('idle');
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState('');
  const [streamingReply, setStreamingReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handsFree, setHandsFree] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [talkRatio, setTalkRatio] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [sayIt, setSayIt] = useState<SayItBetterState>(null);
  const [sayItLoading, setSayItLoading] = useState(false);
  const [sayItSource, setSayItSource] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  // Typing is the fallback path, but it is the PRIMARY one when speech recognition is degraded
  // or the microphone fails. Leaving it buried behind a collapsed disclosure in those cases
  // leaves the user with no obvious way to continue (UX.md §1 failure states).
  const [typeBoxOpen, setTypeBoxOpen] = useState(config.stt === 'browser');
  // Set when the browser had no voice matching the requested presentation (ADR-020). Shown
  // once, quietly — it is information, not a failure.
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const captureRef = useRef<MicCapture | null>(null);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const queueRef = useRef<AudioQueue | null>(null);
  const coachFinishedAt = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);

  const coachVoice = config.coachVoice;

  /**
   * The visible coach state. 'error' is DERIVED rather than stored: an error while the coach is
   * mid-sentence should not stop her speaking, and a derived flag cannot get stuck in the way a
   * stored one can.
   */
  const coachState: CoachState = error && orbState === 'idle' ? 'error' : orbState;

  const useBrowserStt = config.stt === 'browser';
  const useBrowserTts = config.tts === 'browser';

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, streamingReply]);

  // Release the mic and silence playback if the user navigates away mid-session.
  useEffect(() => {
    return () => {
      void captureRef.current?.stop();
      recognitionRef.current?.abort();
      queueRef.current?.stop();
    };
  }, []);

  const refreshNotes = useCallback(async () => {
    try {
      const response = await fetch(`/api/session?sessionId=${sessionId}`);
      if (!response.ok) return;
      const data = (await response.json()) as { notes: Note[]; cost?: { ttsCharacters: number } };
      setNotes(data.notes ?? []);
    } catch {
      // The notes rail is decorative during a session; a failed refresh must not interrupt it.
    }
  }, [sessionId]);

  const speak = useCallback(
    async (text: string, seq: number) => {
      const queue = queueRef.current;
      if (!queue) return;

      if (useBrowserTts) {
        queue.enqueueSpeech(seq, text);
        return;
      }

      try {
        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sessionId }),
        });
        if (!response.ok) {
          // TTS failing is not fatal — the reply is on screen. Fall back to browser speech.
          queue.enqueueSpeech(seq, text);
          return;
        }
        const contentType = response.headers.get('Content-Type') ?? '';
        if (contentType.includes('application/json')) {
          queue.enqueueSpeech(seq, text);
          return;
        }
        queue.enqueueAudio(seq, await response.blob());
      } catch {
        queue.enqueueSpeech(seq, text);
      }
    },
    [sessionId, useBrowserTts],
  );

  /** Send a turn and stream the reply. Shared by voice and typed input. */
  const sendTurn = useCallback(
    async (payload: {
      blob?: Blob;
      transcript?: string;
      durationMs: number;
      /** Where the text came from. Typed text has no recognition uncertainty. */
      source?: 'speech' | 'typed';
    }) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setOrbState('thinking');
      setStreamingReply('');

      const responseLatencyMs =
        coachFinishedAt.current !== null ? Math.round(performance.now() - coachFinishedAt.current) : null;

      const form = new FormData();
      form.set('sessionId', sessionId);
      form.set('durationMs', String(Math.round(payload.durationMs)));
      if (responseLatencyMs !== null) form.set('responseLatencyMs', String(responseLatencyMs));
      if (payload.blob) form.set('audio', payload.blob, 'turn.webm');
      if (payload.transcript) {
        form.set('transcript', payload.transcript);
        form.set('source', payload.source ?? 'speech');
      }

      // TTS lifecycle drives the avatar: onStart -> SPEAKING, onEnd -> IDLE. Real events, not
      // timers (task §12).
      const queue = new AudioQueue(
        {
          onStart: () => setOrbState('speaking'),
          onEnd: () => {
            setOrbState('idle');
            coachFinishedAt.current = performance.now();
            void refreshNotes();
          },
          onVoiceFallback: (reason) => setVoiceNotice(reason),
        },
        coachVoice.presentation,
      );
      queueRef.current = queue;

      const chunker = new SentenceChunker();
      let seq = 0;
      let full = '';

      try {
        const response = await fetch('/api/turn', { method: 'POST', body: form });

        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          throw new Error(data?.error?.message ?? 'The coach could not respond just now.');
        }

        const contentType = response.headers.get('Content-Type') ?? '';
        if (contentType.includes('application/json')) {
          const data = (await response.json()) as { empty?: boolean; message?: string };
          if (data.empty) {
            setNotice(data.message ?? "I didn't catch that — try again.");
            setOrbState('idle');
            return;
          }
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response from the coach.');

        const decoder = new TextDecoder();
        let sseBuffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          const frames = sseBuffer.split('\n\n');
          sseBuffer = frames.pop() ?? '';

          for (const frame of frames) {
            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;

            const event = eventLine.slice(7).trim();
            const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;

            if (event === 'transcript') {
              const text = String(data.text ?? '');
              setTurns((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text }]);
              setPartial('');
            } else if (event === 'delta') {
              const delta = String(data.text ?? '');
              full += delta;
              setStreamingReply(full);
              for (const sentence of chunker.push(delta)) {
                void speak(sentence, seq++);
              }
            } else if (event === 'error') {
              throw new Error(String(data.message ?? 'The coach stopped mid-reply.'));
            } else if (event === 'done') {
              for (const sentence of chunker.flush()) {
                void speak(sentence, seq++);
              }
            }
          }
        }

        if (full.trim().length > 0) {
          setTurns((prev) => [...prev, { id: `c-${Date.now()}`, role: 'coach', text: full }]);
        }
        setStreamingReply('');
        // If nothing was queued (TTS unavailable end to end) the orb would hang on "thinking".
        if (seq === 0) {
          setOrbState('idle');
          coachFinishedAt.current = performance.now();
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Something went wrong.');
        setOrbState('idle');
        setStreamingReply('');
      } finally {
        busyRef.current = false;
        void refreshNotes();
        void updateTalkRatio();
      }
    },
    [sessionId, refreshNotes, speak],
  );

  const updateTalkRatio = useCallback(async () => {
    try {
      const response = await fetch(`/api/session?sessionId=${sessionId}`);
      if (!response.ok) return;
      const data = (await response.json()) as { turns: Turn[] };
      const userWords = data.turns
        .filter((t) => t.role === 'user')
        .reduce((a, t) => a + t.text.split(/\s+/).length, 0);
      const coachWords = data.turns
        .filter((t) => t.role === 'coach')
        .reduce((a, t) => a + t.text.split(/\s+/).length, 0);
      const total = userWords + coachWords;
      setTalkRatio(total > 0 ? userWords / total : null);
    } catch {
      // Non-critical.
    }
  }, [sessionId]);

  const stopListening = useCallback(async () => {
    const capture = captureRef.current;
    const recognition = recognitionRef.current;
    if (!capture) return;

    const result = await capture.stop();
    captureRef.current = null;

    const transcript = recognition ? await recognition.stop() : '';
    recognitionRef.current = null;

    setLevel(0);
    setPartial('');

    if (!result) {
      setOrbState('idle');
      setNotice('That was too short to hear — try again.');
      return;
    }

    if (useBrowserStt) {
      if (transcript.trim().length === 0) {
        setOrbState('idle');
        setNotice("I didn't catch that — try again.");
        return;
      }
      await sendTurn({ transcript, durationMs: result.durationMs, source: 'speech' });
    } else {
      await sendTurn({ blob: result.blob, durationMs: result.durationMs });
    }
  }, [sendTurn, useBrowserStt]);

  const startListening = useCallback(async () => {
    if (busyRef.current || orbState !== 'idle') return;
    setError(null);
    setNotice(null);
    queueRef.current?.stop();

    const capture = new MicCapture({
      onLevel: setLevel,
      onSilenceEnd: () => void stopListening(),
    });

    try {
      await capture.start(handsFree);
      captureRef.current = capture;
      setOrbState('listening');

      if (useBrowserStt && browserRecognitionAvailable()) {
        const recognition = new BrowserRecognition({
          onPartial: setPartial,
          onError: (message) => setError(message),
        });
        recognition.start();
        recognitionRef.current = recognition;
      }
    } catch (caught) {
      setOrbState('idle');
      setError(
        caught instanceof MicError ? caught.message : 'Could not start the microphone.',
      );
      setTypeBoxOpen(true);
    }
  }, [handsFree, orbState, stopListening, useBrowserStt]);

  // Space is push-to-talk (UX.md §5).
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return;
      event.preventDefault();
      if (orbState === 'idle') void startListening();
      else if (orbState === 'listening' && !handsFree) void stopListening();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (!handsFree && orbState === 'listening') void stopListening();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [orbState, handsFree, startListening, stopListening]);

  const dispute = useCallback(
    async (findingId: string) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === findingId ? { ...n, userFeedback: 'disagreed' } : n)),
      );
      await fetch(`/api/findings/${findingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: 'disagreed' }),
      }).catch(() => undefined);
    },
    [],
  );

  const askSayItBetter = useCallback(
    async (text: string, expanded = false) => {
      setSayItSource(text);
      setSayItLoading(true);
      setSayIt(null);
      try {
        const response = await fetch('/api/say-it-better', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sessionId, expanded }),
        });
        if (!response.ok) throw new Error('Could not rewrite that just now.');
        setSayIt((await response.json()) as SayItBetterState);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not rewrite that.');
      } finally {
        setSayItLoading(false);
      }
    },
    [sessionId],
  );

  const endSession = useCallback(async () => {
    setEnding(true);
    queueRef.current?.stop();
    void captureRef.current?.stop();
    recognitionRef.current?.abort();
    try {
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end', sessionId }),
      });
    } catch {
      // Even if ending fails server-side, the report page will end it on arrival.
    }
    router.push(`/report/${sessionId}`);
  }, [router, sessionId]);

  const sendTyped = useCallback(async () => {
    const text = typed.trim();
    if (text.length === 0) return;
    setTyped('');
    await sendTurn({ transcript: text, durationMs: 0, source: 'typed' });
  }, [typed, sendTurn]);

  // Per lane, so a working local conversation is not described as "scripted" just because the
  // analyzer is (ADR-022). Each clause names what is actually degraded and what it costs you.
  const degraded: string[] = [];
  if (config.lanes.hot === 'scripted') {
    degraded.push('the coach is running on scripted replies');
  }
  if (config.lanes.cold === 'scripted') {
    degraded.push('corrections are limited to a few built-in patterns');
  }
  if (config.lanes.session === 'scripted') {
    degraded.push('the end-of-session report is a placeholder');
  }
  if (config.stt === 'browser') degraded.push('speech recognition is using your browser');
  if (config.tts === 'browser') degraded.push('the voice is your browser’s built-in one');

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium capitalize">{mode.replace('_', ' ')}</span>
            <span className="text-xs tabular-nums text-[var(--color-dim)]">
              {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
              {String(elapsed % 60).padStart(2, '0')}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {talkRatio !== null && (
              <div className="hidden items-center gap-2 sm:flex" title="You should be doing most of the talking">
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-raised)]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      talkRatio >= 0.6 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-warm)]',
                    )}
                    style={{ width: `${Math.round(talkRatio * 100)}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-[var(--color-dim)]">
                  you {Math.round(talkRatio * 100)}%
                </span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={endSession} disabled={ending}>
              {ending ? 'Ending…' : 'End'}
            </Button>
          </div>
        </header>

        {degraded.length > 0 && (
          <div className="px-5 pt-3">
            <Banner tone="warn">
              <strong>Development mode.</strong> This is not the real product experience:{' '}
              {degraded.join(', ')}. See the README for how to add API keys.
            </Banner>
          </div>
        )}

        <div ref={scrollRef} className="scrollbar-thin flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto flex max-w-2xl flex-col items-center">
            <CoachStage
              state={coachState}
              level={level}
              handsFree={handsFree}
              voiceName={coachVoice.displayName}
            />

            <div className="mt-8 w-full space-y-4">
              {turns.map((turn) => (
                <CaptionBubble
                  key={turn.id}
                  turn={turn}
                  onSayItBetter={() => askSayItBetter(turn.text)}
                  active={sayItSource === turn.text}
                />
              ))}

              {partial && (
                <div className="text-right">
                  <p className="inline-block max-w-[85%] rounded-2xl rounded-tr-sm bg-[var(--color-raised)] px-4 py-2.5 text-sm text-[var(--color-muted)] italic">
                    {partial}
                  </p>
                </div>
              )}

              {streamingReply && (
                <div>
                  <p className="inline-block max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-text)]">
                    {streamingReply}
                  </p>
                </div>
              )}

              {(sayIt || sayItLoading) && (
                <SayItBetterPanel
                  result={sayIt}
                  loading={sayItLoading}
                  onExpand={() => sayItSource && askSayItBetter(sayItSource, true)}
                  onClose={() => {
                    setSayIt(null);
                    setSayItSource(null);
                  }}
                />
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--color-line)] px-5 py-4">
          <div className="mx-auto max-w-2xl">
            {error && (
              <div className="mb-3">
                <Banner tone="warn">{error}</Banner>
              </div>
            )}
            {notice && !error && (
              <p className="mb-3 text-center text-xs text-[var(--color-dim)]">{notice}</p>
            )}
            {/*
              The requested coach voice was not available on this platform. Stated plainly rather
              than pretending the female voice is playing when it is not (ADR-020).
            */}
            {voiceNotice && !error && (
              <p className="mb-3 text-center text-xs text-[var(--color-dim)]">
                Voice: {voiceNotice}
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button
                size="lg"
                variant={orbState === 'listening' ? 'ghost' : 'primary'}
                className="flex-1"
                disabled={orbState === 'thinking' || orbState === 'speaking' || ending}
                onClick={() => (orbState === 'listening' ? void stopListening() : void startListening())}
              >
                {orbState === 'listening' ? 'Done talking' : 'Talk'}
              </Button>

              <button
                onClick={() => setHandsFree((h) => !h)}
                className="rounded-lg border border-[var(--color-line)] px-3 py-3 text-xs text-[var(--color-muted)] hover:bg-[var(--color-raised)]"
                title="Hands-free ends your turn automatically after a short silence"
              >
                {handsFree ? 'Hands-free' : 'Hold to talk'}
              </button>
            </div>

            <details
              className="mt-3"
              open={typeBoxOpen}
              onToggle={(e) => setTypeBoxOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer text-xs text-[var(--color-dim)]">
                Type instead
              </summary>
              {/*
                A real form rather than a keydown handler: Enter-to-submit then comes from the
                browser natively, which is both more reliable and what assistive technology
                expects from a single-field input.
              */}
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendTyped();
                }}
              >
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Type what you want to say…"
                  aria-label="Type what you want to say"
                  className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-dim)] focus:outline-none"
                />
                <Button type="submit" size="sm" disabled={typed.trim().length === 0}>
                  Send
                </Button>
              </form>
            </details>
          </div>
        </div>
      </div>

      <NotesRail
        notes={notes}
        canAnimate={orbState === 'speaking'}
        onDispute={(id) => void dispute(id)}
        className="max-h-64 border-t lg:max-h-none lg:border-t-0"
      />
    </div>
  );
}

function CaptionBubble({
  turn,
  onSayItBetter,
  active,
}: {
  turn: Turn;
  onSayItBetter: () => void;
  active: boolean;
}) {
  if (turn.role === 'coach') {
    return (
      <div>
        <p className="inline-block max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-text)]">
          {turn.text}
        </p>
      </div>
    );
  }

  return (
    <div className="group text-right">
      <div className="inline-flex max-w-[85%] items-start gap-1.5">
        <p className="rounded-2xl rounded-tr-sm bg-[var(--color-raised)] px-4 py-2.5 text-left text-sm text-[var(--color-text)]">
          {turn.text}
        </p>
        {/* The on-demand Say It Better affordance — one tap, no menu (UX.md §1). */}
        <button
          onClick={onSayItBetter}
          title="Say it better"
          aria-label="Show a better way to say this"
          className={cn(
            'mt-2 shrink-0 rounded-full border border-[var(--color-line)] px-2 py-0.5 text-xs',
            'text-[var(--color-dim)] opacity-0 transition group-hover:opacity-100 focus:opacity-100',
            'hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]',
            active && 'opacity-100 border-[var(--color-accent-dim)] text-[var(--color-accent)]',
          )}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
