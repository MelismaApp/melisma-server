/**
 * Spotify's `color-lyrics` response.
 *
 * Worth having for one reason only: it is matched to the exact track id rather than
 * searched for by name, so it can never be the wrong song. Its timing is line-level —
 * the `syllables` array in the response is always empty, whatever its presence suggests —
 * so in a merge it is a text-and-alignment reference rather than a candidate for the
 * timing backbone.
 */

import { document, isRtlText, type LyricLine, type LyricsDocument } from '../model.ts';

interface ColorLyricsResponse {
  lyrics?: {
    syncType?: string;
    language?: string;
    provider?: string;
    providerDisplayName?: string;
    lines?: {
      startTimeMs?: string;
      endTimeMs?: string;
      words?: string;
      syllables?: unknown[];
    }[];
  };
}

/** Spotify marks an instrumental stretch with a lone musical note. */
const INSTRUMENTAL = /^[♪♫\s]*$/;

export function parseColorLyrics(raw: string): LyricsDocument | null {
  let parsed: ColorLyricsResponse;
  try {
    parsed = JSON.parse(raw) as ColorLyricsResponse;
  } catch {
    return null;
  }

  const payload = parsed.lyrics;
  const source = payload?.lines ?? [];
  if (source.length === 0) return null;

  const unsynced = (payload?.syncType ?? '').toUpperCase() === 'UNSYNCED';
  const lines: LyricLine[] = [];

  for (const [index, entry] of source.entries()) {
    const words = (entry.words ?? '').trim();
    // Instrumental markers are not lyrics; the app draws its own interlude dots from the
    // gaps between lines, and keeping these would put a note on screen instead.
    if (!words || INSTRUMENTAL.test(words)) continue;

    const startMs = Number.parseInt(entry.startTimeMs ?? '0', 10) || 0;
    const declaredEnd = Number.parseInt(entry.endTimeMs ?? '0', 10) || 0;
    // Spotify sends `endTimeMs: "0"` on every line, so the end is the next line's start.
    const nextStart = Number.parseInt(source[index + 1]?.startTimeMs ?? '0', 10) || 0;
    const endMs = declaredEnd > startMs ? declaredEnd : nextStart > startMs ? nextStart : startMs + 4_000;

    lines.push({
      role: 'lead',
      startMs: unsynced ? 0 : startMs,
      endMs: unsynced ? 0 : endMs,
      text: words,
      syllables: [],
      oppositeAligned: false,
      rtl: isRtlText(words),
    });
  }

  if (lines.length === 0) return null;
  return document(lines, {
    kind: unsynced ? 'static' : 'line',
    language: payload?.language,
  });
}
