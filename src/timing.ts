/**
 * Whether a document's timings agree with the song it claims to describe.
 *
 * The merge picks one candidate to own the timing and borrows everything else onto it, and it picks by
 * tier: word-timed beats line-timed beats unsynced. That is the right order and it has one hole — the
 * tier is taken from the document's own claim. A source that labels a whole line as a single "syllable"
 * claims the word-timed tier, wins the backbone against a genuinely word-timed answer, and its timings
 * are then what every client gets *and what the cache keeps*. On a phone a bad answer lasts until the
 * next lookup; here it is written down and served to everything.
 *
 * So the claim gets checked before it is ranked. These checks were calibrated on this server's own
 * archive — 384 word-timed documents across 400 tracks from four providers, most tracks answered by two
 * or three of them, which is the only reason the numbers mean anything. A provider is measurably wrong
 * about a song only when another provider is measurably right about the same song. The same checks and
 * the same constants now run in the app; this is the copy that runs before anything is cached.
 *
 * Three things the archive showed, and one it disproved:
 *
 *  - **A fragment per line, labelled word-sync.** Musixmatch richsync routinely returns one fragment
 *    holding an entire line for Chinese and Japanese: 咏春 came back as 45 "syllables" of ten characters
 *    each where NetEase had 467 of one, and Lemon as 47 against Apple's 273 and AMLL's 520. Nothing is
 *    out of order and nothing is missing — every line simply highlights in one block, which is
 *    line-sync wearing a word-sync hat. 18 of 135 Musixmatch documents were more than half such lines,
 *    against 0 of 80 from NetEase, 0 of 12 from AMLL and 1 of 157 from Apple.
 *
 *  - **One timestamp, repeated.** Apple serves unsynced lyrics as the same TTML it uses for synced
 *    ones, with no `itunes:timing` and no `begin` anywhere. 14 of 339 Apple documents were this. It
 *    reads as broken timing rather than absent timing: a full transcription that claims to follow the
 *    song, outranks a source honest about having none, and never advances off the first line.
 *
 *  - **Timings that run past the end of the track.** NetEase's Irony ran to 5:48 on a 2:24 recording,
 *    74% of its syllables starting after the song had finished; 紅 47%, Borderline 21%, AMLL's CRAZY
 *    13%. These describe a different recording — a live take, an extended mix — and no part of one is
 *    usable against what is playing. The next document down was at 2.5%, a remaster a few seconds
 *    longer and perfectly fine, so the line sits in a real gap rather than on a guess.
 *
 *  - **Syllables out of order, which is not worth acting on.** It was the first thing looked for and
 *    the archive says leave it alone: where it happens at all it is 1 to 8 syllables in a document of
 *    400, at most 1.7%, and those documents are otherwise good. No threshold catches a mangled
 *    document without also discarding a fine one, so there is no check for it.
 */

import { kindRank, type LyricLine, type LyricsDocument, type LyricsKind } from './model.ts';

/**
 * A single fragment this many characters long is a line, not a word.
 *
 * Short lines are exempt because a one-word line really is one syllable: "Oh", "Yeah" and "Hey" are
 * sung in one block and timed in one fragment by every source. Six characters is comfortably above
 * those and far below a sung phrase in any script — the coarse documents in the archive averaged five
 * to eleven characters per fragment, the genuine ones one to three for CJK and under four for English.
 */
export const WHOLE_LINE_CHARS = 6;

/**
 * The share of a document's lines that must be genuinely word-timed for it to claim the tier.
 *
 * Half, because the claim is about the document rather than about its best line. Three word-timed
 * lines in forty is a line-timed document with some detail in it.
 */
export const MIN_SYLLABLE_COVERAGE = 0.5;

/**
 * How far past the track's end a timing may sit before it counts as outside the song.
 *
 * A player's duration and a provider's idea of the same recording disagree by a second or two
 * routinely — different masters, and the trailing silence counted or not.
 */
export const PAST_END_TOLERANCE_MS = 2_000;

/** The share of timings that may start after the track has ended. See the archive numbers above. */
export const MAX_PAST_END_SHARE = 0.1;

/** The lines a listener is meant to read. Interludes are markers this server generates. */
function vocalLines(doc: LyricsDocument): LyricLine[] {
  return doc.lines.filter((line) => line.role !== 'interlude');
}

/**
 * Whether this line is word-timed in the sense that matters — that the highlight moves *through* it
 * rather than landing on all of it at once.
 */
export function hasWordTimings(line: LyricLine): boolean {
  if (line.syllables.length === 0) return false;
  if (line.syllables.length >= 2) return true;
  // One fragment, so it is word-timed only if there was one word to time.
  return line.text.trim().length < WHOLE_LINE_CHARS;
}

/**
 * Whether the document has timing information at all, as opposed to one timestamp it repeats.
 *
 * A single line is exempt: it cannot be out of step with itself, and one timestamp is all it has.
 */
export function hasUsableTimings(doc: LyricsDocument): boolean {
  const vocal = vocalLines(doc);
  if (vocal.length < 2) return true;

  const seen = new Set<number>();
  for (const line of vocal) {
    seen.add(line.startMs);
    for (const syllable of line.syllables) seen.add(syllable.startMs);
    if (seen.size >= 2) return true;
  }
  return false;
}

/**
 * Whether enough timings fall outside the track to say this describes another recording.
 *
 * Unanswerable without a duration, so a track that arrived without one gets the benefit of the doubt.
 */
export function timingsOutrunTheTrack(doc: LyricsDocument, durationMs: number): boolean {
  if (durationMs <= 0) return false;

  const vocal = vocalLines(doc);
  const syllables = vocal.flatMap((line) => line.syllables);
  const timings = syllables.length > 0 ? syllables.map((s) => s.startMs) : vocal.map((l) => l.startMs);
  if (timings.length === 0) return false;

  const limit = durationMs + PAST_END_TOLERANCE_MS;
  const past = timings.filter((ms) => ms > limit).length;
  return past / timings.length > MAX_PAST_END_SHARE;
}

/** How many of a document's lines are word-timed in the sense that matters. */
export function wordTimedLines(doc: LyricsDocument): number {
  return vocalLines(doc).filter(hasWordTimings).length;
}

function oneTierDown(kind: LyricsKind): LyricsKind {
  return kind === 'syllable' ? 'line' : 'static';
}

/**
 * The document, with its `kind` corrected to what its timings actually support.
 *
 * Applied once, where every candidate arrives and the track's duration is known, so the honest tier is
 * what gets ranked, merged, cached and served.
 *
 * A document is only ever moved *down*. These checks can prove a claim false; none of them can prove
 * one true, and a source that undersells itself is not a problem anyone has reported.
 *
 * Dropping one tier rather than straight to `static` is deliberate. When another source answered, one
 * tier is all it takes for the genuine one to win, which is the entire point. When nothing else
 * answered, these are still the only lyrics there are, and lines that scroll slightly wrong beat no
 * lyrics at all.
 */
export function honestKind(doc: LyricsDocument, durationMs: number): LyricsDocument {
  const vocal = vocalLines(doc);
  if (vocal.length === 0) return doc;

  // First, because it applies to a line-timed claim as much as a word-timed one.
  if (!hasUsableTimings(doc)) {
    return doc.kind === 'static' ? doc : { ...doc, kind: 'static' };
  }

  let kind = doc.kind;
  if (kind === 'syllable' && wordTimedLines(doc) / vocal.length < MIN_SYLLABLE_COVERAGE) {
    kind = 'line';
  }
  if (timingsOutrunTheTrack(doc, durationMs)) {
    kind = oneTierDown(kind);
  }

  // Never up, whatever the arithmetic said.
  return kindRank(kind) < kindRank(doc.kind) ? { ...doc, kind } : doc;
}
