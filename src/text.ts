/**
 * Text comparison, and the script rules that make it honest across alphabets.
 *
 * Everything here exists to answer one of two questions: "are these two names the same
 * thing?" and "are these two lines the same line?" — the first for picking a search result,
 * the second for lining up two sources so one can lend the other a translation.
 */

export type Script = 'japanese' | 'chinese' | 'korean' | 'cyrillic' | 'greek' | 'latin' | 'other';

export function detectScript(text: string): Script {
  let kana = 0;
  let han = 0;
  let hangul = 0;
  let cyrillic = 0;
  let greek = 0;
  let latin = 0;

  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (isKana(c)) kana++;
    else if (isHan(c)) han++;
    else if (isHangul(c)) hangul++;
    else if (c >= 0x0400 && c <= 0x052f) cyrillic++;
    else if ((c >= 0x0370 && c <= 0x03ff) || (c >= 0x1f00 && c <= 0x1fff)) greek++;
    else if (c < 0x250 && /\p{L}/u.test(ch)) latin++;
  }

  // Kana anywhere settles it: the kanji in a Japanese line must be read with Japanese
  // readings, never as Mandarin. Getting this backwards is the classic romanization bug.
  if (kana > 0) return 'japanese';
  if (hangul > 0 && hangul >= han) return 'korean';
  if (han > 0) return 'chinese';
  if (hangul > 0) return 'korean';
  if (cyrillic >= 2) return 'cyrillic';
  if (greek >= 2) return 'greek';
  if (latin > 0) return 'latin';
  return 'other';
}

function isKana(c: number): boolean {
  return (c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff);
}

function isHan(c: number): boolean {
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x20000 && c <= 0x2a6df)
  );
}

function isHangul(c: number): boolean {
  return (
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x3130 && c <= 0x318f)
  );
}

export function hasLatinLetters(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x250 && /\p{L}/u.test(ch)) return true;
  }
  return false;
}

/**
 * Whether two strings can meaningfully be compared letter by letter.
 *
 * `YOASOBI` and `YOASOBI (ヨアソビ)` can. `米津玄師` and `Kenshi Yonezu` cannot — they share
 * no characters at all, so a similarity score between them is not a low score, it is no
 * information. Treating it as a low score rejects correct matches from every catalogue that
 * indexes in the original script, which is all of the East Asian ones.
 */
export function comparableScripts(a: string, b: string): boolean {
  if (hasLatinLetters(a) && hasLatinLetters(b)) return true;
  return detectScript(a) === detectScript(b);
}

/** Lowercased, punctuation and repeated whitespace collapsed. */
export function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim();
}

/** Letters and digits only — for "is this the same words" regardless of formatting. */
export function foldTight(value: string): string {
  return value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Normalised Levenshtein similarity, 0..1.
 *
 * Capped at a few hundred characters: lyric lines are short, and the quadratic cost of
 * comparing two paragraphs by accident is not worth paying.
 */
export function similarity(a: string, b: string): number {
  const x = fold(a).slice(0, 400);
  const y = fold(b).slice(0, 400);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const distance = levenshtein(x, y);
  return Math.max(0, 1 - distance / Math.max(x.length, y.length));
}

export function levenshtein(a: string, b: string): number {
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/** The noise catalogues disagree about, removed. `Song (feat. X) - 2011 Remaster` -> `Song`. */
export function cleanTrackTitle(title: string): string {
  const withoutParentheticals = title.replace(
    /\s*[([](?:feat\.?|ft\.?|featuring|with|prod\.?|remaster(?:ed)?|live|acoustic|radio edit|single version|album version|explicit|clean|bonus track|deluxe)[^)\]]*[)\]]/gi,
    '',
  );
  const withoutSuffix = withoutParentheticals.replace(
    /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|radio edit|single version|album version|live|acoustic|instrumental)(?:\s+\d{4})?\s*$/gi,
    '',
  );
  const cleaned = withoutSuffix.trim();
  // Better a title that is only decoration than an empty string to search for.
  return cleaned.length > 0 ? cleaned : title.trim();
}

/**
 * Separators, in two groups because they behave differently.
 *
 * Punctuation can sit flush against a name; a word like `feat.` cannot, and needs the space
 * on each side or `A feat. B` splits into `A` and `. B` — the trailing `\b` lands between the
 * `t` and the `.` rather than after it.
 */
const ARTIST_SEPARATORS =
  /\s*[,;&/、，]\s*|\s+(?:feat|ft|featuring|with|vs|x)\.?\s+/gi;

export function splitArtists(artist: string): string[] {
  return artist
    .split(ARTIST_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
