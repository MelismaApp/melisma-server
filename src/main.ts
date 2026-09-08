/**
 * Entry point.
 *
 * The database lives next to the code by default so that "where is my cache" has an obvious
 * answer; `BL_DATA` moves it.
 */

import { createApp, start } from './server.ts';

const databasePath =
  process.env.BL_DATA ?? new URL('../data/better-lyrics.db', import.meta.url).pathname;

const app = createApp(databasePath);
const server = start(app);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      app.store.close();
      process.exit(0);
    });
  });
}
