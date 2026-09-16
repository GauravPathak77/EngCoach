/**
 * Full data export — ARCHITECTURE.md §6.
 * It is the user's learning history, and they should be able to take it away.
 */

import { eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/migrate';
import { getDb } from '@/db/client';
import {
  findings,
  sessions,
  sessionMetrics,
  sessionReports,
  skillEstimates,
  speechSegments,
  structureObservations,
  turns,
  userVocabStates,
  vocabularyItems,
} from '@/db/schema';
import { requireUser } from '@/server/auth';
import { errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    const user = await requireUser();
    const db = getDb();

    const [
      sessionRows,
      turnRows,
      segmentRows,
      findingRows,
      observationRows,
      metricRows,
      reportRows,
      skillRows,
      vocabRows,
    ] = await Promise.all([
      db.select().from(sessions).where(eq(sessions.userId, user.id)),
      db.select().from(turns).where(eq(turns.userId, user.id)),
      db.select().from(speechSegments).where(eq(speechSegments.userId, user.id)),
      db.select().from(findings).where(eq(findings.userId, user.id)),
      db.select().from(structureObservations).where(eq(structureObservations.userId, user.id)),
      db.select().from(sessionMetrics).where(eq(sessionMetrics.userId, user.id)),
      db.select().from(sessionReports).where(eq(sessionReports.userId, user.id)),
      db.select().from(skillEstimates).where(eq(skillEstimates.userId, user.id)),
      db
        .select()
        .from(userVocabStates)
        .innerJoin(vocabularyItems, eq(vocabularyItems.id, userVocabStates.itemId))
        .where(eq(userVocabStates.userId, user.id)),
    ]);

    const payload = {
      exportedAt: new Date().toISOString(),
      user: {
        email: user.email,
        displayName: user.displayName,
        nativeLanguage: user.nativeLanguage,
        goals: user.goals,
        interests: user.interests,
      },
      sessions: sessionRows,
      turns: turnRows,
      // audio_key is omitted deliberately: the bytes are gone within 24h and a path to a
      // deleted object is noise in an export.
      speechSegments: segmentRows.map(({ audioKey: _audioKey, ...rest }) => rest),
      findings: findingRows,
      structureObservations: observationRows,
      sessionMetrics: metricRows,
      reports: reportRows,
      skillEstimates: skillRows,
      vocabulary: vocabRows,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="engcoach-export-${Date.now()}.json"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
