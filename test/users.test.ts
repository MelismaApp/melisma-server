import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, type App } from '../src/server.ts';
import { MERGE_VERSION } from '../src/merge.ts';
import { cacheKey } from '../src/match.ts';

/**
 * User keys: a key per person or device beside the admin key, each seeing only the tracks they asked
 * for, and reaching nothing that holds a credential or spends the server's tokens.
 */

let app: App;
let server: ReturnType<typeof start>;
let base: string;
let adminKey: string;

before(async () => {
  app = createApp(':memory:');
  adminKey = app.settings.read().apiKey;
  // Every source off, so a lookup answers from the cache or not at all, and never reaches the network.
  for (const id of ['apple', 'amll', 'netease', 'musixmatch', 'spotify', 'lrclib']) {
    app.settings.update({ [`provider.${id}.enabled`]: '0' });
  }
  // The deployed setting: nothing gets in without a key.
  app.settings.update({ 'server.allowLocalNetwork': '0' });
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

const withKey = (key: string, path: string, options: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
  });

async function addUser(name: string): Promise<{ id: number; key: string }> {
  const response = await withKey(adminKey, '/admin/api/users', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user: { id: number }; key: string };
  return { id: body.user.id, key: body.key };
}

/** A cached "nothing found", so a lookup answers from the cache without asking anybody. */
function cached(title: string) {
  const track = { title, artist: 'Someone', album: '', durationMs: 200_000 };
  app.store.putEntry({
    key: cacheKey(track),
    title,
    artist: 'Someone',
    album: '',
    durationMs: 200_000,
    spotifyId: null,
    isrc: null,
    merged: null,
    mergeVersion: MERGE_VERSION,
  });
  return {
    key: cacheKey(track),
    path: `/v1/lyrics?title=${encodeURIComponent(title)}&artist=Someone&durationMs=200000`,
  };
}

async function libraryKeys(key: string, query = ''): Promise<string[]> {
  const response = await withKey(key, `/admin/api/library?limit=500${query}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { rows: { key: string }[] }).rows.map((row) => row.key);
}

async function login(key: string): Promise<string> {
  const response = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  assert.equal(response.status, 200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
}

// ---- keys -----------------------------------------------------------------

test('a new key is shown once and only a hash of it is kept', async () => {
  const { key } = await addUser('Pixel');
  assert.match(key, /^[0-9a-f]{48}$/);

  const listed = await (await withKey(adminKey, '/admin/api/users')).json();
  const text = JSON.stringify(listed);
  assert.ok(!text.includes(key), 'the key came back in the list');
  assert.ok(text.includes(key.slice(-4)), 'no hint to tell the keys apart');

  const internals = app.store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
  assert.ok(!JSON.stringify(internals.db.prepare('SELECT * FROM users').all()).includes(key));
});

test('the admin key still works for lookups, as the app uses it', async () => {
  const track = cached('Admin Song');
  assert.equal((await withKey(adminKey, track.path)).status, 404);
  assert.ok(app.store.hasAsked(0, track.key), 'the admin key lookup was not recorded');
});

test('a user key looks lyrics up, and the lookup is theirs', async () => {
  const { id, key } = await addUser('Laptop');
  const track = cached('Their Song');
  assert.equal((await withKey(key, track.path)).status, 404);
  assert.ok(app.store.hasAsked(id, track.key));
  assert.ok(!app.store.hasAsked(0, track.key), 'recorded against the admin as well');
});

test('a user key reaches nothing that holds a credential or changes the cache', async () => {
  const { key } = await addUser('Tablet');
  const closed: Array<[string, string]> = [
    ['GET', '/admin/api/config'],
    ['POST', '/admin/api/reveal'],
    ['POST', '/admin/api/config'],
    ['GET', '/admin/api/users'],
    ['POST', '/admin/api/users'],
    ['POST', '/admin/api/users/revoke'],
    ['GET', '/admin/api/events'],
    ['GET', '/admin/api/stream'],
    ['POST', '/admin/api/lookup'],
    ['POST', '/admin/api/relookup'],
    ['DELETE', '/admin/api/entry'],
    ['POST', '/admin/api/remerge'],
    ['POST', '/admin/api/test'],
    ['POST', '/admin/api/backfill-isrc'],
    ['POST', '/v1/contribute'],
  ];
  for (const [method, path] of closed) {
    const response = await withKey(key, path, { method, body: method === 'GET' ? undefined : '{}' });
    assert.equal(response.status, 403, `${method} ${path}`);
    await response.body?.cancel();
  }
});

test('a route nobody listed is the admin\'s alone', async () => {
  const { key } = await addUser('Watch');
  const response = await withKey(key, '/admin/api/no-such-route');
  assert.equal(response.status, 403);
  assert.equal((await withKey(adminKey, '/admin/api/no-such-route')).status, 404);
});

// ---- what each can see ----------------------------------------------------

test('a user sees only the tracks they asked for; the admin sees everything, or anyone\'s', async () => {
  const one = await addUser('Mum');
  const two = await addUser('Dad');
  const mine = cached('Mum Song');
  const theirs = cached('Dad Song');
  await withKey(one.key, mine.path);
  await withKey(two.key, theirs.path);

  assert.deepEqual(await libraryKeys(one.key), [mine.key]);
  // An askedBy for someone else is ignored for a user, not honoured.
  assert.deepEqual(await libraryKeys(one.key, `&askedBy=${two.id}`), [mine.key]);

  const everything = await libraryKeys(adminKey);
  assert.ok(everything.includes(mine.key) && everything.includes(theirs.key));
  assert.deepEqual(await libraryKeys(adminKey, `&askedBy=${two.id}`), [theirs.key]);
});

test('a user cannot open a track they did not ask for, and learns nothing about it', async () => {
  const one = await addUser('Guest');
  const other = cached('Someone Else\'s');
  await withKey(adminKey, other.path);

  const entry = await withKey(one.key, `/admin/api/entry?key=${encodeURIComponent(other.key)}`);
  assert.equal(entry.status, 404);
  const raw = await withKey(one.key, `/admin/api/raw?key=${encodeURIComponent(other.key)}&provider=x`);
  assert.equal(raw.status, 404);

  const own = cached('Guest Song');
  await withKey(one.key, own.path);
  assert.equal((await withKey(one.key, `/admin/api/entry?key=${encodeURIComponent(own.key)}`)).status, 200);
});

test('a user\'s counters are their own', async () => {
  const one = await addUser('Counter');
  const track = cached('Counted');
  await withKey(one.key, track.path);
  await withKey(one.key, track.path);
  const stats = (await (await withKey(one.key, '/admin/api/stats')).json()) as Record<string, number>;
  assert.equal(stats.tracks, 1);
  assert.equal(stats.hits, 2);
});

test('"recently asked" orders by the last request, and a user\'s by their own', async () => {
  const one = await addUser('Sorter');
  const first = cached('Asked First');
  const second = cached('Asked Second');
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  await withKey(one.key, first.path);
  await pause();
  await withKey(one.key, second.path);
  await pause();
  await withKey(one.key, first.path);
  await pause();
  // Asked again, by somebody else: it moves up for the admin, not for this user.
  await withKey(adminKey, second.path);

  // The last time each was asked, not the first: asked again, a song comes back to the top.
  assert.deepEqual(await libraryKeys(one.key, '&sort=asked'), [first.key, second.key]);
  const everyone = (await libraryKeys(adminKey, '&sort=asked')).filter((key) =>
    [first.key, second.key].includes(key),
  );
  assert.deepEqual(everyone, [second.key, first.key]);
});

// ---- sessions -------------------------------------------------------------

test('a user signs in to the page with their key, and it says who they are', async () => {
  const { key } = await addUser('Sign In');
  const session = await login(key);
  const me = await (await fetch(`${base}/admin/api/me`, { headers: { Cookie: session } })).json();
  assert.deepEqual(me, { role: 'user', name: 'Sign In' });
  assert.equal((await fetch(`${base}/admin/api/config`, { headers: { Cookie: session } })).status, 403);

  const admin = await login(adminKey);
  assert.deepEqual(await (await fetch(`${base}/admin/api/me`, { headers: { Cookie: admin } })).json(), {
    role: 'admin',
  });
});

test('the page\'s own lookups are not recorded as asked for', async () => {
  const { id, key } = await addUser('Browser');
  const session = await login(key);
  const track = cached('Downloaded');
  await fetch(`${base}${track.path}&format=ttml`, { headers: { Cookie: session } });
  assert.ok(!app.store.hasAsked(id, track.key));
});

test('revoking a key ends it and every session made with it', async () => {
  const { id, key } = await addUser('Lost Phone');
  const session = await login(key);
  const track = cached('Before Revoking');
  assert.equal((await withKey(key, track.path)).status, 404);

  const revoke = await withKey(adminKey, '/admin/api/users/revoke', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  assert.equal(revoke.status, 200);

  assert.equal((await withKey(key, track.path)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/library`, { headers: { Cookie: session } })).status, 401);
  const relogin = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  assert.equal(relogin.status, 401);
});

test('the session cookie is Secure when the request came over HTTPS, and not over plain HTTP', async () => {
  const request = (headers: Record<string, string>) =>
    fetch(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ apiKey: adminKey }),
    });

  const tunnelled = (await request({ 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie') ?? '';
  assert.match(tunnelled, /; Secure/);
  assert.match(tunnelled, /HttpOnly/);
  assert.match(tunnelled, /SameSite=Strict/);

  const plain = (await request({})).headers.get('set-cookie') ?? '';
  assert.doesNotMatch(plain, /Secure/);
});

test('a key that is neither the admin\'s nor a user\'s is refused', async () => {
  assert.equal((await withKey('f'.repeat(48), '/v1/health')).status, 401);
  assert.equal((await withKey('', '/v1/health')).status, 401);
});

test('"recently asked" for everyone goes by the last request from anybody', async () => {
  const early = cached('Asked Long Ago');
  const late = cached('Asked Once Since');
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  await withKey(adminKey, early.path);
  await pause();
  await withKey(adminKey, late.path);
  await pause();
  // Asked again: first asked earliest, but asked most recently.
  await withKey(adminKey, early.path);

  const order = (await libraryKeys(adminKey, '&sort=asked')).filter((key) =>
    [early.key, late.key].includes(key),
  );
  assert.deepEqual(order, [early.key, late.key]);
});
