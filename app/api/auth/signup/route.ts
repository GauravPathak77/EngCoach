import { eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/migrate';
import { getDb } from '@/db/client';
import { learningProfiles, users } from '@/db/schema';
import { newId } from '@/lib/ids';
import {
  createAuthSession,
  DEFAULT_SETTINGS,
  hashPassword,
  setSessionCookie,
} from '@/server/auth';
import { badRequest, errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const body = (await request.json()) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address.');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters.');

    const db = getDb();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) throw badRequest('An account with that email already exists.');

    const id = newId();
    await db.insert(users).values({
      id,
      email,
      passwordHash: await hashPassword(password),
      settings: DEFAULT_SETTINGS,
    });
    await db.insert(learningProfiles).values({ userId: id }).onConflictDoNothing();

    await setSessionCookie(await createAuthSession(id));
    return Response.json({ ok: true, userId: id });
  } catch (error) {
    return errorResponse(error);
  }
}
