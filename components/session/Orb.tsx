'use client';

import { cn } from '@/lib/cn';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * The orb, not an avatar — UX.md §1.
 *
 * A face costs money per minute, sits in the uncanny valley, ages badly, and — the deciding
 * reason — pulls the eye. Listening is the skill we are training. An abstract visualiser reads
 * as present and attentive without competing for attention.
 */
export function Orb({ state, level }: { state: OrbState; level: number }) {
  // Only the listening state responds to input level; the others have their own idiom, so a
  // stale level value cannot make the orb twitch while the coach is talking.
  const scale = state === 'listening' ? 1 + Math.min(level, 1) * 0.28 : 1;

  return (
    <div className="relative flex h-44 w-44 items-center justify-center" aria-hidden="true">
      <div
        className={cn(
          'absolute rounded-full transition-all duration-300',
          state === 'listening' && 'bg-[var(--color-accent)]/10',
          state === 'speaking' && 'bg-[var(--color-warm)]/10',
          state === 'thinking' && 'bg-[var(--color-accent)]/5',
          state === 'idle' && 'bg-white/[0.03]',
        )}
        style={{ height: `${9 * scale}rem`, width: `${9 * scale}rem` }}
      />
      <div
        className={cn(
          'absolute rounded-full border transition-all duration-200',
          state === 'listening' && 'border-[var(--color-accent)]/40',
          state === 'speaking' && 'border-[var(--color-warm)]/40 animate-breathe',
          state === 'thinking' && 'border-[var(--color-accent)]/20 animate-breathe',
          state === 'idle' && 'border-white/10',
        )}
        style={{ height: `${6.5 * scale}rem`, width: `${6.5 * scale}rem` }}
      />
      <div
        className={cn(
          'h-20 w-20 rounded-full transition-all duration-200',
          state === 'listening' &&
            'bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-dim)]',
          state === 'speaking' && 'bg-gradient-to-br from-[var(--color-warm)] to-[#8a6440]',
          state === 'thinking' && 'bg-gradient-to-br from-[var(--color-accent-dim)] to-[#243b38]',
          state === 'idle' && 'bg-[var(--color-raised)]',
        )}
        style={{ transform: `scale(${state === 'listening' ? 1 + level * 0.15 : 1})` }}
      />
    </div>
  );
}

export function OrbCaption({ state, handsFree }: { state: OrbState; handsFree: boolean }) {
  const text: Record<OrbState, string> = {
    idle: handsFree ? 'Tap to start talking' : 'Hold the button (or space) to talk',
    listening: handsFree ? 'Listening — just stop when you are done' : 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Coach is speaking',
  };

  return (
    <p
      className="mt-2 text-center text-sm text-[var(--color-muted)]"
      role="status"
      aria-live="polite"
    >
      {text[state]}
    </p>
  );
}
