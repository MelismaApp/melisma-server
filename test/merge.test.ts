import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alignTo, merge, type Candidate } from '../src/merge.ts';
import { document, line, validate, type LyricLine, type Syllable } from '../src/model.ts';

// ---- building candidates --------------------------------------------------

/** A line with word timings spread evenly across its window. */
function timed(
  text: string,
  startMs: number,
  endMs: number,
  extra: Partial<LyricLine> = {},
): LyricLine {
  const words = text.split(' ');
  const step = (endMs - startMs) / words.length;
  const syllables: Syllable[] = words.map((word, index) => ({
    text: word,
    startMs: Math.round(startMs + index * step),
    endMs: Math.round(startMs + (index + 1) * step),
    partOfWord: false,
  }));
  return line({ text, startMs, endMs, syllables, ...extra });
}

function lineOnly(text: string, startMs: number, endMs: number, extra: Partial<LyricLine> = {}) {
  return line({ text, startMs, endMs, ...extra });
}

function candidate(
  provider: string,
  lines: LyricLine[],
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    provider,
    doc: document(lines),
    match: 1,
    priority: 5,
    ...overrides,
  };
}

const VERSES = ['one two three', 'four five six', 'seven eight nine', 'ten eleven twelve'];

function fourLines(builder: (text: string, start: number, end: number) => LyricLine): LyricLine[] {
  return VERSES.map((text, index) => builder(text, 1000 + index * 4000, 4000 + index * 4000));
}

// ---- spine selection ------------------------------------------------------

test('the word-timed source owns the timing', () => {
  const result = merge([
    candidate('lrclib', fourLines(lineOnly), { priority: 0 }),
    candidate('musixmatch', fourLines(timed), { priority: 9 }),
  ]);
  // Precision beats the user's ordering: a line-timed backbone throws away syllables that
  // another source already has, and no amount of trust in LRCLIB gets them back.
  assert.equal(result.document?.provenance.timing, 'musixmatch');
  assert.equal(result.document?.kind, 'syllable');
});

test('priority breaks a tie between two equally precise sources', () => {
  const result = merge([
    candidate('netease', fourLines(timed), { priority: 7 }),
    candidate('amll', fourLines(timed), { priority: 1 }),
  ]);
  assert.equal(result.document?.provenance.timing, 'amll');
});

test('a fragment does not get to be the backbone just because it is word-timed', () => {
  // Six lines against forty is a partial file or a wrong match. Letting it win because it is
  // word-timed would throw away most of the song.
  const long = Array.from({ length: 40 }, (_, index) =>
    lineOnly(`line ${index}`, 1000 + index * 3000, 3500 + index * 3000),
  );
  const fragment = [timed('line 0', 1000, 3500), timed('line 1', 4000, 6500)];

  const result = merge([candidate('lrclib', long), candidate('amll', fragment)]);
  assert.equal(result.document?.provenance.timing, 'lrclib');
  assert.equal(result.document?.lines.length, 40);

  const rejected = result.summaries.find((summary) => summary.provider === 'amll');
  assert.match(rejected?.rejected ?? '', /too few lines/);
});

test('a single source is used even when it is short', () => {
  // The coverage guard is comparative. With nothing to compare against, a two-line answer is
  // the best answer there is.
  const result = merge([candidate('amll', [timed('only line', 1000, 3000)])]);
  assert.equal(result.document?.provenance.timing, 'amll');
});

test('no candidates means no document, not an empty one', () => {
  assert.equal(merge([]).document, null);
  assert.equal(merge([candidate('lrclib', [])]).document, null);
});

// ---- alignment ------------------------------------------------------------

test('alignment survives a source with an extra line', () => {
  const spine = fourLines(timed);
  const other = [
    lineOnly('one two three', 1000, 4000),
    lineOnly('(instrumental)', 4200, 4800),
    lineOnly('four five six', 5000, 8000),
    lineOnly('seven eight nine', 9000, 12_000),
    lineOnly('ten eleven twelve', 13_000, 16_000),
  ];

  const aligned = alignTo(spine, other);
  assert.equal(aligned[0]?.text, 'one two three');
  assert.equal(aligned[1]?.text, 'four five six');
  assert.equal(aligned[3]?.text, 'ten eleven twelve');
});

test('alignment never reorders', () => {
  // Two sources may disagree about how many lines a chorus is, but never about what comes
  // before what — so an aligner that could reorder would only ever be wrong.
  const spine = fourLines(timed);
  const other = [...fourLines(lineOnly)].reverse();
  const aligned = alignTo(spine, other);

  const matchedIndexes = aligned
    .map((matched) => (matched ? other.indexOf(matched) : -1))
    .filter((index) => index >= 0);
  const ascending = [...matchedIndexes].sort((a, b) => a - b);
  assert.deepEqual(matchedIndexes, ascending);
});

test('an unrelated source aligns to nothing', () => {
  const aligned = alignTo(fourLines(timed), [
    lineOnly('completely different words here', 60_000, 64_000),
    lineOnly('nothing in common at all', 65_000, 69_000),
  ]);
  assert.ok(aligned.every((matched) => matched === undefined));
});

// ---- borrowing ------------------------------------------------------------

test('a line-timed backbone borrows syllables that fit inside its windows', () => {
  const result = merge([
    candidate('lrclib', fourLines(lineOnly), { priority: 0 }),
    // Same words, same windows, but only a fragment — so it lends rather than leads.
    candidate('amll', [timed('one two three', 1000, 4000)], { priority: 1 }),
  ]);

  const document_ = result.document!;
  assert.equal(document_.provenance.timing, 'lrclib');
  assert.deepEqual(document_.provenance.syllables, ['amll']);
  assert.equal(document_.lines[0].syllables.length, 3);
  // And the lines it had nothing for are untouched rather than guessed at.
  assert.equal(document_.lines[1].syllables.length, 0);
  assert.deepEqual(validate(document_), []);
});

test('syllables are not borrowed when the two sources disagree about the clock', () => {
  const result = merge([
    candidate('lrclib', fourLines(lineOnly), { priority: 0 }),
    // The right words, twenty-nine seconds out.
    candidate('amll', [timed('one two three', 30_000, 33_000)], { priority: 1 }),
  ]);
  // Half a second is rounding; twenty-nine seconds is a different performance, whatever the
  // words say. Shifting them in would put the sweep nowhere near the voice.
  assert.equal(result.document?.lines[0].syllables.length, 0);
  assert.deepEqual(result.document?.provenance.syllables, []);
});

test('syllables are not borrowed when the words do not match', () => {
  const result = merge([
    candidate('lrclib', fourLines(lineOnly), { priority: 0 }),
    candidate('amll', [timed('totally other words', 1000, 4000)], { priority: 1 }),
  ]);
  assert.equal(result.document?.lines[0].syllables.length, 0);
  assert.deepEqual(result.document?.provenance.syllables, []);
});

test('a small uniform shift is accepted, because sources round differently', () => {
  const spine = fourLines(lineOnly);
  spine[0] = lineOnly('one two three', 1400, 4400);

  const result = merge([
    candidate('lrclib', spine, { priority: 0 }),
    candidate('amll', [timed('one two three', 1000, 4000)], { priority: 1 }),
  ]);
  const borrowed = result.document!.lines[0].syllables;
  assert.equal(borrowed.length, 3);
  assert.equal(borrowed[0].startMs, 1400);
  assert.deepEqual(validate(result.document!), []);
});

test('the translation comes from the source in the language that was asked for', () => {
  const chinese = fourLines(lineOnly).map((l) => ({
    ...l,
    translated: `中文 ${l.text}`,
    translationLang: 'zh',
  }));
  const english = fourLines(lineOnly).map((l) => ({
    ...l,
    translated: `english ${l.text}`,
    translationLang: 'en',
  }));

  const result = merge(
    [
      candidate('amll', fourLines(timed), { priority: 0 }),
      candidate('netease', chinese, { priority: 1 }),
      candidate('lrclib', english, { priority: 9 }),
    ],
    { preferredTranslationLang: 'en' },
  );

  // Otherwise a Chinese translation of a Japanese song wins simply by being first, which is
  // no use to somebody reading English.
  assert.equal(result.document?.provenance.translation, 'lrclib');
  assert.match(result.document!.lines[0].translated!, /^english/);
});

test('a declared language beats an undeclared one when neither is preferred', () => {
  const declared = fourLines(lineOnly).map((l) => ({
    ...l,
    translated: `de ${l.text}`,
    translationLang: 'de',
  }));
  const undeclared = fourLines(lineOnly).map((l) => ({ ...l, translated: `?? ${l.text}` }));

  const result = merge(
    [
      candidate('amll', fourLines(timed), { priority: 0 }),
      candidate('lrclib', undeclared, { priority: 1 }),
      candidate('netease', declared, { priority: 9 }),
    ],
    { preferredTranslationLang: 'en' },
  );
  assert.equal(result.document?.provenance.translation, 'netease');
});

test('a whole-line reading is borrowed, and credited', () => {
  const withReading = fourLines(lineOnly).map((l) => ({ ...l, romanized: `romaji ${l.text}` }));
  const result = merge([
    candidate('musixmatch', fourLines(timed), { priority: 0 }),
    candidate('netease', withReading, { priority: 1 }),
  ]);
  assert.equal(result.document?.provenance.romanization, 'netease');
  assert.equal(result.document?.lines[0].romanized, 'romaji one two three');
  assert.ok(result.document?.hasRomanization);
});

test('per-syllable readings are borrowed only when the syllables line up exactly', () => {
  const spine = [timed('one two three', 1000, 4000)];
  const matching = [
    {
      ...timed('one two three', 1000, 4000),
      syllables: timed('one two three', 1000, 4000).syllables.map((s) => ({
        ...s,
        romanized: s.text.toUpperCase(),
      })),
    },
  ];

  const matched = merge([
    candidate('amll', spine, { priority: 0 }),
    candidate('apple', matching, { priority: 1 }),
  ]);
  assert.deepEqual(
    matched.document?.lines[0].syllables.map((s) => s.romanized),
    ['ONE', 'TWO', 'THREE'],
  );

  // A different split means there is no mapping, so nothing is copied rather than something
  // being lined up wrongly.
  const differentSplit = [
    {
      ...timed('onetwo three', 1000, 4000),
      syllables: timed('onetwo three', 1000, 4000).syllables.map((s) => ({
        ...s,
        romanized: s.text.toUpperCase(),
      })),
    },
  ];
  const mismatched = merge([
    candidate('amll', spine, { priority: 0 }),
    candidate('apple', differentSplit, { priority: 1 }),
  ]);
  assert.ok(mismatched.document?.lines[0].syllables.every((s) => s.romanized === undefined));
});

test('background vocals are borrowed and slotted in by their timing', () => {
  const backing = [
    ...fourLines(lineOnly),
    line({ text: 'ooh', startMs: 5200, endMs: 6000, role: 'background' }),
  ];
  const result = merge([
    candidate('musixmatch', fourLines(timed), { priority: 0 }),
    candidate('apple', backing, { priority: 1 }),
  ]);

  const document_ = result.document!;
  assert.equal(document_.provenance.background, 'apple');
  const index = document_.lines.findIndex((l) => l.role === 'background');
  assert.ok(index > 0);
  // It belongs under the lead line whose window contains it.
  assert.ok(document_.lines[index - 1].startMs <= 5200);
  assert.deepEqual(validate(document_), []);
});

test('duet parts are borrowed when the backbone has only one voice', () => {
  const duet = fourLines(lineOnly).map((l, index) => ({
    ...l,
    agent: index % 2 === 0 ? 'v1' : 'v2',
    oppositeAligned: index % 2 === 1,
  }));
  const result = merge([
    candidate('musixmatch', fourLines(timed), { priority: 0 }),
    candidate('apple', duet, { priority: 1 }),
  ]);
  assert.equal(result.document?.lines[1].agent, 'v2');
  assert.equal(result.document?.lines[1].oppositeAligned, true);
});

test('credits are pooled across every source, without duplicates', () => {
  const result = merge([
    {
      ...candidate('amll', fourLines(timed)),
      doc: document(fourLines(timed), { songWriters: ['Kenshi Yonezu'] }),
    },
    {
      ...candidate('netease', fourLines(lineOnly)),
      doc: document(fourLines(lineOnly), { songWriters: ['kenshi yonezu', 'Someone Else'] }),
    },
  ]);
  assert.deepEqual(result.document?.songWriters, ['Kenshi Yonezu', 'Someone Else']);
});

// ---- safety ---------------------------------------------------------------

test('the backbone survives a source that would break the invariants', () => {
  const spine = fourLines(timed);
  // Syllables that run far past the line they claim to belong to. If this were adopted the
  // document would be invalid, so the graft has to be rolled back.
  const hostile = [
    {
      ...lineOnly('one two three', 1000, 4000),
      syllables: [
        { text: 'one', startMs: 1000, endMs: 999_000, partOfWord: false },
        { text: 'two', startMs: 500, endMs: 600, partOfWord: false },
      ],
    },
  ];

  const result = merge([
    candidate('lrclib', fourLines(lineOnly), { priority: 0 }),
    candidate('amll', hostile, { priority: 1 }),
  ]);

  assert.deepEqual(validate(result.document!), []);
  assert.equal(result.document?.lines[0].syllables.length, 0);
  assert.equal(spine.length, 4); // and nothing was mutated on the way through
});

test('merging does not mutate the candidates it was given', () => {
  const original = fourLines(timed);
  const before = JSON.stringify(original);
  merge([
    candidate('amll', original, { priority: 0 }),
    candidate('netease', fourLines(lineOnly).map((l) => ({ ...l, translated: 'x' })), {
      priority: 1,
    }),
  ]);
  assert.equal(JSON.stringify(original), before);
});

test('every candidate is reported, winners and losers alike', () => {
  const result = merge([
    candidate('amll', fourLines(timed), { priority: 0, match: 0.91 }),
    candidate('lrclib', [], { priority: 1 }),
  ]);
  assert.equal(result.summaries.length, 2);
  assert.equal(result.summaries[0].provider, 'amll');
  assert.equal(result.summaries[0].match, 0.91);
  assert.equal(result.summaries[1].rejected, 'no lines');
});
