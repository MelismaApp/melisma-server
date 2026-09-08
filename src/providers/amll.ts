/**
 * The AMLL TTML Database — hand-timed, word-by-word, CC0, no account.
 *
 * The best free source there is: a community corpus authored in the same TTML dialect Apple
 * uses, so it carries syllable timings, duet agents, background vocals, readings and
 * translations. Indexed by Spotify, Apple Music, NetEase, QQ Music and ISRC, which means a
 * track the app identified by id can be looked up exactly rather than searched for.
 *
 * The public endpoint is volunteer-run and the server is free software, so the base URL is a
 * setting — anybody using this heavily should run their own copy of `amll-ttml-api`.
 */

import { json, query, request } from '../http.ts';
import { MATCH_THRESHOLD, bestScore, cleanTitleOf, primaryArtistOf, type TrackQuery } from '../match.ts';
import { parseTtml } from '../format/ttml.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

interface AmllEntry {
  id?: number;
  filename?: string;
  musicNames?: string[];
  artistNames?: string[];
  albumNames?: string[];
  spotifyIds?: string[];
  appleMusicIds?: string[];
  isrcs?: string[];
  authorUsernames?: string[];
  lyrics?: string;
  format?: string;
}

interface AmllEnvelope<T> {
  status?: number;
  data?: T;
}

export const amll: Provider = {
  id: 'amll',
  label: 'AMLL TTML Database',
  description:
    'Community-timed word-by-word TTML, public domain. Indexed by Spotify, Apple, NetEase and ISRC.',
  requires: [],
  wordLevel: true,
  isConfigured: () => true,

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const base = ctx.config.amllBaseUrl;

    // In order of how certain the identification is. An id match cannot be the wrong song;
    // a name match can.
    const direct: string[] = [];
    if (track.spotifyId) direct.push(query({ spotifyId: track.spotifyId }));
    if (track.isrc) direct.push(query({ isrc: track.isrc }));

    for (const params of direct) {
      const entry = await get(base, params);
      if (entry?.lyrics) {
        const answer = toAnswer(entry, 1);
        if (answer) return answer;
      }
    }

    const searches = [
      query({ musicName: cleanTitleOf(track), artistName: primaryArtistOf(track), pageSize: 20 }),
      query({ musicName: cleanTitleOf(track), pageSize: 20 }),
    ];

    for (const params of searches) {
      const found = await json<AmllEnvelope<{ items?: AmllEntry[] }>>(
        `${base}/v1/lyrics/search?${params}`,
      );
      const items = found.value?.data?.items ?? [];
      if (items.length === 0) continue;

      let best: { entry: AmllEntry; match: number } | null = null;
      for (const item of items) {
        // The corpus stores no durations, so the score leans on title and artist. Each entry
        // lists several of both — alternate titles, every credited artist — and the best
        // pairing counts.
        const match = bestScore(track, item.musicNames ?? [], item.artistNames ?? [], 0);
        if (match < MATCH_THRESHOLD) continue;
        if (!best || match > best.match) best = { entry: item, match };
      }
      if (!best) continue;

      // Search results carry no lyrics; the winner has to be fetched by id.
      const full = best.entry.id ? await get(base, query({ id: best.entry.id })) : null;
      const answer = toAnswer(full ?? best.entry, best.match);
      if (answer) return answer;
    }

    return null;
  },

  async test(ctx: ProviderContext) {
    const result = await request(
      `${ctx.config.amllBaseUrl}/v1/lyrics/search?${query({ q: 'Lemon', pageSize: 1 })}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!result.ok) {
      return { ok: false, ms: result.ms, detail: result.error ?? 'unreachable' };
    }
    let items = 0;
    try {
      items = (JSON.parse(result.body) as AmllEnvelope<{ items?: unknown[] }>).data?.items?.length ?? 0;
    } catch {
      return { ok: false, ms: result.ms, detail: 'response was not JSON' };
    }
    return { ok: true, ms: result.ms, detail: `reachable, ${items} result(s) for a known track` };
  },

  reparse: (body) => parseTtml(body),
};

async function get(base: string, params: string): Promise<AmllEntry | null> {
  const response = await json<AmllEnvelope<AmllEntry>>(`${base}/v1/lyrics/get?${params}`);
  return response.value?.data ?? null;
}

function toAnswer(entry: AmllEntry, match: number): ProviderAnswer | null {
  const xml = entry.lyrics?.trim();
  if (!xml) return null;
  const doc = parseTtml(xml);
  if (!doc) return null;

  // Somebody timed this by hand. CC0 asks for nothing, but the contributor's name travels
  // with the document so the app can say who.
  const authors = entry.authorUsernames ?? [];
  return {
    doc,
    match,
    raw: { body: xml, contentType: 'application/ttml+xml' },
    note: authors.length > 0 ? `timed by ${authors.join(', ')}` : undefined,
  };
}
