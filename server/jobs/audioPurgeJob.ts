/**
 * Audio purge and data deletion — ROADMAP.md M12, ADR-015.
 *
 * Note what "purge" means here: the speech_segments ROW survives, only `audio_key` is nulled and
 * the stored object removed. The word timings stay, and they carry 100% of the analytical value
 * at a fraction of the privacy risk. That trade is the whole argument in ADR-015.
 */

import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { llmCalls, speechSegments, users } from '@/db/schema';
import { llmCallCutoff } from '@/lib/privacy/retention';
import { deleteAudio } from '@/server/storage';
import { USER_SCOPED_TABLES } from '@/lib/privacy/retention';

export type PurgeResult = {
  audioPurged: number;
  llmCallsDeleted: number;
};

export async function runPurge(now: Date = new Date()): Promise<PurgeResult> {
  const db = getDb();

  const expired = await db
    .select({ id: speechSegments.id, audioKey: speechSegments.audioKey })
    .from(speechSegments)
    .where(
      and(
        sql`${speechSegments.audioKey} is not null`,
        eq(speechSegments.pinned, false),
        lte(speechSegments.audioPurgeAfter, now),
      ),
    );

  let audioPurged = 0;
  for (const segment of expired) {
    if (segment.audioKey) await deleteAudio(segment.audioKey);
    await db
      .update(speechSegments)
      .set({ audioKey: null })
      .where(eq(speechSegments.id, segment.id));
    audioPurged += 1;
  }

  const cutoff = llmCallCutoff(now);
  const stale = await db
    .select({ n: sql<number>`count(*)` })
    .from(llmCalls)
    .where(lte(llmCalls.createdAt, cutoff));
  await db.delete(llmCalls).where(lte(llmCalls.createdAt, cutoff));

  return { audioPurged, llmCallsDeleted: Number(stale[0]?.n ?? 0) };
}

/**
 * Hard delete. No soft delete, no tombstones — "delete everything" must mean it
 * (ARCHITECTURE.md §6). Foreign keys cascade from users, but the audio objects live outside the
 * database and have to be removed explicitly first.
 */
export async function deleteAllUserData(userId: string): Promise<{ tablesCleared: number }> {
  const db = getDb();

  const segments = await db
    .select({ audioKey: speechSegments.audioKey })
    .from(speechSegments)
    .where(eq(speechSegments.userId, userId));

  for (const segment of segments) {
    if (segment.audioKey) await deleteAudio(segment.audioKey);
  }

  // Cascades from users handle the rest, but tables keyed by user_id without a foreign key
  // (skill_estimates, suppressed_rules, progress_snapshots, ...) need explicit deletion.
  for (const table of USER_SCOPED_TABLES) {
    if (table === 'users') continue;
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE user_id = '${escapeLiteral(userId)}'`));
  }

  await db.delete(users).where(eq(users.id, userId));

  return { tablesCleared: USER_SCOPED_TABLES.length };
}

/** Ids are generated uuids, but never interpolate unescaped input into SQL. */
function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
