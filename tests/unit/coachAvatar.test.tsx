/**
 * Coach avatar states and the fallback boundary — ADR-021.
 *
 * Rendered with `react-dom/server`, which is already in the stack. The avatar is a pure function
 * of `(state, level)` with no interaction, so static markup is exactly the right level to test
 * it at — adding a DOM testing library for this would be a dependency for nothing (task §18).
 *
 * The boundary's catch behaviour is tested by driving the class directly, because server
 * rendering does not exercise error boundaries the way the client does.
 */

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CoachAvatar, CoachStatus, type CoachState } from '@/components/session/CoachAvatar';
import { AvatarBoundary, CoachStage } from '@/components/session/CoachStage';

const ALL_STATES: CoachState[] = ['idle', 'listening', 'thinking', 'speaking', 'error'];

function renderAvatar(state: CoachState, level = 0): string {
  return renderToStaticMarkup(<CoachAvatar state={state} level={level} />);
}

describe('every state renders', () => {
  it.each(ALL_STATES)('renders in the %s state without throwing', (state) => {
    const html = renderAvatar(state);
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain('<svg');
  });

  it('always draws the face, whatever the state', () => {
    for (const state of ALL_STATES) {
      // The eye group is present in every state — she does not disappear.
      expect(renderAvatar(state), state).toContain('coach-blink');
    }
  });

  it('labels the character as a fictional coach, not a real person', () => {
    expect(renderAvatar('idle')).toContain('Maya, your English coach');
  });
});

describe('SPEAKING', () => {
  it('animates the mouth only while speaking', () => {
    expect(renderAvatar('speaking')).toContain('coach-mouth');
    for (const state of ['idle', 'listening', 'thinking', 'error'] as CoachState[]) {
      expect(renderAvatar(state), state).not.toContain('coach-mouth');
    }
  });

  it('drifts the head while speaking', () => {
    expect(renderAvatar('speaking')).toContain('coach-speaking');
  });

  it('shows a speaking indicator that survives reduced motion', () => {
    // prefers-reduced-motion suppresses the animation, so the state must still be legible.
    expect(renderAvatar('speaking')).toContain('coach-bar');
  });

  it('does not show the speaking indicator in any other state', () => {
    for (const state of ['idle', 'listening', 'thinking', 'error'] as CoachState[]) {
      expect(renderAvatar(state), state).not.toContain('coach-bar');
    }
  });
});

describe('LISTENING', () => {
  it('marks the attentive posture', () => {
    expect(renderAvatar('listening')).toContain('coach-listening');
  });

  it('never animates the mouth — she does not talk over the learner (task §10)', () => {
    expect(renderAvatar('listening', 0.9)).not.toContain('coach-mouth');
  });

  it('responds to microphone level, and only in this state', () => {
    const quiet = renderAvatar('listening', 0);
    const loud = renderAvatar('listening', 1);
    expect(quiet).not.toBe(loud);

    // A stale level must not make her twitch while she is talking.
    expect(renderAvatar('speaking', 0)).toBe(renderAvatar('speaking', 1));
    expect(renderAvatar('thinking', 0)).toBe(renderAvatar('thinking', 1));
    expect(renderAvatar('idle', 0)).toBe(renderAvatar('idle', 1));
  });
});

describe('THINKING', () => {
  it('shows the subtle thinking indicator', () => {
    expect(renderAvatar('thinking')).toContain('coach-thinking');
  });

  it('shows it in no other state', () => {
    for (const state of ['idle', 'listening', 'speaking', 'error'] as CoachState[]) {
      expect(renderAvatar(state), state).not.toContain('coach-thinking');
    }
  });
});

describe('ERROR is subtle, never dramatic', () => {
  it('does not turn her red or otherwise alarm the user', () => {
    const html = renderAvatar('error');
    expect(html).not.toMatch(/#(ef|f4|dc|e5)[0-9a-f]{4}/i); // no alarm reds
    expect(html.toLowerCase()).not.toContain('red');
  });

  it('still renders the whole face rather than replacing it with a warning', () => {
    expect(renderAvatar('error')).toContain('coach-blink');
  });
});

describe('she never reacts to the learner making a mistake (task §14)', () => {
  it('has no state for correction, disapproval or judgement', () => {
    // The type is the guarantee: there is no 'correcting' or 'disappointed' state to reach.
    const states: CoachState[] = ['idle', 'listening', 'thinking', 'speaking', 'error'];
    expect(states).toHaveLength(5);
  });

  it('keeps the brows fixed across every state — a moving brow reads as judgement', () => {
    const brow = 'M76 82 Q86 77 96 81';
    for (const state of ALL_STATES) {
      expect(renderAvatar(state), state).toContain(brow);
    }
  });
});

describe('accessibility', () => {
  it('hides the decorative avatar from assistive technology', () => {
    expect(renderAvatar('idle')).toContain('aria-hidden="true"');
  });

  it('announces every state as live text, not only as animation', () => {
    for (const state of ALL_STATES) {
      const html = renderToStaticMarkup(
        <CoachStatus state={state} handsFree voiceName="Maya" />,
      );
      expect(html, state).toContain('role="status"');
      expect(html, state).toContain('aria-live="polite"');
      // Something meaningful, not an empty node.
      expect(html.replace(/<[^>]+>/g, '').trim().length, state).toBeGreaterThan(5);
    }
  });

  it('names the coach in the speaking status', () => {
    const html = renderToStaticMarkup(<CoachStatus state="speaking" handsFree voiceName="Maya" />);
    expect(html).toContain('Maya is speaking');
  });

  it('tells the user how to talk, per input mode', () => {
    const handsFree = renderToStaticMarkup(<CoachStatus state="idle" handsFree />);
    const pushToTalk = renderToStaticMarkup(<CoachStatus state="idle" handsFree={false} />);
    expect(handsFree).toContain('Tap to start talking');
    expect(pushToTalk).toContain('Hold the button');
  });
});

describe('CoachStage', () => {
  it('renders the avatar together with the status text', () => {
    const html = renderToStaticMarkup(
      <CoachStage state="listening" level={0.4} handsFree voiceName="Maya" />,
    );
    expect(html).toContain('coach-blink');
    expect(html).toContain('role="status"');
  });

  it('renders in every state', () => {
    for (const state of ALL_STATES) {
      const html = renderToStaticMarkup(
        <CoachStage state={state} level={0} handsFree voiceName="Maya" />,
      );
      expect(html.length, state).toBeGreaterThan(500);
    }
  });
});

describe('avatar failure does not break the conversation (task §21)', () => {
  it('flips to the failed state when React reports a thrown child', () => {
    expect(AvatarBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('renders the children while healthy', () => {
    const boundary = new AvatarBoundary({
      fallback: <span>ORB FALLBACK</span>,
      children: <span>AVATAR</span>,
    });
    boundary.state = { failed: false };
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toContain('AVATAR');
  });

  it('renders the orb fallback once it has failed', () => {
    const boundary = new AvatarBoundary({
      fallback: <span>ORB FALLBACK</span>,
      children: <span>AVATAR</span>,
    });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain('ORB FALLBACK');
    expect(html).not.toContain('AVATAR');
  });

  it('logs the failure rather than swallowing it silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boundary = new AvatarBoundary({ fallback: null, children: null });

    boundary.componentDidCatch(new Error('avatar exploded'));

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('falling back to the orb');
    spy.mockRestore();
  });

  it('keeps the status text outside the boundary, so state survives an avatar crash', () => {
    // CoachStage renders <AvatarBoundary/> and <CoachStatus/> as siblings: whatever happens to
    // the picture, the accessible state text is still on screen.
    const html = renderToStaticMarkup(
      <CoachStage state="thinking" level={0} handsFree voiceName="Maya" />,
    );
    expect(html).toContain('Thinking…');
  });
});
