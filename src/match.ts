/**
 * Deciding whether a search result is the track that was asked for.
 *
 * Wrong lyrics are worse than no lyrics — they are actively misleading, and on a karaoke
 * screen they are unusable in a way an empty screen is not. So the threshold is set where a
 * near-miss is discarded, and every source that finds tracks by name rather than by id has
 * to clear it.
 */

import {
  cleanTrackTitle,
  comparableScripts,
  foldTight,
  similarity,
  splitArtists,
} from './text.ts';

export interface TrackQuery {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** Bare 22-character id, when the app knew it. Beats every kind of name matching. */
  spotifyId?: string;
  isrc?: string;
}

export const MATCH_THRESHOLD = 0.62;

export function cleanTitleOf(query: TrackQuery): string {
  return cleanTrackTitle(query.title);
}

export function primaryArtistOf(query: TrackQuery): string {
  return splitArtists(query.artist)[0] ?? query.artist;
}

/**
 * How well a candidate matches, 0..1.
 *
 * Title carries half the weight, artist a third, duration a fifth. A missing or
 * incomparable value scores 0.5 — "unknown", not "wrong" — so the fields that *are* known
 * decide the outcome instead of an absence dragging everything under the threshold.
 */
export function score(
  query: TrackQuery,
  candidateTitle: string,
  candidateArtist: string,
  candidateDurationMs: number,
): number {
  const titleScore = Math.max(
    similarity(query.title, candidateTitle),
    similarity(cleanTitleOf(query), cleanTrackTitle(candidateTitle)),
  );

  let artistScore: number;
  if (!query.artist.trim() || !candidateArtist.trim()) {
    artistScore = 0.5;
  } else if (!comparableScripts(query.artist, candidateArtist)) {
    artistScore = 0.5;
  } else {
    const primary = primaryArtistOf(query);
    artistScore = Math.max(
      similarity(query.artist, candidateArtist),
      similarity(primary, candidateArtist),
      containsFold(candidateArtist, primary) ? 1 : 0,
      // Every credited artist gets a look: catalogues disagree about who is "the" artist
      // on a collaboration.
      ...splitArtists(query.artist).map((one) => similarity(one, candidateArtist)),
    );
  }

  let durationScore: number;
  if (query.durationMs <= 0 || candidateDurationMs <= 0) {
    durationScore = 0.5;
  } else {
    const delta = Math.abs(query.durationMs - candidateDurationMs);
    durationScore = delta <= 2_000 ? 1 : delta <= 5_000 ? 0.75 : delta <= 10_000 ? 0.35 : 0;
  }

  return titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.2;
}

/** Best score across every title/artist pair a candidate lists under. */
export function bestScore(
  query: TrackQuery,
  titles: string[],
  artists: string[],
  durationMs: number,
): number {
  const titleList = titles.length > 0 ? titles : [''];
  const artistList = artists.length > 0 ? artists : [''];
  let best = 0;
  for (const title of titleList) {
    for (const artist of artistList) {
      best = Math.max(best, score(query, title, artist, durationMs));
    }
  }
  return best;
}

function containsFold(haystack: string, needle: string): boolean {
  if (!needle.trim()) return false;
  return foldTight(haystack).includes(foldTight(needle));
}

/**
 * The cache key for a track.
 *
 * The Spotify id when there is one, because it identifies the recording rather than
 * describing it. Otherwise title, artist and a two-second duration bucket — the bucket so
 * that two players reporting 255.0s and 255.9s do not split one song into two entries.
 */
export function cacheKey(query: TrackQuery): string {
  if (query.spotifyId) return `sp:${query.spotifyId}`;
  if (query.isrc) return `isrc:${query.isrc.toUpperCase()}`;
  const title = foldTight(query.title);
  const artist = foldTight(primaryArtistOf(query));
  return `q:${title}|${artist}|${Math.floor(query.durationMs / 2000)}`;
}
