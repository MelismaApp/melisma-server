import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePayload } from '../src/refresher.ts';

/**
 * The output of a browser script is not clean, and cannot be made clean: Playwright prints
 * download progress, Chromium prints warnings to stdout, and a wrapper may print its own log. So
 * the parser has to find the JSON in the noise rather than demand silence — otherwise this fails
 * for a reason nobody can see, at 3am, silently, for an hour at a time.
 */
test('the JSON is found among a browser tool\'s noise', () => {
  const stdout = [
    'Downloading Chromium 131.0 - 140 MiB [====>] 12% 3.4s',
    'some unrelated chatter',
    '{"spotifyWebToken":"BQD_real_token"}',
  ].join('\n');
  assert.deepEqual(parsePayload(stdout), { spotifyWebToken: 'BQD_real_token' });
});

test('the last JSON line wins', () => {
  // A script that retries prints more than one. The newest is the one that worked.
  const stdout = '{"spotifyWebToken":"stale"}\nretrying\n{"spotifyWebToken":"fresh"}';
  assert.deepEqual(parsePayload(stdout), { spotifyWebToken: 'fresh' });
});

test('a pretty-printed object is accepted too', () => {
  const stdout = '{\n  "spotifyWebToken": "BQD_pretty",\n  "appleBearerToken": "eyJ_pretty"\n}';
  assert.deepEqual(parsePayload(stdout), {
    spotifyWebToken: 'BQD_pretty',
    appleBearerToken: 'eyJ_pretty',
  });
});

test('several tokens can come back at once', () => {
  const payload = parsePayload(
    '{"spotifyWebToken":"a","appleMediaUserToken":"b","neteaseCookie":"c"}',
  );
  assert.deepEqual(payload, {
    spotifyWebToken: 'a',
    appleMediaUserToken: 'b',
    neteaseCookie: 'c',
  });
});

test('keys that are not secrets are ignored', () => {
  // The command is a script somebody wrote; it should not be able to write anywhere it likes just
  // by naming a field.
  const payload = parsePayload('{"spotifyWebToken":"a","apiKey":"hijack","host":"0.0.0.0"}');
  assert.deepEqual(payload, { spotifyWebToken: 'a' });
});

test('nothing usable is a null rather than an empty update', () => {
  // The difference between "the browser failed" and "every token was already current".
  assert.equal(parsePayload(''), null);
  assert.equal(parsePayload('Error: no bearer token appeared'), null);
  assert.equal(parsePayload('{"somethingElse":"x"}'), null);
  assert.equal(parsePayload('{"spotifyWebToken":"   "}'), null);
  assert.equal(parsePayload('{not json at all'), null);
});
