/**
 * NetEase Cloud Music.
 *
 * The best free source for Japanese, Korean and Chinese music, and the only one that hands
 * over hand-checked *readings* and *translations* alongside word-level timing. Its
 * translations are almost always into Chinese, which the merge takes into account rather
 * than presenting them as if the reader had asked for them.
 *
 * These endpoints are the ones the web player uses and are not documented. A cookie is
 * optional and raises the per-IP limits.
 */

import { json, query, request } from '../http.ts';
import { MATCH_THRESHOLD, cleanTitleOf, primaryArtistOf, score, type TrackQuery } from '../match.ts';
import { parseNeteasePayload, type NeteaseLyricPayload } from '../format/netease.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

interface SearchResponse {
  result?: {
    songs?: {
      id?: number;
      name?: string;
      duration?: number;
      artists?: { name?: string }[];
      album?: { name?: string };
    }[];
  };
}

export const netease: Provider = {
  id: 'netease',
  label: 'NetEase Cloud Music',
  description:
    'Word-by-word plus hand-checked romanization and translation. Best for East Asian music.',
  requires: [],
  wordLevel: true,
  isConfigured: () => true,

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const base = ctx.config.neteaseBaseUrl;
    const cookie = ctx.config.secrets.neteaseCookie || undefined;

    const terms = [
      `${cleanTitleOf(track)} ${primaryArtistOf(track)}`.trim(),
      cleanTitleOf(track),
    ];

    for (const term of terms) {
      const found = await json<SearchResponse>(
        `${base}/api/search/get?${query({ s: term, type: 1, limit: 20, offset: 0 })}`,
        { cookie, headers: { Referer: base } },
      );
      const songs = found.value?.result?.songs ?? [];
      if (songs.length === 0) continue;

      let best: { id: number; match: number } | null = null;
      for (const song of songs) {
        if (!song.id) continue;
        const artists = (song.artists ?? []).map((a) => a.name ?? '').filter(Boolean);
        const match = score(track, song.name ?? '', artists.join(', '), song.duration ?? 0);
        if (match < MATCH_THRESHOLD) continue;
        if (!best || match > best.match) best = { id: song.id, match };
      }
      if (!best) continue;

      const payload = await lyricsFor(base, best.id, cookie);
      if (!payload) continue;
      const doc = parseNeteasePayload(payload);
      if (!doc) continue;

      return {
        doc,
        match: best.match,
        raw: { body: JSON.stringify(payload), contentType: 'application/json' },
        note: payload.yrc?.lyric ? 'word-timed' : 'line-timed',
      };
    }

    return null;
  },

  async test(ctx: ProviderContext) {
    const result = await request(
      `${ctx.config.neteaseBaseUrl}/api/search/get?${query({ s: 'Lemon', type: 1, limit: 1 })}`,
      {
        cookie: ctx.config.secrets.neteaseCookie || undefined,
        headers: { Referer: ctx.config.neteaseBaseUrl, Accept: 'application/json' },
      },
    );
    if (!result.ok) return { ok: false, ms: result.ms, detail: result.error ?? 'unreachable' };
    try {
      const songs = (JSON.parse(result.body) as SearchResponse).result?.songs ?? [];
      return {
        ok: songs.length > 0,
        ms: result.ms,
        detail:
          songs.length > 0
            ? 'reachable, search works'
            : 'reachable but the search returned nothing — often means the region is blocked',
      };
    } catch {
      return { ok: false, ms: result.ms, detail: 'response was not JSON' };
    }
  },

  reparse(body) {
    try {
      return parseNeteasePayload(JSON.parse(body) as NeteaseLyricPayload);
    } catch {
      return null;
    }
  },
};

/**
 * Fetches every lyric track NetEase has for a song.
 *
 * `/lyric/v1` is the endpoint that includes `yrc`, the word-timed one, and is the reason to
 * bother with this source at all. The older `/lyric` has no `yrc` but is more reliably
 * available, so it is the fallback rather than the first choice.
 */
async function lyricsFor(
  base: string,
  id: number,
  cookie: string | undefined,
): Promise<NeteaseLyricPayload | null> {
  const modern = await json<NeteaseLyricPayload>(
    `${base}/api/song/lyric/v1?${query({
      id,
      cp: 'false',
      lv: 0,
      kv: 0,
      tv: 0,
      rv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    })}`,
    { cookie, headers: { Referer: base } },
  );
  if (modern.value && hasAnyLyric(modern.value)) return modern.value;

  const classic = await json<NeteaseLyricPayload>(
    `${base}/api/song/lyric?${query({ id, lv: 1, kv: 1, tv: 1, rv: 1 })}`,
    { cookie, headers: { Referer: base } },
  );
  return classic.value && hasAnyLyric(classic.value) ? classic.value : null;
}

function hasAnyLyric(payload: NeteaseLyricPayload): boolean {
  return Boolean(
    payload.yrc?.lyric?.trim() ||
      payload.lrc?.lyric?.trim() ||
      payload.klyric?.lyric?.trim(),
  );
}
