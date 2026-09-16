'use client';

import { cn } from '@/lib/cn';

/**
 * The coach avatar — "Maya", a fictional character. ADR-021.
 *
 * Hand-authored inline SVG rather than a portrait image or an avatar SDK:
 *   - no network fetch, so there is nothing to fail slowly on a bad connection
 *   - no new dependency, no added bundle weight beyond this file
 *   - vector, so it is sharp at every viewport without a set of raster assets
 *   - no licensing question and no risk of resembling a real, identifiable person
 *
 * She is a stylised realistic portrait, not photoreal — that is an honest limitation of drawing
 * a character in vectors, and it is the right trade for a face that sits on screen for ten
 * minutes without becoming tiring or uncanny (UX.md §1 argued against a face at all; ADR-021
 * revisits that).
 *
 * ANIMATION HONESTY: there is no phoneme-level lip sync and none is faked. While speaking, the
 * mouth opens and closes on a loop and the head drifts slightly. The effect reads as "she is
 * talking" without claiming a precision we do not have.
 *
 * The avatar NEVER reacts to the learner's mistakes — no frowns, no colour changes, nothing
 * judgemental. Corrections live on the screen, not on her face (task §14).
 */

export type CoachState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

/** Palette kept local so the portrait reads consistently against the app's dark surface. */
const SKIN = '#e8b89b';
const SKIN_SHADE = '#d49f80';
const HAIR = '#3a2a24';
const HAIR_LIGHT = '#4d3830';
const TOP = '#2f5d55';
const TOP_DARK = '#254b45';

export function CoachAvatar({
  state,
  level,
  className,
}: {
  state: CoachState;
  /** Mic input level 0..1. Drives the listening halo only. */
  level: number;
  className?: string;
}) {
  const speaking = state === 'speaking';
  const listening = state === 'listening';
  const thinking = state === 'thinking';

  // The halo answers "whose turn is it" at a glance, before any text is read.
  const haloScale = listening ? 1 + Math.min(level, 1) * 0.14 : 1;

  return (
    <div
      className={cn('relative flex items-center justify-center', className)}
      // The avatar is decoration: state is announced in text by CoachStatus below, so a screen
      // reader must not have to interpret a picture (task §20).
      aria-hidden="true"
    >
      {/* Halo / state ring */}
      <div
        className={cn(
          'absolute rounded-full transition-all duration-500',
          listening && 'bg-[var(--color-accent)]/12',
          speaking && 'bg-[var(--color-warm)]/10',
          thinking && 'bg-[var(--color-accent)]/6',
          state === 'idle' && 'bg-white/[0.03]',
          state === 'error' && 'bg-[var(--color-warm)]/8',
        )}
        style={{ height: `${11 * haloScale}rem`, width: `${11 * haloScale}rem` }}
      />
      <div
        className={cn(
          'absolute rounded-full border transition-all duration-300',
          listening && 'border-[var(--color-accent)]/45',
          speaking && 'border-[var(--color-warm)]/40',
          thinking && 'border-[var(--color-accent)]/20 animate-breathe',
          state === 'idle' && 'border-white/10',
          state === 'error' && 'border-[var(--color-warm)]/35 border-dashed',
        )}
        style={{ height: `${9.2 * haloScale}rem`, width: `${9.2 * haloScale}rem` }}
      />

      <svg
        viewBox="0 0 200 200"
        className={cn(
          'relative h-36 w-36 sm:h-40 sm:w-40',
          // Whole-head motion: a slow drift while speaking, a small attentive tilt while
          // listening. Both are subtle enough to read as presence rather than performance.
          speaking && 'coach-speaking',
          listening && 'coach-listening',
        )}
        role="img"
        aria-label="Maya, your English coach"
      >
        <defs>
          <clipPath id="coach-head-clip">
            <circle cx="100" cy="100" r="76" />
          </clipPath>
          <linearGradient id="coach-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#243040" />
            <stop offset="100%" stopColor="#1a2230" />
          </linearGradient>
        </defs>

        <circle cx="100" cy="100" r="76" fill="url(#coach-bg)" />

        <g clipPath="url(#coach-head-clip)">
          {/* Shoulders / top */}
          <path d="M28 200 Q40 156 74 146 L126 146 Q160 156 172 200 Z" fill={TOP} />
          <path d="M86 146 L100 176 L114 146 Z" fill={TOP_DARK} />

          {/* Neck */}
          <path d="M84 122 L84 150 Q100 160 116 150 L116 122 Z" fill={SKIN_SHADE} />

          {/* Hair, behind the face */}
          <path
            d="M46 100 Q44 44 100 40 Q156 44 154 100 L154 140 Q150 116 146 106 Q140 66 100 62 Q60 66 54 106 Q50 116 46 140 Z"
            fill={HAIR}
          />

          {/* Face */}
          <ellipse cx="100" cy="98" rx="40" ry="47" fill={SKIN} />
          <ellipse cx="100" cy="104" rx="40" ry="41" fill={SKIN} />

          {/* Cheeks — warmth, not blush */}
          <ellipse cx="76" cy="110" rx="10" ry="7" fill={SKIN_SHADE} opacity="0.35" />
          <ellipse cx="124" cy="110" rx="10" ry="7" fill={SKIN_SHADE} opacity="0.35" />

          {/* Brows — level and relaxed. They never move; a moving brow reads as judgement. */}
          <path d="M76 82 Q86 77 96 81" stroke={HAIR} strokeWidth="3.4" fill="none" strokeLinecap="round" />
          <path d="M124 82 Q114 77 104 81" stroke={HAIR} strokeWidth="3.4" fill="none" strokeLinecap="round" />

          {/* Eyes. The `coach-blink` group scales vertically on a loop. */}
          <g className="coach-blink" style={{ transformOrigin: '100px 93px' }}>
            <ellipse cx="85" cy="93" rx="7.5" ry="5" fill="#ffffff" />
            <ellipse cx="115" cy="93" rx="7.5" ry="5" fill="#ffffff" />
            <circle cx="85" cy="93" r="3.9" fill="#4a3a30" />
            <circle cx="115" cy="93" r="3.9" fill="#4a3a30" />
            <circle cx="85" cy="93" r="1.8" fill="#1a1410" />
            <circle cx="115" cy="93" r="1.8" fill="#1a1410" />
            <circle cx="86.8" cy="91.2" r="1.3" fill="#ffffff" opacity="0.9" />
            <circle cx="116.8" cy="91.2" r="1.3" fill="#ffffff" opacity="0.9" />
          </g>

          {/* Nose */}
          <path d="M100 98 Q97 108 101 111" stroke={SKIN_SHADE} strokeWidth="2.4" fill="none" strokeLinecap="round" />

          {/* Mouth.
              Idle/listening: a closed, gently upturned line — pleasant, not grinning.
              Speaking: the `coach-mouth` group animates an open shape. */}
          {speaking ? (
            <g className="coach-mouth" style={{ transformOrigin: '100px 124px' }}>
              <ellipse cx="100" cy="124" rx="9" ry="6.5" fill="#6d3b3b" />
              <ellipse cx="100" cy="121.5" rx="7.5" ry="2.4" fill="#8a4c4c" />
              <ellipse cx="100" cy="127.5" rx="6" ry="2" fill="#5a2f2f" />
            </g>
          ) : (
            <path
              d="M89 123 Q100 130 111 123"
              stroke="#a35c5c"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
            />
          )}

          {/* Front hair */}
          <path d="M56 96 Q54 50 100 46 Q146 50 144 96 Q136 62 100 60 Q64 62 56 96 Z" fill={HAIR_LIGHT} />
          <path d="M58 92 Q66 60 100 58 Q118 59 128 68 Q104 62 82 76 Q66 86 58 92 Z" fill={HAIR} />
        </g>

        {/* Thinking: three dots beside her, not on her face. */}
        {thinking && (
          <g className="coach-thinking">
            <circle cx="160" cy="60" r="4" fill="var(--color-accent)" opacity="0.9" />
            <circle cx="173" cy="52" r="3" fill="var(--color-accent)" opacity="0.6" />
            <circle cx="183" cy="46" r="2" fill="var(--color-accent)" opacity="0.4" />
          </g>
        )}
      </svg>

      {/* Speaking indicator: a small equaliser, so "she is talking" is legible even at a glance
          or with reduced motion, where the mouth animation is suppressed. */}
      {speaking && (
        <div className="absolute -bottom-1 flex items-end gap-[3px]">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="coach-bar w-[3px] rounded-full bg-[var(--color-warm)]"
              style={{ animationDelay: `${i * 110}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The state, as text. This is the accessible source of truth — the avatar is decorative and the
 * status must be readable without it (task §20).
 */
export function CoachStatus({
  state,
  handsFree,
  voiceName,
}: {
  state: CoachState;
  handsFree: boolean;
  voiceName?: string;
}) {
  const text: Record<CoachState, string> = {
    idle: handsFree ? 'Tap to start talking' : 'Hold the button (or space) to talk',
    listening: handsFree ? 'Listening — just stop when you are done' : 'Listening…',
    thinking: 'Thinking…',
    speaking: `${voiceName ?? 'Your coach'} is speaking`,
    error: 'Something went wrong — see the message below',
  };

  return (
    <p
      className="mt-3 text-center text-sm text-[var(--color-muted)]"
      role="status"
      aria-live="polite"
    >
      {text[state]}
    </p>
  );
}
