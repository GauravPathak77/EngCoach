'use client';

import { Component, type ReactNode } from 'react';
import { CoachAvatar, CoachStatus, type CoachState } from './CoachAvatar';
import { Orb } from './Orb';

/**
 * The coach stage — avatar with a guaranteed fallback. ADR-021.
 *
 * The conversation is the product; the avatar is presentation. If the avatar throws for any
 * reason, this boundary drops back to the original orb and the session carries on without the
 * user losing their turn (task §21).
 *
 * The status text lives OUTSIDE the boundary on purpose: it is the accessible source of truth
 * for the current state, so it must survive whatever happens to the picture.
 */

type BoundaryProps = { fallback: ReactNode; children: ReactNode };
type BoundaryState = { failed: boolean };

/** Exported so its contract can be tested directly — server rendering does not run boundaries. */
export class AvatarBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('[engcoach] coach avatar failed, falling back to the orb:', error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CoachStage({
  state,
  level,
  handsFree,
  voiceName,
}: {
  state: CoachState;
  level: number;
  handsFree: boolean;
  voiceName?: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <AvatarBoundary
        fallback={
          // The pre-avatar visual treatment, unchanged. 'error' has no orb equivalent, so it
          // renders as idle — the message below carries the meaning.
          <Orb state={state === 'error' ? 'idle' : state} level={level} />
        }
      >
        <CoachAvatar state={state} level={level} />
      </AvatarBoundary>

      <CoachStatus state={state} handsFree={handsFree} voiceName={voiceName} />
    </div>
  );
}

export type { CoachState };
