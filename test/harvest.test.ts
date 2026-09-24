import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { harvest } from '../src/harvest.ts';
import { sameUpc } from '../src/match.ts';
import { songByIsrc } from '../src/providers/apple.ts';

/**
 * The harvest against a stand-in for Apple.
 *
 * Two things worth pinning, and the fake endpoint is what makes both testable: that the configured
 * base URL is honoured — otherwise this test could not exist at all, which is how the bug survived —
 * and that an identity is only recorded for a result that actually matches. `noteIdentity` keeps the
 * first ISRC it is told, so a wrong one is permanent and turns every later lookup into a confident
 * exact match on the wrong recording.
 */

let server: Server;
let base: string;
let requested: string[] = [];
let songs: unknown[] = [];
/** What `songs?filter[isrc]=` answers: one song per release of the recording. */
let byIsrc: unknown[] = [];

before(async () => {
  server = createServer((request, response) => {
    requested.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (decodeURIComponent(request.url ?? '').includes('filter[isrc]')) {
      response.end(JSON.stringify({ data: byIsrc }));
      return;
    }
    if ((request.url ?? '').includes('/search')) {
      response.end(JSON.stringify({ results: { songs: { data: songs } } }));
      return;
    }
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

function appleSong(name: string, artistName: string, durationInMillis: number, isrc: string) {
  return {
    id: `am-${isrc}`,
    attributes: {
      name,
      artistName,
      durationInMillis,
      isrc,
      albumName: `${name} - Single`,
      artwork: { url: 'https://example.invalid/{w}x{h}.jpg', bgColor: '111111' },
    },
  };
}

function harness() {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  settings.update({
    'secret.appleBearerToken': 'a-token',
    'secret.appleMediaUserToken': 'a-user-token',
    'endpoint.apple': base,
  });
  // Spotify has nothing to contribute here, and would reach for the real internet.
  settings.update({ 'secret.spotifyWebToken': null, 'secret.spDcCookie': null });
  return { store, config: settings.read() };
}

const lemon = { title: 'Lemon', artist: 'Kenshi Yonezu', album: 'Lemon', durationMs: 255_000 };

test('the configured Apple base is what gets called', async () => {
  const { store, config } = harness();
  requested = [];
  songs = [appleSong('Lemon', 'Kenshi Yonezu', 255_000, 'JPU901800227')];

  await harvest(store, config, 'sp:right', lemon);

  // If this were still hard-coded to the production host, nothing would arrive here — and a proxy
  // or test deployment would silently bypass its own configuration.
  assert.ok(requested.some((url) => url.includes('/search')), 'the fake endpoint was never called');
  store.close();
});

test('a matching result supplies the identity', async () => {
  const { store, config } = harness();
  songs = [appleSong('Lemon', 'Kenshi Yonezu', 255_000, 'JPU901800227')];

  await harvest(store, config, 'sp:right', lemon);

  assert.equal(store.isrcFor('sp:right'), 'JPU901800227');
  assert.equal(store.extras('sp:right')?.coverUrl, 'https://example.invalid/{w}x{h}.jpg');
  store.close();
});

test('an unrelated first result records nothing', async () => {
  const { store, config } = harness();
  // What a real search returns for an ambiguous title: something else entirely at the top.
  songs = [
    appleSong('Lemon Tree', 'Fools Garden', 189_000, 'DEXXX9500001'),
    appleSong('Lemonade', 'Internet Money', 195_000, 'USXXX2000001'),
  ];

  await harvest(store, config, 'sp:wrong', lemon);

  // Taking the first result on trust would pin `DEXXX9500001` here, permanently and invisibly:
  // `noteIdentity` keeps the first ISRC it is given, and every later provider would then look up
  // the wrong recording as an exact match.
  assert.equal(store.isrcFor('sp:wrong'), null);
  store.close();
});

test('the right result is chosen even when it is not first', async () => {
  const { store, config } = harness();
  songs = [
    appleSong('Lemon (Live)', 'Kenshi Yonezu', 301_000, 'JPU902200999'),
    appleSong('Lemon', 'Kenshi Yonezu', 255_000, 'JPU901800227'),
  ];

  await harvest(store, config, 'sp:live', lemon);

  // The live take is a different recording with a different length. Scoring is what tells them
  // apart; position in the results does not.
  assert.equal(store.isrcFor('sp:live'), 'JPU901800227');
  store.close();
});

// ---- by identity ----------------------------------------------------------

/** One Apple song per release: same ISRC, its own id, cover and album UPC. */
function onRelease(id: string, isrc: string, upc: string) {
  return {
    id,
    attributes: {
      name: 'Lemon',
      artistName: 'Kenshi Yonezu',
      durationInMillis: 255_000,
      isrc,
      albumName: `release ${id}`,
      artwork: { url: `https://example.invalid/${id}/{w}x{h}.jpg` },
    },
    relationships: { albums: { data: [{ id: `album-${id}`, attributes: { upc } }] } },
  };
}

test('a known ISRC is asked about directly, not searched for by name', async () => {
  const { store, config } = harness();
  requested = [];
  songs = [];
  byIsrc = [onRelease('single', 'JPU901800227', '4988031270000')];
  store.noteIdentity('sp:known', { isrc: 'JPU901800227' });

  await harvest(store, config, 'sp:known', lemon);

  assert.ok(requested.some((url) => decodeURIComponent(url).includes('filter[isrc]=JPU901800227')));
  assert.ok(!requested.some((url) => url.includes('/search')), 'fell back to a name search');
  assert.equal(store.extras('sp:known', { hit: false })?.metadata?.appleMusicId, 'single');
  store.close();
});

test('of several releases of one ISRC, the one whose UPC matches is taken, however it is padded', async () => {
  const { store, config } = harness();
  byIsrc = [
    onRelease('single', 'JPU901800227', '4988031270000'),
    onRelease('album', 'JPU901800227', '4988031290411'),
  ];
  store.noteIdentity('sp:album', { isrc: 'JPU901800227' });
  // Spotify reported it zero-padded to fourteen digits; Apple gives thirteen.
  store.saveExtras({ key: 'sp:album', metadata: { albumUpc: '04988031290411' }, source: 'spotify' });

  await harvest(store, config, 'sp:album', lemon);

  const held = store.extras('sp:album', { hit: false })!;
  assert.equal(held.metadata?.appleMusicId, 'album');
  assert.equal(held.coverUrl, 'https://example.invalid/album/{w}x{h}.jpg');
  store.close();
});

test('with no UPC to go on, the first release is taken, as before', async () => {
  const { store, config } = harness();
  byIsrc = [
    onRelease('single', 'JPU901800227', '4988031270000'),
    onRelease('album', 'JPU901800227', '4988031290411'),
  ];
  store.noteIdentity('sp:first', { isrc: 'JPU901800227' });

  await harvest(store, config, 'sp:first', lemon);

  assert.equal(store.extras('sp:first', { hit: false })?.metadata?.appleMusicId, 'single');
  store.close();
});

test('an ISRC Apple does not have falls back to the scored search', async () => {
  const { store, config } = harness();
  requested = [];
  byIsrc = [];
  songs = [appleSong('Lemon', 'Kenshi Yonezu', 255_000, 'JPU901800227')];
  store.noteIdentity('sp:fallback', { isrc: 'JPU901800227' });

  await harvest(store, config, 'sp:fallback', lemon);

  assert.ok(requested.some((url) => url.includes('/search')));
  assert.equal(store.extras('sp:fallback', { hit: false })?.metadata?.appleMusicId, 'am-JPU901800227');
  store.close();
});

test('the Apple lyrics provider picks the release by UPC too', async () => {
  byIsrc = [
    onRelease('single', 'JPU901800227', '4988031270000'),
    onRelease('album', 'JPU901800227', '4988031290411'),
  ];
  const found = await songByIsrc(base, 'us', 'JPU901800227', '4988031290411', {});
  assert.equal(found.song?.id, 'album');
  assert.equal((await songByIsrc(base, 'us', 'JPU901800227', undefined, {})).song?.id, 'single');
  // A UPC that matches none of them is not a reason to take nothing.
  assert.equal((await songByIsrc(base, 'us', 'JPU901800227', '0000000000017', {})).song?.id, 'single');
});

test('UPCs compare without their zero padding, and never match when absent', () => {
  assert.equal(sameUpc('04988031290411', '4988031290411'), true);
  assert.equal(sameUpc('602557382457', '00602557382457'), true);
  assert.equal(sameUpc('602557382457', '602557382458'), false);
  assert.equal(sameUpc(undefined, undefined), false);
  assert.equal(sameUpc('000', '0'), false);
});

test('the album UPC is part of what is known about a track', () => {
  const store = new Store(':memory:');
  store.saveExtras({ key: 'sp:upc', metadata: { albumUpc: '602557382457' }, source: 'spotify' });
  assert.equal(store.identityFor('sp:upc').upc, '602557382457');
  assert.equal(store.library({}).rows.find((row) => row.key === 'sp:upc')?.ids.upc, '602557382457');
  store.close();
});
