import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { harvest } from '../src/harvest.ts';

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

before(async () => {
  server = createServer((request, response) => {
    requested.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'application/json' });
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
