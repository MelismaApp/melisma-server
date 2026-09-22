/**
 * Turning several sources into one document that is better than any of them.
 *
 * No single provider is best at everything. NetEase has hand-checked readings and
 * translations but only for East Asian music. Musixmatch has word timings for most Western
 * music and no translations at all. LRCLIB has broad coverage and usually only line timings.
 * Apple has the richest data and needs an account. The community database has hand-made
 * syllables and a translation into whichever language the transcriber spoke.
 *
 * So: pick one source to own the *timing*, then borrow everything else.
 *
 * The timing is not negotiable — it is the one field where mixing two sources produces
 * something worse than either, because a lyric that is half a second out is harder to sing
 * to than one with no timing at all. Everything else (translations, readings, background
 * vocals, duet parts, credits) is additive and can come from anywhere, so long as its lines
 * can be lined up with the spine's.
 *
 * Each borrow is applied on its own and checked against the document invariants. Anything
 * that would break them is rolled back, so a bad source can leave the result no better than
 * the spine but never worse.
 */

import {
  kindRank,
  validate,
  type CandidateSummary,
  type LyricLine,
  type LyricsDocument,
  type MergedDocument,
  type Provenance,
  type Syllable,
  type LyricsKind,
} from './model.ts';
import { crossCheck } from './agreement.ts';
import { alignTo } from './align.ts';
import { foldTight, similarity } from './text.ts';
import { hasWordTimings, honestKind, wordTimedLines } from './timing.ts';

/** Bump when the merge changes, so stored entries can be recomputed from raw responses. */
// 2: documents are now checked against their own claimed timing tier and against each other before
// they are ranked, so every entry merged under v1 was built without either check. Bumping this is what
// rebuilds them — at boot, from the archived bodies, without asking any provider anything.
export const MERGE_VERSION = 2;

export interface Candidate {
  provider: string;
  doc: LyricsDocument;
  /** How well the source's own metadata matched the track, 0..1. */
  match: number;
  /** The user's ordering. Lower is more trusted; breaks ties only. */
  priority: number;
  /**
   * Set when the other sources agree its timings belong to a different recording.
   *
   * Its words are still worth having; its clock is not. Kept out of the running for the spine, and never
   * allowed to promote the merged document back to word timing.
   */
  clockSuspect?: boolean;
}

export interface MergeOptions {
  durationMs?: number;
  /**
   * The language the reader actually wants, as a BCP-47 prefix. A source's translation is
   * preferred when it is in this language — otherwise a Chinese translation of a Japanese
   * song wins simply by being first, which is no use to an English reader.
   */
  preferredTranslationLang?: string;
}

export interface MergeResult {
  document: MergedDocument | null;
  /** Every candidate considered, in the order they were ranked. For the admin UI. */
  summaries: CandidateSummary[];
}

export function merge(candidates: Candidate[], options: MergeOptions = {}): MergeResult {
  const summaries: CandidateSummary[] = [];
  const usable: Candidate[] = [];

  for (const raw of candidates) {
    // Before anything is ranked, and therefore before anything is cached: the tier a document claims
    // is checked against the timings it actually carries. A line held in one "syllable" claims the
    // word-timed tier and would take the backbone off a source that means it. See `honestKind`.
    const candidate: Candidate =
      raw.doc.lines.length === 0
        ? raw
        : { ...raw, doc: honestKind(raw.doc, options.durationMs ?? 0) };

    const summary = summarise(candidate);
    if (candidate.doc.lines.length === 0) {
      summary.rejected = 'no lines';
    } else {
      if (candidate.doc.kind !== raw.doc.kind) {
        // Said out loud, because "why did Apple lose to Musixmatch" is answerable only if the
        // demotion is visible in the candidate list the admin page and `format=json` both show.
        summary.note = `timings say ${candidate.doc.kind}, not ${raw.doc.kind}`;
      }
      usable.push(candidate);
    }
    summaries.push(summary);
  }

  if (usable.length === 0) return { document: null, summaries };

  // What the sources make of each other. Nothing inside one document can tell a perfect transcription
  // of the wrong song from a perfect transcription of this one; four answers to the same question can.
  // Silent below three candidates, because two that disagree do not say which is wrong.
  const judged = crossCheck(usable.map((c) => ({ provider: c.provider, doc: c.doc })));
  const trusted: Candidate[] = [];
  for (const candidate of usable) {
    const verdict = judged.find((j) => j.provider === candidate.provider)?.verdict ?? { kind: 'ok' };
    const summary = summaries.find((s) => s.provider === candidate.provider);

    if (verdict.kind === 'wrong-song') {
      // Dropped rather than demoted. There is nothing to salvage from another song's words, and the
      // merge borrows text — a translation or a reading grafted from here would splice that song into
      // this one, line by line, and look deliberate.
      if (summary) summary.rejected = verdict.detail;
      continue;
    }

    if (verdict.kind === 'wrong-recording' && candidate.doc.kind !== 'static') {
      // Marked as well as demoted. One tier down loses the backbone to a source that means it — unless
      // the sources corroborating each other are a tier down too, in which case the reader's ordering
      // could hand the clock straight back to the one document known to have the wrong one.

      // Kept, because the words are right and may be the only copy of them. It just may not own the
      // clock: one tier down is enough to lose the backbone to anyone the others corroborate.
      const kind = candidate.doc.kind === 'syllable' ? 'line' : 'static';
      if (summary) {
        summary.note = verdict.detail;
        summary.kind = kind;
      }
      trusted.push({ ...candidate, clockSuspect: true, doc: { ...candidate.doc, kind } });
      continue;
    }

    trusted.push(candidate);
  }

  if (trusted.length === 0) return { document: null, summaries };

  const ranked = rankForSpine(trusted, summaries);
  const spine = ranked[0];
  if (!spine) return { document: null, summaries };

  const others = ranked.slice(1);
  const durationMs = options.durationMs ?? 0;

  const provenance: Provenance = {
    timing: spine.provider,
    syllables: [],
    songWriters: [],
  };

  let lines = spine.doc.lines.map(cloneLine);

  // Alignment is computed once per source and reused by every borrow below: it is the
  // expensive part, and every borrow needs the same answer to "which line is which".
  const alignments = new Map<string, (LyricLine | undefined)[]>();
  for (const other of others) {
    alignments.set(other.provider, alignTo(lines, other.doc.lines));
  }

  // ---- syllables ---------------------------------------------------------
  for (const other of others) {
    if (other.doc.kind !== 'syllable') continue;
    const aligned = alignments.get(other.provider)!;
    const next = tryGraft(lines, durationMs, (current) =>
      current.map((l, index) => {
        if (l.role === 'background' || l.syllables.length > 0) return l;
        const source = aligned[index];
        if (!source || source.syllables.length === 0) return l;
        const borrowed = fitSyllables(source, l);
        return borrowed ? { ...l, syllables: borrowed } : l;
      }),
    );
    if (next !== lines) {
      lines = next;
      provenance.syllables.push(other.provider);
    }
  }

  // ---- translation -------------------------------------------------------
  const translationSource = pickTranslationSource(
    [spine, ...others],
    options.preferredTranslationLang,
  );
  if (translationSource && translationSource.provider !== spine.provider) {
    const aligned = alignments.get(translationSource.provider)!;
    const next = tryGraft(lines, durationMs, (current) =>
      current.map((l, index) => {
        if (l.translated) return l;
        const source = aligned[index];
        if (!source?.translated) return l;
        return { ...l, translated: source.translated, translationLang: source.translationLang };
      }),
    );
    if (next !== lines) {
      lines = next;
      provenance.translation = translationSource.provider;
    }
  } else if (translationSource) {
    provenance.translation = spine.provider;
  }

  // ---- readings ----------------------------------------------------------
  for (const other of others) {
    if (!other.doc.hasRomanization) continue;
    const aligned = alignments.get(other.provider)!;
    const next = tryGraft(lines, durationMs, (current) =>
      current.map((l, index) => {
        const source = aligned[index];
        if (!source) return l;
        let updated = l;

        // Per-syllable readings are the good kind: they let the karaoke sweep run across
        // the romaji itself. Only usable when the two sources broke the line into exactly
        // the same syllables, which is rare but free to check.
        if (
          l.syllables.length > 0 &&
          l.syllables.length === source.syllables.length &&
          source.syllables.some((s) => s.romanized) &&
          l.syllables.every((s, i) => foldTight(s.text) === foldTight(source.syllables[i].text))
        ) {
          const syllables = l.syllables.map((s, i) => ({
            ...s,
            romanized: s.romanized ?? source.syllables[i].romanized,
            kana: s.kana ?? source.syllables[i].kana,
          }));
          updated = { ...updated, syllables };
        }

        if (!updated.romanized && source.romanized) {
          updated = { ...updated, romanized: source.romanized };
        }
        return updated;
      }),
    );
    if (next !== lines) {
      lines = next;
      provenance.romanization ??= other.provider;
    }
  }
  if (!provenance.romanization && spine.doc.hasRomanization) {
    provenance.romanization = spine.provider;
  }

  // ---- duet parts --------------------------------------------------------
  const spineAgents = new Set(lines.map((l) => l.agent).filter(Boolean));
  if (spineAgents.size < 2) {
    for (const other of others) {
      const agents = new Set(other.doc.lines.map((l) => l.agent).filter(Boolean));
      if (agents.size < 2) continue;
      const aligned = alignments.get(other.provider)!;
      const next = tryGraft(lines, durationMs, (current) =>
        current.map((l, index) => {
          const source = aligned[index];
          if (!source?.agent) return l;
          return { ...l, agent: source.agent, oppositeAligned: source.oppositeAligned };
        }),
      );
      if (next !== lines) {
        lines = next;
        break;
      }
    }
  }

  // ---- background vocals -------------------------------------------------
  //
  // Last, and deliberately so: this is the only borrow that inserts lines rather than filling
  // fields in, and every step above indexes `aligned` by position in the spine. Doing it any
  // earlier silently shifts those indices and hands the wrong lines each other's data.
  if (!lines.some((l) => l.role === 'background')) {
    for (const other of others) {
      const extra = other.doc.lines.filter((l) => l.role === 'background');
      if (extra.length === 0) continue;
      const next = tryGraft(lines, durationMs, (current) =>
        insertBackground(current, extra.map(cloneLine)),
      );
      if (next !== lines) {
        lines = next;
        provenance.background = other.provider;
        break;
      }
    }
  }

  // ---- credits and language ----------------------------------------------
  const songWriters: string[] = [];
  for (const candidate of [spine, ...others]) {
    for (const writer of candidate.doc.songWriters) {
      if (!songWriters.some((existing) => foldTight(existing) === foldTight(writer))) {
        songWriters.push(writer);
        if (!provenance.songWriters.includes(candidate.provider)) {
          provenance.songWriters.push(candidate.provider);
        }
      }
    }
  }

  const language =
    spine.doc.language ?? others.find((other) => other.doc.language)?.doc.language;

  // What the merged lines actually support, and never more than the spine's own corrected claim.
  //
  // `syllables.length > 0` was the test, and it undid the demotion it was supposed to respect: a document
  // of whole lines held in one "syllable" each still has syllable arrays, so a candidate just demoted to
  // line timing came back out of here claiming word timing — the candidate list said one thing and the
  // cached document said another. And a spine demoted for its *clock* must not be promoted by borrowed
  // granularity either: the borrowed syllables sit on timings that were judged to belong to another
  // recording.
  const granular = lines.some((line) => hasWordTimings(line));
  let kind: LyricsKind = spine.doc.kind;
  if (kind === 'syllable' && !granular) kind = 'line';
  else if (kind === 'line' && granular && !spine.clockSuspect) kind = 'syllable';

  const document: MergedDocument = {
    kind,
    lines,
    language,
    songWriters,
    hasRomanization: lines.some((l) => l.romanized || l.syllables.some((s) => s.romanized)),
    hasTranslation: lines.some((l) => Boolean(l.translated)),
    provenance,
    candidates: summaries,
    algorithmVersion: MERGE_VERSION,
  };

  return { document, summaries };
}

// ---- spine selection ------------------------------------------------------

/**
 * Orders candidates by how good a timing backbone each would make.
 *
 * Precision first, then coverage, then the user's ordering. The coverage guard matters more
 * than it looks: a syllable-timed candidate holding six lines of a forty-line song is a
 * partial or mismatched file, and letting it win because it is word-timed would throw away
 * most of the song.
 */
function rankForSpine(candidates: Candidate[], summaries: CandidateSummary[]): Candidate[] {
  const counts = candidates.map((c) => leadCount(c.doc)).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const floor = Math.max(3, Math.floor(median * 0.6));

  const eligible: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.clockSuspect) {
      // It may still lend its words. It may not own the clock the reader follows.
      const summary = summaries.find((s) => s.provider === candidate.provider);
      if (summary && !summary.note) summary.note = 'not trusted with the timing';
      continue;
    }
    const lines = leadCount(candidate.doc);
    if (lines < floor && candidates.length > 1) {
      // Still usable for borrowing — just not trusted to carry the whole song.
      const summary = summaries.find((s) => s.provider === candidate.provider);
      if (summary) summary.rejected = `too few lines for the backbone (${lines} vs ~${median})`;
      continue;
    }
    eligible.push(candidate);
  }

  const pool = eligible.length > 0 ? eligible : candidates;
  const sorted = [...pool].sort((a, b) => {
    const kind = kindRank(b.doc.kind) - kindRank(a.doc.kind);
    if (kind !== 0) return kind;
    // Then the reader's own ordering, and *before* any count of lines or syllables.
    //
    // It used to come after a raw count of syllable-bearing lines, which meant one line more than the
    // next source settled it and the ordering was consulted almost never — the same complaint the app
    // had, where a source ranked last kept winning. Coverage is not ignored, it is enforced earlier and
    // more bluntly: too few lines against the median is rejected outright above, and a document that is
    // not mostly word-timed has already left this tier. What is left inside one tier is twenty lines
    // against twenty-one, which is exactly what a preference is for.
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (b.match !== a.match) return b.match - a.match;
    const syllables = wordTimedLines(b.doc) - wordTimedLines(a.doc);
    if (syllables !== 0) return syllables;
    return leadCount(b.doc) - leadCount(a.doc);
  });

  // Candidates rejected as a backbone still get to lend their data, appended after the
  // ones that were eligible.
  const rest = candidates.filter((c) => !sorted.includes(c));
  return [...sorted, ...rest];
}

function leadCount(doc: LyricsDocument): number {
  return doc.lines.filter((l) => l.role !== 'background').length;
}

// Alignment lives in `align.ts` so `agreement.ts` can use it without importing this module, which
// would be a cycle. Re-exported because callers and tests already know it by this name.
export { alignTo } from './align.ts';

// ---- grafts ---------------------------------------------------------------

/**
 * Applies a change only if the document is no less valid afterwards.
 *
 * This is what keeps the merge safe. Every borrow is a guess about two sources describing
 * the same thing, and the invariants — monotonic lines, ordered syllables inside their
 * line's window — are what catch a guess that was wrong.
 */
function tryGraft(
  lines: LyricLine[],
  durationMs: number,
  produce: (current: LyricLine[]) => LyricLine[],
): LyricLine[] {
  let next: LyricLine[];
  try {
    next = produce(lines);
  } catch {
    return lines;
  }
  if (next === lines) return lines;

  const before = validate({ ...emptyShell, lines }, durationMs).length;
  const after = validate({ ...emptyShell, lines: next }, durationMs).length;
  if (after > before) return lines;

  // Nothing changed in substance — keep the original array so callers can tell.
  return changed(lines, next) ? next : lines;
}

const emptyShell: Omit<LyricsDocument, 'lines'> = {
  kind: 'syllable',
  songWriters: [],
  hasRomanization: false,
  hasTranslation: false,
};

function changed(before: LyricLine[], after: LyricLine[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return true;
  return false;
}

/**
 * Moves another source's syllables into a spine line's window.
 *
 * Accepts a uniform shift and nothing more. Stretching syllables to fit would be the
 * obvious next step and is exactly what must not happen: the timings inside a line are what
 * make it singable, and rescaling them by a source's disagreement about when the line starts
 * would smear every syllable in it.
 */
function fitSyllables(source: LyricLine, target: LyricLine): Syllable[] | null {
  if (source.syllables.length === 0) return null;
  if (!textsAgree(source.text, target.text)) return null;

  const sourceStart = source.syllables[0].startMs;
  const sourceEnd = source.syllables[source.syllables.length - 1].endMs;
  const sourceSpan = sourceEnd - sourceStart;
  const targetSpan = target.endMs - target.startMs;
  if (sourceSpan <= 0 || targetSpan <= 0) return null;

  // Two sources that disagree about how long a line lasts are not describing the same
  // performance of it, whatever the words say.
  const ratio = sourceSpan / targetSpan;
  if (ratio < 0.75 || ratio > 1.34) return null;

  const shift = target.startMs - sourceStart;
  if (Math.abs(shift) > 1_500) return null;

  const shifted = source.syllables.map((s) => ({
    ...s,
    startMs: s.startMs + shift,
    endMs: s.endMs + shift,
  }));

  const last = shifted[shifted.length - 1];
  if (shifted[0].startMs < target.startMs - 200) return null;
  if (last.endMs > target.endMs + 200) return null;
  return shifted;
}

function textsAgree(a: string, b: string): boolean {
  const left = foldTight(a);
  const right = foldTight(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // Allow a little disagreement about punctuation-adjacent characters and elisions, but
  // not about words.
  return similarity(a, b) >= 0.9;
}

/** Slots background lines into the lead sequence at the point their timing puts them. */
function insertBackground(lines: LyricLine[], background: LyricLine[]): LyricLine[] {
  const out = [...lines];
  for (const bg of background) {
    // After the last lead line that starts at or before it, which is the line it sits under.
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
      if (out[i].role !== 'background' && out[i].startMs > bg.startMs) {
        insertAt = i;
        break;
      }
    }
    out.splice(insertAt, 0, bg);
  }
  return out;
}

// ---- translation choice ---------------------------------------------------

/**
 * Which source's translations to use.
 *
 * A translation is only useful in a language the reader reads, so a declared language that
 * matches the preference beats everything. Failing that, prefer one that at least says what
 * language it is in — an undeclared translation is usually Chinese, and finding that out by
 * reading it is a poor experience.
 */
function pickTranslationSource(
  candidates: Candidate[],
  preferred: string | undefined,
): Candidate | undefined {
  const withTranslations = candidates.filter((c) => c.doc.hasTranslation);
  if (withTranslations.length === 0) return undefined;

  const prefix = preferred?.slice(0, 2).toLowerCase();
  const scoreOf = (candidate: Candidate): number => {
    const langs = new Set(
      candidate.doc.lines
        .map((l) => l.translationLang?.slice(0, 2).toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );
    const covered = candidate.doc.lines.filter((l) => l.translated).length;
    const coverage = covered / Math.max(1, candidate.doc.lines.length);

    let base = 0;
    if (prefix && langs.has(prefix)) base = 3;
    else if (langs.size > 0) base = 2;
    else base = 1;
    return base * 100 + coverage * 50 - candidate.priority;
  };

  return withTranslations.reduce((best, candidate) =>
    scoreOf(candidate) > scoreOf(best) ? candidate : best,
  );
}

// ---- reporting ------------------------------------------------------------

function summarise(candidate: Candidate): CandidateSummary {
  const langs = new Set(
    candidate.doc.lines
      .map((l) => l.translationLang)
      .filter((value): value is string => Boolean(value)),
  );
  return {
    provider: candidate.provider,
    kind: candidate.doc.kind,
    lines: candidate.doc.lines.length,
    match: Number(candidate.match.toFixed(3)),
    hasTranslation: candidate.doc.hasTranslation,
    translationLang: [...langs][0],
    hasRomanization: candidate.doc.hasRomanization,
  };
}

function cloneLine(line: LyricLine): LyricLine {
  return { ...line, syllables: line.syllables.map((s) => ({ ...s })) };
}
