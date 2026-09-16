/**
 * The coach state sequence, end to end — task §22.
 *
 *   user speaks → LISTENING → processing → THINKING → tts start → SPEAKING → tts end → IDLE
 *
 * The transitions that matter are driven by the real `AudioQueue` lifecycle, not by timers, so
 * this drives the actual queue and records the states a session screen would render.
 *
 * `speechSynthesis` is undefined under the node test environment, so `speak()` resolves
 * immediately — which is exactly the property being tested here (the queue must still fire
 * onStart and onEnd in order), and it also proves the browser fallback cannot hang a turn.
 */

import { describe, expect, it, vi } from 'vitest';
import { AudioQueue } from '@/lib/voice/player';
import type { CoachState } from '@/components/session/CoachAvatar';

/** Mirrors how SessionClient derives what the avatar shows. */
function deriveCoachState(
  machine: Exclude<CoachState, 'error'>,
  error: string | null,
): CoachState {
  return error && machine === 'idle' ? 'error' : machine;
}

function makeRecorder() {
  const states: CoachState[] = [];
  let machine: Exclude<CoachState, 'error'> = 'idle';
  let error: string | null = null;

  const push = (): void => {
    const next = deriveCoachState(machine, error);
    if (states[states.length - 1] !== next) states.push(next);
  };
  push();

  return {
    states,
    set(next: Exclude<CoachState, 'error'>) {
      machine = next;
      push();
    },
    fail(message: string) {
      error = message;
      push();
    },
    clearError() {
      error = null;
      push();
    },
  };
}

describe('the full turn sequence', () => {
  it('goes idle → listening → thinking → speaking → idle', async () => {
    const recorder = makeRecorder();

    // The user presses Talk.
    recorder.set('listening');

    // They stop; the turn is sent.
    recorder.set('thinking');

    const queue = new AudioQueue(
      {
        onStart: () => recorder.set('speaking'),
        onEnd: () => recorder.set('idle'),
      },
      'female',
    );

    queue.enqueueSpeech(0, 'That sounds good. What happened next?');
    await vi.waitFor(() => expect(recorder.states).toContain('idle'));

    expect(recorder.states).toEqual(['idle', 'listening', 'thinking', 'speaking', 'idle']);
  });

  it('reaches SPEAKING only when audio actually starts, never on a timer', async () => {
    const recorder = makeRecorder();
    recorder.set('thinking');

    const queue = new AudioQueue(
      { onStart: () => recorder.set('speaking'), onEnd: () => recorder.set('idle') },
      'female',
    );

    // Nothing enqueued yet: still thinking, however long we wait.
    await new Promise((r) => setTimeout(r, 30));
    expect(recorder.states).not.toContain('speaking');

    queue.enqueueSpeech(0, 'Now she speaks.');
    await vi.waitFor(() => expect(recorder.states).toContain('speaking'));
  });

  it('stays SPEAKING across several sentences and returns to idle once, at the end', async () => {
    const transitions: string[] = [];
    const queue = new AudioQueue(
      {
        onStart: () => transitions.push('start'),
        onEnd: () => transitions.push('end'),
      },
      'female',
    );

    queue.enqueueSpeech(0, 'First sentence.');
    queue.enqueueSpeech(1, 'Second sentence.');
    queue.enqueueSpeech(2, 'Third sentence.');

    await vi.waitFor(() => expect(transitions).toContain('end'));

    // One start, one end — the avatar must not flicker between sentences.
    expect(transitions.filter((t) => t === 'start')).toHaveLength(1);
    expect(transitions.filter((t) => t === 'end')).toHaveLength(1);
  });

  it('waits for a missing earlier chunk rather than speaking out of order', async () => {
    const started = vi.fn();
    const ended = vi.fn();
    const queue = new AudioQueue({ onStart: started, onEnd: ended }, 'female');

    // Sentence 3 arrives first — a short later sentence often synthesises before a long
    // earlier one. Nothing may play until the gap at seq 0 is filled.
    queue.enqueueSpeech(2, 'third');
    await new Promise((r) => setTimeout(r, 30));
    expect(started).not.toHaveBeenCalled();

    queue.enqueueSpeech(1, 'second');
    await new Promise((r) => setTimeout(r, 30));
    expect(started).not.toHaveBeenCalled();

    // Seq 0 unblocks the whole run.
    queue.enqueueSpeech(0, 'first');
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
    expect(started).toHaveBeenCalledOnce();
  });
});

describe('the ERROR state', () => {
  it('shows only when the coach is otherwise idle', () => {
    // An error while she is mid-sentence must not stop her speaking.
    expect(deriveCoachState('speaking', 'mic failed')).toBe('speaking');
    expect(deriveCoachState('listening', 'mic failed')).toBe('listening');
    expect(deriveCoachState('thinking', 'mic failed')).toBe('thinking');
    expect(deriveCoachState('idle', 'mic failed')).toBe('error');
  });

  it('clears as soon as the error is cleared — it cannot get stuck', () => {
    const recorder = makeRecorder();
    recorder.fail('Microphone access was blocked.');
    expect(recorder.states.at(-1)).toBe('error');

    recorder.clearError();
    expect(recorder.states.at(-1)).toBe('idle');
  });

  it('recovers into a normal turn after a failure', async () => {
    const recorder = makeRecorder();
    recorder.fail('Microphone access was blocked.');
    expect(recorder.states.at(-1)).toBe('error');

    // The user types instead; the turn proceeds normally.
    recorder.clearError();
    recorder.set('thinking');

    const queue = new AudioQueue(
      { onStart: () => recorder.set('speaking'), onEnd: () => recorder.set('idle') },
      'female',
    );
    queue.enqueueSpeech(0, 'No problem, carry on.');
    await vi.waitFor(() => expect(recorder.states.at(-1)).toBe('idle'));

    expect(recorder.states).toContain('error');
    expect(recorder.states).toContain('speaking');
  });
});

describe('the browser fallback cannot hang or crash a turn', () => {
  it('resolves even with no speech engine present', async () => {
    const ended = vi.fn();
    const queue = new AudioQueue({ onEnd: ended }, 'female');
    queue.enqueueSpeech(0, 'Anything at all.');
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
  });

  it('defaults to the female presentation when none is given', async () => {
    // The constructor default is the one that matters if a caller forgets to pass it.
    const ended = vi.fn();
    const queue = new AudioQueue({ onEnd: ended });
    queue.enqueueSpeech(0, 'Default voice path.');
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
  });

  it('stops cleanly mid-reply without firing onEnd', async () => {
    const ended = vi.fn();
    const queue = new AudioQueue({ onEnd: ended }, 'female');
    queue.stop();
    queue.enqueueSpeech(0, 'This should never play.');
    await new Promise((r) => setTimeout(r, 30));
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('the SPEAKING state cannot get stuck', () => {
  /**
   * A speech engine that accepts `speak()` and never fires `onend` is real: headless and
   * virtualised environments do it, and Chrome stalls on long utterances. Without the watchdog
   * the avatar stays in SPEAKING and the Talk button stays disabled for the rest of the session.
   */
  function installSilentSpeechEngine(): () => void {
    const globalAny = globalThis as unknown as Record<string, unknown>;
    const hadSynthesis = 'speechSynthesis' in globalAny;
    const hadUtterance = 'SpeechSynthesisUtterance' in globalAny;

    globalAny.SpeechSynthesisUtterance = class {
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      voice: unknown = null;
      lang = '';
      rate = 1;
      pitch = 1;
      constructor(public text: string) {}
    };
    // Accepts the utterance and then does nothing at all.
    globalAny.speechSynthesis = { getVoices: () => [], speak: () => undefined, cancel: () => undefined };

    return () => {
      if (!hadSynthesis) delete globalAny.speechSynthesis;
      if (!hadUtterance) delete globalAny.SpeechSynthesisUtterance;
    };
  }

  it('returns to idle even when the speech engine never fires onend', async () => {
    const restore = installSilentSpeechEngine();
    vi.useFakeTimers();
    try {
      const recorder = makeRecorder();
      recorder.set('thinking');

      const queue = new AudioQueue(
        { onStart: () => recorder.set('speaking'), onEnd: () => recorder.set('idle') },
        'female',
      );
      queue.enqueueSpeech(0, 'A sentence the engine will silently swallow.');

      await vi.advanceTimersByTimeAsync(1);
      expect(recorder.states.at(-1)).toBe('speaking');

      // The watchdog is length-based with slack; 30s covers this sentence comfortably.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recorder.states.at(-1)).toBe('idle');
    } finally {
      vi.useRealTimers();
      restore();
    }
  });
});
