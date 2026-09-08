/**
 * Musixmatch, through the token its desktop web player issues itself.
 *
 * `richsync` is the prize here: word-by-word timing for most Western music, with no account
 * needed — the anonymous token is minted on demand and cached. A token of the user's own
 * reaches more of the catalogue and goes in the admin page if they have one.
 *
 * Undocumented in every respect, so each step reports what actually happened rather than
 * collapsing to "not found": when this breaks, the useful question is *which* call broke.
 */

import { json, query, request } from '../http.ts';
import { MATCH_THRESHOLD, cleanTitleOf, primaryArtistOf, score, type TrackQuery } from '../match.ts';
import { parseRichSync } from '../format/musixmatch.ts';
import { parseLrc } from '../format/lrc.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

const API = 'https://apic-desktop.musixmatch.com/ws/1.1';
const APP_ID = 'web-desktop-app-v1.0';

/** The anonymous token, kept for the process's lifetime — minting one per lookup is rude. */
let guestToken: { value: string; mintedAt: number } | null = null;
const GUEST_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

interface Envelope<T> {
  message?: {
    header?: { status_code?: number; hint?: string };
    body?: T;
  };
}

interface MatcherBody {
  track?: {
    track_id?: number;
    commontrack_id?: number;
    track_name?: string;
    artist_name?: string;
    album_name?: string;
    track_length?: number;
    has_richsync?: number;
    has_subtitles?: number;
    instrumental?: number;
  };
}

export const musixmatch: Provider = {
  id: 'musixmatch',
  label: 'Musixmatch',
  description: 'Word-by-word for most Western music. Works with no account; a token widens it.',
  requires: [],
  wordLevel: true,
  isConfigured: () => true,

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const token = await resolveToken(ctx);
    if (!token) return null;

    const matched = await json<Envelope<MatcherBody>>(
      `${API}/matcher.track.get?${query({
        format: 'json',
        app_id: APP_ID,
        usertoken: token,
        q_track: cleanTitleOf(track),
        q_artist: primaryArtistOf(track),
        q_album: track.album,
        q_duration: track.durationMs > 0 ? Math.round(track.durationMs / 1000) : undefined,
      })}`,
      { headers: desktopHeaders() },
    );

    const found = matched.value?.message?.body?.track;
    if (!found?.track_id) {
      const hint = matched.value?.message?.header?.status_code;
      if (hint && hint !== 200) ctx.log('info', `musixmatch: matcher returned ${hint}`);
      return null;
    }
    if (found.instrumental) return null;

    const match = score(
      track,
      found.track_name ?? '',
      found.artist_name ?? '',
      (found.track_length ?? 0) * 1000,
    );
    if (match < MATCH_THRESHOLD) {
      ctx.log('info', `musixmatch: matched "${found.track_name}" but only scored ${match.toFixed(2)}`);
      return null;
    }

    // Word-level first: a richsync makes this source worth having, a subtitle makes it
    // merely another line-timed opinion.
    if (found.has_richsync) {
      const rich = await json<Envelope<{ richsync?: { richsync_body?: string } }>>(
        `${API}/track.richsync.get?${query({
          format: 'json',
          app_id: APP_ID,
          usertoken: token,
          track_id: found.track_id,
        })}`,
        { headers: desktopHeaders() },
      );
      const body = rich.value?.message?.body?.richsync?.richsync_body;
      if (body) {
        const doc = parseRichSync(body);
        if (doc) {
          return {
            doc,
            match,
            raw: { body, contentType: 'application/json' },
            note: 'richsync (word-timed)',
          };
        }
      }
    }

    if (found.has_subtitles) {
      const subtitle = await json<Envelope<{ subtitle?: { subtitle_body?: string } }>>(
        `${API}/track.subtitle.get?${query({
          format: 'json',
          app_id: APP_ID,
          usertoken: token,
          track_id: found.track_id,
        })}`,
        { headers: desktopHeaders() },
      );
      const body = subtitle.value?.message?.body?.subtitle?.subtitle_body;
      if (body) {
        const doc = parseLrc(body);
        if (doc) {
          return {
            doc,
            match,
            raw: { body, contentType: 'text/plain' },
            note: 'subtitle (line-timed)',
          };
        }
      }
    }

    return null;
  },

  async test(ctx: ProviderContext) {
    const started = performance.now();
    const token = await resolveToken(ctx);
    if (!token) {
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        detail: 'could not obtain a token — the anonymous mint is the usual thing to break',
      };
    }
    const matched = await json<Envelope<MatcherBody>>(
      `${API}/matcher.track.get?${query({
        format: 'json',
        app_id: APP_ID,
        usertoken: token,
        q_track: 'Bohemian Rhapsody',
        q_artist: 'Queen',
      })}`,
      { headers: desktopHeaders() },
    );
    const status = matched.value?.message?.header?.status_code;
    const name = matched.value?.message?.body?.track?.track_name;
    return {
      ok: status === 200 && Boolean(name),
      ms: matched.result.ms,
      detail:
        status === 200 && name
          ? `token works, matched "${name}"`
          : `token obtained but matcher returned ${status ?? 'nothing'}`,
    };
  },

  // The archived body is either a richsync payload or an LRC subtitle, and the content type
  // recorded alongside it is the only thing that says which.
  reparse: (body, contentType) =>
    contentType.includes('json') ? parseRichSync(body) : parseLrc(body),
};

async function resolveToken(ctx: ProviderContext): Promise<string | null> {
  const own = ctx.config.secrets.musixmatchUserToken.trim();
  if (own) return own;

  if (guestToken && Date.now() - guestToken.mintedAt < GUEST_TOKEN_TTL_MS) {
    return guestToken.value;
  }

  const minted = await json<Envelope<{ user_token?: string }>>(
    `${API}/token.get?${query({ format: 'json', app_id: APP_ID })}`,
    { headers: desktopHeaders() },
  );
  const value = minted.value?.message?.body?.user_token;
  if (!value || value === 'UpgradeOnlyUpgradeOnlyUpgradeOnlyUpgradeOnly') {
    ctx.log('warn', 'musixmatch: no usable anonymous token');
    return null;
  }
  guestToken = { value, mintedAt: Date.now() };
  return value;
}

/**
 * The headers the endpoint expects.
 *
 * It is the desktop app's API and it checks: without a desktop-shaped user agent and an
 * origin it recognises, the token mint returns an upgrade placeholder instead of a token.
 */
function desktopHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    Origin: 'musixmatch://',
    Referer: 'musixmatch://',
  };
}
