import assert from 'node:assert/strict';
import { test } from 'node:test';

import { merge, type Candidate } from '../src/merge.ts';
import { document, line, type LyricLine, type Syllable } from '../src/model.ts';
import { hasUsableTimings, hasWordTimings, honestKind, timingsOutrunTheTrack } from '../src/timing.ts';

/**
 * A document claiming a timing tier it cannot support, caught before it is cached.
 *
 * The merge picks one candidate to own the timing, by tier, and the tier is the document's own claim
 * about itself. The archive says that claim is sometimes false — and on this side of the wire a false
 * one is worse than on a phone, because the answer it wins is written into the cache and then served to
 * everything for a month.
 *
 * The cases and the constants both come from measurement, not taste: 384 word-timed documents over 400
 * tracks, four providers, most tracks answered by two or three of them. See `src/timing.ts`.
 */

/** A line whose words are each timed — what word-sync is supposed to mean. */
function timed(text: string, startMs: number, endMs: number): LyricLine {
  const words = text.split(' ');
  const step = (endMs - startMs) / words.length;
  const syllables: Syllable[] = words.map((word, index) => ({
    text: word,
    startMs: Math.round(startMs + index * step),
    endMs: Math.round(startMs + (index + 1) * step),
    partOfWord: false,
  }));
  return line({ text, startMs, endMs, syllables });
}

/**
 * A line held in a single fragment, which is what Musixmatch richsync returns for CJK.
 *
 * Structurally identical to word-sync — one fragment with a start and an end — so nothing downstream
 * can tell the difference by looking at the shape.
 */
function coarse(text: string, startMs: number, endMs: number): LyricLine {
  const syllables: Syllable[] = [{ text, startMs, endMs, partOfWord: false }];
  return line({ text, startMs, endMs, syllables });
}

function candidate(provider: string, lines: LyricLine[], priority: number): Candidate {
  return { provider, doc: document(lines), match: 1, priority };
}

const FOUR_COARSE = [
  coarse('夢ならばどれほどよかったでしょう', 1_000, 5_000),
  coarse('未だにあなたのことを夢にみる', 5_000, 9_000),
  coarse('忘れた物を取りに帰るように', 9_000, 13_000),
  coarse('古びた思い出の埃を払う', 13_000, 17_000),
];

const FOUR_TIMED = [
  timed('I said ooh', 1_000, 3_000),
  timed("I'm blinded by the lights", 3_000, 6_000),
  timed('No I can t sleep until I feel your touch', 6_000, 10_000),
  timed('I said ooh I m drowning in the night', 10_000, 14_000),
];

// ---- the claim --------------------------------------------------------------

test('a whole line in one fragment is not word timing', () => {
  assert.equal(hasWordTimings(coarse('夢ならばどれほどよかったでしょう', 0, 4_000)), false);
  assert.equal(hasWordTimings(timed('I said ooh', 0, 2_000)), true);
});

test('a one-word line in one fragment is word timing', () => {
  // "Oh" is sung in one block and timed in one fragment by every source. Calling that coarse would
  // demote a perfectly good document for having short lines in it.
  for (const text of ['Oh', 'Yeah', 'Hey', 'La']) {
    assert.equal(hasWordTimings(coarse(text, 0, 500)), true, text);
  }
});

test('a document mostly made of whole-line fragments loses the word-timed tier', () => {
  const claimed = document(FOUR_COARSE);
  assert.equal(claimed.kind, 'syllable', 'it claims the tier — that is the problem');

  assert.equal(honestKind(claimed, 200_000).kind, 'line');
});

test('a genuinely word-timed document keeps the tier', () => {
  const doc = document(FOUR_TIMED);
  assert.equal(doc.kind, 'syllable');
  assert.equal(honestKind(doc, 200_000).kind, 'syllable');
});

test('half word-timed is enough to keep the tier', () => {
  // The boundary is deliberately at half, and a document on the line keeps its claim: the check is
  // meant to catch a catalogue of whole-line fragments, not to punish a mixed document.
  const doc = document([...FOUR_TIMED.slice(0, 2), ...FOUR_COARSE.slice(0, 2)]);
  assert.equal(honestKind(doc, 200_000).kind, 'syllable');
});

// ---- one timestamp, repeated ------------------------------------------------

test('a document whose lines all share one timestamp is not synced', () => {
  // Apple serves unsynced lyrics as the same TTML as synced ones. 14 of 339 in the archive.
  const zeroed = document([
    line({ text: 'Dream a little dream', startMs: 0, endMs: 0 }),
    line({ text: 'Of me', startMs: 0, endMs: 0 }),
    line({ text: 'And I of you', startMs: 0, endMs: 0 }),
  ]);
  assert.equal(hasUsableTimings(zeroed), false);
  assert.equal(honestKind(zeroed, 200_000).kind, 'static');
});

test('a repeated timestamp is caught even when it is not zero', () => {
  // The all-zero case falls out of `document()` as static on its own. A repeated *non*-zero stamp does
  // not, and reads on screen exactly the same way: a transcription that never advances.
  const stuck = document([
    line({ text: 'First', startMs: 4_000, endMs: 4_000 }),
    line({ text: 'Second', startMs: 4_000, endMs: 4_000 }),
    line({ text: 'Third', startMs: 4_000, endMs: 4_000 }),
  ]);
  assert.equal(stuck.kind, 'line', 'it claims to be synced');
  assert.equal(honestKind(stuck, 200_000).kind, 'static');
});

test('a single line is not judged for repeating itself', () => {
  const one = document([line({ text: 'Only this', startMs: 0, endMs: 0 })]);
  assert.equal(hasUsableTimings(one), true);
});

// ---- another recording ------------------------------------------------------

test('timings running well past the end mean another recording', () => {
  // NetEase's Irony: 5:48 of timings on a 2:24 track, 74% of them after the end.
  const long = document([
    timed('In time', 1_000, 4_000),
    timed('It fades', 150_000, 154_000),
    timed('And then', 300_000, 304_000),
    timed('It ends', 340_000, 344_000),
  ]);
  assert.equal(timingsOutrunTheTrack(long, 144_000), true);
  assert.equal(honestKind(long, 144_000).kind, 'line', 'one tier down, not discarded');
});

test('a few seconds over is a remaster, not another recording', () => {
  // The archive's next document down sat at 2.5% and was fine. A longer master must not be thrown out.
  const doc = document(FOUR_TIMED);
  assert.equal(timingsOutrunTheTrack(doc, 13_500), false);
  assert.equal(honestKind(doc, 13_500).kind, 'syllable');
});

test('without a duration nothing is assumed', () => {
  const long = document([timed('Way out here', 300_000, 304_000), timed('And here', 320_000, 324_000)]);
  assert.equal(timingsOutrunTheTrack(long, 0), false);
  assert.equal(honestKind(long, 0).kind, 'syllable');
});

test('a claim is only ever lowered', () => {
  const plain = document([line({ text: 'One', startMs: 0, endMs: 1_000 }), line({ text: 'Two', startMs: 2_000, endMs: 3_000 })]);
  assert.equal(plain.kind, 'line');
  // Nothing here can promote it to syllable, whatever else it finds.
  assert.equal(honestKind(plain, 200_000).kind, 'line');
});

// ---- the payoff -------------------------------------------------------------

test('a genuinely word-timed source takes the backbone from a coarse claim', () => {
  // The reported symptom, from the app: "Musixmatch timing always seems worse — the Apple one should
  // beat it at least". Ranking could not fix it, because both answers called themselves word-synced and
  // the tier is the one thing a preference may not overrule. So the tier had to become true.
  const musixmatch = candidate('musixmatch', FOUR_COARSE, 3);
  const apple = candidate('apple', FOUR_TIMED, 0);

  const result = merge([musixmatch, apple], { durationMs: 200_000 });

  assert.equal(result.document?.provenance.timing, 'apple');
  const demoted = result.summaries.find((s) => s.provider === 'musixmatch');
  assert.match(demoted?.note ?? '', /timings say line/, 'and it should say why, in the candidate list');
});

test('the reader ordering decides between two honest word-timed sources', () => {
  // It used to be settled by a raw count of syllable-bearing lines, so one line more than the next
  // source won and the ordering was consulted almost never.
  const preferred = candidate('apple', FOUR_TIMED, 0);
  const extra = candidate('netease', [...FOUR_TIMED, timed('One more line', 14_000, 16_000)], 4);

  const result = merge([preferred, extra], { durationMs: 200_000 });

  assert.equal(result.document?.provenance.timing, 'apple');
});
