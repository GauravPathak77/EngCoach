/**
 * Coach voice registry — ADR-020.
 *
 * PURE MODULE. Data and lookups only.
 *
 * The point of this file is the boundary it draws: the conversation engine, the session UI and
 * the user's stored settings all deal in a provider-agnostic key (`'female' | 'male'`). The
 * mapping from that key to `'sage'` or `'ash'` or some future ElevenLabs UUID lives HERE, inside
 * the voice/provider layer, exactly as ADR-004 intends. Swapping TTS vendor means editing
 * `providerVoiceIds` below and nothing else.
 *
 * Deliberately small: two voices, not a marketplace.
 */

export const VOICE_PRESENTATIONS = ['female', 'male'] as const;
export type VoicePresentation = (typeof VOICE_PRESENTATIONS)[number];

export type CoachVoice = {
  /** Stable, provider-agnostic key. This is what gets persisted in user settings. */
  id: VoicePresentation;
  /** The coach's name for this voice, shown in settings. */
  displayName: string;
  presentation: VoicePresentation;
  /** One line for the settings UI. */
  description: string;
  /** Provider name -> that provider's voice id. Never leaves this layer. */
  providerVoiceIds: Record<string, string>;
  /**
   * Substrings matched (case-insensitively) against `SpeechSynthesisVoice.name` to find a
   * matching browser voice. Heuristic by necessity — the Web Speech API exposes no gender
   * field — so `pickBrowserVoice` degrades to the platform default rather than guessing wildly.
   */
  browserNameHints: readonly string[];
};

/**
 * OpenAI voice choice, against the brief in §3 (natural, conversational, warm, clear, calm,
 * friendly, not robotic, not excessively enthusiastic, not an advertisement or audiobook read):
 *
 *   sage   calm, warm, conversational          → chosen for female
 *   coral  warm but noticeably brighter/peppier — drifts toward "advertisement"
 *   nova   energetic and presentational        — same problem, more so
 *   shimmer softer and breathier               — reads as audiobook narration
 *   alloy  the previous default; neutral-to-masculine and flatter
 *
 *   ash    warm, relaxed, conversational       → chosen for male
 */
export const COACH_VOICES: Record<VoicePresentation, CoachVoice> = {
  female: {
    id: 'female',
    displayName: 'Maya',
    presentation: 'female',
    description: 'Warm, calm and conversational. The default coach voice.',
    providerVoiceIds: { openai: 'sage' },
    browserNameHints: [
      // Apple
      'samantha', 'ava', 'allison', 'susan', 'victoria', 'karen', 'moira', 'tessa', 'fiona',
      'serena', 'nicky', 'zoe',
      // Microsoft
      'zira', 'aria', 'jenny', 'michelle', 'hazel', 'eva', 'sonia',
      // Google / Android
      'google uk english female', 'female',
    ],
  },
  male: {
    id: 'male',
    displayName: 'Aaron',
    presentation: 'male',
    description: 'Warm and relaxed, same manner.',
    providerVoiceIds: { openai: 'ash' },
    browserNameHints: [
      'daniel', 'alex', 'fred', 'tom', 'oliver', 'aaron', 'arthur',
      'david', 'mark', 'guy', 'ryan', 'george',
      'google uk english male', 'male',
    ],
  },
};

/** The default coach voice is female (task §3, §5). */
export const DEFAULT_VOICE_PRESENTATION: VoicePresentation = 'female';

export function isVoicePresentation(value: unknown): value is VoicePresentation {
  return typeof value === 'string' && (VOICE_PRESENTATIONS as readonly string[]).includes(value);
}

/**
 * Coerce whatever is in stored settings into a presentation key.
 *
 * Settings written before ADR-020 hold a raw OpenAI voice id (`'alloy'`, `'nova'`, ...). Those
 * are mapped back to a presentation rather than being passed through to the provider, so an old
 * account does not keep speaking in the pre-change voice forever.
 */
const LEGACY_OPENAI_VOICE_PRESENTATION: Record<string, VoicePresentation> = {
  alloy: 'male',
  echo: 'male',
  onyx: 'male',
  ash: 'male',
  ballad: 'male',
  verse: 'male',
  fable: 'female',
  nova: 'female',
  shimmer: 'female',
  coral: 'female',
  sage: 'female',
};

export function normalisePresentation(value: unknown): VoicePresentation {
  if (isVoicePresentation(value)) return value;
  if (typeof value === 'string') {
    const legacy = LEGACY_OPENAI_VOICE_PRESENTATION[value.toLowerCase()];
    if (legacy) return legacy;
  }
  return DEFAULT_VOICE_PRESENTATION;
}

export function getCoachVoice(presentation: unknown): CoachVoice {
  return COACH_VOICES[normalisePresentation(presentation)];
}

export const ALL_COACH_VOICES: CoachVoice[] = VOICE_PRESENTATIONS.map((p) => COACH_VOICES[p]);

/**
 * Resolve a coach voice to the id a specific provider understands.
 * Falls back to the female voice's id for that provider, then to the raw presentation key, so a
 * provider we have not mapped yet cannot throw inside the hot path.
 */
export function providerVoiceId(voice: CoachVoice, providerName: string): string {
  return (
    voice.providerVoiceIds[providerName] ??
    COACH_VOICES[DEFAULT_VOICE_PRESENTATION].providerVoiceIds[providerName] ??
    voice.id
  );
}
