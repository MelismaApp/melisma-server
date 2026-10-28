import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Settings } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { parseTtml } from '../src/format/ttml.ts';
import { activeProviders, PROVIDERS } from '../src/providers/index.ts';
import { lrcred } from '../src/providers/lrcred.ts';
import type { LearnedExtras } from '../src/providers/types.ts';

/**
 * lrc.red: Apple's lyrics file by ISRC, keyless. The fixture is the head of the real file for
 * Blinding Lights, with a translation added in the form their files carry one.
 */

const TTML =
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:lrc="http://lrc.red/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" lrc:timing="Word" xml:lang="en">' +
  '<head><metadata><ttm:agent type="person" xml:id="v1"><ttm:name type="full">Vocal 1</ttm:name></ttm:agent>' +
  '<sourceMetadata xmlns="http://lrc.red/lyric-ttml-internal" leadingSilence="0">' +
  '<translations><translation type="subtitle" xml:lang="zh-Hans"><text for="L1">我一直想打给你</text></translation></translations>' +
  '<songwriters><songwriter>Abel Tesfaye</songwriter></songwriters><audio lyricOffset="1.115" role="spatial"/></sourceMetadata></metadata></head>' +
  '<body dur="3:21.570"><div begin="27.395" end="32.529" lrc:songPart="Verse">' +
  '<p begin="27.395" end="28.960" lrc:key="L1" ttm:agent="v1"><span begin="27.395" end="27.549">I</span> <span begin="27.549" end="27.740">been</span> <span begin="27.740" end="28.077">tryna</span> <span begin="28.077" end="28.960">call</span></p>' +
  '<p begin="30.189" end="32.529" lrc:key="L2" ttm:agent="v1"><span begin="30.189" end="30.396">I\'ve</span> <span begin="30.396" end="30.642">been</span> <span begin="30.642" end="31.839">on my own</span><span ttm:role="x-bg" begin="31.839" end="32.529"><span begin="31.839" end="32.529">(hey)</span></span></p>' +
  '</div></body></tt>';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(answer: (url: URL) => Response | undefined) {
  const asked: { url: URL; headers: Headers }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ url, headers: new Headers(init?.headers) });
    const reply = answer(url);
    if (!reply) throw new Error(`unexpected request to ${url}`);
    return reply;
  }) as typeof fetch;
  return asked;
}

const ttml = () => new Response(TTML, { headers: { 'Content-Type': 'application/ttml+xml; charset=utf-8' } });

function context() {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  const reasons: string[] = [];
  const learned: LearnedExtras[] = [];
  return {
    ctx: {
      config: settings.read(),
      log: () => {},
      unreachable: (detail: string) => reasons.push(detail),
      learn: (extras: LearnedExtras) => learned.push(extras),
    },
    reasons,
    learned,
    close: () => store.close(),
  };
}

const BLINDING = { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 200_046 };

test("their TTML is Apple's under another prefix, and the parser reads it as it comes", () => {
  const doc = parseTtml(TTML)!;
  assert.equal(doc.kind, 'syllable');
  assert.equal(doc.lines[0]!.text, 'I been tryna call');
  assert.equal(doc.lines[0]!.translated, '我一直想打给你');
  assert.equal(doc.lines[1]!.syllables.length, 3);
  // The backing vocal becomes its own line, as it does from Apple's file.
  assert.equal(doc.lines.length, 3);
  assert.equal(doc.lines[2]!.role, 'background');
  assert.equal(doc.lines[2]!.text, '(hey)');
  assert.deepEqual(doc.songWriters, ['Abel Tesfaye']);
});

test('by ISRC it is one request, archived as served, with a User-Agent that says who is asking', async () => {
  const asked = stub((url) => (url.href === 'https://lrc.red/s/USUG11904206.ttml' ? ttml() : undefined));
  const { ctx, reasons, learned, close } = context();
  try {
    const answer = await lrcred.fetch({ ...BLINDING, isrc: 'usug11904206' }, ctx);
    assert.equal(answer?.doc.kind, 'syllable');
    assert.equal(answer?.match, 1);
    assert.equal(answer?.raw.body, TTML);
    assert.equal(answer?.raw.contentType, 'application/ttml+xml');
    assert.equal(answer?.note, 'word-timed');
    assert.equal(asked.length, 1);
    assert.match(asked[0]!.headers.get('user-agent') ?? '', /^MelismaServer\/\S+ \(.*https:\/\/github\.com\/MelismaApp\/melisma-server.*contact /);
    assert.deepEqual(reasons, []);
    assert.deepEqual(learned, [], 'an ISRC the caller had is nothing new');
    // What the app's credit line names, as their terms ask.
    assert.equal(lrcred.label, 'lrc.red');
    assert.ok(PROVIDERS.includes(lrcred));
  } finally {
    close();
  }
});

test('without an ISRC the search finds the recording by name and length, and the ISRC is learned', async () => {
  const hits = [
    { isrc: 'USUG12004507', title: 'Blinding Lights (Remix)', artist: 'The Weeknd, ROSALÍA', duration: 216.123 },
    { isrc: 'USUG11904206', title: 'Blinding Lights', artist: 'The Weeknd', duration: 200.046 },
  ];
  const asked = stub((url) => {
    if (url.pathname === '/search.json') return Response.json({ hits, next: null });
    if (url.pathname === '/s/USUG11904206.ttml') return ttml();
    return undefined;
  });
  const { ctx, learned, close } = context();
  try {
    const answer = await lrcred.fetch(BLINDING, ctx);
    assert.equal(answer?.doc.kind, 'syllable');
    // An exact title, artist and length: the search's own score, not the 1 an ISRC in hand earns.
    assert.ok(answer!.match >= 0.9, `match ${answer?.match}`);
    assert.equal(asked[0]!.url.searchParams.get('q'), 'Blinding Lights The Weeknd');
    assert.deepEqual(asked.map((call) => call.url.pathname), ['/search.json', '/s/USUG11904206.ttml']);
    assert.deepEqual(learned, [{ isrc: 'USUG11904206' }]);
  } finally {
    close();
  }
});

test('a search that finds nothing close asks for no file', async () => {
  const asked = stub((url) =>
    url.pathname === '/search.json'
      ? Response.json({ hits: [{ isrc: 'USUG11904206', title: 'Something Else', artist: 'Nobody', duration: 200.0 }] })
      : undefined,
  );
  const { ctx, learned, close } = context();
  try {
    assert.equal(await lrcred.fetch(BLINDING, ctx), null);
    assert.equal(asked.length, 1);
    assert.deepEqual(learned, []);
  } finally {
    close();
  }
});

test('an ISRC not shaped like one never reaches the URL', async () => {
  const asked = stub(() => undefined);
  const { ctx, close } = context();
  try {
    assert.equal(await lrcred.fetch({ ...BLINDING, isrc: '../search' }, ctx), null);
    assert.equal(asked.length, 0);
  } finally {
    close();
  }
});

test('the archived body re-merges, and it is asked by default right behind Apple', () => {
  assert.equal(lrcred.reparse(TTML, 'application/ttml+xml')?.kind, 'syllable');
  const store = new Store(':memory:');
  try {
    // No tokens: Apple is not configured, and the keyless sources are asked in this order.
    const ids = activeProviders(new Settings(store).read()).map((provider) => provider.id);
    assert.equal(ids[0], 'lrcred');
    assert.ok(ids.indexOf('lrcred') < ids.indexOf('amll'));
  } finally {
    store.close();
  }
});

test('a 404 is a settled miss; 429 and 5xx are the service being unavailable', async () => {
  let status = 404;
  stub(() => new Response('', { status }));
  const { ctx, reasons, close } = context();
  try {
    assert.equal(await lrcred.fetch({ ...BLINDING, isrc: 'USUG11904206' }, ctx), null);
    assert.deepEqual(reasons, [], 'not held is an answer, not an outage');
    // 429 last: the transport backs the host off after it, for the rest of this process.
    for (status of [503, 429]) {
      assert.equal(await lrcred.fetch({ ...BLINDING, isrc: 'USUG11904206' }, ctx), null);
    }
    assert.deepEqual(reasons, ['ttml: HTTP 503', 'ttml: HTTP 429']);
  } finally {
    close();
  }
});
