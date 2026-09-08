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
import type { Store } from './db.ts';
import { json, query } from './http.ts';
import type { TrackQuery } from './match.ts';
import { pastedToken } from './providers/spotify.ts';

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_INTERNAL = 'https://spclient.wg.spotify.com';
const APPLE_API = 'https://amp-api.music.apple.com';

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
  source: string;
}

/**
 * Collect and store whatever the configured tokens can reach for one track.
 *
 * Both sources are consulted rather than the first that answers, because they know different
 * things: only Spotify has the tempo and the beat grid, only Apple has the songwriter and a
 * colour palette, and either may have an ISRC the other lacks.
 */
export async function harvest(
  store: Store,
  config: Config,
  key: string,
  track: TrackQuery,
): Promise<void> {
  const results: Harvest[] = [];

  const spotify = await fromSpotify(config, track).catch(() => null);
  if (spotify) results.push(spotify);

  const apple = await fromApple(config, track).catch(() => null);
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
async function fromSpotify(config: Config, track: TrackQuery): Promise<Harvest | null> {
  const token = pastedToken(config.secrets.spotifyWebToken);
  if (!token || !track.spotifyId) return null;

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'App-Platform': 'WebPlayer',
    'User-Agent': WEB_UA,
  };

  const details = await json<SpotifyTrack>(`${SPOTIFY_API}/tracks/${track.spotifyId}`, { headers });
  const found = details.value;
  if (!found?.id) return null;

  const cover = [...(found.album?.images ?? [])].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  )[0]?.url;

  // The internal analysis endpoint, not the public one — the public `audio-features` was
  // restricted to apps that already had extended access, so this is the only way to it.
  const analysis = await json<Record<string, unknown>>(
    `${SPOTIFY_INTERNAL}/audio-attributes/v1/audio-analysis/${track.spotifyId}?${query({
      format: 'json',
    })}`,
    { headers },
  );

  const trackSection = analysis.value?.track as Record<string, unknown> | undefined;
  const tempo = Number(trackSection?.tempo ?? 0) || null;

  const artistId = found.artists?.[0]?.id;
  const artistImageUrl = artistId ? await spotifyArtistImage(artistId, headers) : null;

  return {
    source: 'spotify',
    isrc: found.external_ids?.isrc ?? null,
    durationMs: found.duration_ms ?? null,
    coverUrl: cover ?? null,
    artistImageUrl,
    tempo,
    palette: null,
    analysis: analysis.value ? compactAnalysis(analysis.value) : null,
    metadata: compact({
      albumName: found.album?.name,
      releaseDate: found.album?.release_date,
      trackNumber: found.track_number,
      discNumber: found.disc_number,
      explicit: found.explicit,
      popularity: found.popularity,
      spotifyId: found.id,
    }),
  };
}

async function spotifyArtistImage(
  artistId: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const artist = await json<{ images?: Array<{ url?: string; width?: number }> }>(
    `${SPOTIFY_API}/artists/${artistId}`,
    { headers },
  );
  const image = [...(artist.value?.images ?? [])].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  )[0];
  return image?.url ?? null;
}

/**
 * Keep the analysis, but not all of it.
 *
 * `segments` is one entry per note-level event with a twelve-value timbre vector each — megabytes
 * for a long track, and nothing a lyrics renderer will ever read. The grids that *are* useful,
 * beats and bars and sections, are two orders of magnitude smaller.
 */
function compactAnalysis(analysis: Record<string, unknown>): Record<string, unknown> | null {
  const track = analysis.track as Record<string, unknown> | undefined;
  const kept = compact({
    tempo: track?.tempo,
    tempoConfidence: track?.tempo_confidence,
    key: track?.key,
    mode: track?.mode,
    timeSignature: track?.time_signature,
    loudness: track?.loudness,
    duration: track?.duration,
    endOfFadeIn: track?.end_of_fade_in,
    startOfFadeOut: track?.start_of_fade_out,
    beats: analysis.beats,
    bars: analysis.bars,
    sections: analysis.sections,
  });
  return kept;
}

/**
 * Apple: the song, then its artist.
 *
 * A search rather than an id lookup, because the media session gives us no Apple id. The result
 * is not scored here — the caller has already decided which recording this is, and the lyrics
 * provider does the scoring where it matters. What this can get wrong is a cover, not a lyric.
 */
async function fromApple(config: Config, track: TrackQuery): Promise<Harvest | null> {
  const token = config.secrets.appleBearerToken?.trim();
  if (!token || !track.title) return null;

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
  };
  const storefront = config.appleStorefront || 'us';

  const term = `${track.title} ${track.artist}`.trim();
  const search = await json<AppleSearch>(
    `${APPLE_API}/v1/catalog/${storefront}/search?${query({
      term,
      types: 'songs',
      limit: 5,
    })}`,
    { headers },
  );

  const song = search.value?.results?.songs?.data?.[0];
  if (!song?.attributes) return null;
  const attributes = song.attributes;

  const artistId = song.relationships?.artists?.data?.[0]?.id;
  const artistImageUrl = artistId
    ? await appleArtistImage(storefront, artistId, headers).catch(() => null)
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

async function appleArtistImage(
  storefront: string,
  artistId: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const artist = await json<{
    data?: Array<{ attributes?: { artwork?: { url?: string } } }>;
  }>(`${APPLE_API}/v1/catalog/${storefront}/artists/${artistId}`, { headers });
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
  artists?: Array<{ id?: string; name?: string }>;
  album?: {
    name?: string;
    release_date?: string;
    images?: Array<{ url?: string; width?: number }>;
  };
}

interface AppleSearch {
  results?: {
    songs?: {
      data?: Array<{
        id?: string;
        attributes?: {
          isrc?: string;
          durationInMillis?: number;
          albumName?: string;
          composerName?: string;
          genreNames?: string[];
          releaseDate?: string;
          trackNumber?: number;
          discNumber?: number;
          contentRating?: string;
          artwork?: {
            url?: string;
            bgColor?: string;
            textColor1?: string;
            textColor2?: string;
            textColor3?: string;
            textColor4?: string;
          };
        };
        relationships?: { artists?: { data?: Array<{ id?: string }> } };
      }>;
    };
  };
}
