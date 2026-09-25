import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { hokkienScore, isHokkien } from '../src/hokkien.ts';
import { createApp, start, type App } from '../src/server.ts';
import { MERGE_VERSION } from '../src/merge.ts';
import { line, type MergedDocument } from '../src/model.ts';

/**
 * The Hokkien detector, and the server answering with it below a tag. The detector cases are the
 * app's own (`HokkienDetectorTest`), so the two ports are held to the same answers.
 */

const hokkien = ['我毋知影你佇佗位', '阮兜的囡仔攏足乖', '伊講明仔載欲來揣我', '你莫閣講矣', '查某囡仔真媠'];
const mandarin = ['我不知道你在哪裡', '我們家的孩子都很乖', '他說明天要來找我', '你不要再說了', '那個女孩真漂亮'];

test('Hokkien is told from Mandarin', () => {
  assert.equal(isHokkien(hokkien), true);
  assert.equal(isHokkien(mandarin), false);
});

test('simplified Hokkien is still Hokkien, and scores exactly as the Traditional does', () => {
  const simplified = ['我毋知影你佇佗位', '阮兜的囡仔拢足乖', '伊讲明仔载欲来揣我', '你莫阁讲矣', '查某囡仔真媠'];
  assert.equal(isHokkien(simplified), true);
  // The weights are over folded text, so the two spellings of one song are the same song.
  const traditional = ['這個時候我們說過的話讓人難過', '還記得當時的夢想嗎', '誰會為了愛情而離開'];
  const folded = ['这个时候我们说过的话让人难过', '还记得当时的梦想吗', '谁会为了爱情而离开'];
  assert.deepEqual(hokkienScore(traditional), hokkienScore(folded));
});

test('credits do not count', () => {
  const credits = Array.from({ length: 12 }, () => '作词 : 某某某/作曲 : 某某某/编曲 : 某某某/制作人 : 某某某');
  assert.equal(isHokkien([...credits, ...hokkien]), true);
  assert.deepEqual(hokkienScore([...credits, ...mandarin]), hokkienScore(mandarin));
});

test('when the score is unsure, two Hokkien-only words decide it', () => {
  const mostlyMandarin = [
    '這個時候我們說過的話讓人難過', '還記得當時的夢想嗎', '誰會為了愛情而離開', '聽說你們已經結婚了',
    '時間過得真快啊', '毋知影',
  ];
  const working = hokkienScore(mostlyMandarin)!;
  // The case this is about; if new tables move it out of the band, pick another.
  assert.ok(working.score < 0 && working.score >= -0.4, `score ${working.score}`);
  assert.equal(working.markers, 2);
  assert.equal(isHokkien(mostlyMandarin), true);
  assert.equal(isHokkien(mostlyMandarin.slice(0, -1)), false);

  // One is not enough.
  const oneWord = [...mostlyMandarin.slice(0, -1), '毋知'];
  assert.equal(hokkienScore(oneWord)!.markers, 1);
  assert.equal(isHokkien(oneWord), false);

  // 佇立 is Mandarin, so its 佇 is not counted.
  assert.equal(hokkienScore([...mostlyMandarin.slice(0, -1), '佇立佇立'])!.markers, 0);
});

test('too little text decides nothing', () => {
  assert.equal(isHokkien(['毋知影']), false);
});

test('written Cantonese is not Hokkien', () => {
  assert.equal(isHokkien(['我唔知你喺邊度', '佢哋啲嘢好靚', '你食咗飯未呀', '我哋今日冇嘢做']), false);
  // Counted after folding, so a Traditional 諗 counts as its Simplified 谂.
  assert.deepEqual(hokkienScore([...hokkien, '諗']), hokkienScore([...hokkien, '谂']));
  assert.equal(hokkienScore([...hokkien, '諗'])!.cantonese, true);
});

test('kana anywhere makes it Japanese, as the app decides before asking', () => {
  assert.equal(isHokkien([...hokkien, 'ありがとう']), false);
});

// ---- served ---------------------------------------------------------------

let app: App;
let server: ReturnType<typeof start>;
let base: string;
let adminKey: string;

before(async () => {
  app = createApp(':memory:');
  adminKey = app.settings.read().apiKey;
  for (const id of ['apple', 'amll', 'netease', 'musixmatch', 'spotify', 'lrclib']) {
    app.settings.update({ [`provider.${id}.enabled`]: '0' });
  }
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

function cache(spotifyId: string, texts: string[]) {
  const document: MergedDocument = {
    kind: 'line',
    lines: texts.map((text, index) => line({ text, startMs: index * 2_000, endMs: index * 2_000 + 1_800 })),
    songWriters: [],
    hasRomanization: false,
    hasTranslation: false,
    provenance: { timing: 'lrclib', syllables: [], songWriters: [] },
    candidates: [],
    algorithmVersion: MERGE_VERSION,
  };
  app.store.putEntry({
    key: `sp:${spotifyId}`,
    title: 'Song',
    artist: 'Someone',
    album: '',
    durationMs: 20_000,
    spotifyId,
    isrc: null,
    merged: JSON.stringify(document),
    mergeVersion: MERGE_VERSION,
  });
  return `title=Song&artist=Someone&durationMs=20000&spotifyId=${spotifyId}`;
}

test('cached Hokkien lyrics are served as detected, on the lookup and the extras', async () => {
  const query = cache('1111111111111111111111', hokkien);
  const lookup = await fetch(`${base}/v1/lyrics?${query}&cacheOnly=1`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.headers.get('x-lyrics-language'), 'nan');
  assert.equal(lookup.headers.get('x-lyrics-language-source'), 'detected');

  const extras = (await (await fetch(`${base}/v1/extras?${query}`)).json()) as Record<string, unknown>;
  assert.deepEqual([extras.language, extras.languageSource], ['nan', 'detected']);
});

test('a song the detector does not flag is unknown, not Mandarin', async () => {
  const query = cache('2222222222222222222222', mandarin);
  const lookup = await fetch(`${base}/v1/lyrics?${query}&cacheOnly=1`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.headers.get('x-lyrics-language'), null);
});

test('a tag wins over the detector', async () => {
  const query = cache('3333333333333333333333', hokkien);
  const tagged = await fetch(`${base}/v1/language`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Song', artist: 'Someone', spotifyId: '3333333333333333333333', language: 'zh' }),
  });
  assert.equal(tagged.status, 204);
  const lookup = await fetch(`${base}/v1/lyrics?${query}&cacheOnly=1`);
  assert.equal(lookup.headers.get('x-lyrics-language'), 'zh');
  assert.equal(lookup.headers.get('x-lyrics-language-source'), 'tagged');
});
