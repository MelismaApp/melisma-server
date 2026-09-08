import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseLrc, attachLrcTranslation } from '../src/format/lrc.ts';
import { parseNeteasePayload, parseYrc } from '../src/format/netease.ts';
import { parseRichSync } from '../src/format/musixmatch.ts';
import { parseColorLyrics } from '../src/format/spotify.ts';
import { formatTime, parseTime, parseTtml, writeTtml } from '../src/format/ttml.ts';
import { validate } from '../src/model.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// ---- TTML -----------------------------------------------------------------

test('a real community TTML file parses, readings and all', () => {
  const doc = parseTtml(fixture('amll-sample.ttml'))!;
  assert.equal(doc.kind, 'syllable');
  assert.equal(doc.lines.length, 4);
  assert.ok(doc.hasRomanization);
  assert.ok(doc.hasTranslation);

  const first = doc.lines[0];
  assert.equal(first.text, '夢ならば');
  assert.equal(first.startMs, 1372);
  assert.equal(first.endMs, 2705);
  assert.equal(first.romanized, 'yu me na ra ba');
  assert.equal(first.translated, '如果只是一场梦');
  assert.equal(first.translationLang, 'zh-CN');
  // The reading and the translation are untimed siblings of the syllables. A parser that
  // misses that splices romaji into the song at 0:00.
  assert.equal(first.syllables.length, 4);
  assert.ok(first.syllables.every((s) => s.startMs > 0));
});

test('a line-level reading is never pushed onto the syllables', () => {
  // Nine mora against four syllables: there is no mapping, and inventing one would
  // desynchronise the karaoke.
  const doc = parseTtml(fixture('amll-sample.ttml'))!;
  assert.ok(doc.lines.every((l) => l.syllables.every((s) => s.romanized === undefined)));
});

test('background vocals become their own line', () => {
  const doc = parseTtml(`
    <tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">
      <body><div>
        <p begin="1.0" end="3.0" itunes:key="L1"
          ><span begin="1.0" end="2.0">lead</span
          ><span ttm:role="x-bg"><span begin="2.0" end="3.0">ooh</span></span></p>
      </div></body>
    </tt>`)!;
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].role, 'lead');
  assert.equal(doc.lines[1].role, 'background');
  assert.equal(doc.lines[1].text, 'ooh');
});

test('word boundaries survive: a space between spans, and none inside a word', () => {
  const doc = parseTtml(`
    <tt itunes:timing="Word"><body><div>
      <p begin="0" end="3"><span begin="0" end="1">to</span><span begin="1" end="2">geth</span><span begin="2" end="2.5">er</span> <span begin="2.5" end="3">now</span></p>
    </div></body></tt>`)!;
  const syllables = doc.lines[0].syllables;
  assert.deepEqual(
    syllables.map((s) => s.partOfWord),
    [false, true, true, false],
  );
  assert.equal(doc.lines[0].text, 'together now');
});

test('duet agents mark the second voice as opposite-aligned', () => {
  const doc = parseTtml(`
    <tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">
      <head><metadata>
        <ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>
      </metadata></head>
      <body><div>
        <p begin="0" end="1" ttm:agent="v1"><span begin="0" end="1">mine</span></p>
        <p begin="1" end="2" ttm:agent="v2"><span begin="1" end="2">yours</span></p>
      </div></body></tt>`)!;
  assert.equal(doc.lines[0].oppositeAligned, false);
  assert.equal(doc.lines[1].oppositeAligned, true);
});

test('Apple keeps alternates in a metadata block, keyed by line', () => {
  const doc = parseTtml(`
    <tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">
      <head><metadata><iTunesMetadata>
        <translations><translation type="subtitle" xml:lang="en">
          <text for="L1">If it were a dream</text>
        </translation></translations>
        <transliterations><transliteration xml:lang="ja-Latn">
          <text for="L1"><span for="L1.1">yume</span><span for="L1.2">naraba</span></text>
        </transliteration></transliterations>
      </iTunesMetadata></metadata></head>
      <body><div>
        <p begin="0" end="2" itunes:key="L1"><span begin="0" end="1">夢</span><span begin="1" end="2">ならば</span></p>
      </div></body></tt>`)!;
  const line = doc.lines[0];
  assert.equal(line.translated, 'If it were a dream');
  assert.equal(line.translationLang, 'en');
  // Per-syllable readings are the good kind: the karaoke sweep can run across the romaji.
  assert.equal(line.syllables[0].romanized, 'yume');
  assert.equal(line.syllables[1].romanized, 'naraba');
});

test('TTML survives a round trip', () => {
  const original = parseTtml(fixture('amll-sample.ttml'))!;
  const again = parseTtml(writeTtml(original))!;

  assert.equal(again.lines.length, original.lines.length);
  for (const [index, line] of original.lines.entries()) {
    assert.equal(again.lines[index].text, line.text);
    assert.equal(again.lines[index].startMs, line.startMs);
    assert.equal(again.lines[index].romanized, line.romanized);
    assert.equal(again.lines[index].translated, line.translated);
    assert.equal(again.lines[index].syllables.length, line.syllables.length);
  }
});

test('clock values parse in every form these sources emit', () => {
  assert.equal(parseTime('1.372'), 1372); // the community database
  assert.equal(parseTime('00:06.617'), 6617); // Apple
  assert.equal(parseTime('1:02:03.500'), 3_723_500);
  assert.equal(parseTime('1500ms'), 1500);
  assert.equal(parseTime('1.5s'), 1500);
  assert.equal(parseTime('12f'), undefined); // frames: nothing here emits them
  assert.equal(parseTime(undefined), undefined);
  assert.equal(formatTime(6617), '00:06.617');
  assert.equal(formatTime(3_723_500), '1:02:03.500');
});

test('input that is not TTML is a null, not a throw', () => {
  assert.equal(parseTtml('not xml at all'), null);
  assert.equal(parseTtml('<html><body>wrong root</body></html>'), null);
  assert.equal(parseTtml('<tt><body><div></div></body></tt>'), null); // no lines
});

test('a truncated file still yields the lines it did contain', () => {
  // Deliberately tolerant: a response cut off mid-transfer is worth reading up to the cut,
  // and every caller already handles a null for the cases that are really unusable.
  const doc = parseTtml('<tt itunes:timing="Line"><body><div><p begin="1.0">first</p><p begin="2.0">unclosed')!;
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].text, 'first');
  assert.equal(doc.lines[1].text, 'unclosed');
});

test('entities and CDATA decode', () => {
  const doc = parseTtml(`
    <tt itunes:timing="Line"><body><div>
      <p begin="0" end="1">Rock &amp; roll &#x2014; &lt;yes&gt;</p>
    </div></body></tt>`)!;
  assert.equal(doc.lines[0].text, 'Rock & roll — <yes>');
});

// ---- LRC ------------------------------------------------------------------

test('plain LRC closes each line at the next one', () => {
  const doc = parseLrc('[00:01.00]first\n[00:04.50]second')!;
  assert.equal(doc.kind, 'line');
  assert.equal(doc.lines[0].startMs, 1000);
  assert.equal(doc.lines[0].endMs, 4500);
  assert.equal(doc.lines[1].endMs, 8500); // the last line gets a nominal window
});

test('enhanced LRC gives real syllables', () => {
  const doc = parseLrc('[00:10.00]<00:10.00>Is <00:10.50>this <00:11.00>real')!;
  assert.equal(doc.kind, 'syllable');
  assert.deepEqual(
    doc.lines[0].syllables.map((s) => [s.text, s.startMs]),
    [
      ['Is', 10_000],
      ['this', 10_500],
      ['real', 11_000],
    ],
  );
});

test('a repeated timestamp means the line is sung twice', () => {
  const doc = parseLrc('[00:10.00][00:40.00]chorus')!;
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].startMs, 10_000);
  assert.equal(doc.lines[1].startMs, 40_000);
});

test('two entries on one timestamp are a bilingual file', () => {
  const doc = parseLrc('[00:01.00]Yume naraba\n[00:01.00]どれほど\n[00:05.00]next')!;
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].text, 'Yume naraba');
  assert.equal(doc.lines[0].translated, 'どれほど');
});

test('a duplicated line is not treated as its own translation', () => {
  const doc = parseLrc('[00:01.00]same words\n[00:01.00]Same Words!')!;
  assert.equal(doc.lines[0].translated, undefined);
});

test('the offset tag shifts everything', () => {
  const doc = parseLrc('[offset:+500]\n[00:01.00]late')!;
  assert.equal(doc.lines[0].startMs, 1500);
});

test('a separate translation file matches on by timestamp', () => {
  const base = parseLrc('[00:01.00]one\n[00:05.00]two')!;
  const merged = attachLrcTranslation(base, '[00:01.05]uno\n[00:05.00]dos', 'es');
  assert.equal(merged.lines[0].translated, 'uno');
  assert.equal(merged.lines[0].translationLang, 'es');
  assert.equal(merged.lines[1].translated, 'dos');
  assert.ok(merged.hasTranslation);
});

test('metadata-only and empty input give nothing', () => {
  assert.equal(parseLrc('[ti:Title]\n[ar:Artist]'), null);
  assert.equal(parseLrc(''), null);
});

// ---- NetEase --------------------------------------------------------------

test('yrc word timings parse, and credits do not become lyrics', () => {
  const doc = parseYrc(
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"米津玄師"}]}\n' +
      '[1372,1333](1372,377,0)夢(1749,223,0)な(1972,165,0)ら(2137,387,0)ば',
  )!;
  assert.equal(doc.kind, 'syllable');
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.lines[0].text, '夢ならば');
  assert.equal(doc.lines[0].startMs, 1372);
  assert.equal(doc.lines[0].endMs, 2705);
  assert.deepEqual(doc.songWriters, ['米津玄師']);
});

test('NetEase assembles its four tracks into one document', () => {
  const doc = parseNeteasePayload({
    yrc: { lyric: '[1000,1000](1000,500,0)夢(1500,500,0)ならば' },
    lrc: { lyric: '[00:01.00]夢ならば' },
    tlyric: { lyric: '[00:01.00]If it were a dream' },
    romalrc: { lyric: '[00:01.00]yume naraba' },
  })!;
  assert.equal(doc.kind, 'syllable');
  assert.equal(doc.lines[0].translated, 'If it were a dream');
  // NetEase translates into Chinese; saying so lets the merge judge whether it is any use.
  assert.equal(doc.lines[0].translationLang, 'zh');
  assert.equal(doc.lines[0].romanized, 'yume naraba');
});

test('NetEase falls back to the line-timed track when there is no yrc', () => {
  const doc = parseNeteasePayload({ lrc: { lyric: '[00:01.00]only lines' } })!;
  assert.equal(doc.kind, 'line');
});

// ---- Musixmatch and Spotify ----------------------------------------------

test('richsync chunks become syllables, whitespace becomes word boundaries', () => {
  const doc = parseRichSync(
    JSON.stringify([
      {
        ts: 10,
        te: 12,
        x: 'Is this real',
        l: [
          { c: 'Is', o: 0 },
          { c: ' ', o: 0.4 },
          { c: 'this', o: 0.5 },
          { c: ' ', o: 0.9 },
          { c: 'real', o: 1 },
        ],
      },
    ]),
  )!;
  const line = doc.lines[0];
  assert.equal(line.text, 'Is this real');
  assert.equal(line.syllables.length, 3);
  assert.ok(line.syllables.every((s) => s.partOfWord === false));
  assert.equal(line.syllables[0].startMs, 10_000);
  assert.equal(line.syllables[2].endMs, 12_000);
});

test('richsync keeps the whole-line text only when the chunks agree with it', () => {
  const disagreeing = parseRichSync(
    JSON.stringify([{ ts: 0, te: 1, x: 'completely different words', l: [{ c: 'hello', o: 0 }] }]),
  )!;
  // Otherwise the syllables would sweep across text they do not match.
  assert.equal(disagreeing.lines[0].text, 'hello');
});

test('Spotify lines get an end time and instrumental markers are dropped', () => {
  const doc = parseColorLyrics(
    JSON.stringify({
      lyrics: {
        syncType: 'LINE_SYNCED',
        language: 'en',
        lines: [
          { startTimeMs: '0', endTimeMs: '0', words: '♪' },
          { startTimeMs: '1000', endTimeMs: '0', words: 'first' },
          { startTimeMs: '5000', endTimeMs: '0', words: 'second' },
        ],
      },
    }),
  )!;
  assert.equal(doc.kind, 'line');
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].endMs, 5000);
});

test('an unsynced Spotify response is static, not line-timed at zero', () => {
  const doc = parseColorLyrics(
    JSON.stringify({ lyrics: { syncType: 'UNSYNCED', lines: [{ words: 'words' }] } }),
  )!;
  assert.equal(doc.kind, 'static');
});

// ---- invariants -----------------------------------------------------------

test('everything the parsers produce satisfies the document invariants', () => {
  const documents = [
    parseTtml(fixture('amll-sample.ttml'))!,
    parseLrc('[00:01.00]<00:01.00>one <00:02.00>two\n[00:05.00]three')!,
    parseYrc('[1000,1000](1000,500,0)a(1500,500,0)b')!,
  ];
  for (const doc of documents) {
    assert.deepEqual(validate(doc, 300_000), []);
  }
});
