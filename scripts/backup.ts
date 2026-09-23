/**
 * Write a consistent copy of the database to stdout, for `make backup`.
 *
 * Copying the file is not one. The server runs SQLite in WAL mode, so recent writes, schema changes
 * included, sit in `-wal` until a checkpoint, and a plain copy leaves them out while still passing
 * `integrity_check`. `VACUUM INTO` reads through the WAL and writes one self-contained file.
 *
 *   node scripts/backup.ts > copy.db
 *
 * `BL_DATA` picks the database, the same as the server. Opened read-only, so it cannot disturb the
 * server that has it open.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source =
  process.env.BL_DATA ?? fileURLToPath(new URL('../data/better-lyrics.db', import.meta.url));

// A private directory, since the copy holds the tokens in the clear. Removed however this ends.
const dir = mkdtempSync(join(tmpdir(), 'melisma-backup-'));
const target = join(dir, 'backup.db');
try {
  const db = new DatabaseSync(source, { readOnly: true });
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  db.close();
  process.stdout.write(readFileSync(target));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
