import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';

/**
 * A variable set to nothing is not an override.
 *
 * Reported as Spotify saying "no usable web token from the sp_dc cookie" while the refresh was
 * harvesting a token every half hour and reporting success. Both were true: the refresh stored the
 * token in the database, and every read of it was shadowed by `BL_SPOTIFY_WEB_TOKEN=""`.
 *
 * The shadow came from `process.env[key] ?? stored`, where `??` only falls through on null and
 * undefined — an empty string is neither. And an empty string is exactly what a Kamal secret left
 * blank becomes, because `.kamal/secrets` lists every optional secret and passes the unfilled ones
 * through. So the deployment shipped a permanent override of nothing, over everything.
 *
 * It applied to any secret with a listed-but-blank variable, which is most of them — including
 * anything pasted into the admin page, where the effect is that pasting appears to work and changes
 * nothing.
 */

const VARS = ['BL_SPOTIFY_WEB_TOKEN', 'BL_APPLE_BEARER_TOKEN', 'BL_TRANSLATION_LANG'];

afterEach(() => {
  for (const name of VARS) delete process.env[name];
});

test('a blank variable does not shadow a stored secret', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    // What the refresher writes after a successful harvest.
    settings.update({ 'secret.spotifyWebToken': 'BQ-a-real-harvested-token' });
    // What Kamal passes for a secret nobody filled in.
    process.env.BL_SPOTIFY_WEB_TOKEN = '';

    assert.equal(settings.read().secrets.spotifyWebToken, 'BQ-a-real-harvested-token');
  } finally {
    store.close();
  }
});

test('whitespace is blank too', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    settings.update({ 'secret.appleBearerToken': 'stored-token' });
    process.env.BL_APPLE_BEARER_TOKEN = '   \n';

    assert.equal(settings.read().secrets.appleBearerToken, 'stored-token');
  } finally {
    store.close();
  }
});

test('a variable that says something still wins', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    settings.update({ 'secret.appleBearerToken': 'stored-token' });
    process.env.BL_APPLE_BEARER_TOKEN = 'from-the-environment';

    // The documented behaviour, and the reason the deployment can set a starting value at all.
    assert.equal(settings.read().secrets.appleBearerToken, 'from-the-environment');
  } finally {
    store.close();
  }
});

test('the rule is the same for ordinary settings, not just secrets', () => {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  try {
    settings.update({ 'merge.translationLang': 'ja' });
    process.env.BL_TRANSLATION_LANG = '';

    assert.equal(settings.read().translationLang, 'ja');
  } finally {
    store.close();
  }
});
