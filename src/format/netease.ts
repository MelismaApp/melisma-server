/**
 * NetEase Cloud Music's own formats.
 *
 * `yrc` is the interesting one: real word-by-word timing, hand-checked, and by far the best
 * free source for Japanese, Korean and Chinese. It looks like this —
 *
 *     [169310,4400](169310,270,0)你(169580,250,0)说...
 *
 * a line window in square brackets, then one `(start,duration,0)` per word. The trailing
 * zero is unused in every file I have seen.
 *
 * `yrc` files also carry metadata lines that are JSON rather than lyrics, holding the
 * credits: `{"t":0,"c":[{"tx":"作词: "},{"tx":"米津玄師"}]}`. Those are songwriters, not
 * words to sing, and treating them as lyrics puts the credits on screen as line one.
 */

import { document, isRtlText, type LyricLine, type LyricsDocument, type Syllable } from '../model.ts';
import { parseLrc } from './lrc.ts';

const LINE_WINDOW = /^\[(\d+),(\d+)\]/;
const WORD = /\((\d+),(\d+),(-?\d+)\)/g;

export function parseYrc(raw: string): LyricsDocument | null {
  if (!raw.trim()) return null;

  const lines: LyricLine[] = [];
  const writers: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{')) {
      writers.push(...creditsFrom(trimmed));
      continue;
    }

    const window = LINE_WINDOW.exec(trimmed);
    if (!window) continue;
    const lineStart = Number.parseInt(window[1], 10);
    const lineDuration = Number.parseInt(window[2], 10);

    const body = trimmed.slice(window[0].length);
    WORD.lastIndex = 0;
    const syllables: Syllable[] = [];
    let text = '';
    let pendingSpace = true;
    let match: RegExpExecArray | null;
    let cursor = -1;
    let previousStart = 0;
    let previousDuration = 0;

    // The text of a word sits *after* its `(start,duration,0)` marker and runs up to the
    // next one, so each word is only complete once the following marker is in hand.
    const push = (rawWord: string, startMs: number, durationMs: number): void => {
      const word = rawWord.trim();
      if (!word) {
        if (rawWord.length > 0) pendingSpace = true;
        return;
      }
      const partOfWord = !pendingSpace && !/^\s/.test(rawWord);
      syllables.push({
        text: word,
        startMs,
        endMs: startMs + Math.max(durationMs, 1),
        partOfWord,
      });
      if (!partOfWord && text.length > 0) text += ' ';
      text += word;
      pendingSpace = /\s$/.test(rawWord);
    };

    while ((match = WORD.exec(body)) !== null) {
      if (cursor >= 0) {
        push(body.slice(cursor, match.index), previousStart, previousDuration);
      }
      previousStart = Number.parseInt(match[1], 10);
      previousDuration = Number.parseInt(match[2], 10);
      cursor = match.index + match[0].length;
    }
    if (cursor >= 0) push(body.slice(cursor), previousStart, previousDuration);

    if (syllables.length === 0 && !text) continue;

    lines.push({
      role: 'lead',
      startMs: lineStart,
      endMs: lineStart + Math.max(lineDuration, 1),
      text: text.trim(),
      syllables,
      oppositeAligned: false,
      rtl: isRtlText(text),
    });
  }

  if (lines.length === 0) return null;
  lines.sort((a, b) => a.startMs - b.startMs);
  return document(lines, { kind: 'syllable', songWriters: [...new Set(writers)] });
}

/**
 * Pulls credits out of a `yrc` metadata line.
 *
 * They arrive as label/value pairs in one array — `作词: ` then the name — so anything that
 * looks like a label is dropped and the rest kept.
 */
function creditsFrom(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { c?: { tx?: string }[] };
    return (parsed.c ?? [])
      .map((part) => (part.tx ?? '').trim())
      .filter((value) => value.length > 0 && !/[::]\s*$/.test(value))
      .filter((value) => !/^(作词|作曲|编曲|制作人|lyricist|composer|arranger)/i.test(value));
  } catch {
    return [];
  }
}

/**
 * The shape NetEase's lyric endpoint returns.
 *
 * `yrc` is word-timed, `lrc` is line-timed, `tlyric` is the translation and `romalrc` the
 * romanization — each a complete LRC file of its own, lined up by timestamp.
 */
export interface NeteaseLyricPayload {
  yrc?: { lyric?: string };
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
  romalrc?: { lyric?: string };
  klyric?: { lyric?: string };
}

/**
 * Assembles NetEase's several tracks into one document.
 *
 * The word-timed track wins the timing when it exists; the translation and romanization are
 * separate files either way and get matched onto it by start time. This is the only source
 * that hands over hand-checked readings *and* translations for free, so it is worth the
 * extra requests.
 */
export function parseNeteasePayload(payload: NeteaseLyricPayload): LyricsDocument | null {
  const wordTimed = payload.yrc?.lyric ? parseYrc(payload.yrc.lyric) : null;
  const lineTimed = payload.lrc?.lyric ? parseLrc(payload.lrc.lyric) : null;
  const base = wordTimed ?? lineTimed;
  if (!base) return null;

  let lines = base.lines;

  // The line-timed track sometimes carries text the word-timed one dropped; never let it
  // overwrite text that is already there, because the syllables are cut to fit it.
  if (wordTimed && lineTimed) {
    lines = lines.map((l) =>
      l.text ? l : { ...l, text: nearestText(lineTimed.lines, l.startMs) ?? l.text },
    );
  }

  const translations = payload.tlyric?.lyric ? parseLrc(payload.tlyric.lyric) : null;
  const readings = payload.romalrc?.lyric ? parseLrc(payload.romalrc.lyric) : null;

  if (translations || readings) {
    lines = lines.map((l) => {
      const translated = translations ? nearestText(translations.lines, l.startMs) : undefined;
      const romanized = readings ? nearestText(readings.lines, l.startMs) : undefined;
      return {
        ...l,
        translated: l.translated ?? translated,
        // NetEase's translations are into Chinese; saying so lets the merge decide whether
        // they are any use to a reader who asked for something else.
        translationLang: l.translated ? l.translationLang : translated ? 'zh' : undefined,
        romanized: l.romanized ?? romanized,
      };
    });
  }

  return document(lines, {
    kind: wordTimed ? 'syllable' : base.kind,
    songWriters: base.songWriters,
  });
}

function nearestText(lines: LyricLine[], startMs: number, toleranceMs = 1_200): string | undefined {
  let best: LyricLine | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    const delta = Math.abs(l.startMs - startMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = l;
    }
  }
  return bestDelta <= toleranceMs ? best?.text || undefined : undefined;
}
