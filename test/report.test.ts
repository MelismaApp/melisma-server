import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, type App } from '../src/server.ts';
import { MERGE_VERSION } from '../src/merge.ts';
import { Store } from '../src/db.ts';
import { document, line } from '../src/model.ts';
import { relookupCandidates, timingFit } from '../src/report.ts';

/**
 * Judging what is already cached against the length the player reported.
 *
 * The signal the app session proposed sending, which turned out to be here already: every lookup carries
 * `durationMs` and it is stored on the entry, so "did these timings fit the copy that was playing" is
 * answerable over the whole library without a protocol change or a single byte of telemetry.
 */

function merged(lines: ReturnType<typeof line>[], timing: string) {
  return JSON.stringify({
    ...document(lines),
    provenance: { timing, translation: null, romanization: null, contributors: [timing] },
    algorithmVersion: MERGE_VERSION,
  });
}

function entry(store: Store, key: string, durationMs: number, body: string) {
  store.putEntry({
    key,
    title: key,
    artist: 'Someone',
    album: '',
    durationMs,
    spotifyId: null,
    isrc: null,
    merged: body,
    mergeVersion: MERGE_VERSION,
  });
}

test('a document running past the end of the track is reported', () => {
  const store = new Store(':memory:');
  // NetEase's Irony: 5:48 of timings on a 2:24 recording.
  entry(
    store,
    'long',
    144_000,
    merged(
      [
        line({ text: 'In time', startMs: 1_000, endMs: 3_000 }),
        line({ text: 'It fades', startMs: 150_000, endMs: 152_000 }),
        line({ text: 'And then', startMs: 300_000, endMs: 302_000 }),
        line({ text: 'It ends', startMs: 340_000, endMs: 342_000 }),
      ],
      'netease',
    ),
  );

  const report = timingFit(store);
  assert.equal(report.rows.length, 1);
  const [row] = report.rows;
  assert.equal(row.provider, 'netease');
  assert.equal(row.serious, true, 'three quarters past the end is another recording');
  assert.equal(row.lastTimingMs, 340_000);
  assert.ok(row.pastEndShare > 0.7, `share was ${row.pastEndShare}`);
  store.close();
});

test('a document that fits is not news', () => {
  const store = new Store(':memory:');
  entry(
    store,
    'fits',
    200_000,
    merged(
      [
        line({ text: 'One', startMs: 1_000, endMs: 3_000 }),
        line({ text: 'Two', startMs: 100_000, endMs: 102_000 }),
        line({ text: 'Three', startMs: 190_000, endMs: 195_000 }),
      ],
      'apple',
    ),
  );

  const report = timingFit(store);
  assert.equal(report.rows.length, 0);
  assert.equal(report.checked, 1);
  store.close();
});

test('a couple of seconds over is a longer master, and not serious', () => {
  const store = new Store(':memory:');
  entry(
    store,
    'remaster',
    100_000,
    merged(
      [
        ...Array.from({ length: 30 }, (_, i) => line({ text: `L${i}`, startMs: i * 3_000, endMs: i * 3_000 + 2_000 })),
        line({ text: 'Last', startMs: 104_000, endMs: 106_000 }),
      ],
      'lrclib',
    ),
  );

  const report = timingFit(store);
  assert.equal(report.rows.length, 1, 'still worth listing');
  assert.equal(report.rows[0].serious, false, 'but one line over is a longer master');
  assert.equal(report.serious, 0);
  store.close();
});

test('a track whose player never reported a length is unanswerable, not passing', () => {
  const store = new Store(':memory:');
  // Silently treating this as "fits" would be the wrong kind of quiet: there is nothing to compare with.
  entry(store, 'nodur', 0, merged([line({ text: 'Out here', startMs: 900_000, endMs: 902_000 })], 'netease'));

  const report = timingFit(store);
  assert.equal(report.rows.length, 0);
  assert.equal(report.checked, 0);
  assert.equal(report.withoutDuration, 1);
  store.close();
});

test('the report says how many other sources answered', () => {
  const store = new Store(':memory:');
  entry(store, 'alts', 100_000, merged([line({ text: 'Way past', startMs: 300_000, endMs: 302_000 })], 'netease'));
  for (const provider of ['netease', 'apple', 'lrclib']) {
    store.putRaw({ key: 'alts', provider, body: 'body', contentType: 'text/plain', ok: true, note: null });
  }

  const [row] = timingFit(store).rows;
  // Three answered, one of them is the culprit: two remain if it is dropped.
  assert.equal(row.alternatives, 2);
  store.close();
});

// ---- the action ------------------------------------------------------------

let app: App;
let server: ReturnType<typeof start>;
let base: string;
let apiKey: string;

before(async () => {
  app = createApp(':memory:');
  apiKey = app.settings.read().apiKey;
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

const authed = (path: string, options: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...options.headers },
  });

test('dropping a source leaves its body archived and rebuilds without it', async () => {
  const lyric = '[00:01.00]One\n[00:02.00]Two\n[00:03.00]Three\n[00:04.00]Four\n';
  app.store.putRaw({ key: 'drop-me', provider: 'lrclib', body: lyric, contentType: 'text/plain', ok: true, note: null });
  app.store.putRaw({
    key: 'drop-me',
    provider: 'netease',
    body: JSON.stringify({ lrc: { lyric } }),
    contentType: 'application/json',
    ok: true,
    note: null,
  });
  entry(app.store, 'drop-me', 100_000, merged([line({ text: 'One', startMs: 300_000, endMs: 302_000 })], 'netease'));

  const response = await authed('/admin/api/drop-source', {
    method: 'POST',
    body: JSON.stringify({ key: 'drop-me', provider: 'netease' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.dropped, 'netease');

  // The body is still on disk as evidence, marked unusable with the reason.
  const raws = app.store.getRaw('drop-me');
  const dropped = raws.find((r) => r.provider === 'netease');
  assert.ok(dropped, 'the archived body must not be deleted');
  assert.equal(dropped.ok, false);
  assert.match(dropped.note ?? '', /timings did not fit/);

  // And the other source is still usable.
  assert.equal(raws.find((r) => r.provider === 'lrclib')?.ok, true);
});

test('dropping needs both a key and a provider', async () => {
  for (const body of ['{}', '{"key":"x"}', '{"provider":"netease"}']) {
    const response = await authed('/admin/api/drop-source', { method: 'POST', body });
    assert.equal(response.status, 400, body);
  }
});

test('the report and the action both need the key', async () => {
  // It reads the whole library and the action rewrites what is served, so neither is a lookup.
  assert.equal((await fetch(`${base}/admin/api/fit`)).status, 401);
  assert.equal(
    (await fetch(`${base}/admin/api/drop-source`, { method: 'POST', body: '{}' })).status,
    401,
  );
});

// ---- who is worth asking again ---------------------------------------------

test('only the tracks a re-lookup could change are candidates', () => {
  const store = new Store(':memory:');
  const fine = merged([line({ text: 'One', startMs: 1_000, endMs: 2_000 })], 'apple');

  // Asked precisely by Spotify id, answered, cached, fits. Six requests for nothing.
  entry(store, 'sp:abc', 200_000, fine);
  // Nothing cached: the only question is whether anyone has it now.
  entry(store, 'sp:empty', 200_000, '');
  // Filed under a title, which is the match the folding and the identity-first search changed.
  entry(store, 'q:song|artist|100', 200_000, fine);

  const set = relookupCandidates(store);
  const keys = set.candidates.map((c) => c.key).sort();
  assert.deepEqual(keys, ['q:song|artist|100', 'sp:empty']);
  assert.equal(set.total, 3);
  assert.equal(set.byReason['nothing cached'], 1);
  assert.equal(set.byReason['matched by title'], 1);
  store.close();
});

test('a source that never answered is not a reason to run a bulk lookup', () => {
  const store = new Store(':memory:');
  // The largest group on the real library by far — 176 of 407 — and already handled for free: a cache hit
  // re-asks the sources that never got to answer, in the background, on the next play. Putting these in a
  // bulk run would spend hours redoing work that happens by itself.
  entry(store, 'sp:thin', 200_000, merged([line({ text: 'One', startMs: 1_000, endMs: 2_000 })], 'apple'));
  store.putRaw({ key: 'sp:thin', provider: 'apple', body: 'x', contentType: 'text/plain', ok: true, note: null });

  assert.equal(relookupCandidates(store).candidates.length, 0);
  store.close();
});
