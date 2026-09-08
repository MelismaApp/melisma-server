/**
 * Print, set or rotate the API key.
 *
 * The server prints its key once on boot, which is fine on a laptop and useless on a deployed
 * container. This reads it straight out of the database, so the answer to "what is my key" never
 * involves scrolling back through logs.
 *
 *   node scripts/key.ts                 print the current key
 *   node scripts/key.ts --new           mint a new one, invalidating the old
 *   node scripts/key.ts --set <value>   use a key you chose yourself
 *
 * `BL_DATA` picks the database, the same as the server. On a Kamal host:
 *
 *   kamal app exec --interactive --reuse "node scripts/key.ts"
 *
 * Note that a key set through `BL_API_KEY` wins over the stored one at runtime, so on a
 * deployment configured that way this reports what is in the database, which is not what the
 * server is using. It says so when that is the case.
 */

import { fileURLToPath } from 'node:url';

import { Settings, randomKey } from '../src/config.ts';
import { Store } from '../src/db.ts';

const args = process.argv.slice(2);
const wantsNew = args.includes('--new');
const setIndex = args.indexOf('--set');
const explicit = setIndex >= 0 ? args[setIndex + 1] : undefined;

if (setIndex >= 0 && !explicit) {
  console.error('--set needs a value');
  process.exit(1);
}
if (explicit && explicit.length < 16) {
  // Short enough to guess is short enough to refuse. The generated ones are 48 hex characters.
  console.error('that key is too short to be worth having — use at least 16 characters');
  process.exit(1);
}

const databasePath =
  process.env.BL_DATA ?? fileURLToPath(new URL('../data/better-lyrics.db', import.meta.url));

const store = new Store(databasePath);
const settings = new Settings(store);

if (explicit || wantsNew) {
  const key = explicit ?? randomKey();
  settings.update({ 'server.apiKey': key });
  store.log('warn', null, explicit ? 'API key set from the command line' : 'API key rotated');
  console.log(key);
  console.log('\nEvery client using the old key now gets a 401. Update the app, and the admin');
  console.log('page will ask for the new one on its next visit.');
} else {
  const key = settings.read().apiKey;
  if (!key) {
    console.error('no key yet — start the server once, or run this with --new');
    process.exit(1);
  }
  console.log(key);
}

if (process.env.BL_API_KEY) {
  console.log(
    '\nNote: BL_API_KEY is set in this environment, and it overrides the stored key.\n' +
      'The running server is using that value, not this one.',
  );
}

store.close();
