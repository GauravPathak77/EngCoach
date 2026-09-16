import { ensureSchema } from './migrate';
import { closeDb, usingPglite, DATA_DIR } from './client';

await ensureSchema(true);
console.log(usingPglite() ? `Schema ready (PGlite at ${DATA_DIR})` : 'Schema ready (Postgres)');
await closeDb();
