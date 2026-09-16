/**
 * Authentication — ADR-019.
 *
 * Email + password with scrypt hashing and httpOnly cookie sessions. No OAuth provider, no
 * third-party auth service.
 *
 * Why: the blueprint (ARCHITECTURE.md §6) requires real auth from day one because every row is
 * user-scoped, and retrofitting that is miserable. But it is also a personal, self-hosted V1,
 * and requiring the user to register a Google OAuth app before they can say hello to their
 * coach is the wrong trade. scrypt is in node:crypto, so this costs no dependency.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { authSessions, users } from '@/db/schema';
import { newId } from '@/lib/ids';
import {
  DEFAULT_VOICE_PRESENTATION,
  normalisePresentation,
  type VoicePresentation,
} from '@/lib/voice/tts/voices';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const SESSION_COOKIE = 'engcoach_session';
const SESSION_DAYS = 30;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  nativeLanguage: string | null;
  selfReportedLevel: string | null;
  goals: string[];
  interests: string[];
  settings: UserSettingsRecord;
  onboardedAt: Date | null;
};

export type UserSettingsRecord = {
  voiceCorrectionsEnabled: boolean;
  drillsOptIn: boolean;
  difficulty: number;
  /** Provider-agnostic coach voice key ('female' | 'male'). ADR-020. */
  coachVoice: VoicePresentation;
  /** @deprecated pre-ADR-020 raw provider voice id. Read for migration, never written. */
  ttsVoice?: string;
  handsFree: boolean;
  retainAudio: boolean;
};

export const DEFAULT_SETTINGS: UserSettingsRecord = {
  voiceCorrectionsEnabled: true,
  drillsOptIn: false,
  difficulty: 5,
  // The default coach voice is female (ADR-020).
  coachVoice: DEFAULT_VOICE_PRESENTATION,
  handsFree: true,
  // Audio is deleted within 24h regardless (ADR-015); this opts into keeping it that long
  // rather than discarding it immediately after transcription.
  retainAudio: false,
};

export async function createAuthSession(userId: string): Promise<string> {
  const db = getDb();
  const id = newId();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(authSessions).values({ id, userId, expiresAt });
  return id;
}

export async function setSessionCookie(sessionId: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** The current user, or null. Every page and route handler goes through this. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const db = getDb();
  const rows = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(and(eq(authSessions.id, sessionId), gt(authSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || row.user.deletedAt) return null;

  return {
    id: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    nativeLanguage: row.user.nativeLanguage,
    selfReportedLevel: row.user.selfReportedLevel,
    goals: row.user.goals ?? [],
    interests: row.user.interests ?? [],
    settings: normaliseSettings(row.user.settings),
    onboardedAt: row.user.onboardedAt,
  };
}

/** Throwing variant for route handlers. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'UnauthorizedError';
  }
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    await getDb().delete(authSessions).where(eq(authSessions.id, sessionId));
  }
  await clearSessionCookie();
}

/**
 * Merge stored settings over the defaults, coercing the coach voice to a valid presentation.
 *
 * An account created before ADR-020 has `ttsVoice: 'alloy'` and no `coachVoice`. Mapping the
 * legacy id back to a presentation means such an account moves to the new default female voice
 * instead of silently keeping the old one (see `normalisePresentation`).
 */
export function normaliseSettings(stored: unknown): UserSettingsRecord {
  const merged = { ...DEFAULT_SETTINGS, ...((stored as Partial<UserSettingsRecord>) ?? {}) };
  const legacy = (stored as { ttsVoice?: string } | null)?.ttsVoice;
  const hasExplicitChoice = (stored as { coachVoice?: unknown } | null)?.coachVoice;

  return {
    ...merged,
    coachVoice: hasExplicitChoice
      ? normalisePresentation(hasExplicitChoice)
      : legacy
        ? normalisePresentation(legacy)
        : DEFAULT_VOICE_PRESENTATION,
  };
}
