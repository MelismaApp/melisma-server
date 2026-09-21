import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, type App } from '../src/server.ts';
import { MERGE_VERSION } from '../src/merge.ts';
import { PROVIDERS, type Provider } from '../src/providers/index.ts';
import { document, line } from '../src/model.ts';
import { cacheKey, type TrackQuery } from '../src/match.ts';

/**
 * The server answers while it is rebuilding the cache.
 *
 * A merge version bump means every stored entry is out of date, and bringing them up to date is slower
 * than it looks — 386 entries took 68 seconds against the real archive, nearly all of it the pairwise
 * alignment the cross-check needs. Run straight through, that is a minute of a blocked event loop: the
 * proxy health check polls every three seconds, gets nothing, decides the container is broken, and the
 * deploy fails. The bug would only ever appear on a library big enough to matter, which is the worst
 * kind, so it is pinned here with a library big enough to matter.
 */

let app: App;
let server: ReturnType<typeof start>;
let base: string;

const TRACK: TrackQuery = { title: 'Blinding Lights', artist: 'The Weeknd', album: '', durationMs: 200_046 };

/** Answers instantly, but from a body that has to be parsed and merged on every pass. */
const stub: Provider = {
  id: 'lrclib',
  label: 'stub',
  description: 'test',
  requires: [],
  wordLevel: false,
  isConfigured: () => true,
  fetch: async () => ({
    doc: document([line({ text: 'I said ooh', startMs: 1_000, endMs: 2_000 })]),
    match: 1,
    raw: { body: 'line', contentType: 'text/plain' },
  }),
  test: async () => ({ ok: true, detail: 'stub' }),
  reparse: () => {
    // Deliberately not free: the real cost of the sweep is per-entry CPU, and a stub that returns a
    // constant would make any amount of blocking look fine.
    let sink = 0;
    for (let i = 0; i < 40_000; i++) sink += Math.sqrt(i);
    return sink > 0 ? document([line({ text: 'I said ooh', startMs: 1_000, endMs: 2_000 })]) : null;
  },
};

before(async () => {
  app = createApp(':memory:');
  const original = [...PROVIDERS];
  PROVIDERS.length = 0;
  PROVIDERS.push(stub);
  for (const id of ['apple', 'amll', 'netease', 'musixmatch', 'spotify']) {
    app.settings.update({ [`provider.${id}.enabled`]: '0' });
  }
  app.settings.update({ 'provider.lrclib.enabled': '1' });

  // A library, cached at a version the server will consider out of date.
  for (let i = 0; i < 400; i++) {
    const track: TrackQuery = { ...TRACK, title: `Track ${i}` };
    await app.resolver.resolve(track);
    app.store.putEntry({
      key: cacheKey(track),
      title: track.title,
      artist: track.artist,
      album: '',
      durationMs: track.durationMs ?? 0,
      spotifyId: null,
      isrc: null,
      merged: JSON.stringify(document([line({ text: 'stale', startMs: 0, endMs: 1_000 })])),
      mergeVersion: MERGE_VERSION - 1,
    });
  }
  PROVIDERS.length = 0;
  PROVIDERS.push(...original);
  PROVIDERS.length = 0;
  PROVIDERS.push(stub);

  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

test('the health check is answered while the cache is being rebuilt', { timeout: 60_000 }, async () => {
  assert.ok(app.store.keysBelowVersion(MERGE_VERSION).length > 300, 'there should be a real backlog');

  // The sweep is already running, started when the server began listening. Poll the way the proxy does
  // and require every single answer: one timeout is a failed deploy.
  const latencies: number[] = [];
  for (let i = 0; i < 12; i++) {
    const started = Date.now();
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(5_000) });
    latencies.push(Date.now() - started);
    assert.equal(response.status, 200, `health check ${i} while re-merging`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const worst = Math.max(...latencies);
  // The proxy's timeout is 5s. A blocked loop parks a request for as long as the sweep takes.
  assert.ok(worst < 2_000, `worst health check took ${worst}ms during the rebuild`);
});
