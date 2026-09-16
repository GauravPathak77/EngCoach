/**
 * Database client — ADR-016.
 *
 * Two drivers behind one Drizzle interface:
 *   - PGlite (embedded Postgres, on-disk) when DATABASE_URL is absent — zero setup, real
 *     Postgres semantics, the same SQL dialect as production.
 *   - node-postgres when DATABASE_URL is set — Neon, Supabase, or a local server.
 *
 * The blueprint (ADR-006) specifies Postgres and PGlite *is* Postgres compiled to WASM, so
 * moving to Neon later is a connection-string change, not a migration. This keeps the
 * "clone and run" promise in the README without weakening the data model.
 */

import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { mkdirSync } from 'node:fs';
import * as schema from './schema';

export type Database = PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export const DATA_DIR = process.env.ENGCOACH_DATA_DIR ?? './.data/engcoach';

let db: Database | null = null;
let pglite: PGlite | null = null;
let pool: Pool | null = null;

export function usingPglite(): boolean {
  return !process.env.DATABASE_URL;
}

export function getDb(): Database {
  if (db) return db;

  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    db = drizzleNode(pool, { schema });
  } else {
    // In-memory for tests so each run starts clean; on-disk for development so a session
    // survives a restart.
    const inMemory = process.env.ENGCOACH_IN_MEMORY_DB === '1';
    if (!inMemory) {
      // PGlite will not create a missing parent directory, and a first-run crash on `mkdir`
      // is a miserable way to meet a new project.
      mkdirSync(DATA_DIR, { recursive: true });
    }
    pglite = new PGlite(inMemory ? 'memory://' : DATA_DIR);
    db = drizzlePglite(pglite, { schema });
  }
  return db;
}

/** Raw SQL execution, used by the migration runner. */
export async function execRaw(sql: string): Promise<void> {
  if (process.env.DATABASE_URL) {
    if (!pool) getDb();
    await pool!.query(sql);
    return;
  }
  if (!pglite) getDb();
  await pglite!.exec(sql);
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
  db = null;
}

/** Test helper: drop the cached instance so the next getDb() builds a fresh one. */
export function resetDbHandleForTests(): void {
  db = null;
  pglite = null;
  pool = null;
}

export { schema };
