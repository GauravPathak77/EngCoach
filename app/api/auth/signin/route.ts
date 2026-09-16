import { eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/migrate';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { createAuthSession, setSessionCookie, verifyPassword } from '@/server/auth';
import { ApiError, errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const body = (await request.json()) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();

    const rows = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];

    // Same message either way: which half was wrong is not the signer-in's business.
    const invalid = new ApiError('unauthorized', 'Email or password is incorrect.', 401);
    if (!user || user.deletedAt) throw invalid;
    if (!(await verifyPassword(body.password ?? '', user.passwordHash))) throw invalid;

    await setSessionCookie(await createAuthSession(user.id));
    return Response.json({ ok: true, onboarded: user.onboardedAt !== null });
  } catch (error) {
    return errorResponse(error);
  }
}
