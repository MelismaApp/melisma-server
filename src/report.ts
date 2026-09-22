/**
 * Does what is being served actually fit the recording it was served for?
 *
 * The one check that needed the app's help and turned out not to. The app session proposed reporting
 * whether a document's timings fitted the copy playing on the phone, and their user settled the question
 * by pointing out that the evidence is already here: every lookup carries `durationMs`, the length the
 * *player* reported, and it is stored on the entry. So the question is answerable over the whole library,
 * retroactively, with no protocol change and no telemetry — and across every track at once rather than
 * one voice per phone.
 *
 * `timing.ts` runs the same check at merge time and demotes a document that fails it. This is the other
 * half: what is *already cached*, judged against what the player said, so a bad answer can be found
 * without waiting for someone to play the track and notice.
 *
 * Cheap on purpose. The merged document stores its own timings and names the source that owns them, so
 * this reads 400 entries and parses 400 JSON blobs — about a tenth of a second — instead of reparsing
 * 1,374 archived bodies, which takes a minute.
 */

import type { Store } from './db.ts';
import type { LyricsKind, MergedDocument } from './model.ts';
import { MAX_PAST_END_SHARE, PAST_END_TOLERANCE_MS } from './timing.ts';

export interface FitRow {
  key: string;
  title: string;
  artist: string;
  /** What the player said the track was, which is the whole basis of this. */
  durationMs: number;
  /** The source whose timings these are, and therefore the one to drop if they are wrong. */
  provider: string;
  kind: LyricsKind;
  /** Share of timings starting after the track ended, 0..1. */
  pastEndShare: number;
  /** How far the document runs, so "5:48 of lyrics on a 2:24 track" is visible at a glance. */
  lastTimingMs: number;
  /** How many other sources answered for this track — whether dropping this one leaves anything. */
  alternatives: number;
  /** Past the threshold the merge itself uses, so this is a different recording rather than a long tail. */
  serious: boolean;
}

export interface FitReport {
  rows: FitRow[];
  /** Entries with a duration and a document, i.e. the ones this could judge. */
  checked: number;
  /** Entries skipped because the player never reported a length: unanswerable, not passing. */
  withoutDuration: number;
  serious: number;
}

/**
 * Every cached document whose timings run past the track the player reported.
 *
 * Rows come back worst first, and only where something actually falls outside: a document that fits is
 * not news. `serious` marks the ones past the threshold `honestKind` uses — below it, a couple of
 * timings in the outro of a slightly longer master, which is normal and not worth acting on.
 */
export function timingFit(store: Store): FitReport {
  const rows: FitRow[] = [];
  let checked = 0;
  let withoutDuration = 0;

  const answered = store.providersByKey();

  for (const entry of store.allEntries()) {
    if (!entry.merged) continue;
    if (entry.durationMs <= 0) {
      withoutDuration++;
      continue;
    }

    let doc: MergedDocument;
    try {
      doc = JSON.parse(entry.merged) as MergedDocument;
    } catch {
      continue;
    }

    const lead = doc.lines.filter((line) => line.role === 'lead');
    const syllables = lead.flatMap((line) => line.syllables);
    // Syllables when there are any, because that is what the reader is following.
    const timings = syllables.length > 0 ? syllables.map((s) => s.startMs) : lead.map((l) => l.startMs);
    if (timings.length === 0) continue;

    checked++;

    const limit = entry.durationMs + PAST_END_TOLERANCE_MS;
    const past = timings.filter((ms) => ms > limit).length;
    if (past === 0) continue;

    const share = past / timings.length;
    const provider = doc.provenance?.timing ?? '';
    rows.push({
      key: entry.key,
      title: entry.title,
      artist: entry.artist,
      durationMs: entry.durationMs,
      provider,
      kind: doc.kind,
      pastEndShare: share,
      lastTimingMs: Math.max(...timings),
      // Not counting the culprit itself: this is "what is left if it goes".
      alternatives: Math.max(0, (answered.get(entry.key)?.length ?? 0) - 1),
      serious: share > MAX_PAST_END_SHARE,
    });
  }

  rows.sort((a, b) => b.pastEndShare - a.pastEndShare);
  return { rows, checked, withoutDuration, serious: rows.filter((r) => r.serious).length };
}
