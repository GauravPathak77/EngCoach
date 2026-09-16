/**
 * Hard delete — ARCHITECTURE.md §6. No soft delete, no tombstones.
 * "Delete everything" has to mean it, and an integration test asserts the tables are empty.
 */

import { requireUser, signOut } from '@/server/auth';
import { deleteAllUserData } from '@/server/jobs/audioPurgeJob';
import { badRequest, errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { confirm?: string };

    // Irreversible: require the user to type their email rather than click once.
    if (body.confirm !== user.email) {
      throw badRequest('Type your email address exactly to confirm deletion.');
    }

    const result = await deleteAllUserData(user.id);
    await signOut();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
