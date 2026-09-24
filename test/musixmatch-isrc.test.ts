import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { musixmatch } from '../src/providers/musixmatch.ts';

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
