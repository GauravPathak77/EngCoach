/**
 * Dev helper: dump findings and the Gate 1 decisions for the local database.
 *
 * Run: npx tsx scripts/inspect.ts
 *
 * NOTE: stop `npm run dev` first. PGlite is single-writer, and two processes opening the same
 * data directory will abort each other (ADR-016).
 */
import { getDb, closeDb } from '@/db/client';
import { findings, structureObservations, userVocabStates } from '@/db/schema';
import { sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      ruleTag: findings.ruleTag,
      status: findings.status,
      asr: findings.asrConfidence,
      combined: findings.combinedConfidence,
      suspect: findings.isAsrSuspect,
      span: findings.originalSpanText,
    })
    .from(findings);

  console.log(`FINDINGS: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  ${r.status.padEnd(13)} ${r.ruleTag.padEnd(40)} asr=${r.asr} comb=${r.combined} suspect=${r.suspect}  "${r.span}"`,
    );
  }

  const obs = await db.select({ n: sql<number>`count(*)` }).from(structureObservations);
  const vocab = await db.select({ n: sql<number>`count(*)` }).from(userVocabStates);
  console.log(`OBSERVATIONS: ${obs[0]?.n}`);
  console.log(`VOCAB ITEMS:  ${vocab[0]?.n}`);
  await closeDb();
}

void main();
