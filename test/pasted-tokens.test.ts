import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jwtExpiry, Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';

/**
 * Apple's tokens as a browser's developer tools hand them over: with the header's own words on.
 * Sent as is, the bearer becomes `Bearer Bearer …`, which Apple answers with a 401 while the JWT
 * inside still reads as valid.
 */

const JWT = `x.${Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url')}.y`;

test('the bearer token is stored without "Bearer" or "Authorization:"', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    for (const pasted of [`Bearer ${JWT}`, `bearer  ${JWT}`, `Authorization: Bearer ${JWT}`, ` ${JWT}\n`]) {
      settings.update({ 'secret.appleBearerToken': pasted });
      assert.equal(settings.read().secrets.appleBearerToken, JWT, pasted);
    }
    assert.equal(jwtExpiry(settings.read().secrets.appleBearerToken), 4_102_444_800_000);
  } finally {
    store.close();
  }
});

test('the media-user-token is stored without its header name', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    settings.update({ 'secret.appleMediaUserToken': 'media-user-token: AkzF0token' });
    assert.equal(settings.read().secrets.appleMediaUserToken, 'AkzF0token');
  } finally {
    store.close();
  }
});
