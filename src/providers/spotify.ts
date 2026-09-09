/**
 * Spotify's `color-lyrics`, via a web access token.
 *
 * Line-timed only — the `syllables` array in the response is always empty, whatever its
 * presence implies — so this is never the timing backbone. It earns its place for a different
 * reason: it is keyed by track id, so it cannot be the wrong song, which makes it a reliable
 * text-and-alignment reference for lining up the sources that had to search by name.
 *
 * Requires a track id. There is no search here on purpose: guessing the id would throw away
 * the only property that makes this source worth consulting.
 *
 * **The cookie route is closed.** `open.spotify.com/get_access_token` answers `403 URL Blocked`
 * and `open.spotify.com/api/token` answers 400 with "usage of this endpoint is not permitted
 * under the Spotify Developer Terms" — identically with and without a cookie, so it is the
 * endpoint rather than anybody's session. The endpoints that token opens are untouched:
 * `color-lyrics` still answers `401`, meaning bring a token, rather than `403`.
 *
 * So bring the token. `spotifyWebToken` takes one copied out of the web player's own network
 * traffic, and the mint is only attempted if that is empty — which currently means never
 * succeeding. Reproducing the time-based signature the player uses to get its own token would
 * be working around an access control whose owner has explicitly said not to, so this does not.
 */

import { json, query, request } from '../http.ts';
import type { TrackQuery } from '../match.ts';
import { parseColorLyrics } from '../format/spotify.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

const LYRICS_BASE = 'https://spclient.wg.spotify.com/color-lyrics/v2/track';

/**
 * Blinding Lights — the track the source test asks for.
 *
 * Fixed, and chosen because it certainly has lyrics: verified live at 200 with 40 line-synced lines
 * from Musixmatch. That makes an empty answer a statement about the token rather than about the
 * catalogue, which is the only thing a token test can usefully distinguish.
 */
export const TEST_TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';

/** The web token is short-lived; caching it saves a round trip per lookup. */
let webToken: { value: string; expiresAt: number } | null = null;

/**
 * Pull `colors` out of a `color-lyrics` response and hand it to the store.
 *
 * Spotify returns the background, the text colour and a highlight, as signed 32-bit integers
 * rather than hex — negative because the sign bit is part of the colour. Converted here so
 * nothing downstream has to know that.
 */
function reportColours(body: string, ctx: ProviderContext): void {
  try {
    const parsed = JSON.parse(body) as {
      colors?: { background?: number; text?: number; highlightText?: number };
    };
    const colors = parsed.colors;
    if (!colors) return;

    const hex = (value: number | undefined): string | undefined =>
      typeof value === 'number' ? `#${((value >>> 0) & 0xffffff).toString(16).padStart(6, '0')}` : undefined;

    const palette: Record<string, unknown> = {};
    const background = hex(colors.background);
    const text = hex(colors.text);
    const highlight = hex(colors.highlightText);
    if (background) palette.spotifyBackground = background;
    if (text) palette.spotifyText = text;
    if (highlight) palette.spotifyHighlight = highlight;
    if (Object.keys(palette).length) ctx.learn({ palette });
  } catch {
    // The words parsed or they did not; the colours are a bonus either way.
  }
}

/**
 * The pasted token, cleaned up.
 *
 * Accepts the whole `Authorization` header as well as the bare value, because copying the
 * header is what a browser's developer tools make easy.
 */
export function pastedToken(raw: string | undefined): string | null {
  const value = raw
    ?.trim()
    .replace(/^Authorization:\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return value ? value : null;
}

export const spotify: Provider = {
  id: 'spotify',
  label: 'Spotify',
  description: 'The lyrics the Spotify app shows, matched to the exact track. Line-timed.',
  requires: ['spotifyWebToken'],
  wordLevel: false,

  isConfigured(config) {
    return Boolean(pastedToken(config.secrets.spotifyWebToken) || config.secrets.spDcCookie);
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
      // 400 belongs here with 401, which is not obvious. A token from a signed-out player is
      // accepted as a credential — no 401 — and then refused the data, because this endpoint needs a
      // user and there is none. Verified against the live endpoint: with no cookie it answers 400
      // for `market=from_token`, for `market=US` and for no market at all, so it is not the query;
      // with a signed-in cookie the same request returns 200. Keeping such a token would mean
      // failing every lookup until it expired on its own.
      if (response.status === 401 || response.status === 400) {
        webToken = null;
      }
      // A 404 here is an answer: Spotify has no lyrics for this track. Anything else means the
      // question never got through.
      if (response.status === 404) {
        ctx.log('info', 'spotify: no lyrics for this track');
      } else if (response.status === 400) {
        ctx.unreachable('color-lyrics: HTTP 400 — the token is not signed in, so the sp_dc cookie is not working');
      } else {
        ctx.unreachable(`color-lyrics: HTTP ${response.status}`);
      }
      return null;
    }

    // The album's extracted colours come back in the same payload as the words, so they cost
    // nothing to keep — and they let a palette exist before the artwork has finished
    // downloading, which is the one thing deriving it locally cannot do.
    reportColours(response.body, ctx);

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
    const pasted = pastedToken(ctx.config.secrets.spotifyWebToken);
    if (!pasted && !ctx.config.secrets.spDcCookie) {
      return { ok: false, detail: 'no access token set — copy one from the web player' };
    }

    // A real request rather than a mint: with a pasted token there is nothing to mint, and
    // whether the token is still alive is the only question worth asking.
    const token = pasted ?? (await accessToken(ctx, { force: true }));
    if (!token) {
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        detail:
          'the cookie cannot be exchanged for a token any more — Spotify closed that ' +
          'endpoint. Paste an access token from the web player instead.',
      };
    }

    // A track that certainly has lyrics, so an empty answer is about the token rather than the
    // catalogue: verified live at 200 with 40 line-synced lines from Musixmatch.
    const probe = await request(`${LYRICS_BASE}/${TEST_TRACK_ID}?format=json`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'App-Platform': 'WebPlayer',
      },
    });
    const ms = Math.round(performance.now() - started);
    if (probe.status === 401 || probe.status === 403) {
      return { ok: false, ms, detail: 'the token has expired — copy a fresh one' };
    }
    if (probe.status === 400) {
      // Not a malformed request, which is what the status looks like. See the note in `fetch`.
      return {
        ok: false,
        ms,
        detail:
          'the token is not signed in (400) — the sp_dc cookie is expired or wrong, so the ' +
          'browser harvested an anonymous token',
      };
    }
    // A 404 means the token was accepted and that particular track has no lyrics, which is
    // exactly what this test needs to know.
    return {
      ok: probe.ok || probe.status === 404,
      ms,
      detail: probe.ok || probe.status === 404
        ? 'token accepted'
        : `color-lyrics returned HTTP ${probe.status}`,
    };
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
  // A token the operator pasted in wins outright: there is nothing to mint, and the mint no
  // longer works anyway.
  const pasted = pastedToken(ctx.config.secrets.spotifyWebToken);
  if (pasted) return pasted;

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
