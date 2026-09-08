import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, type App } from '../src/server.ts';
import { MERGE_VERSION } from '../src/merge.ts';

let app: App;
let server: ReturnType<typeof start>;
let base: string;
let apiKey: string;

before(async () => {
  // In memory, and with every source turned off: these tests are about the HTTP surface and
  // the cache, and a test that reaches the network is a test that fails on a train.
  app = createApp(':memory:');
  apiKey = app.settings.read().apiKey;
  for (const id of ['apple', 'amll', 'netease', 'musixmatch', 'spotify', 'lrclib']) {
    app.settings.update({ [`provider.${id}.enabled`]: '0' });
  }

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

// ---- authentication -------------------------------------------------------

test('the API is closed without a key', async () => {
  assert.equal((await fetch(`${base}/v1/health`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/stats`)).status, 401);
});

test('a wrong key is rejected', async () => {
  const response = await fetch(`${base}/v1/health`, {
    headers: { Authorization: 'Bearer definitely-not-the-key' },
  });
  assert.equal(response.status, 401);
});

test('the admin page itself is public, because it is only a login form', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
});

test('logging in with the key returns a session cookie', async () => {
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().join('; ');
  assert.match(cookie, /bls_session=/);
  // HttpOnly so a script on the page cannot read it, SameSite so another site cannot use it.
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const stats = await fetch(`${base}/admin/api/stats`, { headers: { Cookie: cookie } });
  assert.equal(stats.status, 200);
});

test('a wrong key does not get a session', async () => {
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'nope' }),
  });
  assert.equal(login.status, 401);
  assert.equal(login.headers.getSetCookie().length, 0);
});

// ---- health and config ----------------------------------------------------

test('health reports every source and whether it can actually run', async () => {
  const body = await (await authed('/v1/health')).json();
  assert.equal(body.ok, true);
  assert.equal(body.mergeVersion, MERGE_VERSION);
  const apple = body.providers.find((provider: { id: string }) => provider.id === 'apple');
  assert.equal(apple.configured, false); // no tokens in this test
  assert.equal(apple.wordLevel, true);
});

test('secrets come back masked, never in full', async () => {
  await authed('/admin/api/config', {
    method: 'POST',
    body: JSON.stringify({ 'secret.appleMediaUserToken': 'super-secret-value-1234' }),
  });

  const body = await (await authed('/admin/api/config')).json();
  const state = body.config.secrets.appleMediaUserToken;
  assert.equal(state.set, true);
  assert.match(state.preview, /1234$/);
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));
});

test('a secret comes back in full only when asked for explicitly', async () => {
  const body = await (
    await authed('/admin/api/reveal', {
      method: 'POST',
      body: JSON.stringify({ name: 'appleMediaUserToken' }),
    })
  ).json();
  assert.equal(body.value, 'super-secret-value-1234');
});

test('only known settings keys can be written', async () => {
  await authed('/admin/api/config', {
    method: 'POST',
    body: JSON.stringify({ 'server.somethingElse': 'x', 'secret.notARealSecret': 'y' }),
  });
  const settings = app.store.allSettings();
  assert.ok(!('server.somethingElse' in settings));
  assert.ok(!('secret.notARealSecret' in settings));
});

test('an unknown secret cannot be revealed', async () => {
  const response = await authed('/admin/api/reveal', {
    method: 'POST',
    body: JSON.stringify({ name: 'apiKey' }),
  });
  assert.equal(response.status, 400);
});

// ---- lookups --------------------------------------------------------------

test('a lookup with no title is a bad request, not an empty search', async () => {
  assert.equal((await authed('/v1/lyrics?artist=Someone')).status, 400);
});

test('a track nothing has is a 404 that says what was asked', async () => {
  const response = await authed(
    '/v1/lyrics?title=Nonexistent%20Xyzzy&artist=No%20Such%20Artist&durationMs=123000',
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.key, /^q:/);
});

test('having no sources configured is not cached as "this track has no lyrics"', async () => {
  // The distinction matters: one is a fact about the track and worth remembering for days,
  // the other is a setting the user is about to fix.
  const body = await (
    await authed('/v1/lyrics?title=Nonexistent%20Xyzzy&artist=No%20Such%20Artist&durationMs=123000')
  ).json();
  assert.equal(body.source, 'absent');
  assert.equal(app.store.getEntry(body.key), null);
});

test('a cached "nothing found" is served from the cache until it expires', async () => {
  const track = { title: 'Definitely Nothing', artist: 'Nobody', album: '', durationMs: 190_000 };
  const { cacheKey } = await import('../src/match.ts');
  const key = cacheKey(track);
  app.store.putEntry({
    key,
    title: track.title,
    artist: track.artist,
    album: '',
    durationMs: track.durationMs,
    spotifyId: null,
    isrc: null,
    merged: null,
    mergeVersion: MERGE_VERSION,
  });

  const response = await authed(
    `/v1/lyrics?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
      track.artist,
    )}&durationMs=${track.durationMs}`,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).source, 'cache');
});

test('cacheOnly never reaches for the network', async () => {
  const response = await authed('/v1/lyrics?title=Never%20Asked%20Before&cacheOnly=1');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).source, 'absent');
});

test('warming is accepted and answered immediately', async () => {
  const response = await authed('/v1/warm', {
    method: 'POST',
    body: JSON.stringify({ title: 'Some Track', artist: 'Some Artist', durationMs: 200_000 }),
  });
  assert.equal(response.status, 202);
});

// ---- contributions --------------------------------------------------------

test('the app can contribute lyrics the server could not reach', async () => {
  const track = { title: 'Contributed', artist: 'Someone', durationMs: 210_000 };
  const response = await authed('/v1/contribute', {
    method: 'POST',
    body: JSON.stringify({
      track,
      provider: 'musixmatch',
      format: 'lrc',
      body: '[00:01.00]<00:01.00>one <00:02.00>two\n[00:05.00]three\n[00:09.00]four',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);

  // It is archived under its own namespace so it can never overwrite a real fetch, and it
  // takes part in the merge from now on.
  const raw = app.store.getRaw(body.key);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].provider, 'app:musixmatch');
});

test('a contribution that is not lyrics is refused', async () => {
  const response = await authed('/v1/contribute', {
    method: 'POST',
    body: JSON.stringify({
      track: { title: 'Junk', artist: 'X', durationMs: 1000 },
      provider: 'lrclib',
      format: 'lrc',
      body: 'this has no timestamps at all',
    }),
  });
  assert.equal(response.status, 400);
});

// ---- admin ----------------------------------------------------------------

test('the cache can be listed, inspected and emptied', async () => {
  const list = await (await authed('/admin/api/entries')).json();
  assert.ok(list.entries.length > 0);

  const key = list.entries[0].key;
  const detail = await (await authed(`/admin/api/entry?key=${encodeURIComponent(key)}`)).json();
  assert.equal(detail.entry.key, key);

  const deleted = await authed(`/admin/api/entry?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  assert.equal(deleted.status, 200);
  assert.equal(app.store.getEntry(key), null);
  // The archive goes with it, so a deletion is a real deletion.
  assert.equal(app.store.getRaw(key).length, 0);
});

test('testing a source with no credentials says what is missing', async () => {
  const body = await (
    await authed('/admin/api/test', { method: 'POST', body: JSON.stringify({ provider: 'apple' }) })
  ).json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /appleBearerToken/);
});

test('an unknown source cannot be tested', async () => {
  const response = await authed('/admin/api/test', {
    method: 'POST',
    body: JSON.stringify({ provider: 'not-a-source' }),
  });
  assert.equal(response.status, 400);
});

test('the log is readable and holds no token values', async () => {
  const body = await (await authed('/admin/api/events')).json();
  assert.ok(Array.isArray(body.events));
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));
});

test('an unknown route is a 404, not a crash', async () => {
  assert.equal((await authed('/v1/nothing-here')).status, 404);
});

test('a path traversal in an asset request gets nothing', async () => {
  for (const path of ['/assets/..%2f..%2fpackage.json', '/assets/../../package.json']) {
    const response = await fetch(`${base}${path}`);
    assert.notEqual(response.status, 200);
    assert.ok(!(await response.text()).includes('better-lyrics-server'));
  }
});
