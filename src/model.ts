/**
 * The one shape every source is converted into.
 *
 * Deliberately the same shape the Android app already renders, so a merged document can
 * be handed straight to it — the server's whole job is to produce one of these that is
 * better than any single provider's answer.
 *
 * The field that matters most is `syllables`. A line-timed lyric tells you when a line
 * starts; a syllable-timed one tells you when each sound starts, which is the difference
 * between following along and singing along. Everything in the merge engine exists to end
 * up with as many syllable-timed lines as possible.
 */

export type LineRole = 'lead' | 'background' | 'interlude';

/** How precise the timings are. Ordering matters: see {@link kindRank}. */
export type LyricsKind = 'syllable' | 'line' | 'static';

export function kindRank(kind: LyricsKind): number {
  switch (kind) {
    case 'syllable':
      return 3;
    case 'line':
      return 2;
    case 'static':
      return 1;
  }
}

export interface Syllable {
  text: string;
  startMs: number;
  endMs: number;
  /**
   * True when this syllable continues the previous one with no space between them —
   * `to`+`geth`+`er`, not `to geth er`. Without it a renderer cannot tell a word split
   * across syllables from two separate words.
   */
  partOfWord: boolean;
  /** Latin transcription of this syllable specifically, when a source supplies one. */
  romanized?: string;
  /** Kana reading, for furigana. Only Japanese sources and analysers provide it. */
  kana?: string;
}

export interface LyricLine {
  role: LineRole;
  startMs: number;
  endMs: number;
  text: string;
  syllables: Syllable[];
  /** `ttm:agent` — which voice sings this. Two distinct agents mean a duet. */
  agent?: string;
  /** True when this voice should be drawn on the opposite side, for duets. */
  oppositeAligned: boolean;
  rtl: boolean;
  /** Whole-line Latin transcription. Mora-by-mora in the community corpus. */
  romanized?: string;
  translated?: string;
  /** BCP-47 tag of `translated`, when the source declares one. Decides usability. */
  translationLang?: string;
  /** `itunes:key`, the source's own line id. Kept so re-merges stay stable. */
  key?: string;
}

export interface LyricsDocument {
  kind: LyricsKind;
  lines: LyricLine[];
  /** BCP-47 tag of the lyrics themselves. */
  language?: string;
  songWriters: string[];
  hasRomanization: boolean;
  hasTranslation: boolean;
}

/** What each part of a merged document came from, so the app can credit it. */
export interface Provenance {
  /** The source whose line and syllable timings form the backbone. */
  timing: string;
  /** Sources that contributed syllables to lines the spine had none for. */
  syllables: string[];
  translation?: string;
  romanization?: string;
  /** Source of background-vocal lines the spine lacked. */
  background?: string;
  songWriters: string[];
}

export interface CandidateSummary {
  provider: string;
  kind: LyricsKind;
  lines: number;
  /** How well the candidate's own metadata matched what was asked for, 0..1. */
  match: number;
  hasTranslation: boolean;
  translationLang?: string;
  hasRomanization: boolean;
  /** Set when the candidate was fetched but thrown away, with the reason. */
  rejected?: string;
}

export interface MergedDocument extends LyricsDocument {
  provenance: Provenance;
  /** Every source that answered, including the ones that lost. For the admin UI. */
  candidates: CandidateSummary[];
  /** Bumped whenever the merge changes, so old entries can be recomputed. */
  algorithmVersion: number;
}

export const EMPTY_DOCUMENT: LyricsDocument = {
  kind: 'static',
  lines: [],
  songWriters: [],
  hasRomanization: false,
  hasTranslation: false,
};

// ---- construction helpers -------------------------------------------------

export function line(partial: Partial<LyricLine> & { text: string }): LyricLine {
  return {
    role: 'lead',
    startMs: 0,
    endMs: 0,
    syllables: [],
    oppositeAligned: false,
    rtl: isRtlText(partial.text),
    ...partial,
  };
}

/**
 * Finishes a document: derives `kind` and the `has*` flags from the lines rather than
 * trusting a provider to have set them, and drops lines with nothing in them.
 */
export function document(
  lines: LyricLine[],
  extra: Partial<Omit<LyricsDocument, 'lines'>> = {},
): LyricsDocument {
  const kept = lines.filter((l) => l.text.trim().length > 0 || l.syllables.length > 0);
  const anySyllables = kept.some((l) => l.syllables.length > 0);
  const anyTiming = kept.some((l) => l.endMs > 0 || l.startMs > 0);

  return {
    kind: extra.kind ?? (anySyllables ? 'syllable' : anyTiming ? 'line' : 'static'),
    lines: kept,
    language: extra.language,
    songWriters: extra.songWriters ?? [],
    hasRomanization:
      extra.hasRomanization ??
      kept.some((l) => l.romanized || l.syllables.some((s) => s.romanized)),
    hasTranslation: extra.hasTranslation ?? kept.some((l) => Boolean(l.translated)),
  };
}

/**
 * Whether a line reads right-to-left.
 *
 * Counts letters rather than looking at the first character: a Hebrew line that opens
 * with a Latin loan word is still Hebrew, and a mostly-Latin line with one Arabic word
 * is not.
 */
export function isRtlText(text: string): boolean {
  let rtl = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isRtlCodePoint(code)) rtl++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  return rtl > 0 && rtl >= other;
}

function isRtlCodePoint(code: number): boolean {
  return (
    (code >= 0x0590 && code <= 0x05ff) || // Hebrew
    (code >= 0x0600 && code <= 0x06ff) || // Arabic
    (code >= 0x0700 && code <= 0x074f) || // Syriac
    (code >= 0x0750 && code <= 0x077f) || // Arabic Supplement
    (code >= 0x08a0 && code <= 0x08ff) || // Arabic Extended-A
    (code >= 0xfb1d && code <= 0xfdff) || // Presentation forms
    (code >= 0xfe70 && code <= 0xfeff)
  );
}

// ---- invariants -----------------------------------------------------------

/**
 * Everything a document must satisfy to be worth serving.
 *
 * The merge engine grafts data from one source onto another's timings, which is exactly
 * the kind of operation that produces a plausible-looking document that plays wrong. Each
 * graft is checked against this and rolled back if it breaks anything, so a bad source
 * can degrade the result to "no better than the spine" but never to "worse".
 */
export function validate(doc: LyricsDocument, durationMs = 0): string[] {
  const problems: string[] = [];

  let previousStart = -1;
  for (const [index, l] of doc.lines.entries()) {
    if (l.startMs < 0 || l.endMs < 0) problems.push(`line ${index}: negative time`);
    if (l.endMs > 0 && l.endMs < l.startMs) problems.push(`line ${index}: ends before it starts`);
    // Background vocals legitimately overlap the lead line they sit under, so only the
    // lead sequence has to advance.
    if (l.role === 'lead') {
      if (l.startMs < previousStart) problems.push(`line ${index}: starts before the previous lead`);
      previousStart = l.startMs;
    }
    if (durationMs > 0 && l.startMs > durationMs + 15_000) {
      problems.push(`line ${index}: starts after the song ends`);
    }

    let syllableEnd = -1;
    for (const [j, s] of l.syllables.entries()) {
      if (s.endMs < s.startMs) problems.push(`line ${index}.${j}: syllable ends before it starts`);
      if (s.startMs + 1 < syllableEnd) problems.push(`line ${index}.${j}: syllables overlap`);
      syllableEnd = s.endMs;
    }
    if (l.syllables.length > 0) {
      const first = l.syllables[0];
      const last = l.syllables[l.syllables.length - 1];
      // A tolerance, not equality: sources round differently and a few ms either way is
      // invisible. A second out means the syllables belong to a different line.
      if (first.startMs + 1_000 < l.startMs || last.endMs > l.endMs + 1_000) {
        problems.push(`line ${index}: syllables fall outside the line's window`);
      }
    }
  }

  return problems;
}
