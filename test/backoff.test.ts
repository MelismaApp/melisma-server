import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { backOff, isUnavailable, pace, request } from '../src/http.ts';

/**
 * Declining to ask a host that has just refused.
 *
 * `run` backs off by itself on an HTTP 429, which covers services that say so in the status. Musixmatch
 * does not: it answers **200** and puts the real status in the body, so the transport sees a perfectly
 * good response and only the provider that parsed it knows the token was rate-limited.
 *
 * That gap was doing real damage. A refusal that looks like a response also looks like an answer, and a
 * provider returning null without reporting a failure is recorded as "asked, and this track has nothing
 * here" — settled, and never asked again. A bulk re-lookup of a hundred tracks wrote that against every
 * one of them. Hence a provider being able to say "stop asking", and hence this test: the point is not
 * the saved requests, it is that a short-circuited request reads as *unavailable* rather than as an
 * answer.
 */

let server: Server;
let base: string;
let hits = 0;

before(async () => {
  server = createServer((_request, response) => {
    hits++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    // Exactly Musixmatch's shape: a 200 carrying a refusal.
    response.end(JSON.stringify({ message: { header: { status_code: 401 } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('a backed-off host is not asked again, and reads as unavailable', async () => {
  const first = await request(`${base}/one`);
  assert.equal(first.status, 200, 'the transport sees nothing wrong with a refusal in the body');
  assert.equal(isUnavailable(first), false, 'which is the whole problem');
  const askedOnce = hits;

  backOff(base, 60_000);

  const second = await request(`${base}/two`);
  assert.equal(hits, askedOnce, 'it should not have gone out at all');
  assert.equal(second.status, 429);
  assert.ok(
    isUnavailable(second),
    'and it must read as "could not ask" — otherwise the caller records a settled miss',
  );
  assert.match(second.error ?? '', /backing off/);
});

test('backing off again does not shorten the window', async () => {
  backOff(base, 60_000);
  backOff(base, 1);
  const result = await request(`${base}/three`);
  // Two refusals in a row should not add up to permission to continue.
  assert.equal(result.status, 429);
});

/**
 * A host paced in tens of seconds is skipped, not waited for.
 *
 * Musixmatch wants thirty to sixty seconds between requests. A floor that waits would mean two separate
 * disasters: a phone sitting half a minute on the sixth source when five have already answered, and a run
 * over four hundred tracks taking the slowest source's pace for every one of them — hours, whether or not
 * that source had anything to add. Past a few seconds the request is not made and not waited for; it
 * reports itself unreachable, which the caller already treats as "ask again later".
 */
test('a host paced beyond patience is skipped rather than waited for', async () => {
  // Its own server, and therefore its own host key: the tests above back `base` off for a minute, and
  // borrowing it would measure that instead of the pacing.
  const paced = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolve) => paced.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${(paced.address() as AddressInfo).port}`;

  try {
    const first = await request(`${at}/first`);
    assert.equal(first.status, 200, 'the first request sets the clock');

    pace(new URL(at).host, 120_000);
    const started = Date.now();
    const second = await request(`${at}/second`);
    const took = Date.now() - started;

    assert.ok(took < 500, `it waited ${took}ms instead of giving up at once`);
    assert.equal(second.status, 429);
    assert.ok(isUnavailable(second), 'it must read as "could not ask", not as an answer');
    assert.match(second.error ?? '', /not due for another/);

    // A pace short enough to wait out is still waited out, because that is what politeness is.
    pace(new URL(at).host, 250);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await request(`${at}/third`)).status, 200);
  } finally {
    pace(new URL(at).host, 0);
    paced.close();
  }
});

test('a paced host still allows one whole lookup through', async () => {
  // The regression this exists to stop, and it shipped: Musixmatch takes three requests to answer — mint
  // a token, `matcher.track.get`, then the richsync — all to the same host. With a turn worth one request,
  // the second was always too early and got the synthetic 429, so the source could not return lyrics at
  // all. The pace is between lookups, and a lookup is not one request.
  const paced = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolve) => paced.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${(paced.address() as AddressInfo).port}`;
  const host = new URL(at).host;

  try {
    // The real setting: tens of seconds between lookups, with Musixmatch's allowance.
    pace(host, 45_000, 4);

    const first = await request(`${at}/token`);
    const second = await request(`${at}/matcher`);
    const third = await request(`${at}/richsync`);
    for (const [name, reply] of [['token', first], ['matcher', second], ['richsync', third]] as const) {
      assert.equal(reply.status, 200, `${name} was refused, so no lyrics could ever come back`);
    }

    // The fourth is the retry allowance, and it is meant to be there.
    assert.equal((await request(`${at}/retry`)).status, 200);

    // Past that the turn is spent, and the next lookup waits — which is the whole point of the pace.
    const nextLookup = await request(`${at}/matcher-again`);
    assert.equal(nextLookup.status, 429, 'a second lookup should wait its turn');
    assert.ok(isUnavailable(nextLookup));
    assert.match(nextLookup.error ?? '', /not due for another/);
  } finally {
    pace(host, 0, 1);
    paced.close();
  }
});
