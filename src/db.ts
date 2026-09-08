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

export interface LogEvent {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  provider: string | null;
  message: string;
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

      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        level    TEXT NOT NULL,
        provider TEXT,
        message  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);
    `);
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

  deleteEntry(key: string): void {
    this.db.prepare('DELETE FROM entries WHERE key = ?').run(key);
    this.db.prepare('DELETE FROM raw WHERE key = ?').run(key);
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

  /** Every key whose merged document predates the current algorithm. */
  keysBelowVersion(version: number): string[] {
    const rows = this.db
      .prepare('SELECT key FROM entries WHERE merge_version < ? ORDER BY updated_at DESC')
      .all(version) as { key: string }[];
    return rows.map((row) => row.key);
  }

  stats(): {
    entries: number;
    found: number;
    misses: number;
    hits: number;
    rawBodies: number;
    bytes: number;
  } {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    };

    const entries = count('SELECT COUNT(*) AS n FROM entries');
    const found = count('SELECT COUNT(*) AS n FROM entries WHERE merged IS NOT NULL');

    return {
      entries,
      found,
      misses: entries - found,
      hits: count('SELECT COALESCE(SUM(hits), 0) AS n FROM entries'),
      rawBodies: count('SELECT COUNT(*) AS n FROM raw'),
      bytes:
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

  // ---- log ---------------------------------------------------------------

  log(level: LogEvent['level'], provider: string | null, message: string): void {
    this.db
      .prepare('INSERT INTO events (at, level, provider, message) VALUES (?, ?, ?, ?)')
      .run(Date.now(), level, provider, message);
    // A personal server does not need a year of logs, and an unbounded table in the same
    // file as the cache eventually makes the cache slow.
    this.db.exec(
      'DELETE FROM events WHERE id < (SELECT MAX(id) - 5000 FROM events)',
    );
  }

  recentEvents(limit = 200): LogEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(Math.min(limit, 1000)) as Record<string, unknown>[];
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
