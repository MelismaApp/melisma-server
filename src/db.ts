/**
 * Storage. One SQLite file, no migrations framework, no ORM.
 *
 * The important design decision is here rather than anywhere else: **every provider's raw
 * response is kept forever, and the merged document is a derived artifact.** A merged
 * document is only as good as the merge algorithm that produced it, and that algorithm will
 * get better. Keeping the raw bodies means improving it is a local recompute over data
 * already on disk instead of re-fetching thousands of tracks from services that are doing
 * this for free.
 *
 * That is also the answer to "why run a server at all" — the app already caches merged
 * results on the phone. The server is the archive.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CacheEntry {
  key: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  spotifyId: string | null;
  isrc: string | null;
  /** Null when every source came back empty — a cached "no lyrics exist". */
  merged: string | null;
  mergeVersion: number;
  createdAt: number;
  updatedAt: number;
  hits: number;
  lastHitAt: number | null;
}

export interface RawResponse {
  key: string;
  provider: string;
  body: string;
  contentType: string;
  fetchedAt: number;
  ok: boolean;
  note: string | null;
}

/**
 * How a source answered when it was last asked about a track.
 *
 * `deferred` is a fourth case and the newest: the request was never made, because the host is paced in
 * tens of seconds and its turn had not come. It looks exactly like `unreachable` from the provider's side
 * and must not be treated like it — six hours of cooldown for a source that was forty seconds early is
 * how a pacing rule turns into a source nobody asks any more.
 *
 * `none` is an answer and `unreachable` is not, which is the whole distinction: one is settled and
 * the other is worth trying again.
 */
export type AttemptOutcome = 'lyrics' | 'none' | 'unreachable' | 'deferred';

/** A JSON column read back, or null if it was empty or unreadable. */
function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Everything about a track that is not its words, as some token once reported it.
 *
 * All of it optional and all of it merged rather than replaced, because the sources know
 * different things: Spotify has the tempo and the beat grid, Apple has the songwriter and a
 * colour palette, and neither has everything.
 */
export interface ExtrasEntry {
  key: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  artistImageUrl: string | null;
  tempo: number | null;
  /** Mirrored from the cache entry, so that write order cannot lose it. See `noteIdentity`. */
  isrc: string | null;
  durationMs: number | null;
  /** Extracted colours: Apple's `bgColor` and `textColor1..4`, Spotify's accent. */
  palette: Record<string, unknown> | null;
  /**
   * The rest of Spotify's audio analysis: key, mode, time signature, loudness, energy,
   * danceability, and the beats, bars and sections grids.
   *
   * Worth holding above all the others because this is the endpoint the public Web API
   * deprecated in November 2024 — a cached copy is the only durable one there is. The beat grid
   * in particular is a capability rather than a decoration: a background can pulse on the beat
   * instead of drifting at a rate derived from the tempo.
   */
  analysis: Record<string, unknown> | null;
  /** Album name, release date, track and disc numbers, composer, genres, content rating. */
  metadata: Record<string, unknown> | null;
  /** The last answer Spotify gave about a Canvas, including "none". Null if never asked. */
  canvas: StoredCanvas | null;
  canvasCheckedAt: number | null;
  source: string;
  updatedAt: number;
}

/**
 * A Spotify Canvas, or the record that a track has none (`url` null), so it is not asked again.
 *
 * Always for the Spotify id it was asked about, never a matched one: a Canvas is made for one
 * release, and a remaster's would be obviously wrong.
 */
export interface StoredCanvas {
  spotifyId: string;
  url: string | null;
  /** Smaller encodes of the same video, smallest first. */
  variants: Array<{ width: number; height: number; url: string }>;
  /** Spotify's own ids and type code, kept as given; nothing reads them yet. */
  id?: string;
  uri?: string;
  type?: number;
  artistUri?: string;
  artistName?: string;
}

/**
 * One song, and everything the server holds about it.
 *
 * Assembled per page rather than stored: the lyric shape has to come out of the merged JSON, and
 * the provider list out of the archive. Cheap at fifty rows, and it means adding a thing worth
 * showing never needs a migration.
 */
export interface LibraryRow {
  key: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  spotifyId: string | null;
  isrc: string | null;

  // ---- the words ----
  hasLyrics: boolean;
  kind: string | null;
  lines: number;
  syllableLines: number;
  hasTranslation: boolean;
  hasRomanization: boolean;
  /** Which source's timings the merge kept. */
  timing: string | null;
  mergeVersion: number;

  // ---- the archive ----
  /** Every provider with a stored response, contributions included. */
  providers: string[];
  archivedBytes: number;

  // ---- everything that is not the words ----
  hasExtras: boolean;
  /** Which of the extras are actually populated, for the "what is cached" column. */
  extrasFields: string[];
  extrasSource: string | null;

  /**
   * Every external id collected for this recording, keyed by where it came from.
   *
   * Pulled out of the metadata blob rather than stored in columns, and surfaced separately from
   * the rest of it because identity is what turns a fuzzy title match into an exact lookup — it
   * is the most valuable thing the harvest collects, and the thing most worth searching by.
   */
  ids: Record<string, string>;

  hits: number;
  /** When the track was first seen, as opposed to last touched. */
  createdAt: number;
  lastHitAt: number | null;
  /** The last request for it; what "recently asked" sorts by. */
  askedAt: number | null;
  updatedAt: number;
}

export interface LibraryQuery {
  search?: string;
  /** Search the lyric text as well as the title, artist and album. */
  inLyrics?: boolean;
  sort?: 'song' | 'recent' | 'hits' | 'lines' | 'added' | 'asked';
  /** Only songs missing something, for finding the gaps. */
  missing?: 'lyrics' | 'extras' | 'syllables' | 'translation' | 'isrc' | 'analysis';
  /** Only songs this user asked for (0 is the admin key), with their counts rather than everybody's. */
  askedBy?: number;
  limit?: number;
  offset?: number;
}

/** Somebody's own key, beside the admin one. */
export interface User {
  id: number;
  name: string;
  /** The key's last four characters. The key itself is not kept. */
  keyHint: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** How many tracks they have asked for. */
  tracks: number;
}

/** User keys are random and long, so a fast hash is enough: there is nothing to guess. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface LogEvent {
  id: number;
  at: number;
  level: LogLevel;
  provider: string | null;
  message: string;
}

/**
 * Log levels, in the order they are worth reading.
 *
 * `debug` exists so the detail that explains a failure can be recorded without burying the lines that
 * announce one — a rate limit reported per request is noise on a good day and the whole answer on a
 * bad one. The admin page filters by minimum level, so nothing has to be decided at the call site.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** How a minimum-level filter is applied: everything at least this severe. */
export function atLeast(level: LogLevel): LogLevel[] {
  return LOG_LEVELS.slice(LOG_LEVELS.indexOf(level)) as unknown as LogLevel[];
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const isNew = path === ':memory:' || !existsSync(path);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();

    if (path !== ':memory:') {
      // The file holds the user's Spotify cookie and Apple tokens in the clear — see the
      // note in README about why, and at minimum keep other accounts on the machine out.
      try {
        chmodSync(path, 0o600);
      } catch {
        /* A filesystem that does not do permissions is not worth failing over. */
      }
      if (isNew) this.log('info', null, 'created a new database');
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        key           TEXT PRIMARY KEY,
        title         TEXT NOT NULL DEFAULT '',
        artist        TEXT NOT NULL DEFAULT '',
        album         TEXT NOT NULL DEFAULT '',
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        spotify_id    TEXT,
        isrc          TEXT,
        merged        TEXT,
        merge_version INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        hits          INTEGER NOT NULL DEFAULT 0,
        last_hit_at   INTEGER
      );

      CREATE INDEX IF NOT EXISTS entries_updated ON entries (updated_at DESC);
      CREATE INDEX IF NOT EXISTS entries_search  ON entries (title, artist);

      -- The archive. Deliberately not unique on (key, provider) alone: a provider that
      -- answers with several documents for one track keeps them all.
      CREATE TABLE IF NOT EXISTS raw (
        key          TEXT NOT NULL,
        provider     TEXT NOT NULL,
        body         TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/plain',
        fetched_at   INTEGER NOT NULL,
        ok           INTEGER NOT NULL DEFAULT 1,
        note         TEXT,
        PRIMARY KEY (key, provider)
      );

      -- What each source said last time it was asked about a track.
      --
      -- The archive above only holds answers, so it cannot distinguish a source that was asked and
      -- had nothing from one that could not be reached — and those want opposite treatment. "No
      -- lyrics here" is a real answer and re-asking it every play is six wasted requests; a timeout
      -- or a refused token is worth another go, because the reason it failed may be gone.
      --
      -- Without this, a track cached during an outage kept the answer it managed to get for the full
      -- thirty days, and nothing knew a better one had ever been missed.
      CREATE TABLE IF NOT EXISTS attempts (
        key      TEXT NOT NULL,
        provider TEXT NOT NULL,
        -- 'lyrics' | 'none' | 'unreachable' | 'deferred'
        outcome  TEXT NOT NULL,
        at       INTEGER NOT NULL,
        PRIMARY KEY (key, provider)
      );

      -- Artwork and tempo, which outlive the tokens that found them.
      --
      -- A Spotify access token is good for an hour and an Apple developer token for a few
      -- months; a cover URL and a tempo, once known, are true forever. The app contributes
      -- what its tokens turn up and this is where it lands, so a phone with no token — or the
      -- same phone an hour later — can still be asked.
      CREATE TABLE IF NOT EXISTS extras (
        key              TEXT PRIMARY KEY,
        title            TEXT NOT NULL DEFAULT '',
        artist           TEXT NOT NULL DEFAULT '',
        cover_url        TEXT,
        artist_image_url TEXT,
        tempo            REAL,
        -- Identity is mirrored here as well as on the entries table, and the reason is ordering.
        -- A provider reports an ISRC while it is being asked for lyrics, and the harvest reports
        -- one of its own; both can happen before the entry row exists. Writing identity only to
        -- entries meant an UPDATE that matched nothing and silently threw the field away -- and an
        -- ISRC is the single most valuable thing collected here, because it turns every later
        -- fuzzy match into an exact lookup. Creating a bare entries row instead is not an option:
        -- one with no merged document *means* "asked, and there are no lyrics", which the negative
        -- cache would then serve.
        isrc             TEXT,
        duration_ms      INTEGER,
        -- Three JSON blobs rather than thirty columns. What is worth keeping here has grown
        -- twice already and will again; a schema change per field would mean a migration per
        -- field, for data whose only consumer reads it back whole.
        --
        -- palette:    bgColor and textColor1..4 from Apple's artwork, Spotify's accent.
        -- analysis:   key, mode, timeSignature, loudness, energy, danceability, and the
        --             beats/bars/sections grids — the endpoint the public API deprecated, so a
        --             cached copy is the only durable one there is.
        -- metadata:   albumName, releaseDate, trackNumber, discNumber, composerName,
        --             genreNames, contentRating.
        palette          TEXT,
        analysis         TEXT,
        metadata         TEXT,
        -- A StoredCanvas as JSON. Replaced rather than merged: each answer supersedes the last.
        canvas           TEXT,
        canvas_checked_at INTEGER,
        source           TEXT NOT NULL DEFAULT '',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        hits             INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        level    TEXT NOT NULL,
        provider TEXT,
        message  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);

      -- A key per person or device, beside the admin key. Only a hash is kept: a key is shown once,
      -- when it is made, and a copy of this file must not be a way in.
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        key_hash     TEXT NOT NULL UNIQUE,
        -- The key's last four characters, to tell two keys apart in the list.
        key_hint     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      );

      -- Who asked for which track. The cache is shared; this is what makes it "mine" for a user.
      -- user_id 0 is the admin key, and a lookup from the local network without one.
      CREATE TABLE IF NOT EXISTS requests (
        user_id  INTEGER NOT NULL,
        key      TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at  INTEGER NOT NULL,
        count    INTEGER NOT NULL DEFAULT 1,
        -- What was asked, so a track nothing was cached for can still be named in the library.
        title    TEXT NOT NULL DEFAULT '',
        artist   TEXT NOT NULL DEFAULT '',
        album    TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, key)
      );

      CREATE INDEX IF NOT EXISTS requests_key ON requests (key);
    `);

    // Columns added after the table first shipped. SQLite has no `ADD COLUMN IF NOT EXISTS`, and
    // a duplicate-column error is the expected outcome on an already-migrated database.
    for (const column of [
      'isrc TEXT',
      'duration_ms INTEGER',
      'canvas TEXT',
      'canvas_checked_at INTEGER',
    ]) {
      try {
        this.db.exec(`ALTER TABLE extras ADD COLUMN ${column}`);
      } catch {
        // Already there.
      }
    }

    // Added to `requests` after it first shipped.
    for (const column of [
      "title TEXT NOT NULL DEFAULT ''",
      "artist TEXT NOT NULL DEFAULT ''",
      "album TEXT NOT NULL DEFAULT ''",
      'duration_ms INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.db.exec(`ALTER TABLE requests ADD COLUMN ${column}`);
      } catch {
        // Already there.
      }
    }

    // Whether an ISRC was in hand when a source was asked.
    //
    // Because "did this source answer?" is not the whole question. A source asked by name, before any
    // ISRC was known, was answering a worse question than the same source asked exactly — and the
    // answer it gave is not evidence that asking properly would give the same one. Defaults to 0, so
    // every attempt recorded before this existed counts as name-searched, which is the safe reading.
    try {
      this.db.exec('ALTER TABLE attempts ADD COLUMN had_isrc INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Already there.
    }
  }

  // ---- extras ------------------------------------------------------------

  /** `hit: false` for the server's own reads, which are not somebody asking about the track. */
  extras(key: string, { hit = true }: { hit?: boolean } = {}): ExtrasEntry | null {
    const row = this.db.prepare('SELECT * FROM extras WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (hit) this.db.prepare('UPDATE extras SET hits = hits + 1 WHERE key = ?').run(key);
    return {
      key,
      title: String(row.title ?? ''),
      artist: String(row.artist ?? ''),
      coverUrl: (row.cover_url as string | null) ?? null,
      artistImageUrl: (row.artist_image_url as string | null) ?? null,
      tempo: (row.tempo as number | null) ?? null,
      isrc: (row.isrc as string | null) ?? null,
      durationMs: (row.duration_ms as number | null) ?? null,
      palette: parseJson(row.palette),
      analysis: parseJson(row.analysis),
      metadata: parseJson(row.metadata),
      canvas: parseJson(row.canvas) as StoredCanvas | null,
      canvasCheckedAt: (row.canvas_checked_at as number | null) ?? null,
      source: String(row.source ?? ''),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  /**
   * Records Spotify's answer about a Canvas, replacing the previous one.
   *
   * Only for an answer. A request that failed says nothing about the Canvas and must not be recorded,
   * or a removed one would be kept, or an outage would read as "none".
   */
  saveCanvas(key: string, canvas: StoredCanvas, at = Date.now()): void {
    const value = JSON.stringify(canvas);
    this.db
      .prepare(
        `INSERT INTO extras (key, canvas, canvas_checked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           canvas            = excluded.canvas,
           canvas_checked_at = excluded.canvas_checked_at,
           -- A re-check that changed nothing is not an update to the track.
           updated_at        = CASE WHEN extras.canvas IS excluded.canvas THEN extras.updated_at
                                    ELSE excluded.updated_at END`,
      )
      .run(key, value, at, at, at);
  }

  /** Keys named by a Spotify id whose Canvas was never asked about, or last asked before `before`. */
  keysNeedingCanvas(before: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT k.key AS key
           FROM (SELECT key FROM entries UNION SELECT key FROM extras) k
           LEFT JOIN extras x ON x.key = k.key
          WHERE k.key LIKE 'sp:%'
            AND (x.canvas_checked_at IS NULL OR x.canvas_checked_at < ?)`,
      )
      .all(before) as { key: string }[];
    return rows.map((row) => row.key);
  }

  /**
   * Remember what a token turned up.
   *
   * Merged rather than replaced: Spotify has the tempo and Apple does not, so a later Apple
   * contribution must not blank a tempo an earlier Spotify one supplied. A field is only
   * overwritten when the new value is actually there.
   */
  saveExtras(entry: Partial<Omit<ExtrasEntry, 'updatedAt'>> & { key: string }): void {
    const now = Date.now();
    const blob = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') return null;
      const keys = Object.keys(value as Record<string, unknown>);
      return keys.length ? JSON.stringify(value) : null;
    };

    // Every optional field is normalised to null here rather than trusted to arrive.
    // `node:sqlite` refuses to bind `undefined`, so a caller that reports only what it happens to
    // know — which is every provider — threw. Inside a provider's `fetch` that throw was caught as
    // a provider failure, so the source was marked unreachable and its lyrics discarded: a missing
    // tempo silently cost a whole set of words. Six call sites can each forget; this cannot.
    const value = <T>(given: T | null | undefined): T | null => given ?? null;

    this.db
      .prepare(
        `INSERT INTO extras
           (key, title, artist, cover_url, artist_image_url, tempo, isrc, duration_ms,
            palette, analysis, metadata, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           -- Only ever filled in: whoever knew a field first keeps it, so write order does not
           -- decide the answer.
           title            = CASE WHEN excluded.title  <> '' THEN excluded.title
                                   ELSE extras.title END,
           artist           = CASE WHEN excluded.artist <> '' THEN excluded.artist
                                   ELSE extras.artist END,
           cover_url        = COALESCE(excluded.cover_url, extras.cover_url),
           artist_image_url = COALESCE(excluded.artist_image_url, extras.artist_image_url),
           tempo            = COALESCE(excluded.tempo, extras.tempo),
           isrc             = COALESCE(extras.isrc, excluded.isrc),
           duration_ms      = COALESCE(extras.duration_ms, excluded.duration_ms),
           -- Merged key by key, not replaced. The sources know different things — Spotify has the
           -- tempo and the album ids, Apple the songwriter and the palette — and they finish in
           -- parallel, so replacing the blob meant whichever landed last erased the other. Keys
           -- already present win, for the same reason the scalars above do.
           -- NULLIF because merging two absent blobs yields '{}', not null — which would read as
           -- "an analysis is present" and hide the track from the list of ones still missing it.
           palette          = NULLIF(json_patch(COALESCE(excluded.palette, '{}'),
                                                COALESCE(extras.palette, '{}')), '{}'),
           analysis         = NULLIF(json_patch(COALESCE(excluded.analysis, '{}'),
                                                COALESCE(extras.analysis, '{}')), '{}'),
           metadata         = NULLIF(json_patch(COALESCE(excluded.metadata, '{}'),
                                                COALESCE(extras.metadata, '{}')), '{}'),
           -- Every source that has contributed, rather than only the most recent one.
           source           = CASE
                                WHEN extras.source = '' THEN excluded.source
                                WHEN excluded.source = '' THEN extras.source
                                WHEN instr(extras.source, excluded.source) > 0 THEN extras.source
                                ELSE extras.source || '+' || excluded.source
                              END,
           updated_at       = excluded.updated_at`,
      )
      .run(
        entry.key,
        entry.title ?? '',
        entry.artist ?? '',
        value(entry.coverUrl),
        value(entry.artistImageUrl),
        value(entry.tempo),
        value(entry.isrc),
        value(entry.durationMs),
        blob(entry.palette),
        blob(entry.analysis),
        blob(entry.metadata),
        entry.source ?? '',
        now,
        now,
      );
  }

  /**
   * Record what a track *is*, as opposed to what it looks like.
   *
   * An ISRC identifies a recording globally, and an authoritative duration in milliseconds
   * turns the duration term in the matcher from a neutral 0.5 into a decision. Both belong on
   * the cache entry rather than in the extras, because the code that needs them is the matcher,
   * not the renderer — and because they never go stale, where a URL eventually does.
   *
   * Only ever fills a gap: a value already recorded is left alone. The first source to identify
   * a recording is as good as the second, and overwriting invites a worse answer to replace a
   * better one.
   */
  noteIdentity(key: string, identity: { isrc?: string | null; durationMs?: number | null }): void {
    const isrc = identity.isrc?.trim() || null;
    const durationMs = identity.durationMs && identity.durationMs > 0 ? identity.durationMs : null;
    if (!isrc && !durationMs) return;

    // On the cache entry, where the lookup path can see it — if there is one yet.
    this.db
      .prepare(
        `UPDATE entries
            SET isrc        = COALESCE(isrc, ?),
                duration_ms = CASE WHEN duration_ms > 0 THEN duration_ms ELSE COALESCE(?, 0) END
          WHERE key = ?`,
      )
      .run(isrc, durationMs, key);

    // And on the extras row, which can be created from nothing. This is what makes the write
    // order irrelevant: a provider reporting an ISRC mid-lookup, and a harvest reporting one
    // afterwards, both land somewhere either way.
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO extras (key, isrc, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           isrc        = COALESCE(extras.isrc, excluded.isrc),
           duration_ms = COALESCE(extras.duration_ms, excluded.duration_ms),
           updated_at  = excluded.updated_at`,
      )
      .run(key, isrc, durationMs, now, now);
  }

  /**
   * What is known about a track's identity, from wherever it was recorded.
   *
   * The point of keeping it: the next lookup of the same track can be an exact one. AMLL indexes
   * on ISRC directly and Apple filters on it, so a recording seen once by name can be found by
   * identity ever after — which is worth more than any amount of tuning the name matcher.
   */
  identityFor(key: string): { isrc: string | null; durationMs: number | null; upc: string | null } {
    const entry = this.db
      .prepare('SELECT isrc, duration_ms FROM entries WHERE key = ?')
      .get(key) as { isrc: string | null; duration_ms: number | null } | undefined;
    const extras = this.db
      .prepare(
        "SELECT isrc, duration_ms, json_extract(metadata, '$.albumUpc') AS upc FROM extras WHERE key = ?",
      )
      .get(key) as
      | { isrc: string | null; duration_ms: number | null; upc: string | number | null }
      | undefined;

    const isrc = entry?.isrc?.trim() || extras?.isrc?.trim() || null;
    const durationMs =
      (entry?.duration_ms && entry.duration_ms > 0 ? entry.duration_ms : null) ??
      (extras?.duration_ms && extras.duration_ms > 0 ? extras.duration_ms : null);
    // Spotify's, from the album of the track id: the release actually being played.
    const upc = extras?.upc != null ? String(extras.upc).trim() || null : null;
    return { isrc, durationMs, upc };
  }

  /**
   * The ISRC known for a track, from wherever it was recorded.
   *
   * The entry first, because that is where the lookup path keeps it, then the extras row, which
   * is where one learned before the entry existed ends up.
   */
  isrcFor(key: string): string | null {
    const entry = this.db.prepare('SELECT isrc FROM entries WHERE key = ?').get(key) as
      | { isrc: string | null }
      | undefined;
    if (entry?.isrc?.trim()) return entry.isrc.trim();

    const extras = this.db.prepare('SELECT isrc FROM extras WHERE key = ?').get(key) as
      | { isrc: string | null }
      | undefined;
    return extras?.isrc?.trim() || null;
  }

  extrasCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM extras').get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  // ---- settings ----------------------------------------------------------

  allSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  setSetting(key: string, value: string | null): void {
    if (value === null || value === '') {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // ---- cache -------------------------------------------------------------

  getEntry(key: string): CacheEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Every cached entry, for a pass over the whole library.
   *
   * Rows rather than keys, because the callers that want all of them want the fields too, and fetching
   * them one key at a time is four hundred statements for one question.
   */
  allEntries(): CacheEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries ORDER BY artist, title')
      .all() as Record<string, unknown>[];
    return rows.map(toEntry);
  }

  /** Which sources have a usable archived body, by track. Superseded ones do not count. */
  providersByKey(): Map<string, string[]> {
    const rows = this.db
      .prepare('SELECT key, provider FROM raw WHERE ok = 1')
      .all() as { key: string; provider: string }[];

    const out = new Map<string, string[]>();
    for (const row of rows) {
      const list = out.get(row.key);
      if (list) list.push(row.provider);
      else out.set(row.key, [row.provider]);
    }
    return out;
  }

  putEntry(entry: Omit<CacheEntry, 'createdAt' | 'hits' | 'lastHitAt'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO entries
           (key, title, artist, album, duration_ms, spotify_id, isrc, merged, merge_version,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           album = excluded.album,
           duration_ms = excluded.duration_ms,
           spotify_id = COALESCE(excluded.spotify_id, entries.spotify_id),
           isrc = COALESCE(excluded.isrc, entries.isrc),
           merged = excluded.merged,
           merge_version = excluded.merge_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.key,
        entry.title,
        entry.artist,
        entry.album,
        entry.durationMs,
        entry.spotifyId,
        entry.isrc,
        entry.merged,
        entry.mergeVersion,
        now,
        now,
      );
  }

  recordHit(key: string): void {
    this.db
      .prepare('UPDATE entries SET hits = hits + 1, last_hit_at = ? WHERE key = ?')
      .run(Date.now(), key);
  }

  // ---- users -------------------------------------------------------------

  /** `key` is hashed here and not kept; the caller shows it once. */
  createUser(name: string, key: string, at = Date.now()): User {
    const result = this.db
      .prepare('INSERT INTO users (name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hashKey(key), key.slice(-4), at);
    return this.userById(Number(result.lastInsertRowid))!;
  }

  /** Every user, revoked ones included, newest first. */
  listUsers(): User[] {
    const rows = this.db
      .prepare(`${USER_SELECT} ORDER BY u.revoked_at IS NOT NULL, u.created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(toUser);
  }

  /** Revoked users too, so a caller holding a session can see that it has ended. */
  userById(id: number): User | null {
    const row = this.db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toUser(row) : null;
  }

  /** The user a key belongs to, if it is theirs and not revoked. */
  userByKey(key: string): User | null {
    if (!key) return null;
    const row = this.db
      .prepare(`${USER_SELECT} WHERE u.key_hash = ? AND u.revoked_at IS NULL`)
      .get(hashKey(key)) as Record<string, unknown> | undefined;
    return row ? toUser(row) : null;
  }

  revokeUser(id: number, at = Date.now()): boolean {
    const result = this.db
      .prepare('UPDATE users SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(at, id);
    return Number(result.changes) > 0;
  }

  /** At most once a minute, since every lookup would otherwise be a write. */
  touchUser(id: number, at = Date.now()): void {
    this.db
      .prepare(
        'UPDATE users SET last_used_at = ? WHERE id = ? AND COALESCE(last_used_at, 0) < ?',
      )
      .run(at, id, at - 60_000);
  }

  /** A lookup, by whoever made it. `userId` 0 is the admin key. */
  recordRequest(
    userId: number,
    key: string,
    track: { title?: string; artist?: string; album?: string; durationMs?: number } = {},
    at = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO requests (user_id, key, first_at, last_at, title, artist, album, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET
           last_at = excluded.last_at,
           count   = count + 1,
           title   = CASE WHEN excluded.title  <> '' THEN excluded.title  ELSE requests.title  END,
           artist  = CASE WHEN excluded.artist <> '' THEN excluded.artist ELSE requests.artist END,
           album   = CASE WHEN excluded.album  <> '' THEN excluded.album  ELSE requests.album  END,
           duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms
                              ELSE requests.duration_ms END`,
      )
      .run(
        userId, key, at, at, track.title ?? '', track.artist ?? '', track.album ?? '',
        Math.max(0, Math.round(track.durationMs ?? 0)),
      );
  }

  /**
   * What was asked for a track, when nothing else is held on it. With `userId`, only what that user
   * asked, so a user is not shown the names somebody else sent for the same key.
   */
  askedFor(
    key: string,
    userId?: number,
  ): { title: string; artist: string; album: string; durationMs: number; lastAt: number } | null {
    const mine = userId === undefined ? '' : 'AND user_id = ?';
    const row = this.db
      .prepare(
        `SELECT MAX(NULLIF(title, '')) AS title, MAX(NULLIF(artist, '')) AS artist,
                MAX(NULLIF(album, '')) AS album, MAX(duration_ms) AS duration_ms,
                MAX(last_at) AS last_at
           FROM requests WHERE key = ? ${mine}`,
      )
      .get(...(userId === undefined ? [key] : [key, userId])) as Record<string, unknown> | undefined;
    if (!row || row.last_at === null) return null;
    return {
      title: String(row.title ?? ''),
      artist: String(row.artist ?? ''),
      album: String(row.album ?? ''),
      durationMs: Number(row.duration_ms ?? 0),
      lastAt: Number(row.last_at),
    };
  }

  hasAsked(userId: number, key: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM requests WHERE user_id = ? AND key = ?').get(userId, key),
    );
  }

  /** The counters a user's own page shows. */
  userStats(userId: number): { tracks: number; found: number; misses: number; hits: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS tracks,
                COALESCE(SUM(NULLIF(e.merged, '') IS NOT NULL), 0) AS found,
                COALESCE(SUM(e.key IS NOT NULL AND NULLIF(e.merged, '') IS NULL), 0) AS misses,
                COALESCE(SUM(r.count), 0) AS hits
           FROM requests r LEFT JOIN entries e ON e.key = r.key
          WHERE r.user_id = ?`,
      )
      .get(userId) as Record<string, number>;
    return {
      tracks: Number(row.tracks),
      found: Number(row.found),
      misses: Number(row.misses),
      hits: Number(row.hits),
    };
  }

  /**
   * Forgets a track, in one of two senses.
   *
   * Without `includeExtras` the lyrics and their archived responses go and the artwork, palette and
   * analysis stay — which is what "look this up again" means. With it, the track is gone entirely.
   *
   * The distinction is not tidiness. Spotify withdrew the audio-analysis endpoint from the public
   * API, so the beat and bar grids stored here are the only copy that will ever exist for that
   * track; throwing them away to force a fresh lyrics lookup would be a bad trade made silently.
   *
   * Leaving the extras behind used to be the only behaviour, and the library made that visible: the
   * song reappeared in the list with no lyrics and no archive, indistinguishable from one that had
   * never been fetched.
   */
  deleteEntry(key: string, options: { includeExtras?: boolean } = {}): void {
    this.db.prepare('DELETE FROM entries WHERE key = ?').run(key);
    this.db.prepare('DELETE FROM raw WHERE key = ?').run(key);
    if (options.includeExtras) {
      this.db.prepare('DELETE FROM extras WHERE key = ?').run(key);
      // Who asked, too: a request with nothing else held on it would keep the track listed.
      this.db.prepare('DELETE FROM requests WHERE key = ?').run(key);
    }
  }

  listEntries(options: { search?: string; limit?: number; offset?: number } = {}): CacheEntry[] {
    const limit = Math.min(options.limit ?? 50, 500);
    const offset = options.offset ?? 0;
    const search = options.search?.trim();

    const rows = search
      ? (this.db
          .prepare(
            'SELECT * FROM entries WHERE title LIKE ? OR artist LIKE ? ' +
              'ORDER BY updated_at DESC LIMIT ? OFFSET ?',
          )
          .all(`%${search}%`, `%${search}%`, limit, offset) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM entries ORDER BY updated_at DESC LIMIT ? OFFSET ?')
          .all(limit, offset) as Record<string, unknown>[]);

    return rows.map(toEntry);
  }

  /**
   * The library: one row per song, with what is held about each.
   *
   * A union of both tables rather than a join from `entries`, because the two can exist
   * independently — a track can have artwork and a tempo and no lyrics anybody has written down.
   * Listing only the ones with lyrics would hide exactly the songs worth knowing about.
   */
  library(query: LibraryQuery = {}): { rows: LibraryRow[]; total: number } {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const search = query.search?.trim();

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      const like = `%${search}%`;
      // Identity as well as names: an ISRC, a Spotify id or an Apple id pasted in should find the
      // track, because that is how you arrive here from a log line or another tool. The ids the
      // harvest collects live inside the metadata blob, so it is searched as text.
      const fields = ['title', 'artist', 'album', 'isrc', 'spotify_id', 'metadata'];
      // Searching the lyric text is a LIKE over the merged JSON. Not an index, but a personal
      // cache is thousands of rows rather than millions, and the alternative is an FTS table to
      // keep in step for a feature used by one person occasionally.
      if (query.inLyrics) fields.push('lyrics');
      where.push(`(${fields.map((f) => `COALESCE(${f}, '') LIKE ?`).join(' OR ')})`);
      params.push(...fields.map(() => like));
    }

    switch (query.missing) {
      case 'lyrics':
        where.push('lyrics IS NULL');
        break;
      case 'extras':
        where.push('extras_updated_at IS NULL');
        break;
      case 'syllables':
        where.push("(lyrics IS NULL OR lyrics NOT LIKE '%\"syllables\":[{%')");
        break;
      case 'translation':
        where.push('(lyrics IS NULL OR hasTranslationFlag = 0)');
        break;
      case 'isrc':
        // The one worth hunting for. Without it every later lookup is a fuzzy name match.
        where.push('isrc IS NULL');
        break;
      case 'analysis':
        // Spotify withdrew this endpoint from the public API, so a track without it may never
        // get one — worth being able to list them while a token still works.
        where.push('analysis IS NULL');
        break;
      default:
        break;
    }

    const order = {
      song: 'artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC',
      recent: 'updated_at DESC',
      hits: 'hits DESC, updated_at DESC',
      lines: 'LENGTH(COALESCE(lyrics, \'\')) DESC',
      added: 'created_at DESC',
      asked: 'asked_at DESC',
    }[query.sort ?? 'song'];

    // Scoped to one asker, the counts and times are theirs rather than everybody's. Unscoped, the last
    // request from anyone, and before requests were recorded, the last cache hit or first sighting.
    //
    // The unscoped count is lookups, the first included: `hits` only counts answers from the cache, so
    // a song asked for once showed 0. Its entry came from one lookup, hence `+ 1`; and since requests
    // were recorded, their sum, whichever is larger, since each also counts in the other.
    const scoped = query.askedBy !== undefined;
    const asked = scoped
      ? 'mine.count AS hits, mine.last_at AS last_hit_at, mine.last_at AS asked_at'
      : `MAX(
            COALESCE(q.count, 0),
            CASE WHEN e.key IS NOT NULL THEN COALESCE(e.hits, 0) + 1 ELSE 0 END
          ) AS hits,
          e.last_hit_at AS last_hit_at,
          COALESCE(q.last_at, e.last_hit_at, NULLIF(e.created_at, 0), x.created_at) AS asked_at`;
    const cteParams = scoped ? [query.askedBy!] : [];

    // When nothing is cached, a request stands in for "updated". Scoped, the asker's own, so a user's
    // list does not reveal when somebody else asked for a song they share.
    const lastAsked = scoped ? 'mine.last_at' : 'q.last_at';
    // And the names asked with, for the same reason.
    const said = scoped ? 'mine' : 'q';

    // One expression for the row shape, used by both the count and the page, so a filter can
    // never mean two different things depending on which one applied it.
    const base = `
      WITH song AS (
        SELECT
          k.key                                                   AS key,
          -- A track only asked for, with nothing cached, is named by what was asked.
          COALESCE(NULLIF(e.title, ''),  NULLIF(x.title, ''),  NULLIF(${said}.title, ''),  '') AS title,
          COALESCE(NULLIF(e.artist, ''), NULLIF(x.artist, ''), NULLIF(${said}.artist, ''), '') AS artist,
          COALESCE(NULLIF(e.album, ''), NULLIF(${said}.album, ''), '') AS album,
          COALESCE(NULLIF(e.duration_ms, 0), NULLIF(x.duration_ms, 0), NULLIF(${said}.duration_ms, 0), 0)
                                                                  AS duration_ms,
          e.spotify_id                                            AS spotify_id,
          -- Identity is written to whichever row existed at the time, so either can hold it.
          COALESCE(e.isrc, x.isrc)                                AS isrc,
          -- Empty is this cache's "asked, and nobody had it", the same as null. See stats().
          NULLIF(e.merged, '')                                    AS lyrics,
          COALESCE(e.merge_version, 0)                            AS merge_version,
          ${asked},
          COALESCE(
            NULLIF(MAX(COALESCE(e.updated_at, 0), COALESCE(x.updated_at, 0)), 0),
            ${lastAsked},
            0
          )                                                       AS updated_at,
          ${
            // Scoped, "first seen" is when they first asked: the cache's own first sighting could be
            // somebody else's lookup.
            scoped
              ? 'mine.first_at'
              : `MIN(
            COALESCE(NULLIF(e.created_at, 0), 9e18),
            COALESCE(NULLIF(x.created_at, 0), 9e18),
            COALESCE(q.first_at, 9e18)
          )`
          }                                                       AS created_at,
          x.updated_at                                            AS extras_updated_at,
          x.cover_url, x.artist_image_url, x.tempo, x.canvas,
          x.palette, x.analysis, x.metadata, x.source             AS extras_source,
          CASE WHEN e.merged LIKE '%\"hasTranslation\":true%' THEN 1 ELSE 0 END AS hasTranslationFlag,
          (SELECT GROUP_CONCAT(provider) FROM raw WHERE raw.key = k.key) AS providers,
          (SELECT COALESCE(SUM(LENGTH(body)), 0) FROM raw WHERE raw.key = k.key) AS archived_bytes
        -- Requests too: a lookup that cached nothing (every source unreachable, or cache-only) is
        -- still a song somebody asked for, and it is on their list.
        FROM (SELECT key FROM entries UNION SELECT key FROM extras UNION SELECT key FROM requests) k
        LEFT JOIN entries e ON e.key = k.key
        LEFT JOIN extras  x ON x.key = k.key
        LEFT JOIN (
          SELECT key, MIN(first_at) AS first_at, MAX(last_at) AS last_at, SUM(count) AS count,
                 MAX(NULLIF(title, '')) AS title, MAX(NULLIF(artist, '')) AS artist,
                 MAX(NULLIF(album, '')) AS album, MAX(duration_ms) AS duration_ms
            FROM requests GROUP BY key
        ) q ON q.key = k.key
        ${scoped ? 'JOIN requests mine ON mine.key = k.key AND mine.user_id = ?' : ''}
      )
      SELECT * FROM song
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    `;
    params.unshift(...cteParams);

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM (${base})`)
      .get(...params) as { n: number } | undefined;

    const rows = this.db
      .prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];

    return { rows: rows.map(toLibraryRow), total: Number(totalRow?.n ?? 0) };
  }

  /** Every key whose merged document predates the current algorithm. */
  keysBelowVersion(version: number): string[] {
    const rows = this.db
      .prepare('SELECT key FROM entries WHERE merge_version < ? ORDER BY updated_at DESC')
      .all(version) as { key: string }[];
    return rows.map((row) => row.key);
  }

  stats(): {
    /** Rows in `entries`: tracks a lyric lookup has been made for. */
    entries: number;
    /** Rows in the library, which is the union of `entries` and `extras`. See `tracks` below. */
    tracks: number;
    found: number;
    misses: number;
    hits: number;
    rawBodies: number;
    bytes: number;
    extras: number;
    withIsrc: number;
    withAnalysis: number;
  } {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    };

    const entries = count('SELECT COUNT(*) AS n FROM entries');
    // Not `IS NOT NULL`. An empty `merged` is this cache's way of saying "asked, and nobody had it" —
    // `fromCache` reads it that way and gives it the short negative TTL — and an empty string is not
    // null, so those were being counted as found. Six of them on the live library, and the number only
    // grows: a re-merge that finds nothing usable now writes exactly this state.
    const found = count("SELECT COUNT(*) AS n FROM entries WHERE merged IS NOT NULL AND merged <> ''");

    // The library lists both tables, so a count of `entries` alone reads as a contradiction next to the
    // artwork and ISRC figures, which are over the union: 410 tracks, 421 with artwork. Eleven keys have
    // extras and no entry — artwork harvested for a track whose lyrics were later forgotten, which keeps
    // the extras on purpose.
    const tracks = count(
      'SELECT COUNT(*) AS n FROM ' +
        '(SELECT key FROM entries UNION SELECT key FROM extras UNION SELECT key FROM requests)',
    );

    return {
      entries,
      tracks,
      found,
      misses: entries - found,
      hits: count('SELECT COALESCE(SUM(hits), 0) AS n FROM entries'),
      rawBodies: count('SELECT COUNT(*) AS n FROM raw'),
      extras: count('SELECT COUNT(*) AS n FROM extras'),
      // Identity coverage, because it is what decides whether the next lookup is exact or fuzzy.
      withIsrc: count(
        'SELECT COUNT(*) AS n FROM (' +
          'SELECT key FROM entries WHERE isrc IS NOT NULL ' +
          'UNION SELECT key FROM extras WHERE isrc IS NOT NULL)',
      ),
      // Spotify withdrew this endpoint from the public API, so what is stored is the only copy.
      withAnalysis: count('SELECT COUNT(*) AS n FROM extras WHERE analysis IS NOT NULL'),
      bytes:
        // The analysis blob alone can be hundreds of kilobytes a track, so leaving the extras out
        // understated the whole cache.
        count(
          'SELECT COALESCE(SUM(' +
            'LENGTH(COALESCE(palette, \'\')) + LENGTH(COALESCE(analysis, \'\')) + ' +
            'LENGTH(COALESCE(metadata, \'\'))), 0) AS n FROM extras',
        ) +
        count('SELECT COALESCE(SUM(LENGTH(merged)), 0) AS n FROM entries') +
        count('SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM raw'),
    };
  }

  // ---- raw archive -------------------------------------------------------

  putRaw(raw: Omit<RawResponse, 'fetchedAt'> & { fetchedAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO raw (key, provider, body, content_type, fetched_at, ok, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key, provider) DO UPDATE SET
           body = excluded.body,
           content_type = excluded.content_type,
           fetched_at = excluded.fetched_at,
           ok = excluded.ok,
           note = excluded.note`,
      )
      .run(
        raw.key,
        raw.provider,
        raw.body,
        raw.contentType,
        raw.fetchedAt ?? Date.now(),
        raw.ok ? 1 : 0,
        raw.note,
      );
  }

  getRaw(key: string): RawResponse[] {
    const rows = this.db
      .prepare('SELECT * FROM raw WHERE key = ? ORDER BY provider')
      .all(key) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: row.key as string,
      provider: row.provider as string,
      body: row.body as string,
      contentType: row.content_type as string,
      fetchedAt: row.fetched_at as number,
      ok: Boolean(row.ok),
      note: (row.note as string | null) ?? null,
    }));
  }

  /**
   * Tracks whose ISRC is recoverable exactly, because their Spotify id is already known.
   *
   * The id names one recording, so `/v1/tracks/{id}` gives *the* ISRC for it rather than a best
   * guess — no matching, nothing to get wrong. Anything cached before an app token was configured is
   * sitting here waiting, because the only thing that ever stopped it was the rate limit.
   */
  keysNeedingIsrc(limit = 500): Array<{ key: string; spotifyId: string }> {
    const rows = this.db
      .prepare(
        `SELECT key, spotify_id FROM entries
         WHERE spotify_id IS NOT NULL AND spotify_id <> ''
           AND (isrc IS NULL OR isrc = '')
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(Math.min(limit, 2000)) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: row.key as string,
      spotifyId: row.spotify_id as string,
    }));
  }

  /**
   * A cheap fingerprint of everything the library view shows.
   *
   * Counts and newest timestamps rather than a change feed: the admin page wants to know *that*
   * something changed, and it already has an endpoint for what. Three tables, because a track's row
   * moves for three different reasons — a lookup or a re-merge writes `entries`, a harvest writes
   * `extras`, and an archived answer writes `raw` — and watching only the first missed the harvest
   * landing a tempo a few seconds later, which is exactly the update worth seeing. And `requests`,
   * since a lookup that cached nothing still adds a row, and a repeat one moves its count.
   */
  cacheRevision(): string {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM entries)                        AS entries,
           (SELECT COALESCE(MAX(updated_at), 0) FROM entries)    AS entriesAt,
           (SELECT COUNT(*) FROM extras)                         AS extras,
           (SELECT COALESCE(MAX(updated_at), 0) FROM extras)     AS extrasAt,
           (SELECT COUNT(*) FROM raw)                            AS raws,
           (SELECT COALESCE(MAX(fetched_at), 0) FROM raw)        AS rawsAt,
           (SELECT COALESCE(SUM(hits), 0) FROM entries)          AS hits,
           (SELECT COUNT(*) FROM requests)                       AS requests,
           (SELECT COALESCE(SUM(count), 0) FROM requests)        AS asks`,
      )
      .get() as Record<string, number>;
    return [
      row.entries, row.entriesAt, row.extras, row.extrasAt, row.raws, row.rawsAt, row.hits,
      row.requests, row.asks,
    ].join('.');
  }

  /**
   * Every cached track, newest first, for a bulk operation over the library.
   *
   * Both tables, the same union the library view lists from. `entries` alone missed every extras-only
   * row — which is what "Forget lyrics" leaves behind, since it drops the entry and the archive and
   * keeps the artwork and tempo. Those rows showed in the library and were then skipped by the very
   * action most likely to be aimed at them. Requests too, for a track asked for while no source could
   * be reached: the one a re-lookup is most for.
   */
  allKeys(limit = 5_000): string[] {
    const rows = this.db
      .prepare(
        `SELECT k.key AS key,
                MAX(COALESCE(e.updated_at, 0), COALESCE(x.updated_at, 0), COALESCE(q.last_at, 0)) AS touched
           FROM (SELECT key FROM entries UNION SELECT key FROM extras UNION SELECT key FROM requests) k
           LEFT JOIN entries e ON e.key = k.key
           LEFT JOIN extras  x ON x.key = k.key
           LEFT JOIN (SELECT key, MAX(last_at) AS last_at FROM requests GROUP BY key) q ON q.key = k.key
          ORDER BY touched DESC
          LIMIT ?`,
      )
      .all(Math.min(limit, 20_000)) as { key: string }[];
    return rows.map((row) => row.key);
  }

  /**
   * Marks one provider's archived body as no longer fit to merge from.
   *
   * Not a delete, because the archive is the point of this server — a body kept is a body a better
   * algorithm can revisit. But a body matched to the *wrong recording* is not differently-merged data,
   * it is wrong data, and re-merging from it would keep producing the wrong words. So it stays on disk,
   * flagged, with the reason attached, and `remerge` passes over it.
   */
  supersedeRaw(key: string, provider: string, note: string): void {
    this.db
      .prepare('UPDATE raw SET ok = 0, note = ? WHERE key = ? AND provider = ?')
      .run(note, key, provider);
  }

  // ---- what each source said ---------------------------------------------

  /**
   * Records how a source answered, so a later lookup can tell a real "nothing here" from a failure.
   *
   * One row per source per track, overwritten: only the latest outcome matters, and keeping a history
   * would grow without bound for a question nobody asks.
   */
  recordAttempt(
    key: string,
    provider: string,
    outcome: AttemptOutcome,
    hadIsrc = false,
  ): void {
    this.db
      .prepare(
        `INSERT INTO attempts (key, provider, outcome, at, had_isrc)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key, provider) DO UPDATE SET
           outcome = excluded.outcome,
           at = excluded.at,
           -- Sticky: once a source has been asked with an ISRC, a later name-search does not undo
           -- that. Otherwise a lookup that lost the identity would make the track eligible for
           -- re-asking all over again.
           had_isrc = MAX(attempts.had_isrc, excluded.had_isrc)`,
      )
      .run(key, provider, outcome, Date.now(), hadIsrc ? 1 : 0);
  }

  attemptsFor(key: string): Map<string, { outcome: AttemptOutcome; at: number; hadIsrc: boolean }> {
    const rows = this.db
      .prepare('SELECT provider, outcome, at, had_isrc FROM attempts WHERE key = ?')
      .all(key) as Record<string, unknown>[];
    return new Map(
      rows.map((row) => [
        row.provider as string,
        {
          outcome: row.outcome as AttemptOutcome,
          at: row.at as number,
          hadIsrc: Boolean(row.had_isrc),
        },
      ]),
    );
  }

  // ---- log ---------------------------------------------------------------

  log(level: LogLevel, provider: string | null, message: string): void {
    this.db
      .prepare('INSERT INTO events (at, level, provider, message) VALUES (?, ?, ?, ?)')
      .run(Date.now(), level, provider, message);
    // A personal server does not need a year of logs, and an unbounded table in the same
    // file as the cache eventually makes the cache slow.
    this.db.exec(
      'DELETE FROM events WHERE id < (SELECT MAX(id) - 5000 FROM events)',
    );
  }

  recentEvents(
    limit = 200,
    filter: { level?: LogLevel; provider?: string; search?: string } = {},
  ): LogEvent[] {
    // Filtered in SQL rather than in the page. The log is the thing you reach for when something is
    // wrong, and "load two hundred and scroll" is not a way to find one line among them.
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.level) {
      const levels = atLeast(filter.level);
      clauses.push(`level IN (${levels.map(() => '?').join(', ')})`);
      values.push(...levels);
    }
    if (filter.provider) {
      clauses.push('provider IS ?');
      values.push(filter.provider);
    }
    if (filter.search?.trim()) {
      // Provider as well as message: "spotify" is as likely to be what someone types as a word from
      // the message itself.
      clauses.push('(message LIKE ? OR provider LIKE ?)');
      const like = `%${filter.search.trim()}%`;
      values.push(like, like);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values, Math.min(limit, 1000)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      at: row.at as number,
      level: row.level as LogEvent['level'],
      provider: (row.provider as string | null) ?? null,
      message: row.message as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}

const USER_SELECT = `
  SELECT u.*, (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id) AS tracks
    FROM users u`;

function toUser(row: Record<string, unknown>): User {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    keyHint: String(row.key_hint ?? ''),
    createdAt: Number(row.created_at ?? 0),
    lastUsedAt: (row.last_used_at as number | null) ?? null,
    revokedAt: (row.revoked_at as number | null) ?? null,
    tracks: Number(row.tracks ?? 0),
  };
}

function toLibraryRow(row: Record<string, unknown>): LibraryRow {
  const merged = parseJson(row.lyrics);
  const lines = Array.isArray(merged?.lines) ? (merged!.lines as Record<string, unknown>[]) : [];
  const provenance = (merged?.provenance ?? null) as Record<string, unknown> | null;

  const metadata = parseJson(row.metadata);
  const analysis = parseJson(row.analysis);

  const extrasFields: string[] = [];
  if (row.cover_url) extrasFields.push('cover');
  if (row.artist_image_url) extrasFields.push('artist image');
  if (row.tempo != null) extrasFields.push('tempo');
  if (parseJson(row.canvas)?.url) extrasFields.push('canvas');
  if (parseJson(row.palette)) extrasFields.push('palette');
  if (metadata) extrasFields.push('metadata');
  // The grids are the part that cannot be re-fetched, so they are named rather than folded into
  // "analysis": Spotify withdrew the endpoint from the public API in 2024.
  if (analysis) {
    const grids = ['beats', 'bars', 'sections', 'tatums'].filter((name) =>
      Array.isArray(analysis[name]),
    );
    extrasFields.push(grids.length > 0 ? `analysis + ${grids.join('/')}` : 'analysis');
  }

  return {
    key: String(row.key),
    title: String(row.title ?? ''),
    artist: String(row.artist ?? ''),
    album: String(row.album ?? ''),
    durationMs: Number(row.duration_ms ?? 0),
    spotifyId: (row.spotify_id as string | null) ?? null,
    isrc: (row.isrc as string | null) ?? null,

    hasLyrics: Boolean(merged),
    kind: typeof merged?.kind === 'string' ? merged.kind : null,
    lines: lines.length,
    syllableLines: lines.filter(
      (l) => Array.isArray(l.syllables) && (l.syllables as unknown[]).length > 0,
    ).length,
    hasTranslation: merged?.hasTranslation === true,
    hasRomanization: merged?.hasRomanization === true,
    timing: typeof provenance?.timing === 'string' ? provenance.timing : null,
    mergeVersion: Number(row.merge_version ?? 0),

    providers: String(row.providers ?? '')
      .split(',')
      .filter((value) => value.length > 0)
      .sort(),
    archivedBytes: Number(row.archived_bytes ?? 0),

    hasExtras: row.extras_updated_at != null,
    extrasFields,
    extrasSource: (row.extras_source as string | null) || null,
    ids: identityFrom(metadata, row),

    hits: Number(row.hits ?? 0),
    createdAt: Number(row.created_at ?? 0) < 9e17 ? Number(row.created_at ?? 0) : 0,
    lastHitAt: (row.last_hit_at as number | null) ?? null,
    askedAt: (row.asked_at as number | null) ?? null,
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * Every external id known for a recording, gathered from wherever it was recorded.
 *
 * Read by suffix rather than by an allowlist of names, so an id a provider starts reporting
 * tomorrow appears here without this function being edited. That matters: the ids arrive in a JSON
 * blob precisely so that adding one needs no migration, and a reader that hard-codes the list
 * would quietly undo that.
 */
export function identityFrom(
  metadata: Record<string, unknown> | null,
  row: Record<string, unknown> = {},
): Record<string, string> {
  const ids: Record<string, string> = {};
  if (row.isrc) ids.isrc = String(row.isrc);
  if (row.spotify_id) ids.spotify = String(row.spotify_id);
  // The album's barcode, which the suffix rule below would not pick up.
  if (metadata?.albumUpc) ids.upc = String(metadata.albumUpc);

  for (const [field, value] of Object.entries(metadata ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (!/(^|[a-z])Id$|Ids$/.test(field)) continue;
    const name = field
      .replace(/(Music)?Ids?$/, '')
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .toLowerCase();
    if (!name) continue;
    ids[name] ??= Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return ids;
}

function toEntry(row: Record<string, unknown>): CacheEntry {
  return {
    key: row.key as string,
    title: row.title as string,
    artist: row.artist as string,
    album: row.album as string,
    durationMs: row.duration_ms as number,
    spotifyId: (row.spotify_id as string | null) ?? null,
    isrc: (row.isrc as string | null) ?? null,
    merged: (row.merged as string | null) ?? null,
    mergeVersion: row.merge_version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    hits: row.hits as number,
    lastHitAt: (row.last_hit_at as number | null) ?? null,
  };
}
