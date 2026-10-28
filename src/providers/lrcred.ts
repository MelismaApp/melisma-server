/**
 * lrc.red: Apple Music's lyrics file, served by ISRC with no token.
 *
 * The same TTML Apple serves — word timings, translations, transliterations, backing vocals — for
 * nothing but a well-mannered request, so it is asked before the Apple token is spent. Its namespace
 * prefix is `lrc:` where Apple's is `itunes:`; the parser matches attributes by local name, so the
 * file is read and archived as it arrives.
 *
 * Their terms: a User-Agent naming the app with a link and a contact (the transport's), and the data
 * credited and linked wherever it is shown, which is what `label` is for. Rate limited; lifting is
 * by arrangement with api@lrc.red.
 */

import { cleanTitleOf, MATCH_THRESHOLD, primaryArtistOf, score, type TrackQuery } from '../match.ts';
import { isUnavailable, json, query, request } from '../http.ts';
import { parseTtml } from '../format/ttml.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

const BASE = 'https://lrc.red';
/** Spliced into a path, so only a thing shaped like an ISRC goes in. */
const ISRC = /^[A-Z0-9]{12}$/;
/** Blinding Lights, which they hold word-timed with a translation and backing vocals. */
const TEST_ISRC = 'USUG11904206';

interface Hit {
  isrc?: string;
  title?: string;
  artist?: string;
  album?: string;
  /** Seconds, with decimals. */
  duration?: number;
}

export const lrcred: Provider = {
  id: 'lrcred',
  label: 'lrc.red',
  description:
    "Apple Music's lyrics by ISRC, with no token: word timings, translations, readings and backing vocals.",
  requires: [],
  wordLevel: true,
  usesIsrc: true,
  origin: 'apple',
  isConfigured: () => true,

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const found = track.isrc ? { isrc: track.isrc.toUpperCase(), match: 1 } : await search(track, ctx);
    if (!found || !ISRC.test(found.isrc)) return null;

    const reply = await request(`${BASE}/s/${found.isrc}.ttml`);
    // Not held: a real answer, worth caching as one.
    if (reply.status === 404) return null;
    if (!reply.ok || isUnavailable(reply)) {
      ctx.unreachable(`ttml: HTTP ${reply.status}`);
      return null;
    }

    const doc = parseTtml(reply.body);
    if (!doc || doc.lines.length === 0) {
      ctx.log('warn', `lrc.red: ${found.isrc} was not parseable TTML`);
      return null;
    }
    // Found by name: the ISRC is worth more than the words, since every later lookup is exact.
    if (!track.isrc) ctx.learn({ isrc: found.isrc });

    return {
      doc,
      match: found.match,
      raw: { body: reply.body, contentType: 'application/ttml+xml' },
      note: doc.kind === 'syllable' ? 'word-timed' : doc.kind === 'line' ? 'line-timed' : 'unsynced',
    };
  },

  async test(ctx: ProviderContext) {
    void ctx;
    const reply = await request(`${BASE}/s/${TEST_ISRC}.ttml`);
    if (reply.status === 429) return { ok: false, ms: reply.ms, detail: 'rate limited; lifting is by arrangement with api@lrc.red' };
    if (!reply.ok) return { ok: false, ms: reply.ms, detail: `HTTP ${reply.status}` };
    const doc = parseTtml(reply.body);
    if (!doc || doc.lines.length === 0) return { ok: false, ms: reply.ms, detail: 'answered, but not with TTML the parser reads' };
    return { ok: true, ms: reply.ms, detail: `Blinding Lights: ${doc.kind === 'syllable' ? 'word-timed' : doc.kind}, ${doc.lines.length} lines` };
  },

  reparse: (body) => parseTtml(body),
};

/** The recording, by name, when nothing better is known. Scored like any name search. */
async function search(track: TrackQuery, ctx: ProviderContext): Promise<{ isrc: string; match: number } | null> {
  const reply = await json<{ hits?: Hit[] }>(
    `${BASE}/search.json?${query({ q: `${cleanTitleOf(track)} ${primaryArtistOf(track)}`.trim() })}`,
  );
  if (isUnavailable(reply.result)) {
    ctx.unreachable(`search: HTTP ${reply.result.status}`);
    return null;
  }
  let best: { isrc: string; match: number } | null = null;
  for (const hit of reply.value?.hits ?? []) {
    const isrc = hit.isrc?.toUpperCase() ?? '';
    if (!ISRC.test(isrc)) continue;
    const match = score(track, hit.title ?? '', hit.artist ?? '', Math.round((hit.duration ?? 0) * 1000));
    if (match > (best?.match ?? 0)) best = { isrc, match };
  }
  if (!best || best.match < MATCH_THRESHOLD) {
    if (best) ctx.log('info', `lrc.red: best search hit scored ${best.match.toFixed(2)}`);
    return null;
  }
  return best;
}
