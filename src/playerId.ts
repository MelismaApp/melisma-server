/**
 * A player's own id for the track it is playing, resolved to the recording's ISRC.
 *
 * Only Spotify publishes an id the sources take as it is. Deezer, TIDAL and Amazon Music publish their
 * own, which name the recording exactly and mean nothing to a lyrics source; each service's catalogue
 * turns it into an ISRC, which Apple and AMLL then take. Resolved once per id, for every user.
 */

import { cleanTitleOf, MATCH_THRESHOLD, primaryArtistOf, score, type TrackQuery } from './match.ts';
import { json, query } from './http.ts';
import type { Config } from './config.ts';
import type { LogLevel, Store } from './db.ts';

export const PLAYER_SERVICES = ['deezer', 'tidal', 'amazon', 'soundcloud'] as const;
export type PlayerService = (typeof PLAYER_SERVICES)[number];

export interface PlayerId {
  service: PlayerService;
  id: string;
}

/** What each service's ids look like. Anything else is dropped, as a malformed Spotify id is. */
const ID_SHAPE: Record<PlayerService, RegExp> = {
  deezer: /^\d{1,20}$/,
  tidal: /^\d{1,20}$/,
  amazon: /^[A-Z0-9]{10}$/,
  soundcloud: /^\d{1,20}$/,
};

/** A "none" is asked again after this long: catalogues gain tracks. */
const NONE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Amazon's durations are exact to the millisecond; a second either way allows for rounding elsewhere. */
const AMAZON_DURATION_TOLERANCE_MS = 1_000;

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export type Log = (level: LogLevel, service: PlayerService, message: string) => void;

/** Resolutions under way, by `service:id`, so a prefetch and a live lookup for the same track ask once. */
const inFlight = new Map<string, Promise<string | null | undefined>>();

/** `<service>:<id>`, as the app sends it. */
export function parsePlayerId(value: unknown): PlayerId | undefined {
  if (typeof value !== 'string') return undefined;
  const [service, id, ...rest] = value.trim().split(':');
  if (rest.length > 0 || !service || !id) return undefined;
  if (!(PLAYER_SERVICES as readonly string[]).includes(service)) return undefined;
  const known = service as PlayerService;
  return ID_SHAPE[known].test(id) ? { service: known, id } : undefined;
}

/**
 * The track with its ISRC filled in from its player id, where that can be resolved.
 *
 * An ISRC the caller sent wins, and is remembered against the id. One remembered earlier is used.
 * Otherwise the service is asked, once: a failure to ask leaves the track as it was and is not
 * remembered, so the next lookup asks again; a service that answered "no such track" or "no ISRC"
 * is remembered as none, and asked again after a week. With `network: false` nobody is asked at
 * all, which is what a cache-only lookup promised.
 */
export async function withPlayerIsrc(
  store: Store,
  config: Config,
  track: TrackQuery,
  log: Log,
  options: { network?: boolean } = {},
): Promise<TrackQuery> {
  const player = track.playerId;
  if (!player) return track;

  if (track.isrc) {
    store.rememberPlayerId(player.service, player.id, track.isrc);
    return track;
  }

  const known = store.playerIsrc(player.service, player.id);
  if (known && (known.isrc || Date.now() - known.resolvedAt < NONE_RECHECK_MS)) {
    return known.isrc ? { ...track, isrc: known.isrc } : track;
  }
  if (options.network === false) return track;

  const answer = await resolveOnce(store, player, track, config, log);
  return answer ? { ...track, isrc: answer } : track;
}

/** One resolution per id at a time; whoever asks while it is under way gets the same answer. */
function resolveOnce(
  store: Store,
  player: PlayerId,
  track: TrackQuery,
  config: Config,
  log: Log,
): Promise<string | null | undefined> {
  const key = `${player.service}:${player.id}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = resolve(player, track, config, log)
      .then((answer) => {
        if (answer !== undefined) {
          store.rememberPlayerId(player.service, player.id, answer);
          log('info', player.service, answer ? `${player.id} is ${answer}` : `${player.id}: no ISRC to be had`);
        }
        return answer;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** An ISRC, `null` for a definite "none", `undefined` when the service could not be asked. */
async function resolve(
  player: PlayerId,
  track: TrackQuery,
  config: Config,
  log: Log,
): Promise<string | null | undefined> {
  switch (player.service) {
    case 'deezer':
      return fromDeezer(player.id, log);
    case 'tidal':
      return fromTidal(player.id, config, log);
    case 'amazon':
      return fromAppleCatalogue(track, config, log);
    case 'soundcloud':
      // Nothing resolves one yet. The id is still remembered when an ISRC arrives beside it.
      return undefined;
  }
}

function validIsrc(value: unknown): string | null {
  const isrc = typeof value === 'string' ? value.replace(/-/g, '').toUpperCase() : '';
  return ISRC.test(isrc) ? isrc : null;
}

/** Public and keyless. An id Deezer does not have is a 200 with an error body and no `isrc`: none. */
async function fromDeezer(id: string, log: Log): Promise<string | null | undefined> {
  const reply = await json<{ isrc?: string }>(`https://api.deezer.com/track/${id}`);
  if (!reply.result.ok) {
    log('warn', 'deezer', `track ${id}: HTTP ${reply.result.status}`);
    return undefined;
  }
  return validIsrc(reply.value?.isrc);
}

// ---- TIDAL ----------------------------------------------------------------

const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const TIDAL_API = 'https://openapi.tidal.com/v2';

let tidalToken: { value: string; expiresAt: number } | null = null;

/** The developer API, with the client credentials set under Tokens. Not asked without them. */
async function fromTidal(id: string, config: Config, log: Log): Promise<string | null | undefined> {
  const { tidalClientId: clientId, tidalClientSecret: secret } = config.secrets;
  if (!clientId || !secret) return undefined;

  const token = await tidalAccessToken(clientId, secret, log);
  if (!token) return undefined;

  const reply = await json<{ data?: { attributes?: { isrc?: string } } }>(
    `${TIDAL_API}/tracks/${id}?${query({ countryCode: 'US' })}`,
    { headers: { Accept: 'application/vnd.api+json', Authorization: `Bearer ${token}` } },
  );
  if (reply.result.status === 404) return null;
  if (reply.result.status === 401) {
    tidalToken = null;
    log('warn', 'tidal', 'the access token was refused; a fresh one is minted next time');
    return undefined;
  }
  if (!reply.result.ok) {
    log('warn', 'tidal', `track ${id}: HTTP ${reply.result.status}`);
    return undefined;
  }
  return validIsrc(reply.value?.data?.attributes?.isrc);
}

async function tidalAccessToken(clientId: string, secret: string, log: Log): Promise<string | null> {
  if (tidalToken && tidalToken.expiresAt > Date.now() + 60_000) return tidalToken.value;
  const reply = await json<{ access_token?: string; expires_in?: number }>(TIDAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const value = reply.value?.access_token;
  if (!reply.result.ok || !value) {
    log('warn', 'tidal', `could not get an access token: HTTP ${reply.result.status}; check the client credentials`);
    return null;
  }
  tidalToken = { value, expiresAt: Date.now() + (reply.value?.expires_in ?? 3_600) * 1_000 };
  return value;
}

// ---- Amazon Music, by way of Apple's catalogue -------------------------------------

interface AppleSearch {
  results?: {
    songs?: {
      data?: Array<{
        attributes?: { name?: string; artistName?: string; durationInMillis?: number; isrc?: string };
      }>;
    };
  };
}

/**
 * Nothing keyless resolves an ASIN, so the track is found in Apple's catalogue by name instead, with
 * one guard a name search alone does not have: Amazon reports the duration to the millisecond, so
 * only a song of the same length to the second is accepted. The ASIN itself is only what the answer
 * is remembered under.
 */
async function fromAppleCatalogue(track: TrackQuery, config: Config, log: Log): Promise<string | null | undefined> {
  const token = config.secrets.appleBearerToken;
  if (!token || track.durationMs <= 0 || !track.title) return undefined;

  const storefront = config.appleStorefront || 'us';
  const search = await json<AppleSearch>(
    `${config.appleApiBase}/v1/catalog/${storefront}/search?${query({
      term: `${cleanTitleOf(track)} ${primaryArtistOf(track)}`.trim(),
      types: 'songs',
      limit: 25,
    })}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://music.apple.com',
        Referer: 'https://music.apple.com/',
      },
    },
  );
  if (!search.result.ok) {
    log('warn', 'amazon', `Apple search: HTTP ${search.result.status}`);
    return undefined;
  }

  let best = 0;
  let isrc: string | null = null;
  for (const song of search.value?.results?.songs?.data ?? []) {
    const attributes = song.attributes;
    if (!attributes?.durationInMillis) continue;
    if (Math.abs(attributes.durationInMillis - track.durationMs) > AMAZON_DURATION_TOLERANCE_MS) continue;
    const scored = score(track, attributes.name ?? '', attributes.artistName ?? '', attributes.durationInMillis);
    if (scored > best) {
      best = scored;
      isrc = validIsrc(attributes.isrc);
    }
  }
  return best >= MATCH_THRESHOLD ? isrc : null;
}
