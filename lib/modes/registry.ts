/**
 * Mode registry — PRODUCT.md §6, ADR-011.
 *
 * A mode is configuration, not a code path. One conversation engine, one prompt assembly
 * pipeline, three config tuples. Casual and Coach differ only in persona warmth and correction
 * intensity, which is why having both costs almost nothing.
 *
 * V1 ships exactly three. Storytelling, Interview, Negotiation and Professional Communication
 * are V2/V3 and are deliberately absent (CLAUDE.md "not in scope for V1").
 */

import type { ModeConfig, ModeId } from '@/lib/types';
import { V1_MODES } from '@/lib/types';

export const MODES: Record<ModeId, ModeConfig> = {
  casual: {
    id: 'casual',
    label: 'Casual Conversation',
    blurb: 'Just talk. Corrections stay on screen unless something really blocks understanding.',
    promptFile: 'modes/casual.md',
    // One eligible voice correction per six turns — the light touch.
    recastInterval: 6,
    allowMicroTeach: false,
    allowDrill: false,
    sayItBetterRegisters: ['natural'],
    maxReplyWords: 45,
  },
  coach: {
    id: 'coach',
    label: 'English Coach',
    blurb: 'More active teaching. Still a conversation, but the coach will step in more often.',
    promptFile: 'modes/coach.md',
    recastInterval: 3,
    allowMicroTeach: true,
    allowDrill: true,
    sayItBetterRegisters: ['natural', 'professional'],
    maxReplyWords: 55,
  },
  free_topic: {
    id: 'free_topic',
    label: 'Free Topic',
    blurb: 'The coach picks something interesting to talk about. Good when you are stuck.',
    promptFile: 'modes/free-topic.md',
    recastInterval: 6,
    allowMicroTeach: false,
    allowDrill: false,
    sayItBetterRegisters: ['natural'],
    maxReplyWords: 45,
  },
};

export function getMode(id: string): ModeConfig {
  const mode = MODES[id as ModeId];
  if (!mode) throw new Error(`Unknown mode "${id}". V1 modes: ${V1_MODES.join(', ')}`);
  return mode;
}

export function isValidMode(id: string): id is ModeId {
  return (V1_MODES as readonly string[]).includes(id);
}

export const ALL_MODES: ModeConfig[] = V1_MODES.map((id) => MODES[id]);

export const DEFAULT_MODE: ModeId = 'casual';
