/**
 * Both ends of `make backup`: a consistent copy of the database, framed so it arrives intact.
 *
 *   node scripts/backup.ts             on the server: write the framed copy to stdout
 *   node scripts/backup.ts --receive   locally: unframe stdin, verify it, write the database
 *
 * The copy is made with `VACUUM INTO`, not by copying the file. The server runs SQLite in WAL mode,
 * so recent writes, schema changes included, sit in `-wal` until a checkpoint, and a plain copy
 * leaves them out while still passing `integrity_check`.
 *
 * The frame is because `kamal app exec` is not a byte pipe at the end of its output: it rewrites a
 * trailing carriage return as newlines. A database's last byte is ordinary data, and changing it
 * once turned an index entry for one row into another's. So the copy travels between markers with
 * its length and SHA-256, and the receiver refuses anything that does not match.
 *
 * `BL_DATA` picks the database, the same as the server. Opened read-only, so it cannot disturb the
 * server that has it open.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = 'MELISMA-BACKUP-BEGIN\n';
const END = /\nMELISMA-BACKUP-END (\d+) ([0-9a-f]{64})/;

if (process.argv.includes('--receive')) receive();
else await send();

async function send(): Promise<void> {
  // Imported here so the receiving end, which never opens a database, does not print SQLite's
  // experimental-feature warning.
  const { DatabaseSync } = await import('node:sqlite');
  const source =
    process.env.BL_DATA ?? fileURLToPath(new URL('../data/better-lyrics.db', import.meta.url));

  // A private directory, since the copy holds the tokens in the clear. Removed however this ends.
  const dir = mkdtempSync(join(tmpdir(), 'melisma-backup-'));
  const target = join(dir, 'backup.db');
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    db.close();
    const bytes = readFileSync(target);
    const sha = createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(BEGIN);
    process.stdout.write(bytes);
    process.stdout.write(`\nMELISMA-BACKUP-END ${bytes.length} ${sha}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function receive(): void {
  // Whatever Kamal printed around the frame is ignored; only what is inside it is kept.
  const input = readFileSync(0);
  const begin = input.indexOf(BEGIN);
  if (begin < 0) fail('no backup in the output — did the command run?');
  const start = begin + BEGIN.length;

  // Searched for from the end, since the database itself could contain anything.
  const tail = input.subarray(Math.max(start, input.length - 256)).toString('latin1');
  const found = END.exec(tail);
  if (!found) fail('the backup was cut off before its end marker');
  const length = Number(found[1]);
  const bytes = input.subarray(start, start + length);

  if (bytes.length !== length) fail(`expected ${length} bytes, got ${bytes.length}`);
  if (createHash('sha256').update(bytes).digest('hex') !== found[2]) {
    fail('the backup arrived damaged: its checksum does not match');
  }
  process.stdout.write(bytes);
}

function fail(message: string): never {
  console.error(`backup: ${message}`);
  process.exit(1);
}
