import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

import { createApp, isLocalAddress, start, type App } from '../src/server.ts';
import { MERGE_VERSION } from '../src/merge.ts';
import { cacheKey } from '../src/match.ts';

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

test('the admin surface is closed without a key, always', async () => {
  // It is the only thing that can read a credential.
  assert.equal((await fetch(`${base}/admin/api/stats`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/config`)).status, 401);
});

test('a lookup from this machine needs no key', async () => {
  // The app is designed to send no authentication, and a lookup cannot read a token — it can
  // only cause a lyric fetch. This is what lets the app work as written.
  assert.equal((await fetch(`${base}/v1/health`)).status, 200);
});

test('a wrong key is rejected even from here', async () => {
  // An explicit credential that does not match is an error, not something to shrug off and
  // fall back to the local allowance.
  const response = await fetch(`${base}/v1/health`, {
    headers: { Authorization: 'Bearer definitely-not-the-key' },
  });
  assert.equal(response.status, 401);
});

test('turning the local allowance off closes lookups too', async () => {
  app.settings.update({ 'server.allowLocalNetwork': '0' });
  try {
    assert.equal((await fetch(`${base}/v1/health`)).status, 401);
    assert.equal((await authed('/v1/health')).status, 200);
  } finally {
    app.settings.update({ 'server.allowLocalNetwork': '1' });
  }
});

test('a forwarded request never counts as local', async () => {
  // The deployment case: behind kamal-proxy or a tunnel, every request arrives from the Docker
  // bridge or loopback. Reading the socket alone would hand the whole internet an exception
  // meant for a phone on the same Wi-Fi.
  for (const headers of [
    { 'X-Forwarded-For': '203.0.113.9' },
    { 'X-Forwarded-For': '10.0.0.5' }, // even a private-looking one: the socket is still a proxy
    { Forwarded: 'for=203.0.113.9;proto=https' },
  ]) {
    const response = await fetch(`${base}/v1/health`, { headers });
    assert.equal(response.status, 401, JSON.stringify(headers));
  }

  // With the key, a forwarded request is fine — that is how the app talks to a deployed server.
  const authorised = await fetch(`${base}/v1/health`, {
    headers: { 'X-Forwarded-For': '203.0.113.9', Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(authorised.status, 200);
});

test('only this machine and the private network count as local', () => {
  for (const address of [
    '127.0.0.1',
    '::1',
    '::ffff:192.168.1.5', // IPv4 over a dual-stack socket
    '10.0.0.7',
    '172.16.4.1',
    '192.168.1.20',
    '169.254.1.1',
    'fd00::1',
  ]) {
    assert.ok(isLocalAddress(address), address);
  }

  for (const address of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '2001:4860::1', '', undefined]) {
    assert.ok(!isLocalAddress(address), String(address));
  }
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

// ---- outages --------------------------------------------------------------

/** Runs a block with one source enabled and pointed at a port nothing is listening on. */
async function withDeadSource<T>(run: () => Promise<T>): Promise<T> {
  app.settings.update({
    'provider.lrclib.enabled': '1',
    'endpoint.lrclib': 'http://127.0.0.1:9',
  });
  try {
    return await run();
  } finally {
    app.settings.update({ 'provider.lrclib.enabled': '0', 'endpoint.lrclib': null });
  }
}

test('an outage is not written down as "this track has no lyrics"', async () => {
  // The distinction the negative cache depends on. A timeout is not an answer, and recording it
  // as one hides the track for the whole negative TTL — two days, for a blip.
  await withDeadSource(async () => {
    const response = await authed(
      '/v1/lyrics?title=During%20An%20Outage&artist=Someone&durationMs=200000',
    );
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.source, 'absent');
    assert.equal(app.store.getEntry(body.key), null);
  });
});

test('an outage does not overwrite a document that was already good', async () => {
  const track = { title: 'Already Cached', artist: 'Someone', durationMs: 200_000 };
  const { cacheKey } = await import('../src/match.ts');
  const key = cacheKey(track);
  const good = {
    kind: 'line',
    lines: [{ role: 'lead', startMs: 1000, endMs: 4000, text: 'kept', syllables: [], oppositeAligned: false, rtl: false }],
    songWriters: [],
    hasRomanization: false,
    hasTranslation: false,
    provenance: { timing: 'lrclib', syllables: [], songWriters: [] },
    candidates: [],
    algorithmVersion: MERGE_VERSION,
  };
  app.store.putEntry({
    key,
    title: track.title,
    artist: track.artist,
    album: '',
    durationMs: track.durationMs,
    spotifyId: null,
    isrc: null,
    merged: JSON.stringify(good),
    mergeVersion: MERGE_VERSION,
  });

  await withDeadSource(async () => {
    // `force=1` is the case that used to destroy the entry: it skips the cache, finds nothing
    // because the source is down, and wrote the empty result over the top.
    const response = await authed(
      `/v1/lyrics?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
        track.artist,
      )}&durationMs=${track.durationMs}&force=1`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.data.lyrics, /kept/);
  });

  const after = app.store.getEntry(key);
  assert.ok(after?.merged?.includes('kept'), 'the good document was overwritten');
});

test('a genuine miss is still cached', async () => {
  // The other half: when a source answers and simply has nothing, remembering that is the whole
  // point of the cache. Verified through the store, since no source here reaches the network.
  const track = { title: 'Genuinely Absent', artist: 'Nobody', durationMs: 190_000 };
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
  const cases = [
    // Markup where lyrics were expected: an error page reaching a permanent archive.
    { format: 'lrc', body: '<!doctype html><html>502 Bad Gateway</html>' },
    // A body that does not parse as the format it claims.
    { format: 'ttml', body: '[00:01.00]this is LRC, not TTML' },
    { format: 'json', body: '{"lines":[]}' },
    { format: 'lrc', body: '   \n  ' },
  ];
  for (const { format, body } of cases) {
    const response = await authed('/v1/contribute', {
      method: 'POST',
      body: JSON.stringify({
        track: { title: `Junk ${format} ${body.length}`, artist: 'X', durationMs: 1000 },
        provider: 'lrclib',
        format,
        body,
      }),
    });
    assert.equal(response.status, 400, `${format}: ${body.slice(0, 30)}`);
  }
});

test('a contribution is validated with the reader that will re-merge it', async () => {
  // The failure this rules out: a 200 for something the archive then quietly never uses. Every
  // accepted format has to come back out of `remerge`.
  const formats = [
    { format: 'lrc', body: '[00:01.00]<00:01.00>one <00:02.00>two\n[00:05.00]three\n[00:09.00]four' },
    {
      format: 'ttml',
      body:
        '<tt itunes:timing="Word"><body><div>' +
        '<p begin="1.0" end="3.0" itunes:key="L1"><span begin="1.0" end="3.0">alpha</span></p>' +
        '<p begin="4.0" end="6.0" itunes:key="L2"><span begin="4.0" end="6.0">beta</span></p>' +
        '<p begin="7.0" end="9.0" itunes:key="L3"><span begin="7.0" end="9.0">gamma</span></p>' +
        '</div></body></tt>',
    },
    {
      format: 'json',
      body: JSON.stringify({
        kind: 'line',
        lines: [
          { text: 'one', startMs: 1000, endMs: 4000 },
          { text: 'two', startMs: 4000, endMs: 8000 },
          { text: 'three', startMs: 8000, endMs: 12_000 },
        ],
      }),
    },
    // Unsynced text is a real answer, and still useful: it aligns other sources.
    { format: 'lrc', body: 'plain one\nplain two\nplain three' },
  ];

  for (const { format, body } of formats) {
    const track = { title: `Contributed ${format}`, artist: 'Someone', durationMs: 210_000 };
    const response = await authed('/v1/contribute', {
      method: 'POST',
      body: JSON.stringify({ track, provider: 'lrclib', format, body }),
    });
    assert.equal(response.status, 200, format);
    const result = await response.json();
    assert.equal(result.merged, true, `${format} was accepted but never merged`);
  }
});

test('a contribution needs the key even from the local network', async () => {
  // It writes to the archive permanently. Reading lyrics is what the local exception is for.
  const response = await fetch(`${base}/v1/contribute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      track: { title: 'Unauthorised', artist: 'X', durationMs: 1000 },
      provider: 'lrclib',
      format: 'lrc',
      body: '[00:01.00]nope',
    }),
  });
  assert.equal(response.status, 401);
  assert.equal(app.store.getRaw('q:unauthorised|x|0').length, 0);
});

// ---- status ----------------------------------------------------------------

test('the status route reports every source without leaking a credential', async () => {
  // What the app's developer menu asks. Pointing the app at a server puts every source failure out
  // of its reach, so the server has to answer the same question about itself: off, needs a token,
  // token expired, or working.
  //
  // try/finally rather than a tidy-up at the end: a failed assertion that leaves a secret behind
  // breaks whichever test runs next, which is a worse bug than the one being investigated.
  app.settings.update({ 'secret.appleBearerToken': 'super-secret-jwt-value' });
  app.settings.update({ 'provider.apple.enabled': '1' });
  try {
    const response = await fetch(`${base}/v1/status`, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      sources: Array<{ id: string; name: string; ok: boolean; detail: string }>;
      cache: Record<string, number>;
    };

    const byId = new Map(body.sources.map((source) => [source.id, source]));
    assert.equal(byId.size, 6, 'every source should be reported, including ones that cannot run');
    // Disabled in this suite's setup, and that is a different thing from missing a token.
    assert.match(byId.get('lrclib')!.detail, /off on the server/i);
    // Enabled but with only one of the two tokens Apple needs.
    assert.match(byId.get('apple')!.detail, /needs|token/i);
    assert.equal(typeof body.cache.entries, 'number');

    // The whole payload, not only the detail strings: a token must never travel to the app.
    assert.ok(
      !JSON.stringify(body).includes('super-secret-jwt-value'),
      'a credential value reached the status response',
    );
  } finally {
    app.settings.update({ 'secret.appleBearerToken': '' });
    app.settings.update({ 'provider.apple.enabled': '0' });
  }
});

test('status does not need the key from the local network', async () => {
  // Same footing as a lookup: it reads, and it is what the app calls to explain itself.
  const response = await fetch(`${base}/v1/status`);
  assert.notEqual(response.status, 401);
});

// ---- artwork and tempo ----------------------------------------------------
//
// Read-only over HTTP. The server collects these itself while it is already looking a track up,
// so these exercise the store directly and then check that the route serves what it holds.

test('extras the server harvested are served', async () => {
  const track = { title: 'Held Cover', artist: 'Someone', album: '', durationMs: 200_000 };
  app.store.saveExtras({
    // Derived rather than written out: the key format is the matcher's business, and a test that
    // hard-codes it tests the wrong thing.
    key: cacheKey(track),
    title: track.title,
    artist: track.artist,
    coverUrl: 'https://i.scdn.co/image/cover.jpg',
    artistImageUrl: 'https://i.scdn.co/image/artist.jpg',
    tempo: 87.5,
    isrc: null,
    durationMs: null,
    palette: { bgColor: '1f1f24', spotifyBackground: '#1f1f24' },
    analysis: { timeSignature: 4, beats: [{ start: 0.5 }, { start: 1.0 }] },
    metadata: { composerName: 'Someone Else', albumName: 'The Album' },
    source: 'spotify',
  });

  const read = await fetch(
    `${base}/v1/extras?title=Held%20Cover&artist=Someone&durationMs=200000`,
  );
  assert.equal(read.status, 200);
  const body = (await read.json()) as Record<string, any>;
  assert.equal(body.coverUrl, 'https://i.scdn.co/image/cover.jpg');
  assert.equal(body.tempo, 87.5);
  assert.equal(body.palette.bgColor, '1f1f24');
  assert.equal(body.analysis.beats.length, 2);
  assert.equal(body.metadata.composerName, 'Someone Else');
});

test('a second source fills gaps without blanking the first', async () => {
  // Apple has no tempo and Spotify has no songwriter. If the merge overwrote rather than filled
  // in, whichever ran second would silently throw away what the other knew.
  const key = cacheKey({ title: 'Merged Extras', artist: 'Someone', album: '', durationMs: 210_000 });
  const common = { key, title: 'Merged Extras', artist: 'Someone' };
  app.store.saveExtras({
    ...common,
    coverUrl: null,
    artistImageUrl: null,
    tempo: 120,
    isrc: null,
    durationMs: null,
    palette: null,
    analysis: { key: 5 },
    metadata: null,
    source: 'spotify',
  });
  app.store.saveExtras({
    ...common,
    coverUrl: 'https://example.com/apple.jpg',
    artistImageUrl: null,
    tempo: null,
    isrc: null,
    durationMs: null,
    palette: { bgColor: 'abcdef' },
    analysis: null,
    metadata: { composerName: 'A Writer' },
    source: 'applemusic',
  });

  const held = app.store.extras(key);
  assert.equal(held?.tempo, 120, 'the tempo Spotify supplied was lost');
  assert.equal(held?.coverUrl, 'https://example.com/apple.jpg');
  assert.equal(held?.metadata?.composerName, 'A Writer');
  assert.equal((held?.analysis as Record<string, unknown>)?.key, 5);
});

test('an ISRC is identity, so it lands on the cache entry', () => {
  // Not in the extras: the code that needs it is the matcher, and an ISRC turns a fuzzy name
  // match into an exact lookup for every later caller.
  const track = { title: 'Identified', artist: 'Someone', album: '', durationMs: 250_000 };
  const key = cacheKey(track);
  app.store.putEntry({
    key,
    ...track,
    spotifyId: null,
    isrc: null,
    merged: null,
    mergeVersion: MERGE_VERSION,
    updatedAt: Date.now(),
  });
  app.store.noteIdentity(key, { isrc: 'GBAYE0601498', durationMs: 250_000 });
  assert.equal(app.store.isrcFor(key), 'GBAYE0601498');

  // Filled in, never overwritten: the first source to identify a recording is as good as the
  // second, and overwriting invites a worse answer to replace a better one.
  app.store.noteIdentity(key, { isrc: 'ZZZZZZZZZZZZ' });
  assert.equal(app.store.isrcFor(key), 'GBAYE0601498');
});

test('identity learned before the entry exists is not lost', async () => {
  // The ordering trap. `noteIdentity` updates the cache entry, and providers report an ISRC while
  // they are being asked for lyrics — before any entry exists. An UPDATE that matched nothing
  // silently threw away the single most valuable field collected, so it is mirrored onto the
  // extras row, which can be created from nothing.
  const key = cacheKey({ title: 'Early ISRC', artist: 'Someone', album: '', durationMs: 190_000 });
  assert.equal(app.store.getEntry(key), null, 'precondition: no entry yet');

  app.store.noteIdentity(key, { isrc: 'GBUM71029604', durationMs: 190_000 });
  assert.equal(app.store.isrcFor(key), 'GBUM71029604');

  const read = await fetch(
    `${base}/v1/extras?title=Early%20ISRC&artist=Someone&durationMs=190000`,
  );
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as Record<string, unknown>).isrc, 'GBUM71029604');
});

test('a track nothing has been harvested for is a 404', async () => {
  const read = await fetch(`${base}/v1/extras?title=Never%20Seen&artist=Nobody`);
  assert.equal(read.status, 404);
});

test('there is no way for a client to write extras', async () => {
  // The server harvests its own. An endpoint nothing needs is surface nobody should have.
  const response = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Nope', coverUrl: 'https://example.com/x.jpg' }),
  });
  assert.equal(response.status, 404);
});

test('reading extras does not need the key from the local network', async () => {
  const response = await fetch(`${base}/v1/extras?title=Held%20Cover&artist=Someone`);
  assert.notEqual(response.status, 401);
});

// ---- the shape the app expects --------------------------------------------

test('a found track comes back as TTML in an envelope, with the credit', async () => {
  // Exactly the request the app makes: no Authorization header, no format parameter.
  const track = { title: 'Enveloped', artist: 'Someone', durationMs: 240_000 };
  const { cacheKey } = await import('../src/match.ts');
  const key = cacheKey(track);

  app.store.putRaw({
    key,
    provider: 'app:amll',
    body:
      '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word"><body><div>' +
      '<p begin="1.0" end="3.0" itunes:key="L1"><span begin="1.0" end="2.0">one</span>' +
      '<span begin="2.0" end="3.0"> two</span>' +
      '<span ttm:role="x-roman">wan tsu</span></p>' +
      '<p begin="4.0" end="6.0" itunes:key="L2"><span begin="4.0" end="6.0">three</span></p>' +
      '<p begin="7.0" end="9.0" itunes:key="L3"><span begin="7.0" end="9.0">four</span></p>' +
      '</div></body></tt>',
    contentType: 'application/ttml+xml',
    ok: true,
    note: 'timed by somebody',
  });
  app.store.putEntry({
    key,
    title: track.title,
    artist: track.artist,
    album: '',
    durationMs: track.durationMs,
    spotifyId: null,
    isrc: null,
    merged: null,
    mergeVersion: 0, // forces a re-merge from the archive on the next lookup
  });

  const response = await fetch(
    `${base}/v1/lyrics?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
      track.artist,
    )}&durationMs=${track.durationMs}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.status, 200);
  assert.equal(body.data.format, 'ttml');
  assert.ok(body.data.lyrics.startsWith('<?xml') || body.data.lyrics.startsWith('<tt'));
  assert.match(body.data.lyrics, /itunes:timing="Word"/);
  assert.match(body.data.lyrics, /ttm:role="x-roman"/);
  // The attribution has to survive the hop, or every track claims to come from a cache.
  assert.match(body.data.providerName, /AMLL TTML Database \(via the app\)/);
  assert.match(body.data.providerName, /timed by somebody/);
  assert.equal(response.headers.get('x-cache'), 'remerge');
});

test('format=json gives the structured document instead', async () => {
  const body = await (
    await authed('/v1/lyrics?title=Enveloped&artist=Someone&durationMs=240000&format=json')
  ).json();
  assert.equal(body.document.kind, 'syllable');
  assert.equal(body.document.lines[0].romanized, 'wan tsu');
});

test('format=ttml gives the bare file', async () => {
  const response = await authed(
    '/v1/lyrics?title=Enveloped&artist=Someone&durationMs=240000&format=ttml',
  );
  assert.match(response.headers.get('content-type') ?? '', /ttml/);
  assert.match(await response.text(), /^<\?xml/);
});

// ---- the library ----------------------------------------------------------

test('the library lists a song with everything held about it', async () => {
  const key = 'sp:libraryTest';
  app.store.putEntry({
    key,
    title: 'Library Test',
    artist: 'Someone',
    album: 'An Album',
    durationMs: 240_000,
    spotifyId: 'libraryTest',
    isrc: null,
    merged: JSON.stringify({
      kind: 'syllable',
      hasTranslation: true,
      hasRomanization: true,
      provenance: { timing: 'amll', syllables: ['musixmatch'] },
      lines: [
        { role: 'lead', text: 'one', syllables: [{ text: 'one', startMs: 1, endMs: 2 }] },
        { role: 'lead', text: 'two', syllables: [] },
      ],
    }),
    mergeVersion: MERGE_VERSION,
  });
  app.store.putRaw({
    key,
    provider: 'amll',
    body: '<tt/>',
    contentType: 'application/ttml+xml',
    ok: true,
    note: null,
  });
  app.store.saveExtras({
    key,
    title: 'Library Test',
    artist: 'Someone',
    coverUrl: 'https://example.invalid/cover.jpg',
    artistImageUrl: null,
    tempo: 120,
    isrc: null,
    durationMs: 240_000,
    palette: { bgColor: '#101010' },
    analysis: null,
    metadata: { albumName: 'An Album' },
    source: 'spotify',
  });

  const body = await (await authed('/admin/api/library?search=Library%20Test')).json();
  const row = body.rows.find((r: { key: string }) => r.key === key);
  assert.ok(row, 'the song is missing from the library');

  // The point of the view: what is held, per song, without opening it.
  assert.equal(row.kind, 'syllable');
  assert.equal(row.lines, 2);
  assert.equal(row.syllableLines, 1);
  assert.equal(row.timing, 'amll');
  assert.equal(row.hasTranslation, true);
  assert.equal(row.hasRomanization, true);
  assert.deepEqual(row.providers, ['amll']);
  assert.deepEqual(row.extrasFields, ['cover', 'tempo', 'palette', 'metadata']);
});

test('everything the harvest collects reaches the library', async () => {
  // The audit this test exists for: the extras row is three JSON blobs precisely so a provider can
  // start reporting something new without a migration, which means a reader with a hard-coded list
  // of fields silently drops whatever was added. Nothing below is named in `toLibraryRow`.
  const key = 'sp:harvestCoverage';
  app.store.saveExtras({
    key,
    title: 'Harvest Coverage',
    artist: 'Everyone',
    coverUrl: 'https://example.invalid/{w}x{h}.jpg',
    artistImageUrl: 'https://example.invalid/artist.jpg',
    tempo: 87.6,
    isrc: 'JPU901800227',
    durationMs: 255_000,
    palette: { bgColor: '#1b2a3a', textColor1: '#e8eaf0' },
    // The real shape: Spotify's audio analysis, nested under `track`, in snake_case.
    analysis: {
      track: { key: 9, mode: 0, time_signature: 4, loudness: -6.2, duration: 255.1 },
      beats: [1, 2, 3, 4],
      bars: [1, 2],
      sections: [1],
    },
    metadata: {
      albumName: 'Lemon',
      albumType: 'single',
      albumTotalTracks: 1,
      albumSpotifyId: 'albumId',
      releaseDate: '2018-03-14',
      releaseDatePrecision: 'day',
      trackNumber: 1,
      discNumber: 1,
      explicit: false,
      popularity: 82,
      artistNames: ['米津玄師'],
      artistSpotifyIds: ['artistId'],
      spotifyId: 'spotifyTrackId',
      spotifyUrl: 'https://open.spotify.com/track/x',
      composerName: 'Kenshi Yonezu',
      genreNames: ['J-Pop'],
      contentRating: 'clean',
      hasLyrics: true,
      hasTimeSyncedLyrics: true,
      isAppleDigitalMaster: true,
      audioTraits: ['lossless'],
      appleMusicId: '1537460612',
      appleMusicUrl: 'https://music.apple.com/x',
      neteaseId: 536_622_304,
      neteaseAlbumId: 1,
      publishTime: 1_521_000_000_000,
      musixmatchTrackId: 99,
      musixmatchCommontrackId: 12,
      hasRichsync: true,
      lrclibId: 7,
      instrumental: false,
    },
    source: 'spotify+apple',
  });

  const body = await (await authed('/admin/api/library?search=Harvest%20Coverage')).json();
  const row = body.rows.find((r: { key: string }) => r.key === key);
  assert.ok(row, 'the song is missing from the library');

  // Identity, gathered by shape rather than by name — so an id added later appears on its own.
  for (const [name, value] of [
    ['isrc', 'JPU901800227'],
    ['apple', '1537460612'],
    ['netease', '536622304'],
    ['musixmatch track', '99'],
    ['lrclib', '7'],
  ]) {
    assert.equal(row.ids[name], value, `id "${name}" did not reach the library`);
  }

  // Identity written to the extras row before an entry existed still counts.
  assert.equal(row.isrc, 'JPU901800227');
  assert.equal(row.durationMs, 255_000);

  // The grids are the part that cannot be re-fetched, so the row names them rather than folding
  // them into a generic "analysis".
  const analysisField = row.extrasFields.find((f: string) => f.startsWith('analysis'));
  assert.match(analysisField, /beats/);
  assert.match(analysisField, /bars/);
  assert.match(analysisField, /sections/);

  for (const field of ['cover', 'artist image', 'tempo', 'palette', 'metadata']) {
    assert.ok(row.extrasFields.includes(field), `${field} did not reach the library`);
  }
  assert.ok(row.createdAt > 0, 'first-seen was lost');

  // And searching by an id finds it, which is how you arrive here from a log line.
  for (const term of ['JPU901800227', '1537460612', '536622304']) {
    const found = await (
      await authed(`/admin/api/library?search=${encodeURIComponent(term)}`)
    ).json();
    assert.ok(
      found.rows.some((r: { key: string }) => r.key === key),
      `searching for ${term} did not find the track`,
    );
  }
});

test('the identity map reads ids by shape, so a new one needs no code change', async () => {
  const { identityFrom } = await import('../src/db.ts');
  const ids = identityFrom({
    // None of these are named anywhere in the implementation.
    deezerId: 12345,
    tidalTrackId: 'abc',
    someFutureServiceIds: ['x', 'y'],
    albumName: 'not an id',
    hasLyrics: true,
  });
  assert.equal(ids.deezer, '12345');
  assert.equal(ids['tidal track'], 'abc');
  assert.equal(ids['some future service'], 'x, y');
  assert.ok(!('album name' in ids), 'a non-id field was treated as identity');
});

test('the library can list what has no ISRC, and what has no analysis', async () => {
  for (const missing of ['isrc', 'analysis']) {
    const body = await (await authed(`/admin/api/library?missing=${missing}`)).json();
    const keys = body.rows.map((r: { key: string }) => r.key);
    // The fully-populated song above has both, so it must not appear in either list.
    assert.ok(!keys.includes('sp:harvestCoverage'), `missing=${missing} matched a populated track`);
  }
});

test('forgetting the lyrics keeps what cannot be fetched again', async () => {
  const key = 'sp:deleteScope';
  app.store.putEntry({
    key,
    title: 'Delete Scope',
    artist: 'Someone',
    album: '',
    durationMs: 200_000,
    spotifyId: null,
    isrc: null,
    merged: JSON.stringify({ kind: 'line', lines: [{ text: 'a' }], provenance: { timing: 'x' } }),
    mergeVersion: MERGE_VERSION,
  });
  app.store.putRaw({ key, provider: 'lrclib', body: '{}', contentType: 'application/json', ok: true, note: null });
  app.store.saveExtras({
    key,
    title: 'Delete Scope',
    artist: 'Someone',
    coverUrl: 'https://example.invalid/c.jpg',
    artistImageUrl: null,
    tempo: 100,
    isrc: null,
    durationMs: 200_000,
    palette: null,
    analysis: { beats: [1, 2, 3] },
    metadata: null,
    source: 'spotify',
  });

  await authed(`/admin/api/entry?key=${encodeURIComponent(key)}`, { method: 'DELETE' });

  // The lyrics and the archive go, so the next lookup is fresh.
  assert.equal(app.store.getEntry(key), null);
  assert.equal(app.store.getRaw(key).length, 0);
  // The analysis stays: Spotify withdrew that endpoint, so this is the only copy there will be.
  assert.ok(app.store.extras(key), 'the extras were destroyed by a lyrics-only delete');
});

test('forgetting everything leaves nothing in the library', async () => {
  // The bug the library exposed: deleting a song left its extras row behind, and the union brought
  // it back as a track that had never been fetched.
  const key = 'sp:deleteScope';
  await authed(`/admin/api/entry?key=${encodeURIComponent(key)}&everything=1`, {
    method: 'DELETE',
  });
  assert.equal(app.store.extras(key), null);

  const body = await (await authed('/admin/api/library?search=Delete%20Scope')).json();
  assert.equal(
    body.rows.filter((r: { key: string }) => r.key === key).length,
    0,
    'a deleted song came back through the extras table',
  );
});

test('the archive says whether each response actually succeeded', async () => {
  const key = 'sp:harvestCoverage';
  app.store.putRaw({
    key,
    provider: 'netease',
    body: '{}',
    contentType: 'application/json',
    ok: false,
    note: 'region blocked',
  });
  const detail = await (await authed(`/admin/api/entry?key=${encodeURIComponent(key)}`)).json();
  const row = detail.raw.find((r: { provider: string }) => r.provider === 'netease');
  // Stored on every row since the archive existed, and invisible until now: a failed response
  // looked exactly like a good one.
  assert.equal(row.ok, false);
  assert.equal(row.note, 'region blocked');
});

test('the library searches the words, not only the titles', async () => {
  const titled = await (await authed('/admin/api/library?search=one')).json();
  const inWords = await (await authed('/admin/api/library?search=one&inLyrics=1')).json();
  // "one" is a lyric in the song above and in no title, so the difference is the feature.
  assert.ok(
    inWords.total > titled.total,
    `searching the words found ${inWords.total}, titles alone found ${titled.total}`,
  );
});

test('the library can show only what is missing', async () => {
  const key = 'q:nolyrics|nobody|95';
  app.store.putEntry({
    key,
    title: 'No Lyrics At All',
    artist: 'Nobody',
    album: '',
    durationMs: 190_000,
    spotifyId: null,
    isrc: null,
    merged: null,
    mergeVersion: MERGE_VERSION,
  });

  const missing = await (await authed('/admin/api/library?missing=lyrics')).json();
  const keys = missing.rows.map((r: { key: string }) => r.key);
  assert.ok(keys.includes(key));
  // And the one with lyrics is not in it.
  assert.ok(!keys.includes('sp:libraryTest'));
});

test('a song with artwork and no lyrics is still in the library, and still opens', async () => {
  // The old view joined from the lyrics table, so these were invisible — which is exactly the
  // set worth knowing about.
  const key = 'q:artonly|aay|90';
  app.store.saveExtras({
    key,
    title: 'Artwork Only',
    artist: 'Aay',
    coverUrl: 'https://example.invalid/d.jpg',
    artistImageUrl: null,
    tempo: 96,
    isrc: null,
    durationMs: 180_000,
    palette: null,
    analysis: null,
    metadata: null,
    source: 'apple',
  });

  const body = await (await authed('/admin/api/library?search=Artwork')).json();
  const row = body.rows.find((r: { key: string }) => r.key === key);
  assert.ok(row, 'a song known only by its artwork was not listed');
  assert.equal(row.hasLyrics, false);
  assert.equal(row.title, 'Artwork Only');

  const detail = await (await authed(`/admin/api/entry?key=${encodeURIComponent(key)}`)).json();
  assert.equal(detail.entry, null);
  assert.equal(detail.extras.title, 'Artwork Only');
});

test('the library pages, and reports how many there are in total', async () => {
  const first = await (await authed('/admin/api/library?limit=1&offset=0')).json();
  const second = await (await authed('/admin/api/library?limit=1&offset=1')).json();
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  assert.notEqual(first.rows[0].key, second.rows[0].key);
  assert.ok(first.total > 1);
  assert.equal(first.total, second.total);
});

// ---- keeping the tokens alive ---------------------------------------------

test('with no cookie there is nothing to refresh, and it says why', async () => {
  const status = await (await authed('/admin/api/refresh')).json();
  assert.equal(status.configured, false);
  assert.equal(status.mechanism, 'none');
  assert.equal(status.command, null);
  assert.ok(status.everyMinutes >= 5);
  // The reason has to name the thing to do about it, and which thing depends on the image.
  assert.match(
    status.reason,
    status.chromium ? /sp_dc cookie/ : /no Chromium/,
    status.reason,
  );
});

test('running with nothing configured is a clear no, not a crash', async () => {
  const result = await (await authed('/admin/api/refresh', { method: 'POST' })).json();
  assert.equal(result.ok, false);
  assert.equal(result.via, 'none');
  assert.ok(result.detail.length > 0);
});

test('a cookie is all the built-in browser harvest needs', async (t) => {
  const { chromiumAvailable } = await import('../src/browser/spotify.ts');
  if (!chromiumAvailable()) {
    t.skip('no Chromium on this machine — the deployed image carries one');
    return;
  }

  app.settings.update({ 'secret.spDcCookie': 'not-a-real-cookie-but-a-value' });
  try {
    const status = await (await authed('/admin/api/refresh')).json();
    // No command, no second container, no configuration beyond the cookie.
    assert.equal(status.mechanism, 'browser');
    assert.equal(status.configured, true);
    assert.equal(status.reason, null);
  } finally {
    app.settings.update({ 'secret.spDcCookie': null });
  }
});

test('an external command overrides the built-in harvest', async () => {
  process.env.BL_TOKEN_REFRESH_COMMAND = 'echo \'{"spotifyWebToken":"BQD_from_the_command"}\'';
  app.settings.update({ 'secret.spDcCookie': 'a-cookie-that-would-have-been-used' });
  try {
    const status = await (await authed('/admin/api/refresh')).json();
    // Somebody who set a command meant it, and it can renew things the harvest knows nothing about.
    assert.equal(status.mechanism, 'command');

    const result = await (await authed('/admin/api/refresh', { method: 'POST' })).json();
    assert.equal(result.ok, true);
    assert.equal(result.via, 'command');
    assert.deepEqual(result.updated, ['spotifyWebToken']);

    const revealed = await (
      await authed('/admin/api/reveal', {
        method: 'POST',
        body: JSON.stringify({ name: 'spotifyWebToken' }),
      })
    ).json();
    assert.equal(revealed.value, 'BQD_from_the_command');
  } finally {
    delete process.env.BL_TOKEN_REFRESH_COMMAND;
    app.settings.update({ 'secret.spDcCookie': null, 'secret.spotifyWebToken': null });
  }
});

test('a refreshed token wins over the value the server booted with', async () => {
  // The documented deployment sets BL_SPOTIFY_WEB_TOKEN as a starting value, and an environment
  // variable normally outranks the stored one. Without dropping it, the refresh reported success
  // while every provider carried on using the token that expired an hour ago.
  process.env.BL_SPOTIFY_WEB_TOKEN = 'the-token-from-boot';
  process.env.BL_TOKEN_REFRESH_COMMAND = 'echo \'{"spotifyWebToken":"the-fresh-one"}\'';
  try {
    assert.equal(app.settings.read().secrets.spotifyWebToken, 'the-token-from-boot');

    const result = await (await authed('/admin/api/refresh', { method: 'POST' })).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.updated, ['spotifyWebToken']);

    // What the providers will actually send.
    assert.equal(app.settings.read().secrets.spotifyWebToken, 'the-fresh-one');
  } finally {
    delete process.env.BL_SPOTIFY_WEB_TOKEN;
    delete process.env.BL_TOKEN_REFRESH_COMMAND;
    app.settings.update({ 'secret.spotifyWebToken': null });
  }
});

test('the schedule exists before the cookie does', async (t) => {
  const { Refresher } = await import('../src/refresher.ts');
  const refresher = new Refresher(app.store, app.settings);

  // The documented setup is "boot the server, then paste a cookie into the admin page". Returning
  // early on a cookie-less boot meant that flow never scheduled anything: the status said
  // "browser", a manual run worked, and the token quietly expired an hour later.
  assert.equal(refresher.mechanism, 'none');
  refresher.start();

  const { chromiumAvailable } = await import('../src/browser/spotify.ts');
  if (!chromiumAvailable()) {
    refresher.stop();
    t.skip('no Chromium here — the deployed image carries one');
    return;
  }

  app.settings.update({ 'secret.spDcCookie': 'pasted-after-boot' });
  try {
    // Same object, no restart: the next tick now has something to do.
    assert.equal(refresher.mechanism, 'browser');
  } finally {
    refresher.stop();
    app.settings.update({ 'secret.spDcCookie': null });
  }
});

test('a command that returns the same token is reported as a no-op, not a failure', async () => {
  process.env.BL_TOKEN_REFRESH_COMMAND = 'echo \'{"spotifyWebToken":"already-current"}\'';
  app.settings.update({ 'secret.spotifyWebToken': 'already-current' });
  try {
    const result = await (await authed('/admin/api/refresh', { method: 'POST' })).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.updated, []);
    assert.match(result.detail, /already current/);
  } finally {
    delete process.env.BL_TOKEN_REFRESH_COMMAND;
    app.settings.update({ 'secret.spotifyWebToken': null });
  }
});

test('a command that fails is reported with what it printed', async () => {
  process.env.BL_TOKEN_REFRESH_COMMAND = 'echo "the cookie has expired" >&2; exit 3';
  try {
    const result = await (await authed('/admin/api/refresh', { method: 'POST' })).json();
    assert.equal(result.ok, false);
    // The tail of stderr, because that is where a browser script says what went wrong.
    assert.match(result.detail, /cookie has expired/);
  } finally {
    delete process.env.BL_TOKEN_REFRESH_COMMAND;
  }
});

test('the refresh needs the key, even from the local network', async () => {
  // It executes a command on the host. Nothing about that belongs behind the lookup exception.
  assert.equal((await fetch(`${base}/admin/api/refresh`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/refresh`, { method: 'POST' })).status, 401);
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

test('testing a source that reports being unreachable is not a 500', async () => {
  // Reported as "internal error". The route built a context with two of its four members, and
  // `test` reaches code shared with `fetch` — Spotify's token lookup calls `unreachable`. Types are
  // stripped at runtime, so the partial object compiled fine and threw
  // `ctx.unreachable is not a function`.
  //
  // Spotify with a cookie and no token is exactly that path: `isConfigured` passes on the cookie,
  // and the mint behind it has been closed by Spotify since.
  app.settings.update({ 'secret.spDcCookie': 'not-a-real-cookie', 'secret.spotifyWebToken': '' });
  try {
    const response = await authed('/admin/api/test', {
      method: 'POST',
      body: JSON.stringify({ provider: 'spotify' }),
    });
    assert.equal(response.status, 200, 'a failing source is an answer, not a server error');

    const body = await response.json();
    assert.equal(body.ok, false);
    // And it says what went wrong rather than "internal error".
    assert.ok(body.detail && body.detail.length > 0, 'expected a reason');
  } finally {
    app.settings.update({ 'secret.spDcCookie': '', 'secret.spotifyWebToken': '' });
  }
});

test('the source test reports every source, and asks about a real track', async () => {
  const response = await authed('/admin/api/sources', { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();

  // Fixed on purpose, and the duration is the album version's: the remixes run 216 and 261 seconds,
  // and duration is how a provider tells them apart.
  assert.equal(body.track.title, 'Blinding Lights');
  assert.equal(body.track.artist, 'The Weeknd');
  assert.equal(body.track.durationMs, 200_046);
  assert.equal(body.track.spotifyId, '0VjIjW4GlUZAMYd2vXMi3b');

  // Every source appears whether or not it could be asked. A source test that silently omits the
  // ones it skipped is how "why is Apple not answering" stays unanswered.
  const ids = body.sources.map((source: { id: string }) => source.id).sort();
  assert.deepEqual(ids, ['amll', 'apple', 'lrclib', 'musixmatch', 'netease', 'spotify']);

  // All disabled in this harness, so nothing reached the network and every answer says why.
  for (const source of body.sources) {
    assert.equal(source.ok, false);
    assert.equal(source.detail, 'off in settings');
  }
});

test('the source test needs the key', async () => {
  // It causes six outbound lookups, so an unauthenticated caller may not trigger it.
  assert.equal((await fetch(`${base}/admin/api/sources`, { method: 'POST' })).status, 401);
});

test('the log is readable and holds no token values', async () => {
  const body = await (await authed('/admin/api/events')).json();
  assert.ok(Array.isArray(body.events));
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));
});

test('an unknown route is a 404, not a crash', async () => {
  assert.equal((await authed('/v1/nothing-here')).status, 404);
});

/**
 * Sends a request line exactly as given, without a client tidying it up first.
 *
 * `fetch` resolves `..` segments before anything goes out, so a traversal written into a `fetch` URL
 * never reaches the server as a traversal — it arrives already collapsed to a path that was always
 * safe. A test built on it passes whatever the server does, which is how this one passed for a long
 * time while checking nothing. The only way to aim a `..` at the server is to write the bytes.
 */
async function rawGet(path: string): Promise<string> {
  const { port } = server.address() as AddressInfo;
  return await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let seen = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      seen += chunk;
    });
    socket.on('end', () => resolve(seen));
    socket.on('error', reject);
  });
}

test('a path traversal in an asset request gets nothing', async () => {
  // The needle is read out of the file rather than written here. Hardcoded, renaming the package
  // quietly turned this into an assertion that passes on a *full* leak — worse than no test, because
  // it reports safety it is no longer checking.
  const { name } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { name: string };

  for (const path of [
    '/assets/../../package.json',
    '/assets/..%2f..%2fpackage.json',
    '/assets/....//....//package.json',
    '/assets/..\\..\\package.json',
  ]) {
    const raw = await rawGet(path);
    assert.ok(!raw.includes(name), `leaked package.json via ${path}`);
    assert.ok(!raw.startsWith('HTTP/1.1 200'), `served something for ${path}`);
  }
});

// ---- the live stream ------------------------------------------------------

/**
 * Reads the admin stream for a while and returns the re-lookup snapshots it carried.
 *
 * The stream never ends by itself, so it is aborted rather than awaited to completion.
 */
async function relookupSnapshots(
  during: () => void,
  isDone: (snapshots: Array<Record<string, unknown>>) => boolean,
  ms = 10_000,
): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const response = await authed('/admin/api/stream', { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const snapshots: Array<Record<string, unknown>> = [];
  let buffer = '';

  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.kind === 'relookup') snapshots.push(event);
      }
    }
  })().catch(() => undefined);

  during();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !isDone(snapshots)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.abort();
  await pump;
  return snapshots;
}

test('the stream reports a re-lookup ending, not only its running', { timeout: 30_000 }, async () => {
  // The failure this guards against is invisible from the server: the run finishes perfectly well and
  // the page is simply never told, so it sits there showing a live job, its start buttons disabled,
  // until somebody reloads. Keying the "has this changed" test on the start time alone does exactly
  // that, because while the run goes that value is already the one on record.
  const before = app.settings.read().relookupPauseMs;
  // Long enough that the run spans a tick or two of the once-a-second stream: a run that begins and
  // ends between ticks would be reported by the broken version too, and prove nothing.
  app.settings.update({ 'cache.relookupPauseMs': '700' });
  try {
    const keys = ['q:stream-one|nobody|100', 'q:stream-two|nobody|100', 'q:stream-three|nobody|100'];
    const snapshots = await relookupSnapshots(
      () => void app.resolver.relookup(keys).catch(() => undefined),
      (seen) => seen.some((s) => s.running === true) && seen.some((s) => s.running === false && s.startedAt),
    );

    assert.ok(
      snapshots.some((s) => s.running === true),
      'the stream should carry the run while it is going',
    );
    const final = snapshots.filter((s) => s.running === false && s.startedAt).at(-1);
    assert.ok(final, 'and it must say when the run ended, or the page can never re-enable itself');
    // Unknown keys, so every one is skipped — the point here is the reporting, not the lookups.
    assert.equal(final.skipped, 3);
    assert.equal(final.cancelled, false);
  } finally {
    app.settings.update({ 'cache.relookupPauseMs': String(before) });
  }
});

test('/v1/extras names the album UPC beside the ISRC', async () => {
  const key = cacheKey({ title: 'Has A Barcode', artist: 'Someone', album: '', durationMs: 200_000 });
  app.store.saveExtras({ key, metadata: { albumUpc: '00602557382457' }, source: 'spotify' });
  const read = await fetch(`${base}/v1/extras?title=Has%20A%20Barcode&artist=Someone&durationMs=200000`);
  assert.equal(((await read.json()) as Record<string, unknown>).upc, '00602557382457');
});

test('a lookup hands the sources the album UPC it knows', () => {
  // So the Apple source can take the song on the release being played, not the first of several.
  const key = cacheKey({ title: 'Known Release', artist: 'Someone', album: '', durationMs: 200_000 });
  app.store.saveExtras({ key, metadata: { albumUpc: '602557382457' }, source: 'spotify' });
  const resolver = app.resolver as unknown as {
    withKnownIdentity(key: string, track: unknown): { upc?: string };
  };
  const track = { title: 'Known Release', artist: 'Someone', album: '', durationMs: 200_000 };
  assert.equal(resolver.withKnownIdentity(key, track).upc, '602557382457');
});
