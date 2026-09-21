import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crossCheck } from '../src/agreement.ts';
import { merge, type Candidate } from '../src/merge.ts';
import { parseNeteasePayload } from '../src/format/netease.ts';
import { document, line, type LyricLine } from '../src/model.ts';

/**
 * Asking the other sources about a candidate.
 *
 * Every case here is a real one from the archive, named. The point of the feature is that no check
 * inside a single document can catch any of them: each of these documents is complete, ordered,
 * internally consistent and — read on its own — perfectly good.
 */

function at(text: string, startMs: number): LyricLine {
  return line({ text, startMs, endMs: startMs + 2_000 });
}

/** Three sources that agree, the shape of every one of these tests. */
const ENGLISH = [
  at('No lying when it feels right', 12_800),
  at('Stop trying, baby, listen', 15_500),
  at('No hiding what it feels like', 18_700),
  at("Don't play me like a rhythm", 21_800),
  at("And I'm crying out for anything", 25_600),
];

const shifted = (lines: LyricLine[], by: number): LyricLine[] =>
  lines.map((l) => line({ ...l, startMs: l.startMs + by, endMs: l.endMs + by }));

const subject = (provider: string, lines: LyricLine[]) => ({ provider, doc: document(lines) });

test('two sources that disagree accuse nobody', () => {
  // The rule that keeps this honest. With two answers there is no way to tell which is wrong, and a
  // guess would be worse than leaving both alone.
  const verdicts = crossCheck([
    subject('apple', ENGLISH),
    subject('netease', [at('乾いた鈴の音が響く', 89_500), at('古びた記憶へと誘う', 93_500)]),
  ]);
  assert.deepEqual(verdicts.map((v) => v.verdict.kind), ['ok', 'ok']);
});

test('a source alone in another language is the wrong song', () => {
  // NetEase's LE SSERAFIM *Irony*: a Japanese song, starting 89s into a 144s Korean track, against
  // three sources that agreed with each other at over 90%.
  const verdicts = crossCheck([
    subject('apple', ENGLISH),
    subject('lrclib', shifted(ENGLISH, 40)),
    subject('musixmatch', shifted(ENGLISH, -30)),
    subject('netease', [
      at('乾いた鈴の音が響く', 89_500),
      at('古びた記憶へと誘う', 93_500),
      at('あどけない目 闇の奥', 97_690),
      at('心無き シルエット', 101_670),
      at('置き去りの血の上で', 115_600),
    ]),
  ]);

  const netease = verdicts.find((v) => v.provider === 'netease');
  assert.equal(netease?.verdict.kind, 'wrong-song');
  assert.match(netease?.verdict.detail ?? '', /japanese words where every other source has latin/);
  // And nobody else is touched by it.
  for (const other of verdicts.filter((v) => v.provider !== 'netease')) {
    assert.equal(other.verdict.kind, 'ok', other.provider);
  }
});

test('the same words in another script are not the wrong song', () => {
  // Apple's 弥渡山歌 aligned with 4% of three sources that agreed with each other — and is the same
  // song, Simplified against Traditional. This is the case that makes a text-only rule unusable: the
  // words are identical and share no codepoints.
  // Lines whose every character has a different Simplified and Traditional form, which is the case that
  // actually bites: my first attempt used 山對山來崖對崖 against 山对山来崖对崖, and those share 山 and
  // 崖 — four of seven characters identical, so it aligned at 0.57 and the rule was never reached. The
  // test passed with the script guard deleted, which is the definition of a test that checks nothing.
  const traditional = [
    at('這樣過來說話', 40),
    at('時間沒有愛會讓頭髮變', 2_140),
    at('開關記憶應該讓邊', 4_020),
    at('現在過後見證說話', 6_370),
    at('讓頭髮發現時間', 8_290),
  ];
  const simplified = [
    at('这样过来说话', 0),
    at('时间没有爱会让头发变', 2_006),
    at('开关记忆应该让边', 4_072),
    at('现在过后见证说话', 6_263),
    at('让头发现时间', 8_286),
  ];

  const verdicts = crossCheck([
    subject('spotify', traditional),
    subject('lrclib', shifted(traditional, 5)),
    subject('musixmatch', shifted(traditional, -5)),
    subject('apple', simplified),
  ]);

  assert.equal(verdicts.find((v) => v.provider === 'apple')?.verdict.kind, 'ok');
});

test('right words on another recording keeps the words and loses the clock', () => {
  // Musixmatch's *Borderline*: a different mix, 19.6s displaced from three sources agreeing to within
  // 250ms. Throwing it away would be wrong — the words are right, and may be the only copy.
  const verdicts = crossCheck([
    subject('apple', ENGLISH),
    subject('lrclib', shifted(ENGLISH, 60)),
    subject('spotify', shifted(ENGLISH, -40)),
    // Not a constant offset — that would be a different master and fine. Progressively adrift.
    subject(
      'musixmatch',
      ENGLISH.map((l, i) => line({ ...l, startMs: l.startMs + i * 5_000, endMs: l.endMs + i * 5_000 })),
    ),
  ]);

  const musixmatch = verdicts.find((v) => v.provider === 'musixmatch');
  assert.equal(musixmatch?.verdict.kind, 'wrong-recording');
  assert.match(musixmatch?.verdict.detail ?? '', /agree with no other source/);
});

test('a constant offset is a different master, not a different recording', () => {
  // Every source rounds differently, masters differ, and one source counts the intro. Punishing that
  // would demote most of the archive — so the median offset is removed before the spread is measured.
  //
  // Four seconds, deliberately past the two-second line: shifted by less than the threshold, this test
  // passed whether or not the offset was being removed at all, which made it worthless. It now fails if
  // the subtraction goes away.
  const verdicts = crossCheck([
    subject('apple', ENGLISH),
    subject('lrclib', shifted(ENGLISH, 60)),
    subject('spotify', shifted(ENGLISH, -40)),
    subject('musixmatch', shifted(ENGLISH, 4_000)),
  ]);
  assert.deepEqual(new Set(verdicts.map((v) => v.verdict.kind)), new Set(['ok']));
});

// ---- what the merge does with a verdict -------------------------------------

function candidate(provider: string, lines: LyricLine[], priority: number): Candidate {
  return { provider, doc: document(lines), match: 1, priority };
}

test('a wrong-song candidate is dropped from the merge, not merged from', () => {
  // It must not be kept as a lending source either: the merge borrows text, so a translation or a
  // reading grafted from another song would be spliced into this one line by line.
  const result = merge(
    [
      candidate('apple', ENGLISH, 0),
      candidate('lrclib', shifted(ENGLISH, 40), 5),
      candidate('spotify', shifted(ENGLISH, -30), 4),
      candidate('netease', [
        at('乾いた鈴の音が響く', 89_500),
        at('古びた記憶へと誘う', 93_500),
        at('あどけない目 闇の奥', 97_690),
        at('心無き シルエット', 101_670),
        at('置き去りの血の上で', 115_600),
      ], 2),
    ],
    { durationMs: 144_000 },
  );

  const netease = result.summaries.find((s) => s.provider === 'netease');
  assert.ok(netease?.rejected, 'it should be rejected outright');
  assert.match(netease?.rejected ?? '', /japanese words/);
  const text = result.document?.lines.map((l) => l.text).join(' ') ?? '';
  assert.ok(!text.includes('乾いた鈴'), 'and none of its words may reach the result');
});

test('netease answering "instrumental, please enjoy" is no lyrics at all', () => {
  // A sentence in the lyric field, at a timestamp, with nothing marking it as a placeholder. 14 of the
  // 316 NetEase documents in the archive, including NewJeans' OMG, which is not an instrumental.
  for (const wording of [
    '纯音乐，请欣赏', // the only form in the archive, 14 times
    '纯音乐,请欣赏', // an ASCII comma
    '此歌曲为没有填词的纯音乐，请您欣赏', // the longer wording, reported by the app side
  ]) {
    assert.equal(parseNeteasePayload({ lrc: { lyric: `[00:05.000]${wording}\n` } }), null, wording);
  }

  // But a real song mentioning it in one line is still a real song.
  const real = parseNeteasePayload({
    lrc: { lyric: '[00:05.000]这是纯音乐，请欣赏吧\n[00:09.000]还有一行真的歌词\n' },
  });
  assert.equal(real?.lines.length, 2);
});
