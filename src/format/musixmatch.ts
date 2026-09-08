/**
 * Musixmatch's `richsync` — word-by-word timing for most Western music, and the only
 * word-level source that needs no account at all.
 *
 * The body is a JSON string holding one object per line:
 *
 *     {"ts":10.5,"te":14.2,"x":"Is this the real life",
 *      "l":[{"c":"Is","o":0},{"c":" ","o":0.28},{"c":"this","o":0.31}]}
 *
 * `ts`/`te` are the line's window in seconds. Each `l` entry is a chunk of the line with an
 * offset `o` from `ts`, and a chunk of pure whitespace is how the format marks a word
 * boundary — which is the only thing that says whether two chunks are one word or two.
 */

import { document, isRtlText, type LyricLine, type LyricsDocument, type Syllable } from '../model.ts';

interface RichSyncLine {
  ts: number;
  te: number;
  x?: string;
  l?: { c: string; o: number }[];
}

export function parseRichSync(raw: string): LyricsDocument | null {
  let parsed: RichSyncLine[];
  try {
    parsed = JSON.parse(raw) as RichSyncLine[];
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const lines: LyricLine[] = [];

  for (const entry of parsed) {
    const startMs = Math.round(entry.ts * 1000);
    const endMs = Math.round(entry.te * 1000);
    const chunks = entry.l ?? [];

    const syllables: Syllable[] = [];
    let text = '';
    let pendingSpace = true;

    for (const [index, chunk] of chunks.entries()) {
      const piece = chunk.c ?? '';
      if (piece.trim().length === 0) {
        if (piece.length > 0) pendingSpace = true;
        continue;
      }
      const chunkStart = Math.round((entry.ts + chunk.o) * 1000);
      // A chunk runs until the next one begins, whitespace included — the gap belongs to
      // the word before it, which is what a sweep across the word needs.
      const next = chunks[index + 1];
      const chunkEnd = next ? Math.round((entry.ts + next.o) * 1000) : endMs;

      const partOfWord = !pendingSpace && !/^\s/.test(piece);
      syllables.push({
        text: piece.trim(),
        startMs: chunkStart,
        endMs: Math.max(chunkEnd, chunkStart),
        partOfWord,
      });
      if (!partOfWord && text.length > 0) text += ' ';
      text += piece.trim();
      pendingSpace = /\s$/.test(piece);
    }

    // `x` is the line as Musixmatch wrote it, including punctuation and capitalisation the
    // chunks sometimes lose. Prefer it, but only when the chunks agree with it — otherwise
    // the syllables would be sweeping across text they do not match.
    const whole = (entry.x ?? '').trim();
    const resolved = whole && comparable(whole, text) ? whole : text;
    if (!resolved) continue;

    lines.push({
      role: 'lead',
      startMs,
      endMs,
      text: resolved,
      syllables,
      oppositeAligned: false,
      rtl: isRtlText(resolved),
    });
  }

  if (lines.length === 0) return null;
  return document(lines, { kind: 'syllable' });
}

/** Same letters and digits, ignoring spacing, case and punctuation. */
function comparable(a: string, b: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return fold(a) === fold(b);
}

/**
 * Musixmatch's plain subtitle body, which is an LRC file by another name.
 *
 * Kept separate from `richsync` because a track often has one and not the other, and a
 * line-timed answer is still worth having when nothing better exists.
 */
export interface MusixmatchSubtitle {
  subtitle_body?: string;
}
