/**
 * Coach voice configuration and browser fallback — ADR-020.
 *
 * The two things that must hold: the default is female, and the conversation layer never sees a
 * provider voice id.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_COACH_VOICES,
  COACH_VOICES,
  DEFAULT_VOICE_PRESENTATION,
  getCoachVoice,
  isVoicePresentation,
  normalisePresentation,
  providerVoiceId,
  VOICE_PRESENTATIONS,
} from '@/lib/voice/tts/voices';
import { pickBrowserVoice, type VoiceDescriptor } from '@/lib/voice/browserVoice';
import { DEFAULT_SETTINGS, normaliseSettings } from '@/server/auth';

describe('the default coach voice is female', () => {
  it('is the registry default', () => {
    expect(DEFAULT_VOICE_PRESENTATION).toBe('female');
    expect(getCoachVoice(undefined).presentation).toBe('female');
  });

  it('is what a brand-new account gets', () => {
    expect(DEFAULT_SETTINGS.coachVoice).toBe('female');
  });

  it('is what an account with no stored voice resolves to', () => {
    expect(normaliseSettings({}).coachVoice).toBe('female');
    expect(normaliseSettings(null).coachVoice).toBe('female');
  });

  it('is the fallback for anything unrecognised', () => {
    expect(normalisePresentation('nonsense')).toBe('female');
    expect(normalisePresentation(42)).toBe('female');
    expect(normalisePresentation(null)).toBe('female');
  });
});

describe('the registry stays small and well-formed', () => {
  it('offers exactly female and male — not a marketplace', () => {
    expect(VOICE_PRESENTATIONS).toEqual(['female', 'male']);
    expect(ALL_COACH_VOICES).toHaveLength(2);
  });

  it('gives every voice a display name, description and provider mapping', () => {
    for (const voice of ALL_COACH_VOICES) {
      expect(voice.displayName.length, voice.id).toBeGreaterThan(1);
      expect(voice.description.length, voice.id).toBeGreaterThan(10);
      expect(voice.providerVoiceIds.openai, voice.id).toBeTruthy();
      expect(voice.browserNameHints.length, voice.id).toBeGreaterThan(3);
    }
  });

  it('keys every entry by its own id', () => {
    for (const presentation of VOICE_PRESENTATIONS) {
      expect(COACH_VOICES[presentation].id).toBe(presentation);
      expect(COACH_VOICES[presentation].presentation).toBe(presentation);
    }
  });

  it('validates presentation keys', () => {
    expect(isVoicePresentation('female')).toBe(true);
    expect(isVoicePresentation('male')).toBe(true);
    expect(isVoicePresentation('sage')).toBe(false);
  });
});

describe('provider voice ids stay inside the voice layer', () => {
  it('maps the female coach voice to a warm conversational OpenAI voice', () => {
    expect(providerVoiceId(COACH_VOICES.female, 'openai')).toBe('sage');
  });

  it('maps the male coach voice to its own id', () => {
    expect(providerVoiceId(COACH_VOICES.male, 'openai')).toBe('ash');
  });

  it('falls back to the default voice rather than throwing on an unmapped provider', () => {
    // A future ElevenLabs adapter with no mapping yet must not break the hot path.
    expect(providerVoiceId(COACH_VOICES.female, 'elevenlabs')).toBeTruthy();
  });
});

describe('legacy settings migrate rather than sticking on the old voice', () => {
  it('maps a pre-ADR-020 raw OpenAI id back to a presentation', () => {
    // 'alloy' was the previous default and is neutral-to-masculine.
    expect(normaliseSettings({ ttsVoice: 'alloy' }).coachVoice).toBe('male');
    expect(normaliseSettings({ ttsVoice: 'nova' }).coachVoice).toBe('female');
    expect(normaliseSettings({ ttsVoice: 'shimmer' }).coachVoice).toBe('female');
  });

  it('prefers an explicit modern choice over the legacy field', () => {
    expect(normaliseSettings({ coachVoice: 'male', ttsVoice: 'nova' }).coachVoice).toBe('male');
  });

  it('coerces a corrupt stored value instead of passing it through', () => {
    expect(normaliseSettings({ coachVoice: 'shimmer' }).coachVoice).toBe('female');
    expect(normaliseSettings({ coachVoice: '' }).coachVoice).toBe('female');
  });

  it('leaves the rest of the settings alone', () => {
    const merged = normaliseSettings({ difficulty: 8, handsFree: false });
    expect(merged.difficulty).toBe(8);
    expect(merged.handsFree).toBe(false);
    expect(merged.voiceCorrectionsEnabled).toBe(DEFAULT_SETTINGS.voiceCorrectionsEnabled);
  });
});

// ---------------------------------------------------------------------------
// Browser fallback
// ---------------------------------------------------------------------------

const voice = (name: string, lang = 'en-US', isDefault = false): VoiceDescriptor => ({
  name,
  lang,
  default: isDefault,
});

describe('browser voice selection', () => {
  it('picks a known female voice by name on macOS', () => {
    const choice = pickBrowserVoice([voice('Daniel'), voice('Samantha')], 'female');
    expect(choice.voice?.name).toBe('Samantha');
    expect(choice.matched).toBe(true);
  });

  it('picks a known female voice by name on Windows', () => {
    const choice = pickBrowserVoice(
      [voice('Microsoft David - English (United States)'), voice('Microsoft Zira - English (United States)')],
      'female',
    );
    expect(choice.voice?.name).toContain('Zira');
    expect(choice.matched).toBe(true);
  });

  it('picks a male voice when male is requested', () => {
    const choice = pickBrowserVoice([voice('Samantha'), voice('Daniel')], 'male');
    expect(choice.voice?.name).toBe('Daniel');
    expect(choice.matched).toBe(true);
  });

  it('does NOT match "male" inside "female" — the word-boundary trap', () => {
    // A naive substring test would return the female voice when asked for a male one.
    const choice = pickBrowserVoice([voice('Google UK English Female')], 'male');
    expect(choice.matched).toBe(false);
  });

  it('matches the generic suffix when no personal name is present', () => {
    const choice = pickBrowserVoice([voice('Google UK English Female')], 'female');
    expect(choice.matched).toBe(true);
  });

  it('reports matched:false and falls back when the platform has no matching voice', () => {
    // Honesty requirement (task §5): do not claim a female voice that is not there.
    const choice = pickBrowserVoice([voice('Robotic Voice 1'), voice('Robotic Voice 2', 'en-GB', true)], 'female');
    expect(choice.matched).toBe(false);
    expect(choice.voice).not.toBeNull();
    expect(choice.reason).toContain('no female voice');
  });

  it('prefers the platform default among non-matching voices', () => {
    const choice = pickBrowserVoice([voice('Aaa'), voice('Bbb', 'en-US', true)], 'female');
    expect(choice.voice?.name).toBe('Bbb');
  });

  it('prefers English voices over other languages', () => {
    const choice = pickBrowserVoice([voice('Amélie', 'fr-FR', true), voice('Generic', 'en-US')], 'female');
    expect(choice.voice?.lang).toBe('en-US');
  });

  it('still returns an English voice when a same-named one exists in another language', () => {
    const choice = pickBrowserVoice([voice('Samantha', 'en-AU')], 'female');
    expect(choice.matched).toBe(true);
    expect(choice.voice?.name).toBe('Samantha');
  });

  it('does not crash when the browser reports no voices at all', () => {
    // Chrome returns [] until the speech engine has loaded.
    const choice = pickBrowserVoice([], 'female');
    expect(choice.voice).toBeNull();
    expect(choice.matched).toBe(false);
    expect(choice.reason).toContain('no voices');
  });

  it('defaults to female when the presentation is missing or junk', () => {
    const available = [voice('Daniel'), voice('Samantha')];
    expect(pickBrowserVoice(available, undefined).voice?.name).toBe('Samantha');
    expect(pickBrowserVoice(available, 'nonsense').voice?.name).toBe('Samantha');
  });
});
