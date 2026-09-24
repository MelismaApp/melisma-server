import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { harvest } from '../src/harvest.ts';
import { resetAppToken } from '../src/spotifyApp.ts';

/**
 * A track played from somewhere other than Spotify has no Spotify id, and the harvest searches for
 * one. With an ISRC known, that search is Spotify's `isrc:` query, which is exact, rather than a
 * scored name search.
 */

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const ISRC = 'JPU901800227';
const realFetch = globalThis.fetch;
let searches: string[] = [];
let isrcResults: unknown[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  resetAppToken();
});

function stubSpotify() {
  searches = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.host === 'accounts.spotify.com') {
      return reply({ access_token: 'an-app-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname === '/v1/search') {
      const q = url.searchParams.get('q') ?? '';
      searches.push(q);
      if (q.startsWith('isrc:')) return reply({ tracks: { items: isrcResults } });
      return reply({
        tracks: { items: [{ id: 'TEXTMATCH0000000000000', name: 'Lemon', duration_ms: 255_000, artists: [{ name: 'Kenshi Yonezu' }] }] },
      });
    }
    return reply({ error: { status: 404 } }, 404);
  }) as typeof fetch;
}

function withAppToken() {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  settings.update({ 'secret.spotifyClientId': 'client', 'secret.spotifyClientSecret': 'secret' });
  return { store, config: settings.read() };
}

const lemon = { title: 'Lemon', artist: 'Kenshi Yonezu', album: '', durationMs: 255_000 };

test('a known ISRC finds the Spotify id exactly, without a name search', async () => {
  stubSpotify();
  isrcResults = [{ id: ID, name: 'Lemon', external_ids: { isrc: ISRC } }];
  const { store, config } = withAppToken();
  store.noteIdentity('q:lemon', { isrc: ISRC });

  const logged: string[] = [];
  const original = store.log.bind(store);
  store.log = (level, provider, message) => {
    logged.push(message);
    return original(level, provider, message);
  };
  await harvest(store, config, 'q:lemon', lemon);

  assert.deepEqual(searches, [`isrc:${ISRC}`]);
  assert.ok(logged.some((message) => message.includes('by ISRC')), logged.join('\n'));
  store.close();
});

test('a result carrying a different ISRC is not taken, and the name search follows', async () => {
  stubSpotify();
  isrcResults = [{ id: ID, name: 'Lemon', external_ids: { isrc: 'USXXX0000001' } }];
  const { store, config } = withAppToken();
  store.noteIdentity('q:lemon', { isrc: ISRC });

  await harvest(store, config, 'q:lemon', lemon);

  assert.deepEqual(searches, [`isrc:${ISRC}`, 'Lemon Kenshi Yonezu']);
  store.close();
});

test('with no album from the phone, Spotify\'s album for the track id picks the Apple release', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.host === 'accounts.spotify.com') {
      return reply({ access_token: 'an-app-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname === `/v1/tracks/${ID}`) {
      return reply({ id: ID, external_ids: { isrc: ISRC }, album: { id: 'alb', name: 'STRAY SHEEP' } });
    }
    if (url.host === 'apple.invalid') {
      asked.push(decodeURIComponent(url.search));
      const release = (id: string, albumName: string) => ({
        id,
        attributes: { name: 'Lemon', artistName: 'Kenshi Yonezu', isrc: ISRC, albumName },
        relationships: { albums: { data: [{ id: `a-${id}`, attributes: { upc: `9${id.length}` } }] } },
      });
      return reply({ data: [release('single', 'Lemon - Single'), release('album', 'STRAY SHEEP')] });
    }
    return reply({ error: { status: 404 } }, 404);
  }) as typeof fetch;

  const { store } = withAppToken();
  const settings = new Settings(store);
  settings.update({ 'secret.appleBearerToken': 'a-token', 'endpoint.apple': 'https://apple.invalid' });

  await harvest(store, settings.read(), `sp:${ID}`, { ...lemon, spotifyId: ID });

  assert.ok(asked.some((search) => search.includes(`filter[isrc]=${ISRC}`)), asked.join('\n'));
  assert.equal(store.extras(`sp:${ID}`, { hit: false })?.metadata?.appleMusicId, 'album');
  store.close();
});
