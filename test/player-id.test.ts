import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, type App } from '../src/server.ts';
import { parsePlayerId } from '../src/playerId.ts';
import { MERGE_VERSION } from '../src/merge.ts';
import { line, type MergedDocument } from '../src/model.ts';

/**
 * A player's own track id, resolved to the recording's ISRC once for everyone, and the lookup keyed
 * by that rather than by name.
 */

let app: App;
let server: ReturnType<typeof start>;
let base: string;

before(async () => {
  app = createApp(':memory:');
  for (const id of ['apple', 'amll', 'netease', 'musixmatch', 'spotify', 'lrclib']) {
    app.settings.update({ [`provider.${id}.enabled`]: '0' });
  }
  app.settings.update({ 'server.allowLocalNetwork': '1' });
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Everything but the server under test goes to `answer`; what it does not answer is a failing test. */
function stub(answer: (url: URL, init?: RequestInit) => Response | undefined) {
  const asked: { url: URL; headers: Headers; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    asked.push({ url, headers: new Headers(init?.headers), init });
    const reply = answer(url, init);
    if (!reply) throw new Error(`unexpected request to ${url}`);
    return reply;
  }) as typeof fetch;
  return asked;
}

function cache(key: string) {
  const document: MergedDocument = {
    kind: 'line',
    lines: [line({ text: 'words', startMs: 0, endMs: 1_000 })],
    songWriters: [],
    hasRomanization: false,
    hasTranslation: false,
    provenance: { timing: 'lrclib', syllables: [], songWriters: [] },
    candidates: [],
    algorithmVersion: MERGE_VERSION,
  };
  app.store.putEntry({
    key, title: 'Song', artist: 'Someone', album: '', durationMs: 200_000, spotifyId: null, isrc: null,
    merged: JSON.stringify(document), mergeVersion: MERGE_VERSION,
  });
}

const SONG = 'title=Song&artist=Someone&durationMs=200000';
const lyrics = (query: string) => fetch(`${base}/v1/lyrics?${query}`);
const keyOf = async (response: Response) => ((await response.json()) as { key: string }).key;

test('a player id is <service>:<id>, and anything else is dropped', () => {
  assert.deepEqual(parsePlayerId('deezer:2981739661'), { service: 'deezer', id: '2981739661' });
  assert.deepEqual(parsePlayerId('amazon:B0DX1H5KT5'), { service: 'amazon', id: 'B0DX1H5KT5' });
  assert.deepEqual(parsePlayerId(' tidal:134858527 '), { service: 'tidal', id: '134858527' });
  const dropped = ['spotify:4uLU6hMCjMI75M1A2tKUQC', 'deezer:', 'deezer:12:34', 'deezer:../x', 'amazon:b0dx1h5kt5', 'youtube:abc', 42, undefined];
  for (const bad of dropped) assert.equal(parsePlayerId(bad), undefined, String(bad));
});

test('a Deezer id is resolved once, keys the lookup by the recording, and comes back as the ISRC', async () => {
  const asked = stub((url) =>
    url.href === 'https://api.deezer.com/track/2981739661'
      ? Response.json({ id: 2981739661, title: 'Song', isrc: 'KRA302400093', duration: 200 })
      : undefined,
  );
  const query = `${SONG}&playerId=deezer:2981739661`;

  const miss = await lyrics(query);
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('x-lyrics-isrc'), 'KRA302400093');
  assert.equal(await keyOf(miss), 'isrc:KRA302400093');
  assert.equal(asked.length, 1);

  // Nothing else is held, and the extras still answer with what was worked out.
  const extras = await fetch(`${base}/v1/extras?${query}`);
  assert.equal(extras.status, 200);
  assert.equal(((await extras.json()) as { isrc: string }).isrc, 'KRA302400093');

  // Remembered: nobody is asked again.
  cache('isrc:KRA302400093');
  const hit = (await (await lyrics(`${query}&cacheOnly=1`)).json()) as { status: number; data: { isrc: string } };
  assert.equal(hit.status, 200);
  assert.equal(hit.data.isrc, 'KRA302400093');
  assert.equal(asked.length, 1);
  assert.equal(app.store.playerIsrc('deezer', '2981739661')?.isrc, 'KRA302400093');
});

test('an ISRC sent beside a player id is remembered against it, and nobody is asked', async () => {
  const asked = stub(() => undefined);
  await lyrics(`${SONG}&isrc=KRA302400094&playerId=deezer:111`);
  assert.equal(asked.length, 0);
  assert.equal(app.store.playerIsrc('deezer', '111')?.isrc, 'KRA302400094');

  const later = await lyrics(`${SONG}&playerId=deezer:111`);
  assert.equal(later.headers.get('x-lyrics-isrc'), 'KRA302400094');
  assert.equal(asked.length, 0);
});

test('"no such track" is remembered as none; a failure to ask is not, and is asked again', async () => {
  let down = true;
  const asked = stub((url) =>
    url.hostname !== 'api.deezer.com'
      ? undefined
      : down
        ? new Response('down', { status: 500 })
        : Response.json({ error: { type: 'DataException', message: 'no data', code: 800 } }),
  );
  const query = `${SONG}&playerId=deezer:222`;

  assert.equal((await keyOf(await lyrics(query))).slice(0, 2), 'q:', 'the lookup still went by name');
  assert.equal(app.store.playerIsrc('deezer', '222'), null, 'an outage is not an answer');

  down = false;
  await lyrics(query);
  assert.equal(asked.length, 2);
  assert.equal(app.store.playerIsrc('deezer', '222')?.isrc, null);

  await lyrics(query);
  assert.equal(asked.length, 2, 'a none is not asked about on every play');
});

test("an Amazon ASIN is found in Apple's catalogue by name, only at the same length to the second", async () => {
  app.settings.update({ 'secret.appleBearerToken': 'eyJ.apple.token' });
  let candidates: Record<string, unknown>[] = [];
  const asked = stub((url) =>
    url.hostname === 'amp-api.music.apple.com' && url.pathname.endsWith('/search')
      ? Response.json({ results: { songs: { data: candidates.map((attributes) => ({ attributes })) } } })
      : undefined,
  );
  // Through the extras, which identify the track without running a lookup: a lookup's own harvest
  // would search Apple by name too, and learn an ISRC this test would then mistake for the resolver's.
  const identified = async (asin: string) => {
    const response = await fetch(
      `${base}/v1/extras?title=Blinding%20Lights&artist=The%20Weeknd&durationMs=200040&playerId=amazon:${asin}`,
    );
    return response.status === 200 ? ((await response.json()) as { isrc?: string }).isrc ?? null : null;
  };

  // The same name two seconds longer is another recording.
  candidates = [{ name: 'Blinding Lights', artistName: 'The Weeknd', durationInMillis: 202_500, isrc: 'USUG11904206' }];
  assert.equal(await identified('B000000001'), null);
  assert.equal(app.store.playerIsrc('amazon', 'B000000001')?.isrc, null);
  assert.equal(asked[0]!.headers.get('authorization'), 'Bearer eyJ.apple.token');

  // The right length and the right name, among a remix and a different song of the same length.
  candidates = [
    { name: 'Blinding Lights', artistName: 'The Weeknd', durationInMillis: 240_000, isrc: 'USUG11904208' },
    { name: 'Something Else', artistName: 'Nobody', durationInMillis: 200_040, isrc: 'XXAAA0000001' },
    { name: 'Blinding Lights', artistName: 'The Weeknd', durationInMillis: 200_040, isrc: 'USUG11904206' },
  ];
  assert.equal(await identified('B0DX1H5KT5'), 'USUG11904206');

  // The right length and the right artist alone are not enough: another of their songs of the same
  // length is none. (The artist agrees, so this is the name threshold, not the artist contradiction.)
  candidates = [{ name: 'Starboy', artistName: 'The Weeknd', durationInMillis: 200_040, isrc: 'USUG11600001' }];
  assert.equal(await identified('B000000003'), null);
  assert.equal(app.store.playerIsrc('amazon', 'B000000003')?.isrc, null);

  // Without the Apple token there is nothing to search with, so nothing is asked.
  app.settings.update({ 'secret.appleBearerToken': null });
  const before = asked.length;
  assert.equal(await identified('B000000002'), null);
  assert.equal(asked.length, before);
  assert.equal(app.store.playerIsrc('amazon', 'B000000002'), null);
});

test('a TIDAL id needs the developer credentials, and one access token serves many ids', async () => {
  const asked = stub((url) => {
    if (url.href === 'https://auth.tidal.com/v1/oauth2/token') {
      return Response.json({ access_token: 'tidal-access', token_type: 'Bearer', expires_in: 86_400 });
    }
    if (url.hostname === 'openapi.tidal.com') {
      const id = url.pathname.split('/').pop()!;
      return id === '404404'
        ? new Response('', { status: 404 })
        : Response.json({ data: { id, type: 'tracks', attributes: { isrc: `USUG1${id.slice(0, 7)}` } } });
    }
    return undefined;
  });
  const query = (id: string) => `${SONG}&playerId=tidal:${id}`;

  await lyrics(query('134858527'));
  assert.equal(asked.length, 0, 'without credentials nothing is asked');

  app.settings.update({ 'secret.tidalClientId': 'tidal-id', 'secret.tidalClientSecret': 'tidal-secret' });
  assert.equal((await lyrics(query('134858527'))).headers.get('x-lyrics-isrc'), 'USUG11348585');
  assert.equal((await lyrics(query('7000000'))).headers.get('x-lyrics-isrc'), 'USUG17000000');

  const mints = asked.filter((call) => call.url.hostname === 'auth.tidal.com');
  assert.equal(mints.length, 1, 'one token for both');
  assert.equal(mints[0]!.init?.method, 'POST');
  assert.equal(mints[0]!.init?.body, 'grant_type=client_credentials');
  assert.equal(mints[0]!.headers.get('authorization'), `Basic ${Buffer.from('tidal-id:tidal-secret').toString('base64')}`);
  const tracks = asked.filter((call) => call.url.hostname === 'openapi.tidal.com');
  assert.ok(tracks.every((call) => call.headers.get('authorization') === 'Bearer tidal-access'));

  await lyrics(query('404404'));
  assert.equal(app.store.playerIsrc('tidal', '404404')?.isrc, null);
});

test('a SoundCloud id asks nobody, and is remembered once an ISRC arrives beside it', async () => {
  const asked = stub(() => undefined);
  assert.equal((await keyOf(await lyrics(`${SONG}&playerId=soundcloud:555`))).slice(0, 2), 'q:');
  assert.equal(asked.length, 0);
  await lyrics(`${SONG}&playerId=soundcloud:555&isrc=KRA302400095`);
  assert.equal((await lyrics(`${SONG}&playerId=soundcloud:555`)).headers.get('x-lyrics-isrc'), 'KRA302400095');
});

test('a warm-up resolves the id too, and records the request by the recording', async () => {
  stub((url) =>
    url.href === 'https://api.deezer.com/track/333'
      ? Response.json({ id: 333, isrc: 'KRA302400096' })
      : undefined,
  );
  const warmed = await fetch(`${base}/v1/warm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Song', artist: 'Someone', durationMs: 200_000, playerId: 'deezer:333' }),
  });
  assert.equal(warmed.status, 202);
  for (let waited = 0; waited < 50 && !app.store.hasAsked(0, 'isrc:KRA302400096'); waited++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(app.store.hasAsked(0, 'isrc:KRA302400096'));
});
