/** End-of-session report — ROADMAP.md M7. */

import { ensureSchema } from '@/db/migrate';
import { requireUser } from '@/server/auth';
import { getSession, endSession } from '@/server/services/sessionService';
import { generateReport, loadReport } from '@/server/services/reportService';
import { badRequest, errorResponse, notFound } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as { sessionId?: string };
    if (!body.sessionId) throw badRequest('sessionId is required');

    const session = await getSession(body.sessionId, user.id);
    if (!session) throw notFound('Session not found');

    if (session.status !== 'ended') await endSession(session.id, user.id);

    const report = await generateReport(user, { ...session, status: 'ended' });
    return Response.json(report);
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

    const report = await loadReport(sessionId, user.id);
    if (!report) throw notFound('No report yet for this session');
    return Response.json(report);
  } catch (error) {
    return errorResponse(error);
  }
}
