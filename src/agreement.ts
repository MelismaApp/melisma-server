/**
 * What the other sources think of a candidate.
 *
 * `timing.ts` asks whether a document is consistent with *itself* and with the track's length. It
 * cannot ask the question that actually matters — "are these the right words for this song?" — because
 * nothing inside one document answers it. A complete, well-timed, internally perfect transcription of
 * the wrong song passes every check there is.
 *
 * This server is the only place that question can be asked cheaply, and the reason is structural: it
 * holds four to six answers for the same track at the same moment, which no client does. The archive
 * says it is worth asking. Measured over 339 tracks with two or more archived documents, 2111 pairs:
 *
 *  - **Text agreement is bimodal, with a real gap.** 1556 of 2111 pairs align more than 90% of their
 *    lines, and 92 pairs align under 10%. Between 10% and 40% there are 12. There is no "somewhat the
 *    same song" — either the words match or they are a different song.
 *
 *  - **Timing agreement is tight once the words match.** Removing the median offset first, because a
 *    constant offset is a different master rather than a disagreement: 1765 of 1809 pairs sit within
 *    500ms of each other, and 1472 within 250ms. Only 24 exceed two seconds.
 *
 * Both failures the archive contains were invisible to every single-document check:
 *
 *  - LE SSERAFIM's *Irony* from NetEase is a Japanese song — different words, different language,
 *    starting 89 seconds into a 144-second track. Internally flawless, and it aligned with 0% of the
 *    lines of the three sources that agreed with each other at over 90%.
 *  - Musixmatch's *Borderline* is a different mix, 19.6 seconds displaced from the three sources that
 *    agree with each other to within 250ms. The words are right; the timings belong to another cut.
 *
 * The two get different treatment, which is the point of separating them. Wrong words are worthless
 * and are thrown away — merging them would splice another song's lines into this one. Wrong timings on
 * the right words are still worth keeping for the words, so that candidate simply may not own the
 * clock.
 *
 * **This needs three sources to say anything.** With two disagreeing answers there is no way to tell
 * which one is wrong, and guessing would be worse than doing nothing — so with fewer than three, every
 * verdict here is `ok`.
 */

import { alignTo } from './align.ts';
import type { LyricLine, LyricsDocument } from './model.ts';
import { detectScript, type Script } from './text.ts';

/**
 * The share of lines that must align for two documents to be about the same song.
 *
 * Set inside the measured gap. Nothing in the archive between 10% and 40% was a real match, and
 * nothing above 40% was a different song.
 */
export const AGREES_SHARE = 0.3;

/** How much of a document must align with another before its *timings* are worth comparing. */
export const COMPARABLE_SHARE = 0.6;

/**
 * How far two documents' timings may drift apart, after the constant offset between them is removed,
 * and still be describing the same recording.
 *
 * Two seconds is deliberately loose: 97.6% of the archive's pairs agree within 500ms, so anything at
 * two seconds is already far outside normal, and the cases this is meant to catch were 11 to 19
 * seconds out. A loose line here costs a real disagreement nothing and protects a sloppy-but-correct
 * source from being punished for rounding.
 */
export const CORROBORATES_SPREAD_MS = 2_000;

/**
 * Which writing system a document is in, from a sample of its lines.
 *
 * This is what makes the words test safe, and it was a measured save rather than a precaution. Apple's
 * 弥渡山歌 aligned with 4% of the three sources that agreed with each other at over 90%, which reads
 * exactly like a different song — and it is the same song: 山对山来崖对崖 against 山對山來崖對崖,
 * Simplified against Traditional. The same words, sharing no codepoints, so character similarity is
 * blind to it and would have thrown away a perfectly good document.
 *
 * Timing cannot rescue that case, which was the first thing tried and is worth writing down: a K-pop
 * track and its Japanese version share an arrangement, so AMLL's Japanese *CRAZY* sits within 599ms of
 * the Korean everyone else returned while being the wrong words entirely. The clock says "same
 * recording" for both the script variant and the language version.
 *
 * The script is what separates them. Same system with different characters is a transliteration of one
 * language — keep it. A different system is a different language, which on a track someone is listening
 * to means the wrong words, whatever the clock says.
 */
function scriptOf(doc: LyricsDocument): Script {
  // A sample, because detecting on one line is noisy and on four hundred is pointless.
  const sample = doc.lines
    .filter((line) => line.role === 'lead')
    .slice(0, 20)
    .map((line) => line.text)
    .join(' ');
  return detectScript(sample);
}

/** What the rest of the sources make of one candidate. */
export type Verdict =
  | { kind: 'ok' }
  /** The words are a different song. Unusable, and dangerous to merge from. */
  | { kind: 'wrong-song'; detail: string }
  /** The words are right and the timings belong to another recording. Keep the words only. */
  | { kind: 'wrong-recording'; detail: string };

export interface Judged {
  provider: string;
  verdict: Verdict;
}

interface Pairing {
  /** Share of the smaller document's lines that found a partner. */
  agreement: number;
  /** Median gap between paired lines, once the constant offset is removed. Null if too few pairs. */
  spreadMs: number | null;
  offsetMs: number | null;
}

function lead(doc: LyricsDocument): LyricLine[] {
  return doc.lines.filter((line) => line.role === 'lead');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * How much two documents agree, on the words and then on the clock.
 *
 * The alignment is the merge's own — the same Needleman–Wunsch pass that decides which line of one
 * source corresponds to which line of another, so "agreement" here means exactly what the merge means
 * by it and cannot drift from it.
 */
export function comparePair(a: LyricsDocument, b: LyricsDocument): Pairing {
  const left = lead(a);
  const right = lead(b);
  if (left.length === 0 || right.length === 0) return { agreement: 0, spreadMs: null, offsetMs: null };

  const aligned = alignTo(left, right);
  const pairs: Array<[LyricLine, LyricLine]> = [];
  for (const [index, line] of left.entries()) {
    const partner = aligned[index];
    if (partner) pairs.push([line, partner]);
  }

  const agreement = pairs.length / Math.min(left.length, right.length);
  // Four is the floor for a median to mean anything; below it one bad pair is the answer.
  if (pairs.length < 4) return { agreement, spreadMs: null, offsetMs: null };

  const deltas = pairs.map(([l, r]) => l.startMs - r.startMs);
  const offsetMs = median(deltas);
  return { agreement, offsetMs, spreadMs: median(deltas.map((d) => Math.abs(d - offsetMs))) };
}

interface Subject {
  provider: string;
  doc: LyricsDocument;
}

/**
 * Judges every candidate against the others.
 *
 * Deliberately not a score. A candidate is condemned only when the sources that disagree with it agree
 * with *each other* — a majority that holds together. Two sources that merely differ produce no verdict
 * at all, because the evidence does not name which of them is wrong.
 */
export function crossCheck(subjects: Subject[]): Judged[] {
  const verdicts: Judged[] = subjects.map((s) => ({ provider: s.provider, verdict: { kind: 'ok' } }));
  // A short-circuit, not the guarantee. Removing it changes no verdict — both rules below already
  // require two *other* sources to corroborate each other, which two candidates can never supply — so
  // this only skips the pairwise work. Said plainly because a redundant guard that looks load-bearing
  // is how a later edit deletes the real one by mistake.
  if (subjects.length < 3) return verdicts;

  // One pass, reused by both questions.
  const pairings = new Map<string, Pairing>();
  const at = (i: number, j: number): Pairing => {
    const forward = pairings.get(`${i}:${j}`);
    if (forward) return forward;
    const computed = comparePair(subjects[i].doc, subjects[j].doc);
    pairings.set(`${i}:${j}`, computed);
    pairings.set(`${j}:${i}`, computed);
    return computed;
  };
  for (let i = 0; i < subjects.length; i++) {
    for (let j = i + 1; j < subjects.length; j++) at(i, j);
  }

  const others = (self: number): number[] =>
    subjects.map((_, index) => index).filter((index) => index !== self);

  for (let self = 0; self < subjects.length; self++) {
    const rest = others(self);

    // ---- the words ---------------------------------------------------------
    const bestAgreement = Math.max(...rest.map((other) => at(self, other).agreement));
    // The rest have to corroborate each other, or a lone disagreement proves nothing.
    const restAgree = rest.some((a) =>
      rest.some((b) => a !== b && at(a, b).agreement >= 1 - AGREES_SHARE),
    );

    // Only when this document is in a different writing system from the sources that agree with each
    // other. Same system and different characters is Simplified against Traditional, which is the same
    // words and must be kept — see `scriptOf`.
    const mine = scriptOf(subjects[self].doc);
    const theirs = rest.map((other) => scriptOf(subjects[other].doc));
    const majorityScript = theirs
      .map((script) => ({ script, n: theirs.filter((s) => s === script).length }))
      .sort((a, b) => b.n - a.n)[0]?.script;

    if (bestAgreement < AGREES_SHARE && restAgree && majorityScript && mine !== majorityScript) {
      verdicts[self].verdict = {
        kind: 'wrong-song',
        detail: `${mine} words where every other source has ${majorityScript} (aligned ${Math.round(bestAgreement * 100)}% of lines)`,
      };
      continue;
    }

    // ---- the clock --------------------------------------------------------
    // Only asked of documents that carry timings and whose words line up; there is nothing to compare
    // otherwise, and an unsynced document has no clock to be wrong about.
    if (subjects[self].doc.kind === 'static') continue;

    const comparable = rest.filter(
      (other) =>
        subjects[other].doc.kind !== 'static' &&
        at(self, other).spreadMs !== null &&
        at(self, other).agreement >= COMPARABLE_SHARE,
    );
    if (comparable.length < 2) continue;

    const corroborated = comparable.some((other) => (at(self, other).spreadMs ?? 0) <= CORROBORATES_SPREAD_MS);
    // And again: the others must hold together before a disagreement means anything.
    const restCorroborate = comparable.some((a) =>
      comparable.some(
        (b) =>
          a !== b &&
          at(a, b).spreadMs !== null &&
          (at(a, b).spreadMs ?? 0) <= CORROBORATES_SPREAD_MS &&
          at(a, b).agreement >= COMPARABLE_SHARE,
      ),
    );

    if (!corroborated && restCorroborate) {
      const drift = Math.min(...comparable.map((other) => at(self, other).spreadMs ?? Infinity));
      verdicts[self].verdict = {
        kind: 'wrong-recording',
        detail: `timings agree with no other source (nearest ${(drift / 1000).toFixed(1)}s adrift)`,
      };
    }
  }

  return verdicts;
}
