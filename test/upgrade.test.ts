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

/**
 * How long the word-level source takes to answer.
 *
 * Zero for almost every test. The progress and pause tests need it non-zero: a lookup that begins and
 * ends inside one poll of `until` has no observable in-flight moment, and "a request is in the air" is
 * precisely what those tests are about.
 */
let wordLevelDelayMs = 0;

const wordLevel: Provider = {
  id: 'netease',
  label: 'Fake word source',
  description: 'test',
  requires: [],
  wordLevel: true,
  isConfigured: () => true,
  fetch: async () => {
    wordLevelAsked++;
    if (wordLevelDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, wordLevelDelayMs));
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
  wordLevelDelayMs = 0;

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

test('a re-lookup updates the entry it was asked about, rather than filing a second one', async () => {
  // The trap in this operation. `cacheKey` prefers a Spotify id, then an ISRC, then name and duration
  // — so a track first filed under its name, which has since learned its ISRC, would be re-keyed by
  // that ISRC and written as a *second* entry while the original sat there stale. And those are
  // precisely the tracks worth revisiting, so it would have happened to all of them.
  const named: TrackQuery = {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    durationMs: 200_046,
  };
  const key = cacheKey(named);
  assert.ok(key.startsWith('q:'), `expected a name-based key, got ${key}`);

  settings.update({ 'provider.netease.enabled': '1' });
  await resolver.resolve(named);
  assert.equal(store.allKeys().length, 1);

  // Learned afterwards, exactly as the harvest or the ISRC backfill would.
  store.noteIdentity(key, { isrc: 'USUG11904206' });
  assert.equal(store.isrcFor(key), 'USUG11904206');

  await resolver.relookup([key]);

  const keys = store.allKeys();
  assert.deepEqual(keys, [key], `re-lookup should not have re-keyed the entry; got ${keys}`);
});

test('a re-lookup asks the sources again rather than serving the cache', async () => {
  settings.update({ 'provider.netease.enabled': '1' });
  await resolver.resolve(TRACK);
  const asked = wordLevelAsked;
  assert.ok(asked > 0);

  await resolver.relookup([cacheKey(TRACK)]);
  assert.ok(wordLevelAsked > asked, 'the whole point is that it asks again');
});

test('two bulk re-lookups do not run at once', async () => {
  settings.update({ 'provider.netease.enabled': '1' });
  await resolver.resolve(TRACK);
  const key = cacheKey(TRACK);

  const asked = wordLevelAsked;
  const [first, second] = await Promise.all([
    resolver.relookup([key]),
    resolver.relookup([key]),
  ]);

  // One of them declines rather than both racing every source into its rate limit. The declining call
  // gets a snapshot of the run that is *still going*, which is how a caller tells the two apart.
  assert.ok(
    first.running || second.running,
    `expected one to see a run in progress, got ${JSON.stringify([first, second])}`,
  );
  assert.equal(wordLevelAsked, asked + 1, 'the track should have been looked up once, not twice');
});

// ---- what the review found -------------------------------------------------

/** A source that can be asked *by* ISRC, which is what makes it worth re-asking. */
function exactSource(answer: () => Promise<unknown>): Provider {
  return {
    id: 'amll',
    label: 'Fake exact source',
    description: 'test',
    requires: [],
    wordLevel: true,
    usesIsrc: true,
    isConfigured: () => true,
    fetch: answer as Provider['fetch'],
    test: async () => ({ ok: true, detail: 'fake' }),
    reparse: () => syllableDoc(),
  };
}

test('a second lookup joins the first instead of racing it', async () => {
  // The identity-first path awaited the harvest before registering anything in `inFlight`, so a live
  // lookup arriving during those seconds saw no work in progress and started its own name-only fetch.
  // Two lookups, both writing the same entry, and the one that had bothered to learn the ISRC could
  // lose the race.
  settings.update({ 'provider.netease.enabled': '1' });

  const [a, b] = await Promise.all([
    resolver.resolve(TRACK, { identityFirst: true }),
    resolver.resolve(TRACK),
  ]);

  assert.equal(wordLevelAsked, 1, 'the sources should have been asked once, not twice');
  assert.equal(a.document?.kind, b.document?.kind, 'both callers should get the same answer');
  assert.equal(store.allKeys().length, 1);
});

test('an exact re-ask that finds nothing withdraws the earlier name match', async () => {
  // The reported case, on the server side. A source answers by title alone with the wrong recording's
  // words; an ISRC turns up later; asked exactly, the same source has no such recording. Its earlier
  // body is why the merge is wrong, and before this nothing would ever have removed it — the attempt
  // was marked settled, so it would not even be asked again.
  let asked = 0;
  const wrongThenNothing = exactSource(async () => {
    asked++;
    // First time (by name) it hands over a match. Second time (by ISRC) it has nothing.
    if (asked === 1) {
      return { doc: syllableDoc(), match: 1, raw: { body: 'name-matched', contentType: 'text/plain' } };
    }
    return null;
  });

  PROVIDERS.length = 0;
  PROVIDERS.push(lineTimed, wrongThenNothing);
  settings.update({ 'provider.amll.enabled': '1', 'provider.netease.enabled': '0' });

  const named: TrackQuery = { ...TRACK };
  const key = cacheKey(named);
  await resolver.resolve(named);
  assert.equal(asked, 1);
  assert.ok(
    store.getRaw(key).some((raw) => raw.provider === 'amll' && raw.ok),
    'its name match should be archived and usable',
  );

  // Learned afterwards, as the harvest or the backfill would.
  store.noteIdentity(key, { isrc: 'USUG11904206' });
  await resolver.resolve(named);
  assert.ok(await until(() => asked > 1), 'it should be re-asked once an ISRC is known');

  await until(() => store.getRaw(key).some((raw) => raw.provider === 'amll' && !raw.ok));
  const body = store.getRaw(key).find((raw) => raw.provider === 'amll');
  assert.equal(body?.ok, false, 'the superseded body must not be merged from again');
  assert.match(body?.note ?? '', /superseded/);
  // Kept rather than deleted: the archive is the point of this server.
  assert.ok(body?.body, 'and it should still be on disk');
});

test('a legacy archived body is re-asked once an ISRC is known', async () => {
  // Caches that predate the attempts table have a body and no record of how it was obtained. Inferring
  // "answered, with an ISRC" would make every legacy Apple and AMLL row look already-exact, so the ISRC
  // rule could never fire for the caches that most need it.
  let asked = 0;
  PROVIDERS.length = 0;
  PROVIDERS.push(
    lineTimed,
    exactSource(async () => {
      asked++;
      return { doc: syllableDoc(), match: 1, raw: { body: 'x', contentType: 'text/plain' } };
    }),
  );
  settings.update({ 'provider.amll.enabled': '0' });

  const key = cacheKey(TRACK);
  await resolver.resolve(TRACK);

  // An archived body with no attempt beside it, which is exactly what an older database holds.
  store.putRaw({ key, provider: 'amll', body: 'legacy', contentType: 'text/plain', ok: true, note: null });
  assert.ok(!store.attemptsFor(key).get('amll'), 'no attempt should be recorded yet');

  settings.update({ 'provider.amll.enabled': '1' });
  store.noteIdentity(key, { isrc: 'USUG11904206' });
  await resolver.resolve(TRACK);

  assert.ok(await until(() => asked > 0), 'a legacy body counts as name-searched, so ask again');
});

test('a track filed before its duration was known is still re-lookupable', async () => {
  // `cacheKey` buckets the duration in two-second steps, so an entry filed with none and given an
  // authoritative one later no longer hashes to its own key. Rebuilding from what is known now missed,
  // and bulk re-lookup skipped the track silently.
  const noDuration: TrackQuery = {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    durationMs: 0,
  };
  const key = cacheKey(noDuration);
  assert.ok(key.endsWith('|0'), `expected a zero bucket, got ${key}`);

  settings.update({ 'provider.netease.enabled': '1' });
  await resolver.resolve(noDuration);

  // As the harvest does once Spotify or Apple answers.
  store.noteIdentity(key, { durationMs: 200_046 });

  const asked = wordLevelAsked;
  const result = await resolver.relookup([key]);
  assert.equal(result.done, 1, 'it should not have been skipped');
  assert.equal(result.skipped, 0);
  assert.ok(wordLevelAsked > asked);
  assert.deepEqual(store.allKeys(), [key], 'and it must not have been re-keyed');
});

test('a track with only extras left is still re-lookupable', async () => {
  // What "Forget lyrics" leaves: the entry and the archive gone, the artwork and tempo kept. The library
  // lists those rows — it reads the union of both tables — so the action most likely to be aimed at one
  // must be able to find it.
  settings.update({ 'provider.netease.enabled': '1' });
  const key = cacheKey(TRACK);
  await resolver.resolve(TRACK);
  store.saveExtras({
    key,
    title: TRACK.title,
    artist: TRACK.artist,
    tempo: 171,
    coverUrl: null,
    artistImageUrl: null,
    palette: null,
    analysis: null,
    metadata: null,
    source: 'test',
  });

  store.deleteEntry(key);
  assert.ok(!store.getEntry(key), 'the entry is gone');
  assert.ok(store.extras(key), 'the extras remain');
  assert.ok(store.allKeys().includes(key), 'and the row is still listed');

  const asked = wordLevelAsked;
  const result = await resolver.relookup([key]);
  assert.equal(result.done, 1, 'an extras-only row should be re-lookupable');
  assert.ok(wordLevelAsked > asked);
});

test('the pause between tracks is honoured', async () => {
  // The knob for a rate limit measured over a longer window than any per-request gap covers. The
  // per-host floors keep a single lookup polite and say nothing at all about a hundred in a row.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '260' });

  const keys: string[] = [];
  for (const title of ['One', 'Two', 'Three']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const started = Date.now();
  const result = await resolver.relookup(keys);
  const took = Date.now() - started;

  assert.equal(result.done, 3);
  // Two gaps for three tracks: the pause goes between them, not before the first.
  assert.ok(took >= 500, `expected at least two pauses, took ${took}ms`);
});

test('a pause of zero does not wait', async () => {
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '0' });
  const keys: string[] = [];
  for (const title of ['Four', 'Five']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const started = Date.now();
  await resolver.relookup(keys);
  assert.ok(Date.now() - started < 250, 'zero should mean zero, not a default');
});

test('a run reports its progress and can be stopped', async () => {
  // A job that takes minutes with no readout and no way out is a job you daren't start.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '120' });

  const keys: string[] = [];
  for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  assert.equal(resolver.relookupProgress.running, false, 'nothing running to begin with');

  const run = resolver.relookup(keys);
  assert.ok(await until(() => resolver.relookupProgress.running), 'it should report itself running');
  assert.equal(resolver.relookupProgress.total, 6);

  // Wait until it is genuinely under way, then stop it.
  assert.ok(await until(() => resolver.relookupProgress.done >= 1));
  assert.equal(resolver.cancelRelookup(), true);

  const final = await run;
  assert.equal(final.running, false);
  assert.equal(final.cancelled, true, 'it should say it was stopped rather than finished');
  assert.ok(final.done >= 1 && final.done < 6, `stopped partway, got ${final.done} of 6`);

  // The readout survives the end of the run, so the page can say how it went.
  assert.equal(resolver.relookupProgress.cancelled, true);
  assert.equal(resolver.relookupProgress.current, null);
});

test('a run can be held and let go again, and keeps its place', { timeout: 20_000 }, async () => {
  // Stop loses your place: a re-lookup forces past the cache, so restarting a long run re-spends every
  // request it had already made. Holding is what you want when a source starts throttling halfway.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '60' });

  const keys: string[] = [];
  for (const title of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const run = resolver.relookup(keys);
  assert.ok(await until(() => resolver.relookupProgress.done >= 1), 'under way');

  assert.equal(resolver.pauseRelookup(true), true);
  assert.ok(
    await until(() => resolver.relookupProgress.paused && resolver.relookupProgress.current === null),
    'it should settle, naming nothing, once the track in flight is finished',
  );

  const held = resolver.relookupProgress.done;
  // The point of the whole thing: a held run does no more work, and does not end either.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(resolver.relookupProgress.done, held, 'no progress while held');
  assert.equal(resolver.relookupProgress.running, true, 'and it is still the live run');

  resolver.pauseRelookup(false);
  const final = await run;
  assert.equal(final.cancelled, false, 'a pause is not a stop');
  assert.equal(final.done, 6, 'it carries on from where it was rather than starting over');
});

test('a held run can still be stopped', { timeout: 20_000 }, async () => {
  // Otherwise a pause is a trap: nothing left to press, and a run that never ends. Bounded explicitly
  // because that failure hangs rather than returning a wrong answer, and a hung suite says less than
  // a failed one.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '60' });

  const keys: string[] = [];
  for (const title of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const run = resolver.relookup(keys);
  assert.ok(await until(() => resolver.relookupProgress.done >= 1));
  resolver.pauseRelookup(true);
  assert.ok(await until(() => resolver.relookupProgress.paused && !resolver.relookupProgress.current));

  assert.equal(resolver.cancelRelookup(), true);
  const final = await run;
  assert.equal(final.running, false, 'it must actually end');
  assert.equal(final.cancelled, true);
  assert.ok(final.done < 6, `stopped partway, got ${final.done} of 6`);
});

test('pausing when nothing is running is not an error', () => {
  assert.equal(resolver.relookupProgress.running, false);
  assert.equal(resolver.pauseRelookup(true), false);
});

test('a stop during the wait between tracks is not sat out', { timeout: 20_000 }, async () => {
  // The delay exists because a source was throttling, so it is set to whatever it takes — and the
  // longer it is, the more a Stop that waits for it to elapse looks like a Stop that did nothing.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '5000' });

  const keys: string[] = [];
  for (const title of ['W1', 'W2', 'W3'] ) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const run = resolver.relookup(keys);
  // One track done means the run is now inside the five-second wait.
  assert.ok(await until(() => resolver.relookupProgress.done >= 1), 'under way');

  const asked = Date.now();
  resolver.cancelRelookup();
  const final = await run;
  const took = Date.now() - asked;

  assert.equal(final.cancelled, true);
  assert.ok(took < 1_500, `it should answer within a moment, took ${took}ms of a 5000ms wait`);
});

test('a delay raised while held applies to the very next lookup', { timeout: 20_000 }, async () => {
  // The whole sequence this is for: you see a source throttling, hold the run, raise the delay, let it
  // go on. If the new delay only takes effect on the track after next, the first request after
  // resuming goes out at the old pace — and that request is the entire reason you intervened.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '200' });
  wordLevelDelayMs = 200;

  const keys: string[] = [];
  for (const title of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const run = resolver.relookup(keys);
  // Asked for while a lookup is in the air, which is what makes the hold that follows unambiguous:
  // the attempt finishes, `current` clears, and the very next thing in the loop is the gate.
  assert.ok(
    await until(() => resolver.relookupProgress.done >= 1 && resolver.relookupProgress.current !== null),
    'a lookup in flight',
  );
  resolver.pauseRelookup(true);
  assert.ok(
    await until(() => resolver.relookupProgress.paused && !resolver.relookupProgress.current),
    'held, with nothing in the air',
  );

  const held = resolver.relookupProgress.done;
  settings.update({ 'cache.relookupPauseMs': '1200' });

  const resumed = Date.now();
  resolver.pauseRelookup(false);
  assert.ok(await until(() => resolver.relookupProgress.done > held, 5_000), 'it should carry on');
  const gap = Date.now() - resumed;

  resolver.cancelRelookup();
  await run;

  assert.ok(gap >= 900, `the new delay should come before the next lookup, waited only ${gap}ms`);
});

test('the track in flight is named, and only while it is in flight', { timeout: 20_000 }, async () => {
  // `current` is what separates "paused" from "pausing, one track to go", so a name left standing
  // through the wait between tracks would report a request that is not in the air.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '400' });
  wordLevelDelayMs = 300;

  const keys: string[] = [];
  for (const title of ['N1', 'N2', 'N3', 'N4'] ) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  const run = resolver.relookup(keys);
  assert.ok(
    await until(() => resolver.relookupProgress.done >= 1 && resolver.relookupProgress.current !== null),
    'a track being asked about is named',
  );
  assert.ok(
    await until(
      () =>
        resolver.relookupProgress.running &&
        resolver.relookupProgress.done >= 1 &&
        resolver.relookupProgress.current === null,
    ),
    'and between two of them, nothing is',
  );

  resolver.cancelRelookup();
  await run;
});

test('a hold does not carry over to the next run', { timeout: 20_000 }, async () => {
  // The failure this guards against is silent and total: a run that starts out held does nothing at
  // all, and the readout would say "paused" about a hold nobody asked for.
  // Enough tracks, and enough delay between them, that there is a run left to hold by the time the
  // hold is asked for.
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '60' });

  const keys: string[] = [];
  for (const title of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) {
    const track: TrackQuery = { ...TRACK, title };
    await resolver.resolve(track);
    keys.push(cacheKey(track));
  }

  // Hold one, then abandon it — the way you would after seeing a source throttle and giving up.
  const abandoned = resolver.relookup(keys);
  assert.ok(await until(() => resolver.relookupProgress.done >= 1));
  resolver.pauseRelookup(true);
  assert.ok(await until(() => resolver.relookupProgress.paused && !resolver.relookupProgress.current));
  resolver.cancelRelookup();
  await abandoned;

  const second = await resolver.relookup(keys);
  assert.equal(second.paused, false, 'the new run must not inherit the hold');
  assert.equal(second.cancelled, false, 'nor the stop');
  assert.equal(second.done, 6, 'and it must actually do the work, unprompted');
});

test('cancelling when nothing is running is not an error', () => {
  assert.equal(resolver.cancelRelookup(), false);
});

test('a finished run is not marked as cancelled', async () => {
  settings.update({ 'provider.netease.enabled': '1', 'cache.relookupPauseMs': '0' });
  const track: TrackQuery = { ...TRACK, title: 'Solo' };
  await resolver.resolve(track);

  const final = await resolver.relookup([cacheKey(track)]);
  assert.equal(final.cancelled, false);
  assert.equal(final.done, 1);
  assert.equal(final.running, false);
});
