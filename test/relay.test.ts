import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';

// @ts-expect-error plain JavaScript, with no types to import
import relay from '../worker/relay.js';

/**
 * The Musixmatch relay Worker: nothing gets through without a valid Cloudflare Access token, and what
 * gets through can only be one of the server's four calls.
 */

const TEAM = 'https://melisma.cloudflareaccess.com';
const AUD = 'aud-tag-of-the-relay-app';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

let teamKey: CryptoKeyPair;
let strangerKey: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
/** Access publishes the current and the next key; the token says which signed it. */
let decoy: JsonWebKey & { kid: string };
let upstream: string[] = [];
let sentHeaders: Headers[] = [];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const RSA = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

before(async () => {
  teamKey = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  strangerKey = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey('jwk', teamKey.publicKey)), kid: 'team-key' };
  decoy = { ...(await crypto.subtle.exportKey('jwk', strangerKey.publicKey)), kid: 'next-key' };
});

function stub() {
  upstream = [];
  sentHeaders = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [decoy, jwk] });
    upstream.push(url);
    sentHeaders.push(new Headers(init?.headers));
    return Response.json({ message: { header: { status_code: 200 } } });
  }) as typeof fetch;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

async function accessToken(claims: Record<string, unknown> = {}, key = teamKey.privateKey, kid = 'team-key') {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid })));
  const body = b64url(
    new TextEncoder().encode(
      JSON.stringify({ aud: [AUD], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 300, ...claims }),
    ),
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

function ask(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return new Request(`https://mxm-relay.asu.tw${path}`, { ...init, headers });
}

const MINT = '/ws/1.1/token.get?format=json&app_id=android-player-v1.0';

test('a valid Access token gets the call relayed, with its query and nothing else of the request', async () => {
  stub();
  const response = await relay.fetch(
    ask(MINT, await accessToken(), { headers: { Cookie: 'session=1', 'CF-Access-Client-Secret': 'secret' } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { message: { header: { status_code: number } } }).message.header.status_code, 200);
  assert.deepEqual(upstream, [`https://apic.musixmatch.com${MINT}`]);
  assert.equal(sentHeaders[0]!.get('cookie'), null);
  assert.equal(sentHeaders[0]!.get('cf-access-client-secret'), null);
});

test('with no Access settings, everything is refused', async () => {
  stub();
  for (const settings of [{}, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }]) {
    assert.equal((await relay.fetch(ask(MINT, await accessToken()), settings)).status, 403);
  }
  assert.deepEqual(upstream, []);
});

test('a missing, forged, misaddressed or expired token is refused', async () => {
  stub();
  const now = Math.floor(Date.now() / 1000);
  const refused = [
    undefined,
    'not.a.token',
    await accessToken({}, strangerKey.privateKey),
    await accessToken({}, strangerKey.privateKey, 'stranger-key'),
    await accessToken({ aud: ['another-app'] }),
    await accessToken({ iss: 'https://someone-else.cloudflareaccess.com' }),
    await accessToken({ exp: now - 1 }),
    await accessToken({ nbf: now + 600 }),
  ];
  for (const [index, token] of refused.entries()) {
    assert.equal((await relay.fetch(ask(MINT, token), env)).status, 403, `token ${index}`);
  }
  assert.deepEqual(upstream, []);
});

test('only the four calls are relayed, and only as GET', async () => {
  stub();
  const token = await accessToken();
  for (const path of ['/ws/1.1/user.get?x=1', '/ws/1.1/../admin', '/other', '/ws/1.1/', '/ws/1.1/token.get/x']) {
    assert.equal((await relay.fetch(ask(path, token), env)).status, 404, path);
  }
  assert.equal((await relay.fetch(ask(MINT, token, { method: 'POST', body: '{}' }), env)).status, 404);
  for (const call of ['matcher.track.get', 'track.richsync.get', 'track.subtitle.get']) {
    assert.equal((await relay.fetch(ask(`/ws/1.1/${call}?format=json`, token), env)).status, 200, call);
  }
  assert.equal(upstream.length, 3);
});
