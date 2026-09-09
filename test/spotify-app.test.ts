import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { appTokenConfigured, resetAppToken, spotifyAppToken } from '../src/spotifyApp.ts';

/**
 * An app token for the public catalogue API.
 *
 * Added because `api.spotify.com` rate-limits a web-player token so hard that the ISRC and the cover
 * effectively never arrived — a persistent `429` that survived a change of address, so the limit
 * follows the token. A registered application has documented quotas instead.
 *
 * These tests are about the parts that do not need Spotify: whether it knows it is unconfigured, and
 * whether it stops asking once it has an answer. The exchange itself needs real credentials, so it is
 * checked by hand against the live endpoint rather than pretended at here.
 */

afterEach(() => resetAppToken());

function withSettings(): { store: Store; settings: Settings } {
  const store = new Store(':memory:');
  return { store, settings: new Settings(store) };
}

test('nothing configured is not an error, and asks Spotify nothing', async () => {
  const { store, settings } = withSettings();
  try {
    assert.equal(appTokenConfigured(settings.read()), false);

    // Null with no detail: this is an optional improvement to the harvest, not a requirement, and a
    // warning on every lookup for a feature nobody turned on would be noise.
    const outcome = await spotifyAppToken(settings.read());
    assert.equal(outcome.token, null);
    assert.equal(outcome.detail, null);
  } finally {
    store.close();
  }
});

test('an id without a secret still counts as unconfigured', async () => {
  const { store, settings } = withSettings();
  try {
    settings.update({ 'secret.spotifyClientId': 'an-id' });
    assert.equal(appTokenConfigured(settings.read()), false);
    assert.equal((await spotifyAppToken(settings.read())).token, null);
  } finally {
    store.close();
  }
});

test('both halves present counts as configured', () => {
  const { store, settings } = withSettings();
  try {
    settings.update({
      'secret.spotifyClientId': 'an-id',
      'secret.spotifyClientSecret': 'a-secret',
    });
    assert.equal(appTokenConfigured(settings.read()), true);
  } finally {
    store.close();
  }
});

test('a blank secret does not count, the same as everywhere else', () => {
  const { store, settings } = withSettings();
  try {
    settings.update({
      'secret.spotifyClientId': 'an-id',
      'secret.spotifyClientSecret': '   ',
    });
    // The same trap as `BL_SPOTIFY_WEB_TOKEN=""`: something set to nothing is not something.
    assert.equal(appTokenConfigured(settings.read()), false);
  } finally {
    store.close();
  }
});
