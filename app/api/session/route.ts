/** Session lifecycle: start, fetch state, end. */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import {
  endSession,
  getActiveSession,
  getSession,
  listTurns,
  startSession,
} from '@/server/services/sessionService';
import { surfacedFindings } from '@/server/services/analysisService';
import { sessionCost } from '@/server/services/telemetry';
import { isValidMode } from '@/lib/modes/registry';
import { badRequest, errorResponse, notFound } from '@/lib/api/errors';
import { hasLiveCredentials } from '@/lib/llm/client';
import type { ModeId } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as { mode?: string; action?: string; sessionId?: string };

    if (body.action === 'end') {
      if (!body.sessionId) throw badRequest('sessionId is required');
      const session = await getSession(body.sessionId, user.id);
      if (!session) throw notFound('Session not found');
      const metrics = await endSession(body.sessionId, user.id);
      return Response.json({ ok: true, metrics });
    }

    const mode = body.mode ?? 'casual';
    if (!isValidMode(mode)) throw badRequest(`Unknown mode "${mode}"`);

    // Only one active session at a time — a stale session left open would keep accumulating
    // turns against an old snapshot.
    const active = await getActiveSession(user.id);
    if (active) await endSession(active.id, user.id);

    const started = await startSession(user, mode as ModeId);
    return Response.json({
      sessionId: started.id,
      mode: started.mode,
      focus: started.focus,
      isLive: hasLiveCredentials(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) throw badRequest('sessionId is required');

    const session = await getSession(sessionId, user.id);
    if (!session) throw notFound('Session not found');

    const [turns, notes, cost] = await Promise.all([
      listTurns(sessionId),
      surfacedFindings(sessionId, user.id),
      sessionCost(sessionId),
    ]);

    return Response.json({
      session: {
        id: session.id,
        mode: session.mode,
        status: session.status,
        startedAt: session.startedAt,
        focus: {
          primary: session.primaryFocusRuleTag,
          secondary: session.secondaryFocusRuleTag,
        },
      },
      turns: turns.map((t) => ({
        id: t.id,
        role: t.role,
        text: t.text,
        index: t.index,
        directiveKind: t.directiveKind,
      })),
      notes,
      cost,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
