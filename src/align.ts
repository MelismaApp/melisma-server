/**
 * Lining one source's lines up against another's.
 *
 * Its own module because two callers need it and they must not depend on each other: the merge uses it
 * to decide which line lends what, and `agreement.ts` uses it to ask whether two sources are describing
 * the same song at all. Importing it from the merge made that a cycle.
 */

import type { LyricLine } from './model.ts';
import { similarity } from './text.ts';

const PAIR_ACCEPT = 0.55;
const GAP_PENALTY = 0.35;

/**
 * Lines up another source's lines against the spine's, in order.
 *
 * Needleman–Wunsch over the two line sequences, scoring a pair on how similar its text is
 * and how close its timings are. Order-preserving by construction, which is the property
 * that matters: two sources may disagree about how many lines a chorus is, but never about
 * what comes before what, so an aligner that can reorder would only ever be wrong.
 *
 * Returns, for each spine line, the other source's line that corresponds to it.
 */
export function alignTo(
  spine: LyricLine[],
  other: LyricLine[],
): (LyricLine | undefined)[] {
  const left = spine.map((l, index) => ({ line: l, index })).filter((e) => e.line.role !== 'background');
  const right = other.filter((l) => l.role !== 'background');

  const out = new Array<LyricLine | undefined>(spine.length).fill(undefined);
  if (left.length === 0 || right.length === 0) return out;

  const n = left.length;
  const m = right.length;
  // score[i][j] is the best alignment of the first i left lines with the first j right ones.
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) score[i][0] = -i * GAP_PENALTY;
  for (let j = 1; j <= m; j++) score[0][j] = -j * GAP_PENALTY;

  const pairCache: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));
  const pair = (i: number, j: number): number => {
    if (pairCache[i][j] < 0) pairCache[i][j] = pairScore(left[i].line, right[j]);
    return pairCache[i][j];
  };

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      // Centred on the accept threshold so a plausible pair is worth taking and an
      // implausible one is worth skipping.
      const diagonal = score[i - 1][j - 1] + (pair(i - 1, j - 1) - PAIR_ACCEPT);
      const up = score[i - 1][j] - GAP_PENALTY;
      const leftward = score[i][j - 1] - GAP_PENALTY;
      score[i][j] = Math.max(diagonal, up, leftward);
    }
  }

  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const diagonal = score[i - 1][j - 1] + (pair(i - 1, j - 1) - PAIR_ACCEPT);
    if (score[i][j] === diagonal) {
      if (pair(i - 1, j - 1) >= PAIR_ACCEPT) out[left[i - 1].index] = right[j - 1];
      i--;
      j--;
    } else if (score[i][j] === score[i - 1][j] - GAP_PENALTY) {
      i--;
    } else {
      j--;
    }
  }

  return out;
}

/**
 * How likely two lines are to be the same line.
 *
 * Text carries most of it, because two sources of the same song agree on the words far more
 * reliably than on the clock. Timing is the tiebreak that separates a repeated chorus line
 * from the identical one forty seconds later.
 */
function pairScore(a: LyricLine, b: LyricLine): number {
  const bothTimed = (a.endMs > 0 || a.startMs > 0) && (b.endMs > 0 || b.startMs > 0);
  const text = a.text && b.text ? similarity(a.text, b.text) : 0;

  if (!bothTimed) return text;
  if (!a.text || !b.text) return timeScore(a, b);
  return text * 0.7 + timeScore(a, b) * 0.3;
}

function timeScore(a: LyricLine, b: LyricLine): number {
  const delta = Math.abs(a.startMs - b.startMs);
  // Five seconds apart is no evidence either way; anything closer is worth something.
  return Math.max(0, 1 - delta / 5_000);
}
