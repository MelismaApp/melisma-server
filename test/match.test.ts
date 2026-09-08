import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MATCH_THRESHOLD, bestScore, cacheKey, score, type TrackQuery } from '../src/match.ts';
import { cleanTrackTitle, comparableScripts, detectScript, splitArtists } from '../src/text.ts';

const lemon: TrackQuery = {
  title: 'Lemon',
  artist: 'Kenshi Yonezu',
  album: 'Lemon',
  durationMs: 255_000,
};

test('an exact match scores at the top', () => {
  assert.ok(score(lemon, 'Lemon', 'Kenshi Yonezu', 255_000) > 0.95);
});

test('a different song is rejected', () => {
  assert.ok(score(lemon, 'Something Else Entirely', 'Another Band', 130_000) < MATCH_THRESHOLD);
});

test('a remaster of the same track still matches', () => {
  assert.ok(score(lemon, 'Lemon - 2018 Remaster', 'Kenshi Yonezu', 256_000) >= MATCH_THRESHOLD);
});

test('a name in another script is unknown, not wrong', () => {
  // Every East Asian catalogue indexes in the original script while the phone reports
  // whatever Spotify chose. Letter similarity between the two is zero, but it is the same
  // person — so scoring it as a contradiction would reject every correct match.
  assert.ok(score(lemon, 'Lemon', '米津玄師', 255_000) >= MATCH_THRESHOLD);
});

test('the cross-script allowance is not a way in for the wrong track', () => {
  // With the artist unknown, the title and duration have to carry the match alone.
  assert.ok(score(lemon, '残酷な天使のように', '高橋洋子', 88_000) < MATCH_THRESHOLD);
});

test('a wildly different duration drags the score down', () => {
  assert.ok(
    score(lemon, 'Lemon', 'Kenshi Yonezu', 400_000) < score(lemon, 'Lemon', 'Kenshi Yonezu', 255_000),
  );
});

test('an unknown duration is neutral rather than damning', () => {
  // The community database stores no durations at all; treating that as a mismatch would
  // reject the best free source there is.
  assert.ok(score(lemon, 'Lemon', 'Kenshi Yonezu', 0) >= MATCH_THRESHOLD);
});

test('any credited artist can carry the match', () => {
  const collaboration: TrackQuery = {
    title: 'Song',
    artist: 'First Artist, Second Artist',
    album: '',
    durationMs: 200_000,
  };
  // Catalogues disagree about who is "the" artist on a collaboration.
  assert.ok(score(collaboration, 'Song', 'Second Artist', 200_000) >= MATCH_THRESHOLD);
});

test('the best of several titles and artists counts', () => {
  // One community entry lists alternate titles and every credited artist.
  const best = bestScore(lemon, ['日剧《非自然死亡》主题曲', 'Lemon'], ['米津玄師'], 0);
  assert.ok(best >= MATCH_THRESHOLD);
});

// ---- keys -----------------------------------------------------------------

test('a Spotify id is the key when there is one', () => {
  assert.equal(cacheKey({ ...lemon, spotifyId: '7Cd17G3oNQ34OWUwS8ZxfR' }), 'sp:7Cd17G3oNQ34OWUwS8ZxfR');
});

test('an ISRC is the next best key', () => {
  assert.equal(cacheKey({ ...lemon, isrc: 'jpu901800227' }), 'isrc:JPU901800227');
});

test('a one-second reporting difference does not split the entry', () => {
  // Two players reporting 255.0s and 255.9s are describing the same recording.
  assert.equal(cacheKey(lemon), cacheKey({ ...lemon, durationMs: 255_900 }));
});

test('punctuation and case do not split the entry either', () => {
  assert.equal(cacheKey(lemon), cacheKey({ ...lemon, title: 'lemon!', artist: 'kenshi  yonezu' }));
});

// ---- text -----------------------------------------------------------------

test('kana anywhere means the kanji are Japanese', () => {
  // 君の名は is mostly Han characters; the kana prove it must never be read as Mandarin.
  assert.equal(detectScript('君の名は'), 'japanese');
  assert.equal(detectScript('米津玄師'), 'chinese'); // no kana to go on
  assert.equal(detectScript('아이유'), 'korean');
  assert.equal(detectScript('Кино'), 'cyrillic');
  assert.equal(detectScript('Hello'), 'latin');
});

test('scripts are comparable when they share Latin letters', () => {
  assert.ok(comparableScripts('YOASOBI', 'YOASOBI (ヨアソビ)'));
  assert.ok(comparableScripts('米津玄師', '米津玄師'));
  assert.ok(!comparableScripts('Kenshi Yonezu', '米津玄師'));
});

test('titles lose the decoration catalogues disagree about', () => {
  assert.equal(cleanTrackTitle('Song (feat. Someone)'), 'Song');
  assert.equal(cleanTrackTitle('Song - 2011 Remaster'), 'Song');
  assert.equal(cleanTrackTitle('Song (Remastered 2015)'), 'Song');
  assert.equal(cleanTrackTitle('Song - Radio Edit'), 'Song');
  // Better a title that is only decoration than an empty string to search for.
  assert.equal(cleanTrackTitle('(Live)'), '(Live)');
});

test('artists split on every separator the catalogues use', () => {
  assert.deepEqual(splitArtists('A, B & C'), ['A', 'B', 'C']);
  assert.deepEqual(splitArtists('A feat. B'), ['A', 'B']);
  assert.deepEqual(splitArtists('米津玄師、DAOKO'), ['米津玄師', 'DAOKO']);
});
