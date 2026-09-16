/**
 * Finding feedback — the dispute affordance (UX.md §2).
 *
 * One tap, and it feeds the suppression list, the frustration brake, and our precision metric.
 * A product that cannot be told it is wrong loses the user's trust silently rather than loudly.
 */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import { agreeFinding, disputeFinding } from '@/server/services/policyState';
import { badRequest, errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const { id } = await context.params;
    const body = (await request.json()) as { feedback?: string };

    if (body.feedback === 'disagreed') {
      await disputeFinding(user.id, id);
    } else if (body.feedback === 'agreed') {
      await agreeFinding(user.id, id);
    } else {
      throw badRequest('feedback must be "agreed" or "disagreed"');
    }

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
