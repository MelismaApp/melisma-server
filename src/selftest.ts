/**
 * Asking every source for one known track, and reporting what each said.
 *
 * The per-source `test()` proves a service can be reached and a credential is accepted. That is not
 * the same as proving a lookup works, and the difference is where the real faults have been: a token
 * that was accepted and then refused the data, a cookie that reached the browser but did not sign it
 * in, a match that scored just under the threshold. All of those pass a credential check and return
 * nothing from a lookup.
 *
 * So this runs the actual `fetch` each provider runs in a real lookup, against a track chosen so
 * that "nothing came back" cannot be explained away by the catalogue.
 */

import { PROVIDERS, type Provider } from './providers/index.ts';
import { TEST_TRACK_ID } from './providers/spotify.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { LearnedExtras } from './providers/types.ts';
import type { TrackQuery } from './match.ts';

/**
 * Blinding Lights, by The Weeknd.
 *
 * Fixed on purpose. Every field is the real one — the duration is the album version's 200,046 ms,
 * measured rather than rounded, because the remixes run 216 and 261 seconds and duration is how a
 * provider tells them apart. A test that asked with the wrong length would produce mismatches that
 * look like broken sources.
 */
export const TEST_TRACK: TrackQuery = {
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  durationMs: 200_046,
  spotifyId: TEST_TRACK_ID,
};

export interface SourceReport {
  id: string;
  label: string;
  /** True only when lyrics came back. */
  ok: boolean;
  detail: string;
  ms: number;
  /** What it learned in passing, when it learned anything. */
  learned?: string[];
}

/** Long enough for a browser harvest to finish, since one may be triggered by the lookup. */
const TIMEOUT_MS = 60_000;

export async function testSources(
  store: Store,
  config: Config,
  track: TrackQuery = TEST_TRACK,
): Promise<SourceReport[]> {
  // In parallel, as a real lookup does: six sources in turn would take longer than anyone will
  // wait, and asking them together is also the arrangement being tested.
  return Promise.all(PROVIDERS.map((provider) => testOne(provider, store, config, track)));
}

async function testOne(
  provider: Provider,
  store: Store,
  config: Config,
  track: TrackQuery,
): Promise<SourceReport> {
  const base = { id: provider.id, label: provider.label };

  if (!config.providers[provider.id]?.enabled) {
    return { ...base, ok: false, detail: 'off in settings', ms: 0 };
  }
  if (!provider.isConfigured(config)) {
    return {
      ...base,
      ok: false,
      detail: `needs ${provider.requires.join(' and ')}`,
      ms: 0,
    };
  }

  const started = performance.now();
  // Captured rather than logged and forgotten: "could not reach it" and "reached it, no lyrics" are
  // different answers, and the provider says which through `unreachable`.
  let unreachable: string | null = null;
  const learned: string[] = [];

  try {
    const answer = await withTimeout(
      provider.fetch(track, {
        config,
        log: (level, message) => store.log(level, provider.id, message),
        unreachable: (detail) => {
          unreachable = detail;
        },
        learn: (extras: LearnedExtras) => {
          for (const [key, value] of Object.entries(extras)) {
            if (value !== null && value !== undefined) learned.push(key);
          }
        },
      }),
      TIMEOUT_MS,
    );
    const ms = Math.round(performance.now() - started);

    if (answer) {
      const kind = answer.doc.kind;
      const words = answer.doc.lines.some((line) => (line.syllables?.length ?? 0) > 0);
      return {
        ...base,
        ok: true,
        ms,
        detail:
          `${answer.doc.lines.length} lines, ${kind}` +
          (words ? ', with syllable timings' : '') +
          `, match ${answer.match.toFixed(2)}` +
          (answer.note ? ` (${answer.note})` : ''),
        learned: learned.length > 0 ? [...new Set(learned)] : undefined,
      };
    }

    return {
      ...base,
      ok: false,
      ms,
      // `unreachable` is the provider's own account of why it never got an answer. Without it, the
      // honest report is that it asked and this track was not there — which for this track would
      // itself be worth knowing.
      detail: unreachable ?? 'asked, and it had nothing for this track',
      learned: learned.length > 0 ? [...new Set(learned)] : undefined,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
