/**
 * The lookup: cache, then every source at once, then merge, then keep everything.
 *
 * Three things here are worth more than they look:
 *
 * - **In-flight coalescing.** The app asks the server in parallel with its own lookups, and a
 *   prefetch can land on the same track a moment later. Without this, one track change could
 *   be six requests to each provider instead of one.
 * - **Re-merging from the archive.** When the merge algorithm improves, every cached track can
 *   be recomputed from the raw bodies already on disk. No provider is asked again.
 * - **Negative results expire quickly.** A track with no lyrics today may be added to the
 *   community database tomorrow. Two days, against thirty for a found document.
 */

import { MERGE_VERSION, merge, type Candidate, type MergeResult } from './merge.ts';
import { activeProviders, providerById } from './providers/index.ts';
import { cacheKey, type TrackQuery } from './match.ts';
import { redact } from './http.ts';
import type { Config, Settings } from './config.ts';
import type { Store } from './db.ts';
import { document, line, type LyricsDocument, type MergedDocument } from './model.ts';
import { parseTtml } from './format/ttml.ts';
import { parseLrc } from './format/lrc.ts';
import { harvest } from './harvest.ts';

export interface ResolveOptions {
  /** Ignore the cache and ask every source again. */
  force?: boolean;
  /** Do not fetch; answer only if it is already cached. */
  cacheOnly?: boolean;
}

export interface Resolution {
  document: MergedDocument | null;
  key: string;
  source: 'cache' | 'remerge' | 'network' | 'absent';
  /** Present when this lookup actually asked the providers. */
  candidates?: MergeResult['summaries'];
  ms: number;
}

/**
 * Reads a body by the format it declares, rather than by who sent it.
 *
 * Used for anything the app contributed: it says `lrc`, `ttml` or `json` and the content type
 * recorded alongside it is the only thing that knows which.
 */
export function reparseByFormat(body: string, contentType: string): LyricsDocument | null {
  if (contentType.includes('ttml') || contentType.includes('xml')) return parseTtml(body);
  if (contentType.includes('json')) {
    // The app's own document model. Normalised rather than trusted, so a field it happens not
    // to send cannot produce a document the invariants would later choke on.
    try {
      const parsed = JSON.parse(body) as Partial<LyricsDocument>;
      const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
      if (lines.length === 0) return null;
      return document(
        lines.map((l) =>
          line({
            ...l,
            text: String(l.text ?? ''),
            syllables: Array.isArray(l.syllables) ? l.syllables : [],
          }),
        ),
        { language: parsed.language, songWriters: parsed.songWriters ?? [] },
      );
    } catch {
      return null;
    }
  }
  return parseLrc(body) ?? plainTextDocument(body);
}

/**
 * Unsynced lyrics, one line per line. Still worth keeping: they align other sources.
 *
 * Markup is refused rather than read as text. The realistic accident is an error page arriving
 * where lyrics were expected, and a permanent archive entry reading `502 Bad Gateway` is worse
 * than refusing the contribution — the same rule the app applies to a server's reply.
 */
function plainTextDocument(body: string): LyricsDocument | null {
  if (body.trimStart().startsWith('<')) return null;

  const lines = body
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => line({ text }));
  return lines.length > 0 ? document(lines, { kind: 'static' }) : null;
}

export class Resolver {
  private readonly inFlight = new Map<string, Promise<Resolution>>();

  private readonly store: Store;
  private readonly settings: Settings;

  constructor(store: Store, settings: Settings) {
    this.store = store;
    this.settings = settings;
  }

  async resolve(track: TrackQuery, options: ResolveOptions = {}): Promise<Resolution> {
    const key = cacheKey(track);
    const started = performance.now();
    const config = this.settings.read();

    if (!options.force) {
      const cached = this.fromCache(key, config);
      if (cached) {
        this.store.recordHit(key);
        return { ...cached, ms: Math.round(performance.now() - started) };
      }
    }

    if (options.cacheOnly) {
      return { document: null, key, source: 'absent', ms: Math.round(performance.now() - started) };
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const work = this.fetchAndMerge(track, key, config, started).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  /**
   * Answers from what is already stored, recomputing the merge if the algorithm has moved on.
   */
  private fromCache(key: string, config: Config): Omit<Resolution, 'ms'> | null {
    const entry = this.store.getEntry(key);
    if (!entry) return null;

    const age = Date.now() - entry.updatedAt;

    // Before anything else: if the algorithm has moved on, rebuild from the archive. This
    // comes first because it applies even to an entry that found nothing last time — a new
    // merge may get something out of raw bodies the old one could not, and re-deriving it
    // costs no request.
    if (entry.mergeVersion < MERGE_VERSION) {
      const remerged = this.remerge(key, config);
      if (remerged) return { document: remerged, key, source: 'remerge' };
    }

    if (!entry.merged) {
      // A cached "nothing found". Short-lived on purpose.
      if (age > config.negativeTtlHours * 3_600_000) return null;
      return { document: null, key, source: 'cache' };
    }

    if (age > config.refreshDays * 86_400_000) return null;

    try {
      return { document: JSON.parse(entry.merged) as MergedDocument, key, source: 'cache' };
    } catch {
      this.store.log('warn', null, `cache entry ${key} was unreadable; discarding it`);
      return null;
    }
  }

  private async fetchAndMerge(
    track: TrackQuery,
    key: string,
    config: Config,
    started: number,
  ): Promise<Resolution> {
    // Collect everything else about the track while the tokens are alive, whether or not
    // anything reads it yet. Detached on purpose: the caller asked for words, and none of this
    // is allowed to make them slower or to fail in a way they can see.
    void harvest(this.store, config, key, track).catch(() => undefined);

    const providers = activeProviders(config);
    if (providers.length === 0) {
      this.store.log('warn', null, 'no sources are both enabled and configured');
      return { document: null, key, source: 'absent', ms: Math.round(performance.now() - started) };
    }

    const candidates: Candidate[] = [];
    const unreachable: string[] = [];

    await Promise.all(
      providers.map(async (provider) => {
        const ctx = {
          config,
          log: (level: 'info' | 'warn' | 'error', message: string) =>
            this.store.log(level, provider.id, redact(message)),
          unreachable: (detail: string) => {
            unreachable.push(provider.id);
            this.store.log('warn', provider.id, redact(detail));
          },
        };
        try {
          const answer = await provider.fetch(track, ctx);
          if (!answer) return;

          this.store.putRaw({
            key,
            provider: provider.id,
            body: answer.raw.body,
            contentType: answer.raw.contentType,
            ok: true,
            note: answer.note ?? null,
          });

          candidates.push({
            provider: provider.id,
            doc: answer.doc,
            match: answer.match,
            priority: config.providers[provider.id]?.priority ?? 99,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A thrown error is never an answer about the track.
          unreachable.push(provider.id);
          this.store.log('error', provider.id, redact(message));
        }
      }),
    );

    // Nothing found *and* something broke is not the same as nothing found. Writing it down as
    // "this track has no lyrics" would hide the track for as long as the negative cache lasts,
    // and on a stale refresh it would replace a document that was perfectly good. An outage
    // leaves the cache exactly as it was, and serves whatever was already there.
    if (candidates.length === 0 && unreachable.length > 0) {
      const existing = this.store.getEntry(key);
      const ms = Math.round(performance.now() - started);
      this.store.log(
        'warn',
        null,
        `${track.artist} — ${track.title}: nothing found, but ` +
          `${[...new Set(unreachable)].join(', ')} could not be reached — not caching that`,
      );
      if (existing?.merged) {
        try {
          return {
            document: JSON.parse(existing.merged) as MergedDocument,
            key,
            source: 'cache',
            ms,
          };
        } catch {
          /* Unreadable; fall through to the empty answer below. */
        }
      }
      return { document: null, key, source: 'absent', candidates: [], ms };
    }

    const result = merge(candidates, {
      durationMs: track.durationMs,
      preferredTranslationLang: config.translationLang,
    });

    this.store.putEntry({
      key,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      spotifyId: track.spotifyId ?? null,
      isrc: track.isrc ?? null,
      merged: result.document ? JSON.stringify(result.document) : null,
      mergeVersion: MERGE_VERSION,
    });

    const ms = Math.round(performance.now() - started);
    this.store.log(
      'info',
      null,
      result.document
        ? `${track.artist} — ${track.title}: ${result.document.kind} from ` +
            `${result.document.provenance.timing} (${candidates.length}/${providers.length} answered, ${ms}ms)`
        : `${track.artist} — ${track.title}: nothing found (${providers.length} asked, ${ms}ms)`,
    );

    return {
      document: result.document,
      key,
      source: 'network',
      candidates: result.summaries,
      ms,
    };
  }

  /**
   * Rebuilds a merged document from the archived responses.
   *
   * The whole reason the raw bodies are kept. Returns null when there is nothing archived —
   * an entry from before archiving, or one whose providers all failed.
   */
  remerge(key: string, config = this.settings.read()): MergedDocument | null {
    const raws = this.store.getRaw(key);
    if (raws.length === 0) return null;

    const entry = this.store.getEntry(key);
    const candidates: Candidate[] = [];

    for (const raw of raws) {
      const contributed = raw.provider.startsWith('app:');
      const baseId = contributed ? raw.provider.slice(4) : raw.provider;

      // A contribution arrives in whatever format the app declared, which is not the shape the
      // named provider's own reader expects — LRCLIB's reparse wants its JSON record, not an
      // LRC file. Dispatching on the provider would archive a contribution and then silently
      // never merge it, which is worse than refusing it outright.
      const doc = contributed
        ? reparseByFormat(raw.body, raw.contentType)
        : providerById(baseId)?.reparse(raw.body, raw.contentType) ?? null;
      if (!doc) continue;

      candidates.push({
        provider: raw.provider,
        doc,
        // The original match score is not archived, and re-deriving it would need the
        // provider's own metadata. Everything stored was over the threshold at the time,
        // so it counts as a match; only the tie-break ordering loses any information.
        match: 1,
        priority: config.providers[baseId]?.priority ?? 99,
      });
    }

    if (candidates.length === 0) return null;

    const result = merge(candidates, {
      durationMs: entry?.durationMs ?? 0,
      preferredTranslationLang: config.translationLang,
    });
    if (!result.document) return null;

    this.store.putEntry({
      key,
      title: entry?.title ?? '',
      artist: entry?.artist ?? '',
      album: entry?.album ?? '',
      durationMs: entry?.durationMs ?? 0,
      spotifyId: entry?.spotifyId ?? null,
      isrc: entry?.isrc ?? null,
      merged: JSON.stringify(result.document),
      mergeVersion: MERGE_VERSION,
    });

    return result.document;
  }

  /** Recomputes every entry the current algorithm has not seen. Network-free. */
  remergeAll(): { attempted: number; rebuilt: number } {
    const keys = this.store.keysBelowVersion(MERGE_VERSION);
    let rebuilt = 0;
    for (const key of keys) {
      if (this.remerge(key)) rebuilt++;
    }
    if (keys.length > 0) {
      this.store.log('info', null, `re-merged ${rebuilt}/${keys.length} entries at v${MERGE_VERSION}`);
    }
    return { attempted: keys.length, rebuilt };
  }
}
