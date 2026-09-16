import { rmSync, existsSync } from 'node:fs';
import { DATA_DIR, usingPglite } from './client';

if (!usingPglite()) {
  console.error('db:reset only supports the embedded PGlite database. Drop your Postgres schema manually.');
  process.exit(1);
}
if (existsSync(DATA_DIR)) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`Removed ${DATA_DIR}`);
} else {
  console.log('Nothing to remove.');
}
