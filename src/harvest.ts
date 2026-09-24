/**
 * Everything about a track that is not its words, collected while we are already asking.
 *
 * The argument for holding all of it, including what nothing currently reads: the tokens are
 * the scarce thing, not the storage. A Spotify access token lasts an hour and an Apple developer
 * token a few months, and one of these endpoints — `audio-attributes` — was withdrawn from the
 * public API in November 2024, so a cached copy is the only durable one that exists. A field
 * nobody reads today costs a few hundred bytes; a field nobody collected today is gone.
 *
 * Ranked by what it actually buys:
 *
 * 1. **ISRC.** A globally unique recording identifier, which turns every later lookup of the
 *    same track from a fuzzy name match into an exact one — and the community TTML database
 *    indexes on it directly. This is the field that fixes matching rather than decorating a
 *    screen.
 * 2. **An authoritative duration.** The matcher treats an unknown duration as neutral, which is
 *    the position it is in for every AMLL result, since that corpus carries none. A real one in
 *    milliseconds makes the duration term decisive.
 * 3. **The beat and bar grids.** The only item here that unlocks something the renderer cannot
 *    currently do at all: pulse on the beat rather than drift at a rate derived from the tempo.
 * 4. Colour palettes, songwriters, album metadata — genuinely useful, and cheap, but they
 *    decorate rather than enable.
 *
 * Every step is best-effort and silent. This runs after a lookup has already answered, so a
 * failure here must never be visible: the words are what the caller asked for.
 */

import type { Config } from './config.ts';
import type { ExtrasEntry, LogLevel, Store, StoredCanvas } from './db.ts';
import { spotifyAppToken } from './spotifyApp.ts';
import { json, query, redact, request, sleep } from './http.ts';
import { MATCH_THRESHOLD, score, type TrackQuery } from './match.ts';
import { decode, integer, lengthDelimited, submessage, submessages, text } from './protobuf.ts';
import { songByIsrc, type AppleSong } from './providers/apple.ts';
import { pastedToken } from './providers/spotify.ts';

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_INTERNAL = 'https://spclient.wg.spotify.com';
const CANVAS_URL = `${SPOTIFY_INTERNAL}/canvaz-cache/v0/canvases`;

/** 22 characters of base62. Checked because it is spliced into a URI. */
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;

/**
 * How long an answer about a Canvas stands, "none" included.
 *
 * Artists add a Canvas after release and swap them now and then, so both answers go stale. A week
 * catches that for one request per track per week.
 */
export const CANVAS_RECHECK_MS = 7 * 86_400_000;

/** Audio features for tracks Spotify will no longer describe. No key, no account. */
const RECCOBEATS_API = 'https://api.reccobeats.com/v1';

/** A tempo by ISRC, where Deezer happens to have measured one. No key, no account. */
const DEEZER_API = 'https://api.deezer.com';
/**
 * Apple's default host.
 *
 * Only the default: `config.appleApiBase` is what is actually called, so an override set for a
 * proxy or a test reaches the harvest too. The lyrics provider already honoured it, and a harvest
 * that quietly went straight to production made the setting a half-truth.
 */
const APPLE_API_DEFAULT = 'https://amp-api.music.apple.com';

const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

export interface Harvest {
  isrc?: string | null;
  durationMs?: number | null;
  coverUrl?: string | null;
  artistImageUrl?: string | null;
  tempo?: number | null;
  palette?: Record<string, unknown> | null;
  analysis?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  /** Present only when Spotify answered. See `askCanvas`. */
  canvas?: StoredCanvas;
  source: string;
}

/**
 * Collect and store whatever the configured tokens can reach for one track.
 *
 * Both sources are consulted rather than the first that answers, because they know different
 * things: only Spotify has the tempo and the beat grid, only Apple has the songwriter and a
 * colour palette, and either may have an ISRC the other lacks.
 *
 * `canvas: false` skips the Canvas, for a track whose last answer is still current.
 */
export async function harvest(
  store: Store,
  config: Config,
  key: string,
  track: TrackQuery,
  { canvas = true }: { canvas?: boolean } = {},
): Promise<void> {
  const results: Harvest[] = [];

  // What is already known about the recording, so each step can ask by identity rather than by name.
  const known = store.identityFor(key);
  const asked: TrackQuery = {
    ...track,
    isrc: track.isrc ?? known.isrc ?? undefined,
    upc: track.upc ?? known.upc ?? undefined,
    durationMs: track.durationMs > 0 ? track.durationMs : (known.durationMs ?? 0),
  };

  const spotify = await fromSpotify(config, asked, { canvas }, (level, message) =>
    store.log(level, 'spotify', message),
  ).catch(() => null);
  if (spotify) results.push(spotify);
  if (spotify?.canvas) store.saveCanvas(key, spotify.canvas);

  // Spotify's own answer first: for its track id it is exact, and it names the release being played.
  // The album name is the phone's when it sent one, since that is what is playing.
  const spotifyUpc = spotify?.metadata?.albumUpc;
  const spotifyAlbum = spotify?.metadata?.albumName;
  const apple = await fromApple(
    config,
    {
      ...asked,
      isrc: spotify?.isrc ?? asked.isrc,
      upc: typeof spotifyUpc === 'string' ? spotifyUpc : asked.upc,
      album: asked.album || (typeof spotifyAlbum === 'string' ? spotifyAlbum : ''),
    },
    (level, message) => store.log(level, 'applemusic', message),
  ).catch(() => null);
  if (apple) results.push(apple);

  for (const result of results) {
    store.noteIdentity(key, { isrc: result.isrc, durationMs: result.durationMs });

    const hasPresentation =
      result.coverUrl ||
      result.artistImageUrl ||
      result.tempo ||
      result.palette ||
      result.analysis ||
      result.metadata;
    if (!hasPresentation) continue;

    store.saveExtras({
      key,
      title: track.title,
      artist: track.artist,
      coverUrl: result.coverUrl ?? null,
      artistImageUrl: result.artistImageUrl ?? null,
      tempo: result.tempo ?? null,
      palette: result.palette ?? null,
      analysis: result.analysis ?? null,
      metadata: result.metadata ?? null,
      source: result.source,
    });
  }

  if (results.length) {
    store.log('info', null, `harvested extras for "${track.title}" from ${
      results.map((r) => r.source).join(', ')
    }`);
  }
}

/**
 * Spotify: the track, then its audio analysis.
 *
 * Needs the track id — this is not a search. Guessing the id would defeat the point, which is
 * that everything here is about *this* recording rather than one with a similar name.
 */
async function fromSpotify(
  config: Config,
  track: TrackQuery,
  options: { canvas: boolean },
  log: (level: LogLevel, message: string) => void,
): Promise<Harvest | null> {
  const token = pastedToken(config.secrets.spotifyWebToken);

  // A registered application's token for the public catalogue, when one is configured. This is the
  // whole reason the ISRC is obtainable at all: `api.spotify.com` rate-limits a web-player token
  // hard, so without an app token that call is a coin toss. With one it has documented quotas.
  const app = await spotifyAppToken(config);
  if (app.detail) log('warn', app.detail);

  // Either credential is enough to be worth starting, and they buy different things — so requiring
  // both was wrong. Configuring only a client id and secret left this returning immediately while the
  // admin page said the application was in use, which is the most confusing pair of facts available.
  if (!token && !app.token) return null;

  // The player's own credential, for the player's own service. `spclient` does not accept an
  // application token, so without this the analysis is simply not asked for.
  const playerHeaders = token
    ? {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'App-Platform': 'WebPlayer',
        'User-Agent': WEB_UA,
      }
    : null;

  // Falls back to the player token rather than skipping the call — that is what it did before app
  // credentials existed, and a coin toss beats nothing.
  const catalogueHeaders = app.token
    ? { Accept: 'application/json', Authorization: `Bearer ${app.token}` }
    : playerHeaders!;

  // No id from the caller — a local file, or another music app. Searching for one is only reasonable
  // with an app token, since the endpoint is on the host that rate-limits a web-player token; without
  // one, this half of the harvest simply does not happen, as it did not before.
  let spotifyId = track.spotifyId;
  if (!spotifyId) {
    if (!app.token) return null;
    const found = await findSpotifyId(track, catalogueHeaders);
    if (found.detail) log(found.id ? 'debug' : 'info', found.detail);
    if (!found.id) return null;
    spotifyId = found.id;
  }

  // Two independent services, and keeping them independent is the whole point of this shape.
  //
  // `api.spotify.com` is rate-limited hard for a web-player token — persistently `429 API rate
  // limit exceeded`, and observed to survive a change of IP, so the limit follows the token rather
  // than the address. This used to be fetched first and `return null` on failure, which meant one
  // 429 threw away the analysis as well. The analysis lives on `spclient` and is keyed by the track
  // id we were given, so it never needed the reply from `api.spotify.com` at all: the dashboard read
  // "0 with the audio analysis" not because Spotify had none, but because it was never asked.
  //
  // So they run together and each is allowed to fail on its own. A 429 now costs the ISRC and the
  // cover, and the tempo still arrives.
  //
  // The Canvas only for the id the caller gave, never one found by searching: a Canvas for a
  // different release of the song would be the most visible mistake this could make.
  const canvasId = options.canvas && token && track.spotifyId && SPOTIFY_ID.test(track.spotifyId)
    ? track.spotifyId
    : null;
  const [details, analysis, asked] = await Promise.all([
    json<SpotifyTrack>(`${SPOTIFY_API}/tracks/${spotifyId}`, { headers: catalogueHeaders }),
    // The internal analysis endpoint, not the public one — the public `audio-features` was
    // restricted to apps that already had extended access, so this is the only way to it. A 404
    // here is an answer: Spotify has no analysis for plenty of tracks, and for those it never will.
    //
    // Skipped without a player token, since `spclient` will not take an application one. Reported as
    // status 0 so the branches below read it as "did not answer" rather than as a definitive 404,
    // which would retire the track's tempo on the strength of a call never made.
    playerHeaders
      ? json<Record<string, unknown>>(
          `${SPOTIFY_INTERNAL}/audio-attributes/v1/audio-analysis/${spotifyId}?${query({
            format: 'json',
          })}`,
          { headers: playerHeaders },
        )
      : Promise.resolve({
          value: null,
          result: { ok: false, status: 0, body: '', contentType: '', ms: 0 },
        }),
    canvasId ? askCanvas(canvasId, token!, log) : Promise.resolve(null),
  ]);

  const found = details.value;
  const canvas = asked?.canvas ?? null;

  // Said out loud, because the consequence is invisible otherwise: no ISRC and no cover, for a track
  // the server can see perfectly well. A 429 here is routine — `api.spotify.com` is rate-limited hard
  // for a web-player token — so it is a warning rather than an error, and the detail that says *which*
  // call was refused goes to debug.
  if (details.result.status === 429) {
    log(
      'warn',
      app.token
        ? 'spotify rate-limited the track lookup (429) even with an app token — slow down or retry'
        : 'spotify rate-limited the track lookup (429) — no ISRC or cover. Add a Spotify client id ' +
          'and secret in Settings; a web-player token is limited hard on this endpoint',
    );
  } else if (!found?.id) {
    log('debug', `spotify track lookup returned HTTP ${details.result.status}`);
  }
  if (analysis.result.status === 0 && !playerHeaders) {
    log('debug', 'no Spotify web token, so the audio analysis was not asked for');
  } else if (analysis.result.status === 429) {
    log('warn', 'spotify rate-limited the audio analysis (429) — no tempo for this track');
  } else if (analysis.result.status === 404) {
    // Not a fault: Spotify has no analysis for a great many recordings, and never will for those.
    log('debug', 'spotify has no audio analysis for this track (404)');
  } else if (!analysis.value) {
    log('debug', `spotify audio analysis returned HTTP ${analysis.result.status}`);
  }

  const trackSection = analysis.value?.track as Record<string, unknown> | undefined;
  const tempo = Number(trackSection?.tempo ?? 0) || null;

  // Nothing from any of them, so there is nothing to record and no point writing an empty row.
  if (!found?.id && !analysis.value && !canvas) return null;

  const cover = [...(found?.album?.images ?? [])].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  )[0]?.url;

  // Needs the artist id, which only the catalogue call knows — so this one really does depend on it,
  // and is skipped rather than guessed at.
  const artistId = found?.artists?.[0]?.id;
  const artist = artistId ? await spotifyArtist(artistId, catalogueHeaders) : null;

  // The label and the copyright line, which live on the album rather than the track. Only with an app
  // token: without one this would be a third request on the endpoint already refusing the first two.
  const albumId = found?.album?.id;
  const album = app.token && albumId ? await spotifyAlbum(albumId, catalogueHeaders) : null;

  // Spotify has no analysis for a great many recordings and never will, so the tempo is asked for
  // elsewhere when it has none. Both of these are free and unauthenticated; neither is asked at all
  // when Spotify already answered.
  //
  // Only on a **404**, which is Spotify saying it has nothing rather than failing to answer. That
  // distinction decides whether Spotify is ever asked again: a stored `analysis` satisfies the
  // harvest's skip guard, so recording features after a 429 or a dropped connection would retire the
  // track with no beat grid for good. A 404 will not change, so retiring it there is correct.
  let features: Record<string, unknown> | null = null;
  let fallbackTempo: number | null = null;
  if (tempo === null && analysis.result.status === 404) {
    const recco = await fromReccoBeats(spotifyId);
    if (recco) {
      fallbackTempo = recco.tempo;
      features = recco.features;
      log('debug', `tempo ${recco.tempo} from ReccoBeats, since Spotify had no analysis`);
    } else if (found?.external_ids?.isrc) {
      const deezer = await fromDeezer(found.external_ids.isrc);
      if (deezer !== null) {
        fallbackTempo = deezer;
        log('debug', `tempo ${deezer} from Deezer, since Spotify had no analysis`);
      }
    }
  }

  return {
    source: 'spotify',
    isrc: found?.external_ids?.isrc ?? null,
    durationMs: found?.duration_ms ?? null,
    coverUrl: cover ?? null,
    artistImageUrl: artist?.imageUrl ?? null,
    tempo: tempo ?? fallbackTempo,
    palette: null,
    // The features sit beside the analysis rather than in their own column: they are the same kind of
    // thing — what the audio is like — and one of them arrives when the other does not.
    analysis: analysis.value
      ? compactAnalysis(analysis.value)
      : features && Object.keys(features).length
        ? { features }
        : null,
    metadata: compact({
      albumName: found?.album?.name,
      albumType: found?.album?.album_type,
      albumTotalTracks: found?.album?.total_tracks,
      albumSpotifyId: found?.album?.id,
      releaseDate: found?.album?.release_date,
      releaseDatePrecision: found?.album?.release_date_precision,
      trackNumber: found?.track_number,
      discNumber: found?.disc_number,
      explicit: found?.explicit,
      popularity: found?.popularity,
      artistNames: found?.artists?.map((artist) => artist.name).filter(Boolean),
      artistSpotifyIds: found?.artists?.map((artist) => artist.id).filter(Boolean),
      spotifyId: found?.id,
      spotifyUrl: found?.external_urls?.spotify,
      artistGenres: artist?.genres.length ? artist.genres : undefined,
      artistFollowers: artist?.followers ?? undefined,
      ...(album ?? {}),
    }),
    canvas: canvas ?? undefined,
  };
}

/** Whether a track's Canvas should be asked about now. */
export function canvasIsDue(
  extras: ExtrasEntry | null,
  spotifyId: string | undefined,
  now = Date.now(),
): boolean {
  if (!spotifyId || !SPOTIFY_ID.test(spotifyId)) return false;
  if (!extras?.canvasCheckedAt || extras.canvas?.spotifyId !== spotifyId) return true;
  return now - extras.canvasCheckedAt >= CANVAS_RECHECK_MS;
}

/**
 * Asks about the Canvas alone, for a track whose other extras are already held.
 *
 * Returns the HTTP status, so the backfill can tell a refused token from one odd track.
 */
export async function harvestCanvas(
  store: Store,
  config: Config,
  key: string,
  spotifyId: string,
  log: (level: LogLevel, message: string) => void,
): Promise<{ canvas: StoredCanvas | null; status: number }> {
  const token = pastedToken(config.secrets.spotifyWebToken);
  if (!token || !SPOTIFY_ID.test(spotifyId)) return { canvas: null, status: 0 };
  const asked = await askCanvas(spotifyId, token, log);
  if (asked.canvas) store.saveCanvas(key, asked.canvas);
  return asked;
}

let backfilling = false;

/**
 * Asks about the Canvas of every track named by a Spotify id that has no current answer.
 *
 * Starts the run and returns at once, because four hundred requests outlast the reverse proxy's
 * response timeout; the outcome goes to the log. `done` is for tests.
 *
 * `gapMs` between tracks, because this shares its host with Spotify's lyrics, and a 429 here would
 * stop those for a minute too.
 */
export function backfillCanvas(
  store: Store,
  config: Config,
  log: (level: LogLevel, message: string) => void,
  gapMs = 1_000,
): { pending: number; skipped: string | null; done: Promise<void> } {
  const idle = Promise.resolve();
  if (backfilling) return { pending: 0, skipped: 'already filling in Canvas', done: idle };
  const token = pastedToken(config.secrets.spotifyWebToken);
  if (!token) {
    return {
      pending: 0,
      skipped: 'needs the Spotify web token — Canvas is on the player’s own service',
      done: idle,
    };
  }

  const keys = store
    .keysNeedingCanvas(Date.now() - CANVAS_RECHECK_MS)
    .filter((key) => SPOTIFY_ID.test(key.slice(3)));
  if (keys.length === 0) return { pending: 0, skipped: null, done: idle };

  backfilling = true;
  const done = (async () => {
    let found = 0;
    let none = 0;
    let looked = 0;
    let stopped: string | null = null;
    try {
      for (const key of keys) {
        if (looked > 0) await sleep(gapMs);
        looked++;
        const asked = await askCanvas(key.slice(3), token, log);
        if (asked.canvas) {
          store.saveCanvas(key, asked.canvas);
          if (asked.canvas.url) found++;
          else none++;
          continue;
        }
        // A refused or throttled token will refuse the rest too.
        if ([401, 403, 429].includes(asked.status)) {
          stopped = `stopped at HTTP ${asked.status}`;
          break;
        }
      }
    } finally {
      backfilling = false;
    }
    log(
      stopped ? 'warn' : 'info',
      `Canvas backfill: ${found} of ${looked} tracks have one, ${none} have none` +
        (looked - found - none > 0 ? `, ${looked - found - none} did not answer` : '') +
        (stopped ? ` — ${stopped}, ${keys.length - looked} not reached` : ''),
    );
  })();
  return { pending: keys.length, skipped: null, done };
}

/**
 * One track's Canvas, from the player's own service.
 *
 * `canvas` is null when there is no answer — a refused token, a throttle, a reply that does not
 * decode — as opposed to a `StoredCanvas` with no URL, which is Spotify saying there is none.
 */
async function askCanvas(
  spotifyId: string,
  token: string,
  log: (level: LogLevel, message: string) => void,
): Promise<{ canvas: StoredCanvas | null; status: number }> {
  const reply = await request(CANVAS_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/protobuf',
      'Content-Type': 'application/x-protobuf',
      Authorization: `Bearer ${token}`,
      'App-Platform': 'WebPlayer',
      'User-Agent': WEB_UA,
    },
    // EntityCanvazRequest { repeated Entity entities = 1 }, Entity { string entity_uri = 1 }.
    body: lengthDelimited(1, lengthDelimited(1, `spotify:track:${spotifyId}`)),
    binary: true,
  });

  if (!reply.ok || !reply.bytes) {
    log(
      reply.status === 429 ? 'warn' : 'debug',
      `spotify canvas lookup returned HTTP ${reply.status}`,
    );
    return { canvas: null, status: reply.status };
  }
  try {
    const canvas = readCanvas(reply.bytes, spotifyId);
    if (!canvas) log('debug', `spotify canvas reply for ${spotifyId} named a different track`);
    return { canvas, status: reply.status };
  } catch (error) {
    // Spotify publishes no .proto, so this is how a change of format would first show.
    log('warn', `spotify canvas reply did not decode: ${(error as Error).message}`);
    return { canvas: null, status: reply.status };
  }
}

/**
 * Reads an `EntityCanvazResponse`. Field numbers as observed, since there is no published schema:
 *
 * - top level: `1` repeated canvas, `2` ttl in seconds. A track with no Canvas gets only `2`.
 * - canvas: `1` id, `2` url, `4` type, `5` entity uri, `6` artist `{1 uri, 2 name}`, `11` canvas uri,
 *   `13` repeated smaller encodes `{1 width, 2 height, 3 url}`.
 *
 * Null when the reply holds a Canvas for some other track, which is not an answer about this one.
 * Throws when the reply is not protobuf.
 */
export function readCanvas(bytes: Uint8Array, spotifyId: string): StoredCanvas | null {
  const canvases = submessages(decode(bytes), 1);
  const none: StoredCanvas = { spotifyId, url: null, variants: [] };
  if (canvases.length === 0) return none;

  const canvas = canvases.find((entry) => text(entry, 5) === `spotify:track:${spotifyId}`);
  if (!canvas) return null;

  // One the app could not play counts as none: it would only be served to be dropped.
  const url = cdnUrl(text(canvas, 2));
  if (!url) return none;

  const variants = submessages(canvas, 13)
    .map((variant) => ({
      width: integer(variant, 1) ?? 0,
      height: integer(variant, 2) ?? 0,
      url: cdnUrl(text(variant, 3)) ?? '',
    }))
    .filter((variant) => variant.url && variant.width > 0 && variant.height > 0)
    .sort((a, b) => a.width * a.height - b.width * b.height);

  const artist = submessage(canvas, 6);
  return {
    spotifyId,
    url,
    variants,
    id: text(canvas, 1) ?? undefined,
    uri: text(canvas, 11) ?? undefined,
    type: integer(canvas, 4) ?? undefined,
    artistUri: (artist && text(artist, 1)) ?? undefined,
    artistName: (artist && text(artist, 2)) ?? undefined,
  };
}

/** Spotify's CDN over https, or nothing. The app accepts no other host. */
function cdnUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.scdn.co') ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Fills in the ISRCs of tracks whose Spotify id is already known.
 *
 * One request per track, deliberately, after measuring: `/v1/tracks?ids=` would do fifty at a time but
 * answers `403 Forbidden` for an ordinary application token — with two ids or with one, so it is the
 * endpoint rather than the request. `/v1/tracks/{id}` answers 200 for the same token and the same
 * track. Slower and it works, which is the better of the two.
 *
 * Exact rather than matched: each id names one recording, so there is no scoring and no chance of
 * recording the wrong ISRC. That matters more than the speed, because `noteIdentity` keeps the first
 * ISRC it is told and a wrong one is permanent.
 *
 * Needs an app token. Without one this is the endpoint that rate-limits a web-player token into
 * uselessness, and running it anyway would spend the whole budget to fill in two or three.
 */
export async function backfillIsrc(
  store: Store,
  config: Config,
  log: (level: LogLevel, message: string) => void,
): Promise<{ looked: number; found: number; missing: number; skipped: string | null }> {
  const app = await spotifyAppToken(config);
  if (app.detail) log('warn', app.detail);
  if (!app.token) {
    return {
      looked: 0,
      found: 0,
      missing: 0,
      skipped:
        'needs a Spotify client id and secret — a web-player token is rate-limited too hard for this',
    };
  }

  const pending = store.keysNeedingIsrc();
  if (pending.length === 0) return { looked: 0, found: 0, missing: 0, skipped: null };

  const headers = { Accept: 'application/json', Authorization: `Bearer ${app.token}` };
  let found = 0;
  let missing = 0;
  let looked = 0;
  let stopped: string | null = null;

  for (const entry of pending) {
    looked++;
    const result = await json<SpotifyTrack>(`${SPOTIFY_API}/tracks/${entry.spotifyId}`, { headers });

    const isrc = result.value?.external_ids?.isrc;
    if (isrc) {
      store.noteIdentity(entry.key, { isrc, durationMs: result.value?.duration_ms ?? null });
      found++;
      continue;
    }

    // A 404 is an answer rather than a fault, and rarer than it first looked: the case that prompted
    // this turned out to be an id I had mistyped by eye from a screenshot — base62 is case-sensitive
    // and `I` and `l` are the same shape in most fonts. An id that came from Spotify will resolve.
    //
    // Kept because it can still happen honestly — the player's catalogue is not the public one, and a
    // regional release can be playable and unlisted — but it is not the common case.
    if (result.result.status === 404) {
      missing++;
      log('debug', `${entry.spotifyId} is not in the public catalogue, so it has no ISRC to fetch`);
      continue;
    }

    // Anything else stops the run rather than grinding through the rest against a closed door.
    const said = redact(result.result.body ?? '').slice(0, 160).replace(/\s+/g, ' ');
    stopped = `stopped at HTTP ${result.result.status}: ${said}`;
    log('warn', `ISRC backfill ${stopped}`);
    break;
  }

  log(
    'info',
    `ISRC backfill: ${found} of ${looked} tracks now have one` +
      (missing > 0 ? `, ${missing} are not in the public catalogue` : '') +
      (looked < pending.length ? `, ${pending.length - looked} not reached` : ''),
  );
  // `looked` is what was actually asked about rather than what was queued: reporting the queue length
  // after breaking early presented an interrupted run as a finished one.
  return { looked, found, missing, skipped: stopped };
}

/**
 * Audio features from ReccoBeats, for a track Spotify never analysed.
 *
 * Free, unauthenticated, and keyed by the Spotify id — so it needs nothing this harvest does not
 * already have. It serves the feature set Spotify closed to new applications in November 2024:
 * measured against a track Spotify *does* analyse, its tempo came back as 171.001 where Spotify said
 * 171.001, so this is the same data rather than an independent estimate.
 *
 * What it does not have is the beat grid — that is `audio-analysis`, not `audio-features` — so a
 * beat-synchronised effect still needs Spotify. Coverage is roughly Spotify's own: the tracks Spotify
 * never analysed are largely missing here too.
 */
async function fromReccoBeats(
  spotifyId: string,
): Promise<{ tempo: number | null; features: Record<string, unknown> } | null> {
  const lookup = await json<{ content?: Array<{ id?: string }> }>(
    `${RECCOBEATS_API}/track?${query({ ids: spotifyId })}`,
  );
  // ReccoBeats keys its own records by its own id, so the Spotify id has to be traded for one first.
  const id = lookup.value?.content?.[0]?.id;
  if (!id) return null;

  const found = await json<Record<string, unknown>>(`${RECCOBEATS_API}/track/${id}/audio-features`);
  if (!found.value) return null;

  const tempo = Number(found.value.tempo ?? 0) || null;
  const features = compact({
    tempo: tempo ?? undefined,
    energy: found.value.energy,
    danceability: found.value.danceability,
    valence: found.value.valence,
    acousticness: found.value.acousticness,
    instrumentalness: found.value.instrumentalness,
    liveness: found.value.liveness,
    speechiness: found.value.speechiness,
    loudness: found.value.loudness,
    source: 'reccobeats',
  });
  return { tempo, features };
}

/**
 * A tempo from Deezer, keyed by ISRC.
 *
 * The last resort, and a partial one: of six ISRCs tested, three came back with a real tempo, one was
 * present with `bpm: 0` — which Deezer uses for "not measured" — and two were not on Deezer at all.
 * Worth asking because it costs one unauthenticated request and covers some of what ReccoBeats does
 * not, but not worth asking first.
 */
async function fromDeezer(isrc: string): Promise<number | null> {
  const found = await json<{ bpm?: number; error?: unknown }>(`${DEEZER_API}/track/isrc:${isrc}`);
  if (!found.value || found.value.error) return null;
  // Zero is Deezer's way of saying it has not measured one, not a track with no tempo.
  return Number(found.value.bpm ?? 0) || null;
}

/**
 * The artist's picture and what Spotify says they play.
 *
 * One request for both: the image was already being fetched here, and the genres come in the same
 * reply. Nothing else the server asks knows a genre at all — Apple gives one per song rather than per
 * artist, and the lyrics sources give none — so this is the only place it can come from.
 */
async function spotifyArtist(
  artistId: string,
  headers: Record<string, string>,
): Promise<{ imageUrl: string | null; genres: string[]; followers: number | null }> {
  const artist = await json<{
    images?: Array<{ url?: string; width?: number }>;
    genres?: string[];
    followers?: { total?: number };
  }>(`${SPOTIFY_API}/artists/${artistId}`, { headers });

  const image = [...(artist.value?.images ?? [])].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  )[0];
  return {
    imageUrl: image?.url ?? null,
    genres: (artist.value?.genres ?? []).filter(Boolean),
    followers: artist.value?.followers?.total ?? null,
  };
}

/**
 * The album's label and copyright, which are on the album rather than the track.
 *
 * A second request, and worth it: the label and the copyright line are the only things here that say
 * who actually released a recording, and no other source the server asks carries them. Skipped
 * entirely without an app token — it would be a third call on the endpoint that is rate-limiting the
 * first two.
 */
async function spotifyAlbum(
  albumId: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const album = await json<{
    label?: string;
    genres?: string[];
    popularity?: number;
    copyrights?: Array<{ text?: string; type?: string }>;
    external_ids?: { upc?: string; ean?: string };
  }>(`${SPOTIFY_API}/albums/${albumId}`, { headers });

  const value = album.value;
  if (!value) return null;
  return compact({
    label: value.label,
    albumUpc: value.external_ids?.upc,
    albumEan: value.external_ids?.ean,
    albumPopularity: value.popularity,
    albumGenres: value.genres?.length ? value.genres : undefined,
    // Joined rather than kept as objects: there are usually two, differing only in whether they are
    // the ℗ or the © line, and a reader wants the sentence.
    copyright: value.copyrights
      ?.map((entry) => entry.text)
      .filter(Boolean)
      .join(' / ') || undefined,
  });
}

/**
 * Finds a Spotify track id by searching, for a track the app could not name one for.
 *
 * The whole Spotify half of the harvest needs an id, so anything played from a source that does not
 * publish one — a local file, another music app — got nothing from Spotify at all: no ISRC, no cover,
 * no tempo. A search closes that, and only became reasonable with an app token, since the endpoint is
 * on the host that rate-limits a web-player one.
 *
 * Scored with the same matcher the providers use rather than taking the first result, because a search
 * for a common title returns a dozen recordings and the wrong one poisons the identity permanently:
 * `noteIdentity` keeps the first ISRC it is told.
 */
async function findSpotifyId(
  track: TrackQuery,
  headers: Record<string, string>,
): Promise<{ id: string | null; detail: string | null }> {
  // By ISRC first, which is exact rather than scored. Only a result carrying the same ISRC counts.
  if (track.isrc) {
    const isrc = track.isrc.toUpperCase();
    const byIsrc = await json<{
      tracks?: { items?: Array<{ id?: string; name?: string; external_ids?: { isrc?: string } }> };
    }>(`${SPOTIFY_API}/search?${query({ q: `isrc:${isrc}`, type: 'track', limit: '10' })}`, {
      headers,
    });
    const exact = byIsrc.value?.tracks?.items?.find(
      (item) => item.id && item.external_ids?.isrc?.toUpperCase() === isrc,
    );
    if (exact?.id) return { id: exact.id, detail: `found "${exact.name}" on Spotify by ISRC` };
  }

  const terms = [track.title, track.artist].filter(Boolean).join(' ');
  if (!terms.trim()) return { id: null, detail: null };

  const found = await json<{
    tracks?: {
      items?: Array<{
        id?: string;
        name?: string;
        duration_ms?: number;
        artists?: Array<{ name?: string }>;
        album?: { name?: string };
      }>;
    };
  }>(`${SPOTIFY_API}/search?${query({ q: terms, type: 'track', limit: '10' })}`, { headers });

  const items = found.value?.tracks?.items ?? [];
  if (items.length === 0) {
    return { id: null, detail: found.result.ok ? null : `search returned HTTP ${found.result.status}` };
  }

  let best: { id: string; score: number; name: string } | null = null;
  for (const item of items) {
    if (!item.id) continue;
    const candidateScore = score(
      track,
      item.name ?? '',
      item.artists?.map((artist) => artist.name).filter(Boolean).join(', ') ?? '',
      item.duration_ms ?? 0,
    );
    if (!best || candidateScore > best.score) {
      best = { id: item.id, score: candidateScore, name: item.name ?? '' };
    }
  }

  if (!best || best.score < MATCH_THRESHOLD) {
    return {
      id: null,
      detail: best
        ? `no Spotify match confident enough — closest was "${best.name}" at ${best.score.toFixed(2)}`
        : null,
    };
  }
  return { id: best.id, detail: `matched "${best.name}" on Spotify at ${best.score.toFixed(2)}` };
}

/**
 * Keep the analysis, but not all of it.
 *
 * `segments` is one entry per note-level event with a twelve-value timbre vector each — megabytes
 * for a long track, and nothing a lyrics renderer will ever read. The grids that *are* useful,
 * beats and bars and sections, are two orders of magnitude smaller.
 */
function compactAnalysis(analysis: Record<string, unknown>): Record<string, unknown> | null {
  // Everything except `segments`, rather than a hand-picked list: the endpoint is withdrawn from
  // the public API, so a field left behind today cannot be fetched tomorrow, and the shape has
  // fields nobody has named yet. `segments` is the one exclusion — one entry per note-level event
  // with a twelve-value timbre vector each, megabytes for a long track, and nothing a lyrics
  // renderer will ever read.
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(analysis)) {
    if (field === 'segments') continue;
    if (value === undefined || value === null) continue;
    kept[field] = value;
  }

  // A bound anyway. Beats and tatums for a long track are large, and a cache is not a place for
  // an unbounded blob however useful it is.
  if (JSON.stringify(kept).length > 256_000) {
    delete kept.tatums;
  }
  return Object.keys(kept).length ? kept : null;
}

/**
 * Apple: the song, then its artist.
 *
 * By ISRC when one is known, on the release whose UPC matches when that is known too. Otherwise a
 * scored search, because the media session gives us no Apple id. What this can get wrong is a
 * cover, not a lyric.
 */
async function fromApple(
  config: Config,
  track: TrackQuery,
  log: (level: LogLevel, message: string) => void,
): Promise<Harvest | null> {
  const token = config.secrets.appleBearerToken?.trim();
  if (!token || !track.title) return null;

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
  };
  const storefront = config.appleStorefront || 'us';
  const base = config.appleApiBase || APPLE_API_DEFAULT;

  let song: AppleSong | undefined;
  if (track.isrc) {
    const byIsrc = await songByIsrc(
      base,
      storefront,
      track.isrc,
      { upc: track.upc, album: track.album },
      headers,
    );
    if (byIsrc.song?.attributes) song = byIsrc.song;
    else if (byIsrc.status !== 200) log('debug', `harvest: Apple ISRC lookup returned HTTP ${byIsrc.status}`);
  }
  if (!song) song = await searchApple(base, storefront, track, headers, log);
  if (!song?.attributes) return null;
  const attributes = song.attributes;

  const artistId = song.relationships?.artists?.data?.[0]?.id;
  const artistImageUrl = artistId
    ? await appleArtistImage(base, storefront, artistId, headers).catch(() => null)
    : null;

  return {
    source: 'applemusic',
    isrc: attributes.isrc ?? null,
    durationMs: attributes.durationInMillis ?? null,
    // Left as the template Apple returns, `{w}x{h}`, so a caller picks its own size.
    coverUrl: attributes.artwork?.url ?? null,
    artistImageUrl,
    tempo: null,
    palette: compact({
      bgColor: attributes.artwork?.bgColor,
      textColor1: attributes.artwork?.textColor1,
      textColor2: attributes.artwork?.textColor2,
      textColor3: attributes.artwork?.textColor3,
      textColor4: attributes.artwork?.textColor4,
    }),
    analysis: null,
    metadata: compact({
      albumName: attributes.albumName,
      composerName: attributes.composerName,
      genreNames: attributes.genreNames,
      releaseDate: attributes.releaseDate,
      trackNumber: attributes.trackNumber,
      discNumber: attributes.discNumber,
      contentRating: attributes.contentRating,
      appleMusicId: song.id,
    }),
  };
}

/**
 * Scored, not taken on trust. An unscored first result is fine for artwork — a wrong cover is a
 * cosmetic annoyance — but this also reports an ISRC, and `noteIdentity` keeps the first ISRC it is
 * given. A remaster, a live take or a cover sitting at the top of the results would pin the wrong
 * recording permanently, and every later lookup would treat it as an exact match.
 */
async function searchApple(
  base: string,
  storefront: string,
  track: TrackQuery,
  headers: Record<string, string>,
  log: (level: LogLevel, message: string) => void,
): Promise<AppleSong | undefined> {
  const term = `${track.title} ${track.artist}`.trim();
  const search = await json<AppleSearch>(
    `${base}/v1/catalog/${storefront}/search?${query({
      term,
      types: 'songs',
      limit: 5,
    })}`,
    { headers },
  );

  const candidates = search.value?.results?.songs?.data ?? [];
  let song: AppleSong | undefined;
  let best = 0;
  for (const candidate of candidates) {
    const attributes = candidate.attributes;
    if (!attributes) continue;
    const scored = score(
      track,
      attributes.name ?? '',
      attributes.artistName ?? '',
      attributes.durationInMillis ?? 0,
    );
    if (scored > best) {
      best = scored;
      song = candidate;
    }
  }

  if (!song?.attributes || best < MATCH_THRESHOLD) {
    if (candidates.length > 0) {
      log(
        'info',
        `harvest: ${candidates.length} results for "${term}", best scored ${best.toFixed(2)} — ` +
          'not recording an identity from that',
      );
    }
    return undefined;
  }
  return song;
}

async function appleArtistImage(
  base: string,
  storefront: string,
  artistId: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const artist = await json<{
    data?: Array<{ attributes?: { artwork?: { url?: string } } }>;
  }>(`${base}/v1/catalog/${storefront}/artists/${artistId}`, { headers });
  return artist.value?.data?.[0]?.attributes?.artwork?.url ?? null;
}

/** Drop the fields that came back empty, so a stored blob holds only what was actually known. */
function compact(values: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// ---- the shapes we read, and only those ------------------------------------

interface SpotifyTrack {
  id?: string;
  duration_ms?: number;
  track_number?: number;
  disc_number?: number;
  explicit?: boolean;
  popularity?: number;
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
  artists?: Array<{ id?: string; name?: string }>;
  album?: {
    id?: string;
    name?: string;
    album_type?: string;
    total_tracks?: number;
    release_date?: string;
    release_date_precision?: string;
    images?: Array<{ url?: string; width?: number }>;
  };
}

interface AppleSearch {
  results?: { songs?: { data?: AppleSong[] } };
}
