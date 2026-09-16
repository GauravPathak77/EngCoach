/**
 * Scheduled retention job — ADR-015, ROADMAP.md M12.
 *
 * Run: npm run job:purge
 * In production this belongs on a daily cron. Locally, run it whenever you like — it is
 * idempotent and only acts on audio that is already past its deadline.
 *
 * NOTE: with the embedded PGlite database this must NOT run while `npm run dev` is running —
 * PGlite is single-writer and two processes on the same data directory will abort each other.
 * Stop the dev server first, or point DATABASE_URL at a real Postgres.
 */

import { ensureSchema } from '@/db/migrate';
import { closeDb } from '@/db/client';
import { runPurge } from './audioPurgeJob';

async function main(): Promise<void> {
  await ensureSchema();
  const result = await runPurge();
  console.log(
    `Purged ${result.audioPurged} audio object(s); removed ${result.llmCallsDeleted} stale telemetry row(s).`,
  );
  await closeDb();
}

void main();
