/**
 * Spotify's `color-lyrics`, via an `sp_dc` cookie.
 *
 * Line-timed only — the `syllables` array in the response is always empty, whatever its
 * presence implies — so this is never the timing backbone. It earns its place for a different
 * reason: it is keyed by track id, so it cannot be the wrong song, which makes it a reliable
 * text-and-alignment reference for lining up the sources that had to search by name.
 *
 * Requires a track id. There is no search here on purpose: guessing the id would throw away
 * the only property that makes this source worth consulting.
 */

import { json, query, request } from '../http.ts';
import type { TrackQuery } from '../match.ts';
import { parseColorLyrics } from '../format/spotify.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

const LYRICS_BASE = 'https://spclient.wg.spotify.com/color-lyrics/v2/track';

/** The web token is short-lived; caching it saves a round trip per lookup. */
let webToken: { value: string; expiresAt: number } | null = null;

export const spotify: Provider = {
  id: 'spotify',
  label: 'Spotify',
  description: 'The lyrics the Spotify app shows, matched to the exact track. Line-timed.',
  requires: ['spDcCookie'],
  wordLevel: false,

  isConfigured(config) {
    return Boolean(config.secrets.spDcCookie);
  },

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    if (!track.spotifyId) return null;

    const token = await accessToken(ctx);
    if (!token) return null;

    const url = `${LYRICS_BASE}/${track.spotifyId}?${query({
      format: 'json',
      vocalRemoval: 'false',
      market: 'from_token',
    })}`;
    const response = await request(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'App-Platform': 'WebPlayer',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // The cached token went stale mid-flight; drop it so the next lookup re-mints.
        webToken = null;
      }
      // A 404 here is an answer: Spotify has no lyrics for this track. Anything else means the
      // question never got through.
      if (response.status === 404) {
        ctx.log('info', 'spotify: no lyrics for this track');
      } else {
        ctx.unreachable(`color-lyrics: HTTP ${response.status}`);
      }
      return null;
    }

    const doc = parseColorLyrics(response.body);
    if (!doc) return null;

    return {
      // Matched by id, so there is nothing to be uncertain about.
      doc,
      match: 1,
      raw: { body: response.body, contentType: 'application/json' },
      note: doc.kind === 'static' ? 'unsynced' : 'line-timed',
    };
  },

  async test(ctx: ProviderContext) {
    const started = performance.now();
    if (!ctx.config.secrets.spDcCookie) return { ok: false, detail: 'no sp_dc cookie set' };

    const token = await accessToken(ctx, { force: true });
    const ms = Math.round(performance.now() - started);
    if (!token) {
      return {
        ok: false,
        ms,
        detail:
          'could not mint a web token from the cookie — sp_dc expires when the browser ' +
          'session does, so sign in again and re-copy it',
      };
    }
    return { ok: true, ms, detail: 'cookie accepted, web token minted' };
  },

  reparse: (body) => parseColorLyrics(body),
};

/**
 * Trades the `sp_dc` cookie for a short-lived web token.
 *
 * Two endpoints, because Spotify has moved this more than once and which one works depends
 * on when you ask. Both are undocumented; the failure is reported plainly rather than
 * retried forever.
 */
async function accessToken(
  ctx: ProviderContext,
  options: { force?: boolean } = {},
): Promise<string | null> {
  if (!options.force && webToken && webToken.expiresAt > Date.now() + 30_000) {
    return webToken.value;
  }

  const cookie = `sp_dc=${ctx.config.secrets.spDcCookie}`;
  const endpoints = [
    'https://open.spotify.com/api/token?reason=init&productType=web-player',
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
  ];

  for (const url of endpoints) {
    const response = await json<{
      accessToken?: string;
      accessTokenExpirationTimestampMs?: number;
      isAnonymous?: boolean;
    }>(url, {
      cookie,
      headers: {
        'App-Platform': 'WebPlayer',
        Referer: 'https://open.spotify.com/',
      },
    });

    const value = response.value?.accessToken;
    // An anonymous token is what a rejected cookie looks like, and it cannot read lyrics.
    if (!value || response.value?.isAnonymous) continue;

    webToken = {
      value,
      expiresAt: response.value?.accessTokenExpirationTimestampMs ?? Date.now() + 45 * 60_000,
    };
    return value;
  }

  ctx.unreachable('no usable web token from the sp_dc cookie');
  return null;
}
