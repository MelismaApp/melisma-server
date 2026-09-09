import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTokenReply } from '../src/browser/spotify.ts';
import { nextDelayMs } from '../src/refresher.ts';

/**
 * The token's real lifetime, and the schedule that follows from it.
 *
 * Both were assumptions, and both were wrong in the same direction. The harvest decided whether the
 * player was signed in by measuring the token's length — anonymous tokens are 140 characters and the
 * floor was 100, so every anonymous token passed and was reported as a success. And the refresh ran
 * on a fixed interval sized for a lifetime of "about an hour", where a live token was measured at 29
 * minutes: the default fifty-minute cycle spent about twenty minutes of every hour serving a token
 * that had already died.
 *
 * The player states both facts in the reply that issues the token. These tests pin the reading of it,
 * against the shape a live player actually returns.
 */

test('the signed-in flag and the expiry come from the token reply', () => {
  const expiresAt = Date.now() + 29 * 60_000;
  const reply = parseTokenReply(
    JSON.stringify({
      clientId: 'd8a5ed958d274c2e8ee717e6a4b0971d',
      accessToken: `BQCL${'x'.repeat(399)}`,
      accessTokenExpirationTimestampMs: expiresAt,
      isAnonymous: false,
    }),
  );

  assert.equal(reply?.anonymous, false);
  assert.equal(reply?.expiresAt, expiresAt);
  assert.equal(reply?.token?.length, 403);
});

test('an anonymous reply is recognised however long its token is', () => {
  // 140 characters, which cleared the old length check and was returned as a working token.
  const reply = parseTokenReply(
    JSON.stringify({ accessToken: 'x'.repeat(140), isAnonymous: true }),
  );

  assert.equal(reply?.anonymous, true);
  assert.ok((reply?.token?.length ?? 0) > 100, 'long enough to have fooled the length check');
});

test('an expiry already in the past is ignored rather than obeyed', () => {
  const reply = parseTokenReply(
    JSON.stringify({
      accessToken: 'x'.repeat(200),
      isAnonymous: false,
      accessTokenExpirationTimestampMs: Date.now() - 1_000,
    }),
  );

  // Taking it would discard a token that has just arrived and works.
  assert.equal(reply?.expiresAt, null);
});

test('nonsense in the reply is not a crash', () => {
  assert.equal(parseTokenReply('not json at all'), null);
  assert.equal(parseTokenReply('{}')?.token, null);
  assert.equal(parseTokenReply('{}')?.anonymous, null);
});

test('the schedule renews five minutes before a stated expiry', () => {
  const now = 1_000_000_000_000;
  const ceiling = 50 * 60_000;

  // A 29-minute token: renew at 24 minutes, not at the 50-minute interval.
  const delay = nextDelayMs(now + 29 * 60_000, ceiling, now);
  assert.equal(delay, 24 * 60_000);
});

test('the configured interval is still a ceiling', () => {
  const now = 1_000_000_000_000;
  const ceiling = 50 * 60_000;

  // A token good for four hours must not mean four hours without looking: the interval bounds it.
  assert.equal(nextDelayMs(now + 4 * 3600_000, ceiling, now), ceiling);
  // And with nothing stated, the interval is the whole answer.
  assert.equal(nextDelayMs(null, ceiling, now), ceiling);
});

test('an expiry inside the margin does not ask for a negative delay', () => {
  const now = 1_000_000_000_000;
  const ceiling = 50 * 60_000;

  // Two minutes left, which is inside the five-minute margin. Renew soon, but not in a tight loop:
  // a browser launch every few seconds would be worse than the stale token.
  const delay = nextDelayMs(now + 2 * 60_000, ceiling, now);
  assert.ok(delay >= 60_000, `expected a floor, got ${delay}`);
  assert.ok(delay <= ceiling);

  // Already expired, same rule.
  assert.ok(nextDelayMs(now - 60_000, ceiling, now) >= 60_000);
});
