import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Resolver } from '../src/resolver.ts';
import { PROVIDERS, type Provider } from '../src/providers/index.ts';
import { cacheKey, type TrackQuery } from '../src/match.ts';
import { document, line } from '../src/model.ts';

/**
 * A cached answer gets better when a source that never answered finally can.
 *
 * A cached document used to stand for the whole thirty-day refresh window whatever it was missing. A
 * track first played while a source was disabled, unconfigured, or simply down kept the poorer answer
 * for a month, and nothing recorded that a better one had ever been missed — the archive only held
 * answers, so "asked and had nothing" and "could not be reached" were indistinguishable afterwards.
 *
 * Now each attempt is recorded, and a cache hit re-asks only the sources that never got to answer,
 * in the background, then re-merges. A source that answered "no lyrics for this track" is left alone:
 * that is a real answer, and re-asking it every play would be wasted requests for a result that will
 * not change.
 */

const TRACK: TrackQuery = {
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  durationMs: 200_046,
};

/** Line-timed only: what a cache entry looks like when the better source was unavailable. */
const lineTimed: Provider = {
  id: 'lrclib',
  label: 'Fake line source',
  description: 'test',
  requires: [],
  wordLevel: false,
  isConfigured: () => true,
  fetch: async () => ({
    doc: document([
      line({ text: 'I said ooh', startMs: 1_000, endMs: 2_000 }),
      line({ text: "I'm blinded by the lights", startMs: 2_000, endMs: 4_000 }),
    ]),
    match: 1,
    raw: { body: 'line', contentType: 'text/plain' },
  }),
  test: async () => ({ ok: true, detail: 'fake' }),
  reparse: () =>
    document([
      line({ text: 'I said ooh', startMs: 1_000, endMs: 2_000 }),
      line({ text: "I'm blinded by the lights", startMs: 2_000, endMs: 4_000 }),
    ]),
};

/** Syllable-timed: strictly better, and the whole reason to re-ask. */
let wordLevelAsked = 0;
const syllableDoc = () =>
  document([
    line({
      text: 'I said ooh',
      startMs: 1_000,
      endMs: 2_000,
      syllables: [
        { text: 'I', startMs: 1_000, endMs: 1_300, partOfWord: false },
        { text: 'said', startMs: 1_300, endMs: 1_600, partOfWord: false },
        { text: 'ooh', startMs: 1_600, endMs: 2_000, partOfWord: false },
      ],
    }),
    line({
      text: "I'm blinded by the lights",
      startMs: 2_000,
      endMs: 4_000,
      syllables: [
        { text: "I'm", startMs: 2_000, endMs: 2_400, partOfWord: false },
        { text: 'blinded', startMs: 2_400, endMs: 3_000, partOfWord: false },
        { text: 'by the lights', startMs: 3_000, endMs: 4_000, partOfWord: false },
      ],
    }),
  ]);

const wordLevel: Provider = {
  id: 'netease',
  label: 'Fake word source',
  description: 'test',
  requires: [],
  wordLevel: true,
  isConfigured: () => true,
  fetch: async () => {
    wordLevelAsked++;
    return {
      doc: syllableDoc(),
      match: 1,
      raw: { body: 'syllable', contentType: 'text/plain' },
    };
  },
  test: async () => ({ ok: true, detail: 'fake' }),
  reparse: () => syllableDoc(),
};

let store: Store;
let settings: Settings;
let resolver: Resolver;
let original: Provider[];

beforeEach(() => {
  original = [...PROVIDERS];
  PROVIDERS.length = 0;
  PROVIDERS.push(lineTimed, wordLevel);
  wordLevelAsked = 0;

  store = new Store(':memory:');
  settings = new Settings(store);
  // Only the line source to begin with; the word-level one is switched on later, which is the
  // realistic way a source comes to have never been asked.
  settings.update({ 'provider.lrclib.enabled': '1', 'provider.netease.enabled': '0' });
  resolver = new Resolver(store, settings);
});

afterEach(() => {
  PROVIDERS.length = 0;
  PROVIDERS.push(...original);
  store.close();
});

/** Waits for the background upgrade to land, rather than guessing at a sleep. */
async function until(predicate: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test('a source enabled after the fact is asked, and the cache improves', async () => {
  const first = await resolver.resolve(TRACK);
  assert.equal(first.document?.kind, 'line', 'only the line source was available');
  assert.equal(wordLevelAsked, 0, 'it was disabled, so it should not have been asked');

  // What the operator does: turns on a source they had not configured before.
  settings.update({ 'provider.netease.enabled': '1' });

  // The cached answer still comes back immediately — the upgrade must not make this slower.
  const second = await resolver.resolve(TRACK);
  assert.equal(second.source, 'cache');
  assert.equal(second.document?.kind, 'line', 'served from cache, unchanged');

  const key = cacheKey(TRACK);
  const improved = await until(() => {
    const merged = store.getEntry(key)?.merged;
    return Boolean(merged && (JSON.parse(merged) as { kind: string }).kind === 'syllable');
  });
  assert.ok(improved, 'the background upgrade should have re-merged with the better source');
  assert.equal(wordLevelAsked, 1);

  // And the next lookup gets it.
  const third = await resolver.resolve(TRACK);
  assert.equal(third.document?.kind, 'syllable');
});

test('a source that had nothing is not asked again', async () => {
  const silent: Provider = { ...wordLevel, fetch: async () => {
    wordLevelAsked++;
    return null;
  } };
  PROVIDERS.length = 0;
  PROVIDERS.push(lineTimed, silent);
  settings.update({ 'provider.netease.enabled': '1' });

  await resolver.resolve(TRACK);
  assert.equal(wordLevelAsked, 1, 'asked once during the lookup');
  assert.equal(store.attemptsFor(cacheKey(TRACK)).get('netease')?.outcome, 'none');

  // Three more plays. "No lyrics for this track" is a real answer, so none of them should spend a
  // request on it — that would be the whole point of the record.
  for (let i = 0; i < 3; i++) await resolver.resolve(TRACK);
  await until(() => wordLevelAsked > 1, 300);
  assert.equal(wordLevelAsked, 1, 'a settled answer must not be re-asked every play');
});

test('a source that could not be reached is recorded as such, not as an answer', async () => {
  const broken: Provider = {
    ...wordLevel,
    fetch: async () => {
      wordLevelAsked++;
      throw new Error('connection refused');
    },
  };
  PROVIDERS.length = 0;
  PROVIDERS.push(lineTimed, broken);
  settings.update({ 'provider.netease.enabled': '1' });

  await resolver.resolve(TRACK);

  // The distinction the archive could not make: this is worth another go later, unlike 'none'.
  assert.equal(store.attemptsFor(cacheKey(TRACK)).get('netease')?.outcome, 'unreachable');

  // But not immediately. A service having a bad day must not be asked once per play.
  const before = wordLevelAsked;
  await resolver.resolve(TRACK);
  await until(() => wordLevelAsked > before, 300);
  assert.equal(wordLevelAsked, before, 'the retry is on a timer, not on the next play');
});

test('a source that could not be reached is not recorded as having no lyrics', async () => {
  // The distinction the whole `attempts` table exists for, and the easiest one to lose: a provider
  // reports a failure through `unreachable` and *then* returns null, so writing 'none' on the null
  // turns every outage into a settled "no lyrics here" — which `staleSources` never retries.
  const flaky: Provider = {
    ...wordLevel,
    fetch: async (_track, ctx) => {
      wordLevelAsked++;
      ctx.unreachable('a 502 from the source');
      return null;
    },
  };
  PROVIDERS.length = 0;
  PROVIDERS.push(lineTimed, flaky);
  settings.update({ 'provider.netease.enabled': '0' });

  await resolver.resolve(TRACK);
  settings.update({ 'provider.netease.enabled': '1' });
  await resolver.resolve(TRACK);
  assert.ok(await until(() => wordLevelAsked > 0), 'the upgrade should have asked it');

  assert.equal(
    store.attemptsFor(cacheKey(TRACK)).get('netease')?.outcome,
    'unreachable',
    'reporting unreachable and then returning null must not read as "nothing here"',
  );
});

test('an upgrade attempt does not retire the track for the life of the process', async () => {
  // The memo used to be held per key until restart, which silently outranked the six-hour cooldown it
  // was meant to complement: one attempt and the track was never reconsidered, however long the
  // server ran and whatever changed in the meantime.
  let secondAsked = 0;
  const second: Provider = {
    ...wordLevel,
    id: 'musixmatch',
    fetch: async () => {
      secondAsked++;
      return { doc: syllableDoc(), match: 1, raw: { body: 'syllable', contentType: 'text/plain' } };
    },
  };
  PROVIDERS.length = 0;
  PROVIDERS.push(lineTimed, wordLevel, second);
  settings.update({ 'provider.netease.enabled': '0', 'provider.musixmatch.enabled': '0' });

  await resolver.resolve(TRACK);

  // One source switched on, upgraded, done. Waiting for the *merge* rather than the request, because
  // the in-flight guard makes a lookup during an upgrade a no-op — correctly, but it means asking
  // again too early proves nothing.
  settings.update({ 'provider.netease.enabled': '1' });
  await resolver.resolve(TRACK);
  const key = cacheKey(TRACK);
  assert.ok(
    await until(() => {
      const merged = store.getEntry(key)?.merged;
      return Boolean(merged && (JSON.parse(merged) as { kind: string }).kind === 'syllable');
    }),
    'the first upgrade should have finished',
  );

  // Now another. The key has already been through an upgrade, and that must not be the end of it.
  settings.update({ 'provider.musixmatch.enabled': '1' });
  await resolver.resolve(TRACK);
  assert.ok(
    await until(() => secondAsked > 0),
    'a source enabled after an earlier upgrade should still be asked',
  );
});

test('an archived answer counts as having been asked', async () => {
  // Every database that already had a cache started with an empty `attempts` table, so the first hit
  // after this upgrade treated every source as never asked — and re-fetched ones whose answers were
  // already in `raw`, spending rate limit to learn what was on disk.
  const key = cacheKey(TRACK);

  // Disabled for the lookup, so no attempt is recorded for it: the state an older database is in.
  settings.update({ 'provider.netease.enabled': '0' });
  await resolver.resolve(TRACK);
  assert.equal(store.attemptsFor(key).get('netease'), undefined, 'no attempt should exist yet');

  // But its answer is on disk, as it would be for anything cached before the table existed.
  store.putRaw({
    key,
    provider: 'netease',
    body: 'syllable',
    contentType: 'text/plain',
    ok: true,
    note: null,
  });

  settings.update({ 'provider.netease.enabled': '1' });
  const before = wordLevelAsked;
  await resolver.resolve(TRACK);
  await until(() => wordLevelAsked > before, 300);
  assert.equal(wordLevelAsked, before, 'a source with an archived answer must not be re-asked');
});

test('a cache-only lookup makes no requests', async () => {
  await resolver.resolve(TRACK);
  settings.update({ 'provider.netease.enabled': '1' });
  const asked = wordLevelAsked;

  // `cacheOnly` is a promise not to touch the network, and an upgrade is network.
  await resolver.resolve(TRACK, { cacheOnly: true });
  await until(() => wordLevelAsked > asked, 300);
  assert.equal(wordLevelAsked, asked);
});

test('the library fingerprint moves for each thing the view shows', () => {
  // What tells the admin page to refresh itself. Three tables because a row moves for three reasons —
  // a lookup or a re-merge writes `entries`, a harvest writes `extras`, an archived answer writes
  // `raw` — and watching only the first missed a tempo landing seconds later, which is precisely the
  // update worth seeing.
  const key = 'sp:fingerprint';
  const before = store.cacheRevision();
  assert.equal(store.cacheRevision(), before, 'reading it must not change it');

  store.putEntry({
    key, title: 'a song', artist: 'somebody', album: '', durationMs: 0,
    spotifyId: null, isrc: null, merged: null, mergeVersion: 1,
  });
  const afterEntry = store.cacheRevision();
  assert.notEqual(afterEntry, before, 'an entry should move it');

  store.putRaw({ key, provider: 'lrclib', body: 'x', contentType: 'text/plain', ok: true, note: null });
  const afterRaw = store.cacheRevision();
  assert.notEqual(afterRaw, afterEntry, 'an archived answer should move it');

  store.saveExtras({
    key, title: 'a song', artist: 'somebody', tempo: 120,
    coverUrl: null, artistImageUrl: null, palette: null, analysis: null, metadata: null,
    source: 'test',
  });
  assert.notEqual(store.cacheRevision(), afterRaw, 'extras should move it');
});
