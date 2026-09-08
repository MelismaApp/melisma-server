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
import type { MergedDocument } from './model.ts';

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

    if (!entry.merged) {
      // A cached "nothing found". Short-lived on purpose.
      if (age > config.negativeTtlHours * 3_600_000) return null;
      return { document: null, key, source: 'cache' };
    }

    if (age > config.refreshDays * 86_400_000) return null;

    if (entry.mergeVersion < MERGE_VERSION) {
      const remerged = this.remerge(key, config);
      if (remerged) return { document: remerged, key, source: 'remerge' };
    }

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
    const providers = activeProviders(config);
    if (providers.length === 0) {
      this.store.log('warn', null, 'no sources are both enabled and configured');
      return { document: null, key, source: 'absent', ms: Math.round(performance.now() - started) };
    }

    const candidates: Candidate[] = [];

    await Promise.all(
      providers.map(async (provider) => {
        const ctx = {
          config,
          log: (level: 'info' | 'warn' | 'error', message: string) =>
            this.store.log(level, provider.id, redact(message)),
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
          this.store.log('error', provider.id, redact(message));
        }
      }),
    );

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
      // A contribution from the app is archived as `app:<provider>`. It is the same format
      // the provider itself returns, so the provider's own reader handles it — without this
      // a contribution would be stored and then never used, which is worse than refusing it.
      const baseId = raw.provider.replace(/^app:/, '');
      const provider = providerById(baseId);
      if (!provider) continue;
      const doc = provider.reparse(raw.body, raw.contentType);
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
