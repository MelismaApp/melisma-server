import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { musixmatch } from '../src/providers/musixmatch.ts';
import { pace, request } from '../src/http.ts';

/**
 * The Musixmatch matcher is sent the ISRC when one is known. Checked against the live service: an
 * ISRC it knows wins over the names, and one it does not falls back to them.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the matcher is sent the ISRC, and still the names beside it', async () => {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(new URL(String(input)));
    return new Response(
      JSON.stringify({
        message: {
          header: { status_code: 200 },
          body: { track: { track_id: 1, track_name: 'BOOMPALA', artist_name: 'LE SSERAFIM', track_length: 177 } },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const store = new Store(':memory:');
  const settings = new Settings(store);
  settings.update({ 'secret.musixmatchUserToken': '0123456789abcdef'.repeat(3) + 'abcdef' });
  await musixmatch.fetch(
    { title: 'BOOMPALA', artist: 'LE SSERAFIM', album: '', durationMs: 176_546, isrc: 'USA2P2622176' },
    { config: settings.read(), log: () => {}, unreachable: () => {}, learn: () => {} },
  );
  store.close();

  const matcher = asked.find((url) => url.pathname.endsWith('/matcher.track.get'));
  assert.ok(matcher, 'the matcher was never asked');
  assert.equal(matcher.searchParams.get('track_isrc'), 'USA2P2622176');
  // The names go too: an ISRC Musixmatch does not have falls back to them.
  assert.equal(matcher.searchParams.get('q_track'), 'BOOMPALA');
});

test('a 403 is reported as the address being refused, not as a token problem', async () => {
  globalThis.fetch = (async () =>
    new Response('<html><head><title>403 Forbidden</title></head></html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;

  const store = new Store(':memory:');
  const settings = new Settings(store);
  const refused = /refuses this server's address/;
  try {
    // No token of its own: the anonymous mint is what is turned away.
    const anonymous = await musixmatch.test!({ config: settings.read(), log: () => {}, unreachable: () => {}, learn: () => {} });
    assert.match(anonymous.detail, refused);

    // A pasted token is turned away just the same, and a lookup says so too.
    settings.update({ 'secret.musixmatchUserToken': '0123456789abcdef'.repeat(3) + 'abcdef' });
    const ctx = { config: settings.read(), log: () => {}, unreachable: (detail: string) => reasons.push(detail), learn: () => {} };
    const reasons: string[] = [];
    assert.match((await musixmatch.test!(ctx)).detail, refused);
    await musixmatch.fetch({ title: 'Lemon', artist: 'Kenshi Yonezu', album: '', durationMs: 255_000 }, ctx);
    assert.match(reasons.join(' | '), refused);
  } finally {
    store.close();
  }
});

// ---- through the relay --------------------------------------------------------

const TOKEN = '0123456789abcdef'.repeat(3) + 'abcdef';
const quiet = { log: () => {}, unreachable: () => {}, learn: () => {} };

function recording(status = 200) {
  const asked: { url: URL; headers: Headers }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    return status === 200
      ? Response.json({ message: { header: { status_code: 200 }, body: { track: { track_id: 1, track_name: 'Lemon', artist_name: 'Kenshi Yonezu', track_length: 255 } } } })
      : new Response('forbidden', { status });
  }) as typeof fetch;
  return asked;
}

test('through a relay, every call goes to it with the Access token, and the token goes nowhere else', async () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  const track = { title: 'Lemon', artist: 'Kenshi Yonezu', album: '', durationMs: 255_000 };
  try {
    settings.update({
      // Unpaced, so this file's earlier lookups have not spent the turn.
      'throttle.musixmatchMs': '0',
      'secret.musixmatchUserToken': TOKEN,
      'secret.musixmatchRelayClientId': 'client-id.access',
      'secret.musixmatchRelayClientSecret': 'client-secret',
    });
    const direct = recording();
    await musixmatch.fetch(track, { config: settings.read(), ...quiet });
    assert.ok(direct.length > 0);
    for (const { url, headers } of direct) {
      assert.equal(url.host, 'apic.musixmatch.com');
      assert.equal(headers.get('cf-access-client-secret'), null, 'the token went to Musixmatch');
    }

    settings.update({ 'endpoint.musixmatchRelay': 'https://mxm-relay.test/' });
    const relayed = recording();
    await musixmatch.fetch(track, { config: settings.read(), ...quiet });
    assert.ok(relayed.length > 0);
    for (const { url, headers } of relayed) {
      assert.equal(url.host, 'mxm-relay.test');
      assert.match(url.pathname, /^\/ws\/1\.1\/matcher\.track\.get$/);
      assert.equal(headers.get('cf-access-client-id'), 'client-id.access');
      assert.equal(headers.get('cf-access-client-secret'), 'client-secret');
    }
  } finally {
    pace('mxm-relay.test', 0, 1);
    settings.update({ 'throttle.musixmatchMs': null });
    store.close();
  }
});

test('a relay that is not HTTPS is not used, since the Access token would travel in the clear', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    settings.update({ 'endpoint.musixmatchRelay': 'http://mxm-relay.test' });
    assert.equal(settings.read().musixmatchRelayUrl, '');
  } finally {
    store.close();
  }
});

test('a 403 through the relay is the relay refusing, not Musixmatch', async () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    settings.update({ 'secret.musixmatchUserToken': TOKEN, 'endpoint.musixmatchRelay': 'https://mxm-relay-refusing.test' });
    recording(403);
    assert.match((await musixmatch.test!({ config: settings.read(), ...quiet })).detail, /relay refused/);
  } finally {
    pace('mxm-relay-refusing.test', 0, 1);
    store.close();
  }
});

test('the relay is paced as Musixmatch is, with the same allowance per lookup', async () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  const host = 'mxm-relay-paced.test';
  try {
    recording();
    settings.update({ 'endpoint.musixmatchRelay': `https://${host}`, 'throttle.musixmatchMs': '120000' });
    for (let call = 0; call < 4; call++) {
      assert.equal((await request(`https://${host}/ws/1.1/call-${call}`)).status, 200, `call ${call}`);
    }
    const next = await request(`https://${host}/ws/1.1/next-lookup`);
    assert.equal(next.status, 429);
    assert.match(next.error ?? '', /not due for another/);
  } finally {
    pace(host, 0, 1);
    store.close();
  }
});

test('a pasted token Musixmatch refuses is set aside for a guest one, and the test says so', async () => {
  const PASTED = 'deadbeef'.repeat(6);
  const PASTED_AGAIN = 'cafebabe'.repeat(6);
  const THIRD = 'feedface'.repeat(6);
  const GUEST = 'a1b2c3d4e5f6'.repeat(4) + '0123';
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const token = url.searchParams.get('usertoken');
    asked.push(`${url.pathname.split('/').pop()}:${token ?? ''}`);
    if (url.pathname.endsWith('/token.get')) {
      return Response.json({ message: { header: { status_code: 200 }, body: { user_token: GUEST } } });
    }
    if (token === GUEST) {
      return Response.json({
        message: { header: { status_code: 200 }, body: { track: { track_id: 7, track_name: 'Bohemian Rhapsody', artist_name: 'Queen', track_length: 354 } } },
      });
    }
    return Response.json({ message: { header: { status_code: 401, hint: 'renew' }, body: [] } });
  }) as typeof fetch;

  const store = new Store(':memory:');
  const settings = new Settings(store);
  const warnings: string[] = [];
  const ctx = () => ({
    config: settings.read(),
    log: (level: string, message: string) => { if (level === 'warn') warnings.push(message); },
    unreachable: () => {},
    learn: () => {},
  });
  const track = { title: 'Bohemian Rhapsody', artist: 'Queen', album: '', durationMs: 354_000 };
  try {
    settings.update({ 'throttle.musixmatchMs': '0', 'secret.musixmatchUserToken': PASTED });

    // A lookup tries the pasted token, is refused, mints a guest token and asks again with it.
    await musixmatch.fetch(track, ctx());
    assert.deepEqual(asked, [`matcher.track.get:${PASTED}`, 'token.get:', `matcher.track.get:${GUEST}`]);
    assert.ok(warnings.some((w) => /refused \(401 renew\)/.test(w)), 'a lookup logs why');

    // The refusal is remembered: straight to the guest, whose token is kept.
    asked.length = 0;
    await musixmatch.fetch(track, ctx());
    assert.deepEqual(asked, [`matcher.track.get:${GUEST}`]);

    // A different token pasted since is tried at once, and set aside again when refused.
    settings.update({ 'secret.musixmatchUserToken': PASTED_AGAIN });
    asked.length = 0;
    await musixmatch.fetch(track, ctx());
    assert.deepEqual(asked, [`matcher.track.get:${PASTED_AGAIN}`, `matcher.track.get:${GUEST}`]);

    // The test makes the same fallback, and says both halves.
    settings.update({ 'secret.musixmatchUserToken': THIRD });
    asked.length = 0;
    const report = await musixmatch.test!(ctx());
    assert.equal(report.ok, true);
    assert.match(report.detail, /pasted token was refused/);
    assert.match(report.detail, /paste the whole musixmatchUserToken cookie/);
    assert.match(report.detail, /matched "Bohemian Rhapsody"/);
    assert.deepEqual(asked, [`matcher.track.get:${THIRD}`, `matcher.track.get:${GUEST}`]);
  } finally {
    settings.update({ 'throttle.musixmatchMs': null });
    store.close();
  }
});
