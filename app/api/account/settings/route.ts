import { eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/migrate';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { requireUser } from '@/server/auth';
import { errorResponse } from '@/lib/api/errors';
import { normalisePresentation } from '@/lib/voice/tts/voices';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const body = (await request.json()) as Partial<{
      voiceCorrectionsEnabled: boolean;
      drillsOptIn: boolean;
      difficulty: number;
      handsFree: boolean;
      retainAudio: boolean;
      coachVoice: string;
    }>;

    const settings = {
      ...user.settings,
      ...body,
      difficulty: clamp(body.difficulty ?? user.settings.difficulty, 1, 10),
      // Never persist an arbitrary string as the voice — coerce to a registry key (ADR-020).
      coachVoice: normalisePresentation(body.coachVoice ?? user.settings.coachVoice),
    };

    await getDb().update(users).set({ settings }).where(eq(users.id, user.id));
    return Response.json({ ok: true, settings });
  } catch (error) {
    return errorResponse(error);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
