/**
 * LRCLIB — open, community-run, no account, and the broadest coverage of the free sources.
 *
 * Its `/api/get` endpoint matches on all four fields at once and either finds the exact
 * track or returns 404, which makes it the cheapest first question to ask. The search
 * fallback is only used when that misses, and its results are scored like any other
 * search's.
 *
 * Their guidelines ask people not to point anything high-volume at it. This server is a
 * cache, so each track costs them one request ever — which is the point.
 */

import { isUnavailable, json, query, request } from '../http.ts';
import { MATCH_THRESHOLD, cleanTitleOf, primaryArtistOf, score, type TrackQuery } from '../match.ts';
import { parseLrc } from '../format/lrc.ts';
import { document, line, type LyricsDocument } from '../model.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

interface LrcLibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export const lrclib: Provider = {
  id: 'lrclib',
  label: 'LRCLIB',
  description: 'Open community database. No account, broad coverage, usually line-timed.',
  requires: [],
  wordLevel: false,
  isConfigured: () => true,

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const base = ctx.config.lrclibBaseUrl;

    const exact = await json<LrcLibRecord>(
      `${base}/api/get?${query({
        track_name: track.title,
        artist_name: primaryArtistOf(track),
        album_name: track.album,
        duration: track.durationMs > 0 ? Math.round(track.durationMs / 1000) : undefined,
      })}`,
    );
    if (isUnavailable(exact.result)) ctx.unreachable(`get: ${exact.result.error}`);
    if (exact.value) {
      const answer = toAnswer(exact.value, 1, exact.result.contentType);
      if (answer) return answer;
    }

    const search = await json<LrcLibRecord[]>(
      `${base}/api/search?${query({
        track_name: cleanTitleOf(track),
        artist_name: primaryArtistOf(track),
      })}`,
    );
    if (isUnavailable(search.result)) ctx.unreachable(`search: ${search.result.error}`);
    const records = Array.isArray(search.value) ? search.value : [];
    if (records.length === 0) return null;

    let best: { record: LrcLibRecord; match: number } | null = null;
    for (const record of records) {
      const match = score(
        track,
        record.trackName ?? '',
        record.artistName ?? '',
        (record.duration ?? 0) * 1000,
      );
      if (match < MATCH_THRESHOLD) continue;
      if (!best || match > best.match) best = { record, match };
    }
    if (!best) {
      ctx.log('info', `lrclib: ${records.length} results, none over the match threshold`);
      return null;
    }

    return toAnswer(best.record, best.match, search.result.contentType);
  },

  async test(ctx: ProviderContext) {
    // A track everybody has, so a miss means the service rather than the catalogue.
    const result = await request(
      `${ctx.config.lrclibBaseUrl}/api/search?${query({ q: 'bohemian rhapsody' })}`,
    );
    return {
      ok: result.ok,
      ms: result.ms,
      detail: result.ok ? 'reachable' : (result.error ?? 'unreachable'),
    };
  },

  reparse(body) {
    try {
      const answer = toAnswer(JSON.parse(body) as LrcLibRecord, 1, 'application/json');
      return answer?.doc ?? null;
    } catch {
      return null;
    }
  },
};

function toAnswer(
  record: LrcLibRecord,
  match: number,
  contentType: string,
): ProviderAnswer | null {
  // An instrumental has no words by definition; treating it as "not found" would send every
  // other source off looking for lyrics that do not exist.
  if (record.instrumental) return null;

  const synced = record.syncedLyrics?.trim();
  const plain = record.plainLyrics?.trim();
  const body = synced || plain;
  if (!body) return null;

  const doc = synced ? parseLrc(synced) : plainDocument(plain!);
  if (!doc) return null;

  return {
    doc,
    match,
    raw: { body: JSON.stringify(record), contentType: contentType || 'application/json' },
    note: synced ? 'synced' : 'plain text only',
  };
}

/**
 * Unsynced lyrics, which still earn their place in a merge.
 *
 * They cannot be the timing backbone, but they are a text reference: the aligner uses them to
 * work out which line is which, and a source with the right words and no clock can confirm a
 * source with a clock and doubtful words.
 */
function plainDocument(plain: string): LyricsDocument | null {
  const lines = plain
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => line({ text }));
  if (lines.length === 0) return null;
  return document(lines, { kind: 'static' });
}
