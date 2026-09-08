import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, isLocalAddress, start, type App } from '../src/server.ts';
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

// ---- artwork and tempo ----------------------------------------------------

test('extras come back once a token has reported them', async () => {
  // The reason this table exists: a Spotify token lasts an hour, a cover URL lasts forever.
  const track = { title: 'Held Cover', artist: 'Someone', durationMs: 200_000 };

  const stored = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...track,
      coverUrl: 'https://i.scdn.co/image/cover.jpg',
      artistImageUrl: 'https://i.scdn.co/image/artist.jpg',
      tempo: 87.5,
      source: 'spotify',
    }),
  });
  assert.equal(stored.status, 202);

  const read = await fetch(
    `${base}/v1/extras?title=Held%20Cover&artist=Someone&durationMs=200000`,
  );
  assert.equal(read.status, 200);
  const body = (await read.json()) as Record<string, unknown>;
  assert.equal(body.coverUrl, 'https://i.scdn.co/image/cover.jpg');
  assert.equal(body.artistImageUrl, 'https://i.scdn.co/image/artist.jpg');
  assert.equal(body.tempo, 87.5);
  assert.equal(body.source, 'spotify');
});

test('a later contribution does not blank what an earlier one knew', async () => {
  // Apple has no tempo. If its contribution overwrote rather than merged, pasting an Apple
  // token would silently throw away a tempo a Spotify token had already found.
  const track = { title: 'Merged Extras', artist: 'Someone', durationMs: 210_000 };
  const post = (extra: Record<string, unknown>) =>
    fetch(`${base}/v1/extras`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...track, ...extra }),
    });

  await post({ tempo: 120, source: 'spotify' });
  await post({ coverUrl: 'https://example.com/apple.jpg', source: 'applemusic' });

  const read = await fetch(
    `${base}/v1/extras?title=Merged%20Extras&artist=Someone&durationMs=210000`,
  );
  const body = (await read.json()) as Record<string, unknown>;
  assert.equal(body.tempo, 120, 'the tempo Spotify supplied was lost');
  assert.equal(body.coverUrl, 'https://example.com/apple.jpg');
});

test('contributing extras needs the key even from the local network', async () => {
  // A read is exempt; naming a URL that will be served to other clients as a track's cover
  // art is not.
  const response = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Unauthorised Cover', coverUrl: 'https://example.com/x.jpg' }),
  });
  assert.equal(response.status, 401);
});

test('reading extras does not need the key from the local network', async () => {
  const response = await fetch(`${base}/v1/extras?title=Held%20Cover&artist=Someone`);
  assert.notEqual(response.status, 401);
});

test('the richer fields survive a round trip', async () => {
  // Held even though the app reads none of them yet: the tokens are the scarce thing, not the
  // storage, and `audio-attributes` is the endpoint the public API withdrew — so a cached copy
  // is the only durable one there is.
  const track = { title: 'Full House', artist: 'Someone', durationMs: 240_000 };
  const stored = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...track,
      isrc: 'JPU901800227',
      palette: { bgColor: '1f1f24', textColor1: 'ffffff' },
      analysis: { timeSignature: 4, beats: [{ start: 0.5 }, { start: 1.0 }] },
      metadata: { composerName: 'Someone Else', albumName: 'The Album' },
      source: 'spotify',
    }),
  });
  assert.equal(stored.status, 202);

  const read = await fetch(`${base}/v1/extras?title=Full%20House&artist=Someone&durationMs=240000`);
  const body = (await read.json()) as Record<string, any>;
  assert.equal(body.palette.bgColor, '1f1f24');
  assert.equal(body.analysis.timeSignature, 4);
  assert.equal(body.analysis.beats.length, 2);
  assert.equal(body.metadata.composerName, 'Someone Else');
});

test('an ISRC is identity, so it lands on the cache entry', async () => {
  // Not in the extras payload: the code that needs it is the matcher, and an ISRC turns a fuzzy
  // name match into an exact lookup for every later caller.
  const track = { title: 'Identified', artist: 'Someone', durationMs: 250_000 };
  const stored = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...track, isrc: 'GBAYE0601498' }),
  });
  // Identity alone is accepted, not a 400 — a caller sending only an ISRC did something useful.
  assert.equal(stored.status, 202);
  assert.equal(((await stored.json()) as Record<string, unknown>).stored, 'identity');
});

test('an oversized analysis blob is refused rather than stored', async () => {
  // Spotify's `segments` array is megabytes for a long track. A cache is not an upload target.
  const huge = { beats: Array.from({ length: 40_000 }, (_, i) => ({ start: i / 10 })) };
  const response = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Too Much', artist: 'Someone', analysis: huge }),
  });
  assert.equal(response.status, 400);
});

test('a track nothing has reported is a 404', async () => {
  const read = await fetch(`${base}/v1/extras?title=Never%20Seen&artist=Nobody`);
  assert.equal(read.status, 404);
});

test('only http urls are stored', async () => {
  // Otherwise this is the server being asked to fetch something local on a caller's behalf.
  const response = await fetch(`${base}/v1/extras`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Local File',
      artist: 'Someone',
      coverUrl: 'file:///etc/passwd',
      artistImageUrl: 'data:image/png;base64,AAAA',
    }),
  });
  assert.equal(response.status, 400);
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
