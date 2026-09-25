/**
 * Whether a song's Chinese characters are Taiwanese Hokkien rather than Mandarin.
 *
 * A port of the app's `HokkienDetector`, with its tables (`src/hokkien/`, see NOTICE.txt there), so the
 * server and the phone reach the same answer. Kept to the letter, the arithmetic included: weights are
 * rounded to 32-bit floats as the app reads them, and `\s` is Java's ASCII whitespace. Built to rather
 * miss a Hokkien song than misread a Mandarin one; a tag covers the misses.
 */

import { readFileSync } from 'node:fs';

interface Model {
  chars: Map<string, number>;
  pairs: Map<string, number>;
  charFloor: number;
  pairFloor: number;
  fold: Map<string, string>;
}

let model: Model | null = null;

function load(): Model {
  const read = (name: string): string[] => {
    try {
      return readFileSync(new URL(`./hokkien/${name}`, import.meta.url), 'utf8').split('\n');
    } catch {
      // Without its tables it detects nothing, as the app's does.
      return [];
    }
  };

  const chars = new Map<string, number>();
  const pairs = new Map<string, number>();
  let charFloor = 0;
  let pairFloor = 0;
  let section = '';
  for (const line of read('detect.txt')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab);
    const parsed = Number.parseFloat(line.slice(tab + 1));
    if (Number.isNaN(parsed)) continue;
    const weight = Math.fround(parsed);
    if (key === '#u') {
      section = 'u';
      charFloor = weight;
    } else if (key === '#b') {
      section = 'b';
      pairFloor = weight;
    } else if (section === 'u' && key.length === 1) {
      chars.set(key, weight);
    } else if (section === 'b' && key.length === 2) {
      pairs.set(key, weight);
    }
  }

  // One UTF-16 unit each side, as the app reads it.
  const fold = new Map<string, string>();
  for (const line of read('fold.txt')) {
    if (line.length === 3 && line[1] === '\t') fold.set(line[0]!, line[2]!);
  }
  return { chars, pairs, charFloor, pairFloor, fold };
}

const MIN_CHARACTERS = 20;
const THRESHOLD = 0;
const UNSURE = Math.fround(-0.4);
const MARKERS_NEEDED = 2;

/** Words Mandarin does not use, and the Mandarin words that contain one of them. */
const MARKERS = ['明仔载', '知影', '按怎', '啥物', '囡仔', '查某', '恁', '袂', '毋', '喙', '厝', '媠', '佇', '拢是'];
const NOT_MARKERS = ['佇立', '佇候', '佇足'];

/** Characters written Cantonese uses and Hokkien does not, folded like the text they are counted in. */
const CANTONESE = '嘅唔咗喺冇佢哋乜嘢啲睇嚟谂嗰咁咩梗攞嘥';

/** "作词 : …", "编曲：…": credits, in Mandarin whatever the song is in. */
const CREDIT = /^[ \t\n\x0B\f\r]*[^:： \t\n\x0B\f\r]{1,16}[ \t\n\x0B\f\r]*[:：]/;

/** Kana anywhere makes the Han Japanese, as the app decides before it asks this. */
const KANA = /[぀-ヿㇰ-ㇿ]/;

/** A letter of a script that is neither Han nor Latin: Hangul, Cyrillic, Thai… */
const OTHER_LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

function fold(text: string, table: Map<string, string>): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += table.get(text[i]!) ?? text[i];
  return out;
}

function isHan(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * The detector's working: the song's average weight, how many Hokkien-only words it has, and whether
 * it reads as written Cantonese. Null when there is nothing to decide on: kana, too few Han characters,
 * a song mostly in another script, or no tables.
 */
export function hokkienScore(lines: string[]): { score: number; markers: number; cantonese: boolean } | null {
  model ??= load();
  const m = model;
  if (m.chars.size === 0) return null;
  if (lines.some((line) => KANA.test(line))) return null;

  const text = fold(lines.filter((line) => !CREDIT.test(line)).join('\n'), m.fold);
  let han = '';
  for (let i = 0; i < text.length; i++) if (isHan(text[i]!)) han += text[i];
  if (han.length < MIN_CHARACTERS) return null;

  // Only a song whose own script is Chinese: a Korean one with a line or two of Chinese is not Hokkien,
  // whatever those lines score. Latin does not count against it; 愛到明仔載 is half English.
  let otherScripts = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (OTHER_LETTER.test(char) && !isHan(char) && !LATIN.test(char)) otherScripts++;
  }
  if (otherScripts > han.length) return null;

  let cantonese = 0;
  for (let i = 0; i < han.length; i++) if (CANTONESE.includes(han[i]!)) cantonese++;

  let sum = 0;
  for (let i = 0; i < han.length; i++) sum += m.chars.get(han[i]!) ?? m.charFloor;
  for (let i = 0; i < han.length - 1; i++) sum += 0.5 * (m.pairs.get(han.slice(i, i + 2)) ?? m.pairFloor);

  let remaining = text;
  for (const word of NOT_MARKERS) remaining = remaining.split(fold(word, m.fold)).join('');
  let markers = 0;
  for (const word of MARKERS) markers += remaining.split(fold(word, m.fold)).length - 1;

  return { score: sum / han.length, markers, cantonese: cantonese * 50 >= han.length };
}

export function isHokkien(lines: string[]): boolean {
  const working = hokkienScore(lines);
  if (!working || working.cantonese) return false;
  if (working.score >= THRESHOLD) return true;
  if (working.score < UNSURE) return false;
  // Close enough to be unsure: two Hokkien-only words decide it.
  return working.markers >= MARKERS_NEEDED;
}
