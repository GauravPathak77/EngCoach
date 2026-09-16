/** Say It Better, on demand — ROADMAP.md M11. */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import { getSession } from '@/server/services/sessionService';
import { sayItBetter } from '@/lib/analysis/sayItBetter';
import { getMode } from '@/lib/modes/registry';
import { recordLlmCall } from '@/server/services/telemetry';
import { badRequest, errorResponse, notFound } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as {
      text?: string;
      sessionId?: string;
      expanded?: boolean;
    };

    const text = (body.text ?? '').trim();
    if (text.length === 0) throw badRequest('text is required');
    if (!body.sessionId) throw badRequest('sessionId is required');

    const session = await getSession(body.sessionId, user.id);
    if (!session) throw notFound('Session not found');

    const mode = getMode(session.mode);
    const result = await sayItBetter(text, mode.sayItBetterRegisters, {
      expanded: body.expanded ?? false,
    });

    await recordLlmCall({
      userId: user.id,
      sessionId: session.id,
      lane: 'cold',
      modelId: result.modelId,
      promptVersion: result.promptVersion,
      usage: result.usage,
      latencyMs: 0,
      costUsd: result.costUsd,
      isLive: result.isLive,
    });

    return Response.json({
      originalText: result.originalText,
      variants: result.variants,
      meaningPreserved: result.meaningPreserved,
      canExpand: !body.expanded,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
