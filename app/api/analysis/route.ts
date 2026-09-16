/** Cold-lane trigger. Normally fired automatically by /api/turn; exposed for the dev panel. */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import { runColdLane } from '@/server/services/analysisService';
import { badRequest, errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as { sessionId?: string; force?: boolean };
    if (!body.sessionId) throw badRequest('sessionId is required');

    const result = await runColdLane(user.id, body.sessionId, {
      force: body.force ?? false,
      learnerLevel: user.selfReportedLevel,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
