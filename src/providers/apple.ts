/**
 * Apple Music, via the tokens the web player already has.
 *
 * The richest lyrics that exist — syllable timings, official romanizations, official
 * translations, duet agents, background vocals, all in one TTML file — and the reason this
 * server is worth running at all: it needs two credentials the phone has no safe way to
 * carry, and it needs them to stay in one place rather than shipped inside an APK.
 *
 * **Two tokens, and a subscription only gets you one.**
 *
 * - The *developer token* is a JWT. Normally it comes from an Apple Developer Program
 *   membership and a MusicKit key. Without one, the web player's own token works: open
 *   music.apple.com, look at a request to `amp-api.music.apple.com` in the network panel and
 *   copy the `Authorization: Bearer eyJ…` header. It is shared by every web listener and
 *   lasts months, not hours — but it does expire, so the admin page decodes and shows when.
 * - The *media user token* is per-account and proves the subscription. It is the
 *   `media-user-token` cookie on music.apple.com.
 *
 * Neither belongs to this software, both belong to the person running it, and lyrics fetched
 * with them are licensed to that person. Which is why this stays a private cache: the
 * moment it answers for other people it is redistributing Apple's licensed content, and
 * caching does not change that. Contributing timings back to the CC0 community database is
 * the version of this that helps anybody else.
 */

import { json, query, request } from '../http.ts';
import { jwtExpiry } from '../config.ts';
import { MATCH_THRESHOLD, cleanTitleOf, primaryArtistOf, score, type TrackQuery } from '../match.ts';
import { parseTtml } from '../format/ttml.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

interface Song {
  id?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
  };
}

interface SearchResponse {
  results?: { songs?: { data?: Song[] } };
}

interface SongsResponse {
  data?: Song[];
}

interface LyricsResponse {
  data?: { id?: string; type?: string; attributes?: { ttml?: string } }[];
}

export const apple: Provider = {
  id: 'apple',
  label: 'Apple Music',
  description:
    'Syllable timings with official readings and translations. Needs a subscription and the ' +
    'web player’s bearer token.',
  requires: ['appleBearerToken', 'appleMediaUserToken'],
  wordLevel: true,

  isConfigured(config) {
    return Boolean(config.secrets.appleBearerToken && config.secrets.appleMediaUserToken);
  },

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const { appleApiBase: base, appleStorefront: storefront } = ctx.config;

    const song = await identify(track, ctx);
    if (!song?.id) return null;

    const match = song.match;
    // Syllable lyrics first — the whole point. `lyrics` is the same file without the
    // per-word timings, so it is a fallback rather than an alternative.
    for (const kind of ['syllable-lyrics', 'lyrics'] as const) {
      const url = `${base}/v1/catalog/${storefront}/songs/${song.id}/${kind}`;
      const response = await json<LyricsResponse>(url, { headers: headers(ctx) });

      if (!response.result.ok) {
        ctx.log('warn', `apple: ${kind} for ${song.id} -> ${explain(response.result.status)}`);
        // A 401 or 403 is about the credentials, not this track: stop rather than repeat it.
        if (response.result.status === 401 || response.result.status === 403) return null;
        continue;
      }

      const ttml = response.value?.data?.find((entry) => entry.attributes?.ttml)?.attributes?.ttml;
      if (!ttml) continue;

      const doc = parseTtml(ttml);
      if (!doc) {
        ctx.log('warn', `apple: ${kind} for ${song.id} was not parseable TTML`);
        continue;
      }

      return {
        doc,
        match,
        raw: { body: ttml, contentType: 'application/ttml+xml' },
        note: kind === 'syllable-lyrics' ? 'syllable lyrics' : 'line lyrics',
      };
    }

    return null;
  },

  async test(ctx: ProviderContext) {
    const { appleApiBase: base, appleStorefront: storefront } = ctx.config;
    const bearer = ctx.config.secrets.appleBearerToken;
    const mediaUser = ctx.config.secrets.appleMediaUserToken;

    if (!bearer) return { ok: false, detail: 'no bearer token set' };

    const expiry = jwtExpiry(bearer);
    const expiryNote =
      expiry === null
        ? 'token is not a readable JWT'
        : expiry < Date.now()
          ? `token expired ${new Date(expiry).toISOString().slice(0, 10)}`
          : `token valid until ${new Date(expiry).toISOString().slice(0, 10)}`;

    if (expiry !== null && expiry < Date.now()) {
      return { ok: false, detail: `${expiryNote} — copy a fresh one from the web player` };
    }

    // The catalogue answers with the bearer token alone, which separates "the developer
    // token is bad" from "the user token is bad".
    const search = await request(
      `${base}/v1/catalog/${storefront}/search?${query({ term: 'Lemon', types: 'songs', limit: 1 })}`,
      { headers: headers(ctx) },
    );
    if (!search.ok) {
      return { ok: false, ms: search.ms, detail: `catalogue search: ${explain(search.status)}. ${expiryNote}` };
    }
    if (!mediaUser) {
      return {
        ok: false,
        ms: search.ms,
        detail: `catalogue reachable and ${expiryNote}, but no media-user-token — lyrics need it`,
      };
    }

    // Now the part that needs the subscription. Any real song id would do; this one is only
    // used to see which status comes back.
    let songId: string | undefined;
    try {
      songId = (JSON.parse(search.body) as SearchResponse).results?.songs?.data?.[0]?.id;
    } catch {
      /* handled below */
    }
    if (!songId) {
      return { ok: false, ms: search.ms, detail: `search returned no songs. ${expiryNote}` };
    }

    const lyrics = await request(
      `${base}/v1/catalog/${storefront}/songs/${songId}/syllable-lyrics`,
      { headers: headers(ctx) },
    );
    if (lyrics.status === 401 || lyrics.status === 403) {
      return {
        ok: false,
        ms: lyrics.ms,
        detail: `lyrics rejected the media-user-token (${lyrics.status}) — it expires with the ` +
          `browser session, so re-copy it. ${expiryNote}`,
      };
    }
    if (!lyrics.ok && lyrics.status !== 404) {
      return { ok: false, ms: lyrics.ms, detail: `lyrics: ${explain(lyrics.status)}. ${expiryNote}` };
    }

    return {
      ok: true,
      ms: lyrics.ms,
      detail:
        lyrics.status === 404
          ? `both tokens accepted; that track simply has no lyrics. ${expiryNote}`
          : `both tokens accepted, lyrics returned. ${expiryNote}`,
    };
  },

  reparse: (body) => parseTtml(body),
};

/** Finds the Apple song id, preferring the ISRC because it identifies the recording. */
async function identify(
  track: TrackQuery,
  ctx: ProviderContext,
): Promise<{ id: string; match: number } | null> {
  const { appleApiBase: base, appleStorefront: storefront } = ctx.config;

  if (track.isrc) {
    const byIsrc = await json<SongsResponse>(
      `${base}/v1/catalog/${storefront}/songs?${query({ 'filter[isrc]': track.isrc })}`,
      { headers: headers(ctx) },
    );
    const first = byIsrc.value?.data?.[0];
    if (first?.id) return { id: first.id, match: 1 };
  }

  const term = `${cleanTitleOf(track)} ${primaryArtistOf(track)}`.trim();
  const search = await json<SearchResponse>(
    `${base}/v1/catalog/${storefront}/search?${query({ term, types: 'songs', limit: 25 })}`,
    { headers: headers(ctx) },
  );
  if (!search.result.ok) {
    ctx.log('warn', `apple: search -> ${explain(search.result.status)}`);
    return null;
  }

  const songs = search.value?.results?.songs?.data ?? [];
  let best: { id: string; match: number } | null = null;
  for (const song of songs) {
    if (!song.id) continue;
    const attributes = song.attributes ?? {};
    const match = score(
      track,
      attributes.name ?? '',
      attributes.artistName ?? '',
      attributes.durationInMillis ?? 0,
    );
    if (match < MATCH_THRESHOLD) continue;
    if (!best || match > best.match) best = { id: song.id, match };
  }
  return best;
}

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${ctx.config.secrets.appleBearerToken}`,
    'Media-User-Token': ctx.config.secrets.appleMediaUserToken,
    // The API checks these; without them a valid token still gets turned away.
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
  };
}

/** Turns a status into the thing the user would actually have to do about it. */
function explain(status: number): string {
  switch (status) {
    case 0:
      return 'no response (network)';
    case 401:
      return '401 — the bearer token is expired or wrong';
    case 403:
      return '403 — the media-user-token is stale, or the account has no subscription';
    case 404:
      return '404 — no lyrics for this track';
    case 429:
      return '429 — rate limited';
    default:
      return `HTTP ${status}`;
  }
}
