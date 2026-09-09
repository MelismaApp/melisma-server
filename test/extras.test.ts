import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from '../src/db.ts';

/**
 * The extras row is written by six providers and a harvest, each reporting only what it happens to
 * know, in whatever order they finish. Everything here is about that: nothing may throw for a field
 * a caller did not have, and nothing may erase what another source already contributed.
 */

test('a provider that knows one thing can say so without throwing', () => {
  // `node:sqlite` refuses to bind `undefined`, and this threw *inside* a provider's fetch — where
  // it was caught as a provider failure, so the source was marked unreachable and its lyrics
  // thrown away. A missing tempo cost a whole set of words.
  const store = new Store(':memory:');
  assert.doesNotThrow(() => store.saveExtras({ key: 'k', palette: { accent: '#abc' } }));
  assert.doesNotThrow(() => store.saveExtras({ key: 'k', metadata: { albumName: 'A' } }));
  assert.doesNotThrow(() => store.saveExtras({ key: 'k', tempo: 120 }));
  assert.doesNotThrow(() => store.saveExtras({ key: 'k' }));
  store.close();
});

test('two sources reporting different things both survive', () => {
  const store = new Store(':memory:');
  // Spotify has the tempo and the album ids; Apple has the songwriter and the palette. They finish
  // in parallel, so replacing the blob meant whichever landed last erased the other.
  store.saveExtras({
    key: 'k',
    tempo: 87.6,
    metadata: { spotifyId: 'sp1', popularity: 82 },
    source: 'spotify',
  });
  store.saveExtras({
    key: 'k',
    palette: { bgColor: '#111' },
    metadata: { appleMusicId: 'am1', composerName: 'KY' },
    source: 'applemusic',
  });

  const extras = store.extras('k')!;
  assert.equal(extras.tempo, 87.6);
  assert.deepEqual(extras.metadata, {
    appleMusicId: 'am1',
    composerName: 'KY',
    spotifyId: 'sp1',
    popularity: 82,
  });
  assert.deepEqual(extras.palette, { bgColor: '#111' });
  // And it records that both contributed, rather than only the last one in.
  assert.equal(extras.source, 'spotify+applemusic');
  store.close();
});

test('a key already known is not overwritten by a later source', () => {
  const store = new Store(':memory:');
  store.saveExtras({ key: 'k', metadata: { albumName: 'The Original' }, source: 'a' });
  store.saveExtras({ key: 'k', metadata: { albumName: 'A Reissue' }, source: 'b' });
  // Same rule the scalar columns follow: whoever knew it first keeps it, so write order does not
  // decide the answer.
  assert.equal(store.extras('k')!.metadata!.albumName, 'The Original');
  store.close();
});

test('a row created by an ISRC alone still gets its name later', () => {
  const store = new Store(':memory:');
  // `noteIdentity` can create the row before anything knows the title, which left it blank — so the
  // song showed up in the library nameless and could not be found by searching for it.
  store.noteIdentity('k', { isrc: 'JPU901800227', durationMs: 255_000 });
  assert.equal(store.extras('k')!.title, '');

  store.saveExtras({ key: 'k', title: 'Lemon', artist: 'Kenshi Yonezu', tempo: 87.6 });
  const extras = store.extras('k')!;
  assert.equal(extras.title, 'Lemon');
  assert.equal(extras.artist, 'Kenshi Yonezu');
  assert.equal(extras.isrc, 'JPU901800227');

  // And an empty name never wipes a real one.
  store.saveExtras({ key: 'k', tempo: 90 });
  assert.equal(store.extras('k')!.title, 'Lemon');
  store.close();
});

test('a blob nobody reported stays absent, rather than becoming empty', () => {
  // Merging two absent blobs yields `{}`, which is not the same as null: the library would report
  // "analysis" as present, and the list of tracks still missing one would come back empty — which
  // is exactly the list you want while a Spotify token still works, because that endpoint is gone.
  const store = new Store(':memory:');
  store.saveExtras({ key: 'k', palette: { accent: '#abc' } });
  store.saveExtras({ key: 'k', metadata: { albumName: 'A' } });

  const extras = store.extras('k')!;
  assert.equal(extras.analysis, null);
  assert.equal(store.library({ missing: 'analysis' }).rows.length, 1);
  assert.ok(!store.library().rows[0].extrasFields.some((f) => f.startsWith('analysis')));
  store.close();
});

test('the reported size counts the extras, which are the biggest part', () => {
  const store = new Store(':memory:');
  const before = store.stats().bytes;
  store.saveExtras({
    key: 'k',
    // A real analysis is the beat grid: hundreds of kilobytes a track, and previously invisible.
    analysis: { beats: Array.from({ length: 2_000 }, (_, i) => ({ start: i / 2 })) },
  });
  const after = store.stats().bytes;
  assert.ok(after > before + 10_000, `size went from ${before} to ${after}`);
  store.close();
});
