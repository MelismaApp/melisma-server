/**
 * TTML, in the dialect Apple Music authors its lyrics in and the community database
 * copies.
 *
 * It is the only format here that can hold everything at once — syllable timings, duet
 * agents, background vocals, readings and translations — which is why it is both an input
 * and the server's archival output. A merged document written back out as TTML can be read
 * by the app, by the community tooling, and by this parser again.
 *
 * The part that catches people out: a line's reading and translation are *untimed spans
 * sitting beside the timed ones*, so a parser that treats every span as a syllable ends up
 * splicing romaji into the song at 0:00.
 *
 *   <p begin="1.372" end="2.705" ttm:agent="v1" itunes:key="L1"
 *     ><span begin="1.372" end="1.749">夢</span>…
 *     ><span ttm:role="x-translation" xml:lang="zh-CN">如果只是一场梦</span
 *     ><span ttm:role="x-roman">yu me na ra ba</span></p>
 */

import {
  attr,
  children,
  findAll,
  isElement,
  localName,
  parseXml,
  textOf,
  escapeAttr,
  escapeText,
  type XNode,
} from '../xml.ts';
import {
  document,
  isRtlText,
  type LyricLine,
  type LyricsDocument,
  type MergedDocument,
  type Syllable,
} from '../model.ts';

const ROLE_BACKGROUND = 'x-bg';
const ROLE_ROMANIZATION = 'x-roman';
const ROLE_TRANSLATION = 'x-translation';

// ---- reading --------------------------------------------------------------

export function parseTtml(xml: string): LyricsDocument | null {
  let root: XNode;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  if (localName(root.name) !== 'tt') return null;

  const wordTiming = (attr(root, 'itunes:timing') ?? '').toLowerCase() === 'word';
  const language = attr(root, 'xml:lang');

  // Agents are declared in the head; the first one is the primary voice, and any other is
  // drawn on the opposite side.
  const agentTypes = new Map<string, string>();
  for (const agent of findAll(root, 'agent')) {
    const id = attr(agent, 'xml:id');
    if (id) agentTypes.set(id, attr(agent, 'type') ?? 'person');
  }
  const primaryAgent = [...agentTypes.keys()][0];

  const songWriters = findAll(root, 'songwriter')
    .map((node) => textOf(node).trim())
    .filter((value) => value.length > 0);

  // Apple keeps whole-line and per-syllable alternates in a metadata block, keyed by the
  // same itunes:key the lines carry.
  const byLineTransliteration = new Map<string, string>();
  const bySpanTransliteration = new Map<string, string>();
  const byLineTranslation = new Map<string, string>();
  const translationLangs = new Map<string, string>();

  for (const block of findAll(root, 'transliteration')) {
    readAlternates(block, byLineTransliteration, bySpanTransliteration);
  }
  for (const block of findAll(root, 'translation')) {
    const lang = attr(block, 'xml:lang');
    const seen = new Set<string>();
    readAlternates(block, byLineTranslation, new Map(), seen);
    if (lang) for (const key of seen) translationLangs.set(key, lang);
  }

  const lines: LyricLine[] = [];
  for (const p of findAll(root, 'p')) {
    lines.push(...readParagraph(p, primaryAgent));
  }
  if (lines.length === 0) return null;

  for (const l of lines) {
    if (!l.key) continue;
    const reading = byLineTransliteration.get(l.key);
    if (reading && !l.romanized) l.romanized = reading;
    const translation = byLineTranslation.get(l.key);
    if (translation && !l.translated) {
      l.translated = translation;
      l.translationLang = translationLangs.get(l.key) ?? l.translationLang;
    }
    if (bySpanTransliteration.size > 0) {
      l.syllables = l.syllables.map((s, index) => {
        const perSpan = bySpanTransliteration.get(`${l.key}.${index + 1}`);
        return perSpan && !s.romanized ? { ...s, romanized: perSpan } : s;
      });
    }
  }

  const anySyllables = lines.some((l) => l.syllables.length > 0);
  return document(lines, {
    kind: wordTiming || anySyllables ? 'syllable' : 'line',
    language,
    songWriters: [...new Set(songWriters)],
  });
}

/** `<text for="L1">` entries, plus `<span for="L1.2">` when they are per-syllable. */
function readAlternates(
  block: XNode,
  byLine: Map<string, string>,
  bySpan: Map<string, string>,
  seenKeys?: Set<string>,
): void {
  for (const text of findAll(block, 'text')) {
    const key = attr(text, 'for');
    if (!key) continue;
    const whole = textOf(text).replace(/\s+/g, ' ').trim();
    if (whole) {
      byLine.set(key, whole);
      seenKeys?.add(key);
    }
    for (const span of children(text, 'span')) {
      const spanKey = attr(span, 'for');
      const value = textOf(span).trim();
      if (spanKey && value) bySpan.set(spanKey, value);
    }
  }
}

/**
 * One `<p>` becomes a lead line and, if it has a background group, a second line.
 *
 * Background vocals are their own line rather than a flag on the lead one because they
 * have their own timings and overlap it — a renderer needs to draw them separately.
 */
function readParagraph(p: XNode, primaryAgent: string | undefined): LyricLine[] {
  const begin = parseTime(attr(p, 'begin'));
  const end = parseTime(attr(p, 'end'));
  const key = attr(p, 'itunes:key');
  const agent = attr(p, 'ttm:agent');

  const lead: Syllable[] = [];
  const background: Syllable[] = [];
  let leadText = '';
  let backgroundText = '';
  let romanized: string | undefined;
  let translated: string | undefined;
  let translationLang: string | undefined;
  let plainText = '';

  const state = { pendingSpaceLead: true, pendingSpaceBackground: true };

  const collect = (node: XNode, into: 'lead' | 'background'): void => {
    for (const child of node.children) {
      if (!isElement(child)) {
        // Whitespace between spans is the only thing that says where words end. Text with
        // actual content here belongs to a line-synced `<p>` with no spans at all.
        if (child.trim().length === 0) {
          if (child.length > 0) {
            if (into === 'lead') state.pendingSpaceLead = true;
            else state.pendingSpaceBackground = true;
          }
        } else if (node === p) {
          plainText += child;
        } else {
          // Loose text inside a span group, e.g. `<span>a</span>-<span>b</span>`.
          if (into === 'lead') leadText += child;
          else backgroundText += child;
        }
        continue;
      }

      if (localName(child.name) !== 'span') {
        collect(child, into);
        continue;
      }

      const role = attr(child, 'ttm:role');
      if (role === ROLE_BACKGROUND) {
        collect(child, 'background');
        continue;
      }
      if (role === ROLE_ROMANIZATION || role === ROLE_TRANSLATION) {
        const value = textOf(child).replace(/\s+/g, ' ').trim();
        if (!value) continue;
        if (role === ROLE_ROMANIZATION) romanized ??= value;
        else {
          translated ??= value;
          translationLang ??= attr(child, 'xml:lang');
        }
        continue;
      }

      // A span with timed children is a group; only leaves carry syllables.
      const timedChildren = children(child, 'span').filter(
        (grand) => attr(grand, 'begin') !== undefined,
      );
      if (timedChildren.length > 0) {
        collect(child, into);
        continue;
      }

      const raw = textOf(child);
      const text = raw.trim();
      if (!text) {
        if (raw.length > 0) {
          if (into === 'lead') state.pendingSpaceLead = true;
          else state.pendingSpaceBackground = true;
        }
        continue;
      }

      const leadingSpace = /^\s/.test(raw);
      const trailingSpace = /\s$/.test(raw);
      const pending = into === 'lead' ? state.pendingSpaceLead : state.pendingSpaceBackground;
      const partOfWord = !pending && !leadingSpace;

      const syllable: Syllable = {
        text,
        startMs: parseTime(attr(child, 'begin')) ?? 0,
        endMs: parseTime(attr(child, 'end')) ?? 0,
        partOfWord,
      };

      if (into === 'lead') {
        lead.push(syllable);
        if (!partOfWord && leadText.length > 0) leadText += ' ';
        leadText += text;
        state.pendingSpaceLead = trailingSpace;
      } else {
        background.push(syllable);
        if (!partOfWord && backgroundText.length > 0) backgroundText += ' ';
        backgroundText += text;
        state.pendingSpaceBackground = trailingSpace;
      }
    }
  };

  collect(p, 'lead');

  const out: LyricLine[] = [];
  const oppositeAligned = Boolean(agent && primaryAgent && agent !== primaryAgent);
  const resolvedLead = (leadText || plainText).replace(/\s+/g, ' ').trim();

  if (resolvedLead.length > 0 || lead.length > 0) {
    out.push({
      role: 'lead',
      startMs: begin ?? lead[0]?.startMs ?? 0,
      endMs: end ?? lead[lead.length - 1]?.endMs ?? 0,
      text: resolvedLead,
      syllables: lead,
      agent,
      oppositeAligned,
      rtl: isRtlText(resolvedLead),
      romanized,
      translated,
      translationLang,
      key,
    });
  }

  const resolvedBackground = backgroundText.replace(/\s+/g, ' ').trim();
  if (resolvedBackground.length > 0) {
    out.push({
      role: 'background',
      startMs: background[0]?.startMs ?? begin ?? 0,
      endMs: background[background.length - 1]?.endMs ?? end ?? 0,
      text: resolvedBackground,
      syllables: background,
      agent,
      oppositeAligned,
      rtl: isRtlText(resolvedBackground),
      key: key ? `${key}-bg` : undefined,
    });
  }

  return out;
}

/**
 * TTML clock values, in every form these sources actually emit.
 *
 * Apple writes `mm:ss.mmm`; the community database writes bare seconds (`1.372`); the
 * spec also allows `1.5s` and `1500ms`. Offset-time in frames or ticks is not produced by
 * anything here and is rejected rather than guessed at.
 */
export function parseTime(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  if (value.endsWith('ms')) {
    const ms = Number.parseFloat(value.slice(0, -2));
    return Number.isFinite(ms) ? Math.round(ms) : undefined;
  }
  if (value.endsWith('s')) {
    const seconds = Number.parseFloat(value.slice(0, -1));
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
  }
  if (/[a-z]$/i.test(value)) return undefined;

  const parts = value.split(':');
  const numbers = parts.map((part) => Number.parseFloat(part));
  if (numbers.some((n) => !Number.isFinite(n))) return undefined;

  switch (numbers.length) {
    case 1:
      return Math.round(numbers[0] * 1000);
    case 2:
      return Math.round(numbers[0] * 60_000 + numbers[1] * 1000);
    case 3:
      return Math.round(numbers[0] * 3_600_000 + numbers[1] * 60_000 + numbers[2] * 1000);
    default:
      return undefined;
  }
}

// ---- writing --------------------------------------------------------------

export function formatTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const millis = clamped % 1000;
  const totalSeconds = Math.floor(clamped / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const tail = `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
  return hours > 0 ? `${hours}:${tail}` : tail;
}

/**
 * Write a document back out as TTML.
 *
 * Round-trips through {@link parseTtml} and through the app's reader, and is the format to
 * hand to the community database if any of this is ever contributed back — which is the
 * only legitimate way for lyrics assembled here to help anybody else.
 */
/** The sung lines: leads, without the interludes a renderer generates for itself. */
function leadsOf(doc: LyricsDocument): LyricLine[] {
  return doc.lines.filter((l) => l.role === 'lead');
}

export function writeTtml(doc: LyricsDocument | MergedDocument, indent = '  '): string {
  const agents = new Set<string>();
  for (const l of doc.lines) if (l.agent) agents.add(l.agent);
  if (agents.size === 0) agents.add('v1');

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<tt xmlns="http://www.w3.org/ns/ttml"' +
      ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata"' +
      ' xmlns:itunes="http://music.apple.com/lyric-ttml-internal"' +
      // Only claimed when it is true. A document with no timing gets no timing attribute and
      // no begin/end, rather than a mode it cannot honour — though for that case the caller
      // should be sending plain text instead, since TTML has no way to say "unsynced".
      (doc.kind === 'static' ? '' : ` itunes:timing="${doc.kind === 'syllable' ? 'Word' : 'Line'}"`) +
      (doc.language ? ` xml:lang="${escapeAttr(doc.language)}"` : '') +
      '>',
  );

  out.push(`${indent}<head>`);
  out.push(`${indent}${indent}<metadata>`);
  for (const agent of agents) {
    out.push(
      `${indent.repeat(3)}<ttm:agent type="person" xml:id="${escapeAttr(agent)}"/>`,
    );
  }
  for (const writer of doc.songWriters) {
    out.push(`${indent.repeat(3)}<itunes:songwriter>${escapeText(writer)}</itunes:songwriter>`);
  }
  if ('provenance' in doc) {
    // Not part of the TTML vocabulary, but a comment costs nothing and answers "where did
    // this file come from" for anyone who opens it later.
    out.push(
      `${indent.repeat(3)}<!-- merged by better-lyrics-server v${doc.algorithmVersion}: ` +
        `timing=${doc.provenance.timing}` +
        (doc.provenance.translation ? `, translation=${doc.provenance.translation}` : '') +
        (doc.provenance.romanization ? `, romanization=${doc.provenance.romanization}` : '') +
        ' -->',
    );
  }
  // Per-syllable readings live in a metadata block keyed by line and span, which is where
  // Apple puts them and where this parser and the app's both look. Emitting only the timed
  // text would drop them silently — and they are the good kind of reading, the kind the
  // karaoke sweep can run across rather than a line printed underneath.
  const keyed = leadsOf(doc).map((l, index) => ({ line: l, key: l.key ?? `L${index + 1}` }));
  const withSyllableReadings = keyed.filter(({ line: l }) =>
    l.syllables.some((syllable) => syllable.romanized),
  );

  if (withSyllableReadings.length > 0) {
    out.push(`${indent.repeat(3)}<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">`);
    out.push(`${indent.repeat(4)}<transliterations>`);
    out.push(
      `${indent.repeat(5)}<transliteration` +
        (doc.language ? ` xml:lang="${escapeAttr(`${doc.language}-Latn`)}"` : '') +
        '>',
    );
    for (const { line: l, key } of withSyllableReadings) {
      const spans = l.syllables
        .map((syllable, index) =>
          syllable.romanized
            ? `<span for="${escapeAttr(`${key}.${index + 1}`)}">${escapeText(syllable.romanized)}</span>`
            : '',
        )
        .join('');
      out.push(`${indent.repeat(6)}<text for="${escapeAttr(key)}">${spans}</text>`);
    }
    out.push(`${indent.repeat(5)}</transliteration>`);
    out.push(`${indent.repeat(4)}</transliterations>`);
    out.push(`${indent.repeat(3)}</iTunesMetadata>`);
  }

  out.push(`${indent}${indent}</metadata>`);
  out.push(`${indent}</head>`);

  out.push(`${indent}<body>`);
  out.push(`${indent}${indent}<div>`);

  // Background lines are written inside the lead `<p>` they belong to, which is where the
  // format puts them and where a reader expects to find them.
  const backgrounds = doc.lines.filter((l) => l.role === 'background');

  for (const { line: l, key } of keyed) {
    const timing =
      doc.kind === 'static'
        ? ''
        : `begin="${formatTime(l.startMs)}" end="${formatTime(l.endMs)}" `;
    const attrs =
      `${timing}itunes:key="${escapeAttr(key)}"` +
      (l.agent ? ` ttm:agent="${escapeAttr(l.agent)}"` : ' ttm:agent="v1"');

    const body: string[] = [];
    if (l.syllables.length > 0) {
      for (const [j, s] of l.syllables.entries()) {
        if (j > 0 && !s.partOfWord) body.push(' ');
        body.push(
          `<span begin="${formatTime(s.startMs)}" end="${formatTime(s.endMs)}">` +
            `${escapeText(s.text)}</span>`,
        );
      }
    } else {
      body.push(escapeText(l.text));
    }

    // A background group whose window sits inside this line's belongs to it.
    for (const bg of backgrounds) {
      if (bg.startMs < l.startMs - 200 || bg.startMs > l.endMs + 200) continue;
      const inner: string[] = [];
      if (bg.syllables.length > 0) {
        for (const [j, s] of bg.syllables.entries()) {
          if (j > 0 && !s.partOfWord) inner.push(' ');
          inner.push(
            `<span begin="${formatTime(s.startMs)}" end="${formatTime(s.endMs)}">` +
              `${escapeText(s.text)}</span>`,
          );
        }
      } else {
        inner.push(escapeText(bg.text));
      }
      body.push(`<span ttm:role="x-bg">${inner.join('')}</span>`);
    }

    if (l.translated) {
      body.push(
        `<span ttm:role="x-translation"` +
          (l.translationLang ? ` xml:lang="${escapeAttr(l.translationLang)}"` : '') +
          `>${escapeText(l.translated)}</span>`,
      );
    }
    if (l.romanized) {
      body.push(`<span ttm:role="x-roman">${escapeText(l.romanized)}</span>`);
    }

    out.push(`${indent.repeat(3)}<p ${attrs}>${body.join('')}</p>`);
  }

  out.push(`${indent}${indent}</div>`);
  out.push(`${indent}</body>`);
  out.push('</tt>');
  return out.join('\n');
}
