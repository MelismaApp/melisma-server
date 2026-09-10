import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { backOff, isUnavailable, request } from '../src/http.ts';

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
