/**
 * LRC, plain and enhanced.
 *
 * Plain LRC gives one timestamp per line. Enhanced LRC ("A2") adds a `<mm:ss.xx>` before
 * each word, which is a real syllable track and worth keeping — it is the only word-level
 * timing available from LRCLIB.
 *
 * Two conventions beyond the format itself, both common in the wild and both handled:
 *
 * - **Repeated timestamps.** `[00:10.00][01:20.00]same words` means the line is sung
 *   twice. It becomes two lines.
 * - **Bilingual files.** Two entries sharing a timestamp, the second being a translation
 *   of the first. Guessing wrong here would show a lyric twice, so it is only treated as a
 *   translation when the two differ in script or are not near-identical.
 */

import { document, isRtlText, type LyricLine, type LyricsDocument, type Syllable } from '../model.ts';

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const METADATA = /^\[(ar|ti|al|au|by|offset|length|re|ve|tool):(.*)\]$/i;

interface Entry {
  startMs: number;
  text: string;
  syllables: Syllable[];
}

export function parseLrc(raw: string): LyricsDocument | null {
  if (!raw.trim()) return null;

  let offsetMs = 0;
  const writers: string[] = [];
  const entries: Entry[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const meta = METADATA.exec(trimmed);
    if (meta) {
      const [, tag, value] = meta;
      if (tag.toLowerCase() === 'offset') {
        const parsed = Number.parseInt(value.trim(), 10);
        // The tag is "shift the lyrics by", so a positive offset means they arrive later.
        if (Number.isFinite(parsed)) offsetMs = parsed;
      } else if (tag.toLowerCase() === 'au' || tag.toLowerCase() === 'by') {
        const writer = value.trim();
        if (writer) writers.push(writer);
      }
      continue;
    }

    TIMESTAMP.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = TIMESTAMP.exec(trimmed)) !== null) {
      // Only leading timestamps count; one appearing mid-line is part of the lyric.
      if (match.index !== consumed) break;
      consumed = match.index + match[0].length;
      stamps.push(clock(match[1], match[2], match[3]));
    }
    if (stamps.length === 0) continue;

    const body = trimmed.slice(consumed);
    const { text, syllables } = readWords(body);
    if (!text && syllables.length === 0) continue;

    for (const stamp of stamps) {
      entries.push({
        startMs: stamp + offsetMs,
        text,
        syllables: syllables.map((s) => ({
          ...s,
          startMs: s.startMs + offsetMs,
          endMs: s.endMs + offsetMs,
        })),
      });
    }
  }

  if (entries.length === 0) return null;
  entries.sort((a, b) => a.startMs - b.startMs);

  const lines = closeWindows(entries);
  return document(lines, { songWriters: [...new Set(writers)] });
}

/**
 * Splits an enhanced-LRC body into words with their own timings.
 *
 * A body with no `<..>` stamps comes back as one piece of text and no syllables, which is
 * how a plain LRC line should read.
 */
function readWords(body: string): { text: string; syllables: Syllable[] } {
  WORD_STAMP.lastIndex = 0;
  if (!WORD_STAMP.test(body)) {
    return { text: body.trim().replace(/\s+/g, ' '), syllables: [] };
  }

  WORD_STAMP.lastIndex = 0;
  const pieces: { startMs: number; raw: string }[] = [];
  let match: RegExpExecArray | null;
  let leading = '';
  let cursor = 0;

  while ((match = WORD_STAMP.exec(body)) !== null) {
    if (pieces.length === 0 && match.index > 0) leading = body.slice(0, match.index);
    else if (pieces.length > 0) pieces[pieces.length - 1].raw = body.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    pieces.push({ startMs: clock(match[1], match[2], match[3]), raw: '' });
  }
  if (pieces.length > 0) pieces[pieces.length - 1].raw = body.slice(cursor);

  const syllables: Syllable[] = [];
  let text = leading.trim();
  let pendingSpace = text.length === 0;

  for (const [index, piece] of pieces.entries()) {
    const word = piece.raw.trim();
    if (!word) {
      pendingSpace = true;
      continue;
    }
    const partOfWord = !pendingSpace && !/^\s/.test(piece.raw);
    syllables.push({
      text: word,
      startMs: piece.startMs,
      // Closed by the next word; the last one is closed by the line below.
      endMs: pieces[index + 1]?.startMs ?? piece.startMs,
      partOfWord,
    });
    if (!partOfWord && text.length > 0) text += ' ';
    text += word;
    pendingSpace = /\s$/.test(piece.raw);
  }

  return { text: text.trim(), syllables };
}

/**
 * Gives every line an end time, and folds a repeated timestamp into a translation.
 *
 * LRC has no end times at all: a line runs until the next one starts. The last line gets a
 * nominal window, since a renderer needs something to sweep across.
 */
function closeWindows(entries: Entry[]): LyricLine[] {
  const out: LyricLine[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries[i + 1];

    // A second entry on the same timestamp is the bilingual convention. Only accept it as
    // a translation when it is actually different text — some files simply duplicate a
    // line, and showing a lyric as its own translation looks broken.
    let translated: string | undefined;
    if (next && next.startMs === entry.startMs && next.text && next.text !== entry.text) {
      const same = normalise(next.text) === normalise(entry.text);
      if (!same) {
        translated = next.text;
        i++;
      }
    }

    const following = entries[i + 1];
    const endMs = following ? following.startMs : entry.startMs + 4_000;

    const syllables = entry.syllables.map((s, index, all) => ({
      ...s,
      endMs: all[index + 1]?.startMs ?? Math.max(s.endMs, endMs),
    }));

    out.push({
      role: 'lead',
      startMs: entry.startMs,
      endMs,
      text: entry.text,
      syllables,
      oppositeAligned: false,
      rtl: isRtlText(entry.text),
      translated,
    });
  }

  return out;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function clock(minutes: string, seconds: string, fraction: string | undefined): number {
  const frac = fraction ?? '0';
  // `.5` is five hundred milliseconds, `.50` is also five hundred, `.500` likewise.
  const millis = Number.parseInt(frac.padEnd(3, '0').slice(0, 3), 10);
  return Number.parseInt(minutes, 10) * 60_000 + Number.parseInt(seconds, 10) * 1000 + millis;
}

/**
 * Attaches a separate translation track to an existing document.
 *
 * NetEase and LRCLIB both deliver translations as a whole second LRC file rather than
 * inline, so they arrive as two documents that have to be lined up by timestamp.
 */
export function attachLrcTranslation(
  doc: LyricsDocument,
  translationLrc: string,
  lang?: string,
): LyricsDocument {
  const translation = parseLrc(translationLrc);
  if (!translation) return doc;

  const lines = doc.lines.map((l) => {
    if (l.translated) return l;
    const match = nearest(translation.lines, l.startMs);
    if (!match) return l;
    return { ...l, translated: match.text, translationLang: lang };
  });

  return { ...doc, lines, hasTranslation: lines.some((l) => Boolean(l.translated)) };
}

/** The closest line by start time, within a tolerance that rules out a wrong pairing. */
function nearest(lines: LyricLine[], startMs: number, toleranceMs = 1_200): LyricLine | undefined {
  let best: LyricLine | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    const delta = Math.abs(l.startMs - startMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = l;
    }
  }
  return bestDelta <= toleranceMs ? best : undefined;
}
