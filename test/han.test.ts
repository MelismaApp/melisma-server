import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FOLDED_CHARACTERS, toSimplified } from '../src/han.ts';
import { cacheKey, score, MATCH_THRESHOLD } from '../src/match.ts';
import { fold, foldTight, similarity } from '../src/text.ts';

/**
 * Traditional and Simplified Chinese are the same words to a listener and different bytes to a comparison.
 *
 * Found by the app session, which hit it in its own matcher, and confirmed worse here: the server rejected
 * correct lyrics as the wrong song even when the duration matched exactly.
 */

test('the table folds Traditional onto Simplified', () => {
  assert.equal(toSimplified('獨角獸'), '独角兽');
  assert.equal(toSimplified('吳青峰'), '吴青峰');
  assert.equal(toSimplified('山對山來崖對崖'), '山对山来崖对崖');
  assert.equal(toSimplified('這樣過來說話'), '这样过来说话');
});

test('anything it does not know passes through unchanged', () => {
  // Coverage is partial by design, and a character the table has never heard of must be left alone
  // rather than dropped or replaced — unknown folds back to the old behaviour, not to a wrong answer.
  for (const value of ['Blinding Lights', 'ブラインディング', '눈이 오는 날', 'Ω', '', '独角兽']) {
    assert.equal(toSimplified(value), value, value);
  }
});

test('the table is big enough to be worth having', () => {
  // Not an assertion about correctness, an assertion about not being quietly gutted: the value of this
  // is entirely in its coverage, and a table of three entries would pass every other test here.
  assert.ok(FOLDED_CHARACTERS > 550, `only ${FOLDED_CHARACTERS} characters`);
});

test('the pairs the archive proved are all there', () => {
  // The most frequent folds in 5,046 aligned line pairs between a Traditional and a Simplified copy of
  // the same song. 著/着 alone occurred 415 times, and the first hand-written table had none of these —
  // it was directionally right and badly under-covered, which a structural check cannot notice.
  const proven: Array<[string, string]> = [
    ['著', '着'],
    ['裡', '里'],
    ['沒', '没'],
    ['別', '别'],
    ['妳', '你'],
    ['懷', '怀'],
    ['憶', '忆'],
    ['夠', '够'],
    ['壞', '坏'],
    ['瘋', '疯'],
  ];
  for (const [traditional, simplified] of proven) {
    assert.equal(toSimplified(traditional), simplified, traditional);
  }
});

test('characters that only look like a pair are left alone', () => {
  // 像/象 and 的/地 both passed the provenance filter — two songs each, one dominant partner — and are
  // not folds: they are distinct characters in both orthographies, so those were two lyric versions
  // choosing different words. Folding them would make genuinely different lines compare equal, which is
  // this bug pointing backwards.
  assert.equal(toSimplified('像'), '像');
  assert.equal(toSimplified('的'), '的');
  // Same for the one apparent contradiction in the data: 課/科 appeared six times in one song, and 科 is
  // a different word rather than a Simplified form.
  assert.equal(toSimplified('課'), '课');
});

// ---- what it was for --------------------------------------------------------

test('a Traditional catalogue answering a Simplified query is the same track', () => {
  // Measured before the fix: 0.467 with no duration, 0.567 with an exact one — both under the 0.62
  // threshold, so correct lyrics were thrown away as the wrong song.
  const asked = { title: '独角兽', artist: '吴青峰' };

  const noDuration = score({ ...asked, durationMs: 0 }, '獨角獸', '吳青峰', 0);
  assert.ok(noDuration >= MATCH_THRESHOLD, `no duration scored ${noDuration.toFixed(3)}`);

  const exact = score({ ...asked, durationMs: 200_000 }, '獨角獸', '吳青峰', 200_000);
  assert.ok(exact >= MATCH_THRESHOLD, `exact duration scored ${exact.toFixed(3)}`);
});

test('it does not make the matcher a pushover', () => {
  // The risk of folding is accepting a different song by the same artist. A genuinely different title
  // must still lose, with everything else in its favour.
  const different = score(
    { title: '独角兽', artist: '吴青峰', durationMs: 200_000 },
    '完全不同的歌曲名稱',
    '吴青峰',
    200_000,
  );
  assert.ok(different < MATCH_THRESHOLD, `a different song scored ${different.toFixed(3)}`);
});

test('two orthographies of one line read as the same line', () => {
  // What the merge alignment and the cross-check both rest on. Unfolded, these share almost no
  // codepoints and score near zero, which reads as a different song.
  assert.ok(similarity('這樣過來說話', '这样过来说话') > 0.9);
});

// ---- the thing that must not change ----------------------------------------

test('folding stays out of the cache key', () => {
  // `foldTight` derives `cacheKey`. Folding there would change the key of every Chinese track already
  // stored: the entries would never be read again, and the next play would file a duplicate and re-fetch
  // from every source. The whole library would silently orphan itself on deploy.
  assert.equal(foldTight('獨角獸'), '獨角獸');
  assert.notEqual(foldTight('獨角獸'), foldTight('独角兽'));

  assert.equal(cacheKey({ title: '獨角獸', artist: '吳青峰', durationMs: 200_000 }), 'q:獨角獸|吳青峰|100');
  assert.notEqual(
    cacheKey({ title: '獨角獸', artist: '吳青峰', durationMs: 200_000 }),
    cacheKey({ title: '独角兽', artist: '吴青峰', durationMs: 200_000 }),
  );

  // And `fold`, which is for comparing, must do the opposite.
  assert.equal(fold('獨角獸'), fold('独角兽'));
});
