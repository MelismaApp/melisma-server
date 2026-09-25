import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, type App } from '../src/server.ts';
import { cacheKey } from '../src/match.ts';

/**
 * Language tags: the admin says what a song is sung in, and every lookup of it is told.
 */

let app: App;
let server: ReturnType<typeof start>;
let base: string;
let adminKey: string;

before(async () => {
  app = createApp(':memory:');
  adminKey = app.settings.read().apiKey;
  for (const id of ['apple', 'amll', 'netease', 'musixmatch', 'spotify', 'lrclib']) {
    app.settings.update({ [`provider.${id}.enabled`]: '0' });
  }
  // On, as it ships: a lookup from here needs no key, and a tag still does.
  app.settings.update({ 'server.allowLocalNetwork': '1' });
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const OTHER_RELEASE = '7qiZfU4dY1lWllzX7mPBI3';
const ISRC = 'TWA451500001';
const song = { title: '愛到明仔載', artist: '蔡佩軒', durationMs: 240_000 };

function tag(body: Record<string, unknown>, key?: string) {
  return fetch(`${base}/v1/language`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function extras(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/v1/extras?${query}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const query = (spotifyId: string, isrc?: string) =>
  new URLSearchParams({
    title: song.title,
    artist: song.artist,
    durationMs: String(song.durationMs),
    spotifyId,
    ...(isrc ? { isrc } : {}),
  }).toString();

test('only the admin key tags: none is 401, even from here, and a user key is 403', async () => {
  assert.equal((await tag({ ...song, spotifyId: ID, language: 'nan' })).status, 401);

  const made = await fetch(`${base}/admin/api/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Family' }),
  });
  const { key } = (await made.json()) as { key: string };
  assert.equal((await tag({ ...song, spotifyId: ID, language: 'nan' }, key)).status, 403);
  assert.equal(app.store.languageTag(`sp:${ID}`), null);

  // The export is the admin's too.
  assert.equal(
    (await fetch(`${base}/admin/api/languages`, { headers: { Authorization: `Bearer ${key}` } })).status,
    403,
  );
});

test('only a known language or null is accepted, and leaving it out is not a way to clear', async () => {
  for (const language of ['hokkien', 'NAN', '', 1, undefined]) {
    const response = await tag({ ...song, spotifyId: ID, language }, adminKey);
    assert.equal(response.status, 400, String(language));
  }
  assert.equal((await tag({ spotifyId: ID, language: 'nan' }, adminKey)).status, 400, 'no title');
});

test('a tag is served on a lookup, as headers, and on the extras, and null clears it', async () => {
  assert.equal((await tag({ ...song, spotifyId: ID, isrc: ISRC, language: 'nan' }, adminKey)).status, 204);

  // Nothing is cached and every source is off, so this is a miss, and the tag is still told.
  const lookup = await fetch(`${base}/v1/lyrics?${query(ID)}`);
  assert.equal(lookup.status, 404);
  assert.equal(lookup.headers.get('x-lyrics-language'), 'nan');
  assert.equal(lookup.headers.get('x-lyrics-language-source'), 'tagged');

  // Nothing else is held for it, and the extras still answer with the language.
  const held = await extras(query(ID));
  assert.equal(held.status, 200);
  assert.equal(held.body.language, 'nan');
  assert.equal(held.body.languageSource, 'tagged');

  assert.equal((await tag({ ...song, spotifyId: ID, language: null }, adminKey)).status, 204);
  assert.equal((await fetch(`${base}/v1/lyrics?${query(ID)}`)).headers.get('x-lyrics-language'), null);
  assert.equal((await extras(query(ID))).status, 404);
});

test('a tag reaches another release of the same recording, by its ISRC', async () => {
  await tag({ ...song, spotifyId: ID, isrc: ISRC, language: 'nan' }, adminKey);
  assert.equal((await extras(query(OTHER_RELEASE, ISRC))).body.language, 'nan');
  // Without the ISRC the other release is a different track.
  assert.equal((await extras(query(OTHER_RELEASE))).status, 404);
});

test('a tag by name is keyed the way a lookup by name is', async () => {
  const byName = { title: '浪子回頭', artist: '茄子蛋', durationMs: 290_000 };
  await tag({ ...byName, language: 'nan' }, adminKey);
  assert.equal(app.store.languageTag(cacheKey({ ...byName, album: '' }))?.language, 'nan');
  const lookup = await fetch(
    `${base}/v1/lyrics?title=${encodeURIComponent(byName.title)}&artist=${encodeURIComponent(byName.artist)}&durationMs=290000`,
  );
  assert.equal(lookup.headers.get('x-lyrics-language'), 'nan');
});

test('the admin can export every tag, with what it was tagged on', async () => {
  await tag({ ...song, spotifyId: ID, isrc: ISRC, album: '愛到明仔載', language: 'nan' }, adminKey);
  const response = await fetch(`${base}/admin/api/languages`, { headers: { Authorization: `Bearer ${adminKey}` } });
  const { tags } = (await response.json()) as { tags: Record<string, unknown>[] };
  const mine = tags.find((row) => row.key === `sp:${ID}`)!;
  assert.deepEqual(
    [mine.language, mine.isrc, mine.spotifyId, mine.title, mine.artist, mine.album, mine.durationMs],
    ['nan', ISRC, ID, song.title, song.artist, '愛到明仔載', 240_000],
  );
  assert.equal(typeof mine.taggedAt, 'number');
});

test('"Forget everything" forgets the tag; "Forget the lyrics" keeps it', async () => {
  await tag({ ...song, spotifyId: ID, isrc: ISRC, language: 'nan' }, adminKey);
  const forget = (everything: boolean) =>
    fetch(`${base}/admin/api/entry?key=sp:${ID}${everything ? '&everything=1' : ''}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
  await forget(false);
  assert.equal(app.store.languageTag(`sp:${ID}`)?.language, 'nan');
  await forget(true);
  assert.equal(app.store.languageTag(`sp:${ID}`), null);
});
