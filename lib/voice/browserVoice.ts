/**
 * Browser speech-synthesis voice selection — ADR-020.
 *
 * PURE MODULE: takes a plain list of voice descriptors and returns a choice. The browser globals
 * live in `player.ts`; this is separated so the matching heuristic is unit-testable without a DOM.
 *
 * HONESTY: the Web Speech API exposes no gender field. Selection is name matching against the
 * hints in the voice registry, which is a heuristic and is treated as one:
 *
 *   - a confident name match wins
 *   - otherwise fall back to any English voice, then to the platform default
 *   - `matched: false` is reported so callers can tell the user the requested voice was not
 *     available rather than implying it was
 *
 * We do not claim a female voice when the platform does not offer one (task §5).
 */

import { getCoachVoice, type CoachVoice, type VoicePresentation } from './tts/voices';

/** The subset of SpeechSynthesisVoice this module needs. Keeps it DOM-free. */
export type VoiceDescriptor = {
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
};

export type BrowserVoiceChoice<T extends VoiceDescriptor = VoiceDescriptor> = {
  /** Null means "use whatever the platform picks by default". */
  voice: T | null;
  /** True only when a hint for the requested presentation actually matched. */
  matched: boolean;
  reason: string;
};

function isEnglish(voice: VoiceDescriptor): boolean {
  return voice.lang.toLowerCase().startsWith('en');
}

/**
 * A generic "male"/"female" suffix is a weak hint that also appears inside other vendors'
 * names, so it is only consulted after the specific personal names have missed.
 */
function isGenericHint(hint: string): boolean {
  return hint === 'male' || hint === 'female';
}

export function pickBrowserVoice<T extends VoiceDescriptor>(
  available: readonly T[],
  presentation: VoicePresentation | string | undefined,
): BrowserVoiceChoice<T> {
  const coachVoice: CoachVoice = getCoachVoice(presentation);

  if (available.length === 0) {
    return { voice: null, matched: false, reason: 'no voices reported by the browser' };
  }

  const english = available.filter(isEnglish);
  const pool = english.length > 0 ? english : available;

  const specific = coachVoice.browserNameHints.filter((h) => !isGenericHint(h));
  const generic = coachVoice.browserNameHints.filter(isGenericHint);

  // Pass 1: specific personal names ("samantha", "zira", ...).
  for (const hint of specific) {
    const hit = pool.find((v) => v.name.toLowerCase().includes(hint));
    if (hit) {
      return { voice: hit, matched: true, reason: `matched "${hint}"` };
    }
  }

  // Pass 2: the generic suffix, e.g. "Google UK English Female".
  //
  // "female" contains "male", so a naive substring test would match every female voice when
  // looking for a male one. Match on a word boundary to avoid that.
  for (const hint of generic) {
    const pattern = new RegExp(`(^|[^a-z])${hint}([^a-z]|$)`, 'i');
    const hit = pool.find((v) => pattern.test(v.name));
    if (hit) {
      return { voice: hit, matched: true, reason: `matched "${hint}"` };
    }
  }

  // Nothing matched. Prefer an English voice over the platform default in another language,
  // but report honestly that the requested presentation was not found.
  const fallback = pool.find((v) => v.default) ?? pool[0] ?? null;
  return {
    voice: fallback,
    matched: false,
    reason: `no ${coachVoice.presentation} voice on this platform; using ${
      fallback ? `"${fallback.name}"` : 'the platform default'
    }`,
  };
}

/**
 * Delivery settings for the browser fallback.
 *
 * Slightly under the default rate and pitch: the platform defaults read as clipped and
 * announcement-like, which is the opposite of the calm conversational manner the coach is
 * supposed to have (task §3).
 */
export const BROWSER_VOICE_RATE = 0.96;
export const BROWSER_VOICE_PITCH = 1.0;

/**
 * Rough speaking speed for the watchdog in `player.ts`, at BROWSER_VOICE_RATE.
 * Conversational English runs about 150 wpm; at ~5.5 characters per word that is ~14 chars/sec.
 */
export const BROWSER_VOICE_CHARS_PER_SECOND = 14;

/** Extra headroom on top of the estimate before the watchdog gives up. */
export const BROWSER_VOICE_WATCHDOG_SLACK_MS = 3000;
