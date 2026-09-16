import { eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/migrate';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { requireUser } from '@/server/auth';
import { errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as {
      goals?: string[];
      interests?: string[];
      nativeLanguage?: string | null;
      selfReportedLevel?: string;
    };

    await getDb()
      .update(users)
      .set({
        goals: (body.goals ?? []).slice(0, 5),
        interests: (body.interests ?? []).slice(0, 8),
        nativeLanguage: body.nativeLanguage ?? null,
        selfReportedLevel: body.selfReportedLevel ?? 'B1',
        onboardedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
