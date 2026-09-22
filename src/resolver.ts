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
import { PACED_MARKER } from './http.ts';
import { activeProviders, providerById, type Provider } from './providers/index.ts';
import { cacheKey, type TrackQuery } from './match.ts';
import { redact, sleep } from './http.ts';
import type { Config, Settings } from './config.ts';
import type { Store } from './db.ts';
import { document, line, type LyricsDocument, type MergedDocument } from './model.ts';
import { parseTtml } from './format/ttml.ts';
import { parseLrc } from './format/lrc.ts';
import { harvest } from './harvest.ts';
import type { LearnedExtras } from './providers/types.ts';

export interface ResolveOptions {
  /** Ignore the cache and ask every source again. */
  force?: boolean;
  /** Do not fetch; answer only if it is already cached. */
  cacheOnly?: boolean;
  /**
   * Find out what the recording *is* before asking anyone for its words.
   *
   * For the prefetch, which is fire-and-forget and has no latency budget. An ISRC turns AMLL and
   * Apple from a search for a common title into an exact lookup, and the ordering used to be the
   * other way round: every source was asked by name, and the harvest learned the identity a moment
   * too late to have helped. So the first play of a track matched worse than every play after it —
   * and a wrong-but-accepted match is not revisited, so "worse" could mean another artist's song for
   * thirty days.
   *
   * Not for `GET /v1/lyrics`: somebody is waiting for that one, and this costs a round trip before
   * any words come back.
   */
  identityFirst?: boolean;
}

/** How a bulk re-lookup is getting on, for the admin page. */
export interface RelookupProgress {
  running: boolean;
  total: number;
  done: number;
  skipped: number;
  /** True when it stopped because it was asked to, rather than because it finished. */
  cancelled: boolean;
  /**
   * True while it is holding, or about to.
   *
   * `current` is what separates the two: a paused run that still names a track is finishing that one
   * before it settles.
   */
  paused: boolean;
  startedAt: number | null;
  /** The track being asked about right now, or null between them. */
  current: string | null;
}

const IDLE_RELOOKUP: RelookupProgress = {
  running: false,
  total: 0,
  done: 0,
  skipped: 0,
  cancelled: false,
  paused: false,
  startedAt: null,
  current: null,
};

/**
 * How often a held run looks up to see whether it may go on.
 *
 * Small enough that Resume and Stop feel immediate, and the cost of asking is two booleans.
 */
const PAUSE_POLL_MS = 200;

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

/**
 * How long to leave a source alone after it could not be reached.
 *
 * Six hours. Long enough that a service having a bad day is not asked once per play, short enough
 * that a token fixed this morning is used this afternoon.
 */
const RETRY_UNREACHABLE_MS = 6 * 3_600_000;

export class Resolver {
  private readonly inFlight = new Map<string, Promise<Resolution>>();

  /** Tracks already harvested this run. See [harvestOnce]. */
  private readonly harvested = new Set<string>();

  /** Tracks with an upgrade in flight right now. See [upgradeOnce]. */
  private readonly upgrading = new Set<string>();

  /** One bulk re-lookup at a time: two would race each other into every rate limit at once. */
  private relooking = false;

  /**
   * What the run in progress is doing, and whether it has been asked to stop.
   *
   * A job that takes minutes with no readout and no way out is a job you daren't start. The count is
   * kept here rather than derived, because only the loop knows how far it has got.
   */
  private progress: RelookupProgress = { ...IDLE_RELOOKUP };

  private cancelRequested = false;

  /**
   * Whether the run has been asked to hold.
   *
   * Worth having as well as cancel, because Stop loses your place: a re-lookup forces past the cache,
   * so restarting a long run re-spends every request it had already made. When a source starts
   * throttling halfway through, holding is what you actually want.
   */
  private pauseRequested = false;

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
        this.harvestAfter(config, key, track);
        // Only when there is something to improve on. A cached miss has no document to better, and
        // `cacheOnly` is a promise not to make requests.
        if (cached.document && !options.cacheOnly) {
          this.upgradeAfter(config, key, track);
        }
        return { ...cached, ms: Math.round(performance.now() - started) };
      }
    }

    if (options.cacheOnly) {
      return { document: null, key, source: 'absent', ms: Math.round(performance.now() - started) };
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // Registered before anything is awaited, and covering the identity step as well as the fetch.
    //
    // With the harvest awaited *outside* this, a prefetch spent seconds resolving identity with
    // nothing in `inFlight` — so a live lookup for the same track arrived, saw no work in progress,
    // and started its own name-only fetch. Two lookups, both writing the same entry, and the one that
    // had bothered to learn the ISRC could lose.
    const work = this.lookup(track, key, config, started, options).finally(() => {
      this.inFlight.delete(key);
      // After the words, not before. The harvest records the ISRC and the authoritative duration onto
      // the cache entry, and until the lookup has run there is no entry to record them on. Skipped
      // when the identity was resolved up front, which has already done this.
      if (!options.identityFirst) this.harvestAfter(config, key, track);
    });
    this.inFlight.set(key, work);
    return work;
  }

  private async lookup(
    track: TrackQuery,
    key: string,
    config: Config,
    started: number,
    options: ResolveOptions,
  ): Promise<Resolution> {
    // Learn what this recording is, before asking anybody what it says.
    //
    // Only on the prefetch. `harvestOnce` writes the ISRC through `noteIdentity`, which upserts the
    // extras row rather than only updating the entry — so it lands even though no entry exists yet,
    // and `withKnownIdentity` below reads extras as well as entries. That mirror is what makes this
    // ordering possible at all; before it existed, harvesting first threw the identity away.
    if (options.identityFirst) await this.harvestOnce(config, key, track);

    // Ask with everything known about this recording, not only what the caller sent. An ISRC
    // learned on a previous lookup turns AMLL and Apple from a name search into an exact one, and
    // a duration recorded from Spotify makes the matcher's duration term decide rather than
    // abstain. Deliberately after the key is computed: `cacheKey` prefers an ISRC, so enriching
    // first would file the result under an identity the next caller will not have.
    const enriched = this.withKnownIdentity(key, track);
    return this.fetchAndMerge(enriched, key, config, started);
  }

  /**
   * Asks every source again for tracks already cached, with everything since learned about them.
   *
   * The point is the identity. A track first looked up before its ISRC was known was matched on a
   * title, and a source that answered is never re-asked — so a poor match, or the wrong recording
   * entirely, sits there until the thirty-day expiry. This is the button that says "you know more now,
   * go and ask again".
   *
   * Sequential rather than parallel: `http.ts` already spaces requests per host, and a hundred tracks
   * asking six sources at once is a good way to be rate-limited by all of them. Nothing waits for
   * this — the caller gets a count and watches the log and the library, both of which update live.
   */
  async relookup(keys: string[]): Promise<RelookupProgress> {
    if (this.relooking) return this.relookupProgress;
    this.relooking = true;
    this.cancelRequested = false;
    // Cleared here rather than when the last run ended: this is the precondition — every run starts
    // unheld, whatever was asked of the one before it.
    this.pauseRequested = false;
    this.progress = {
      running: true,
      total: keys.length,
      done: 0,
      skipped: 0,
      cancelled: false,
      paused: false,
      startedAt: Date.now(),
      current: null,
    };

    // Read once, so a run that takes minutes does not change pace halfway because the page was saved.
    // A resume re-reads it: see below.
    let pauseMs = Math.max(0, this.settings.read().relookupPauseMs);

    // Holds or stops if it has been asked to, and says whether the run may go on.
    const mayContinue = async (): Promise<boolean> => {
      const gate = await this.holdOrStop();
      if (gate === 'stop') {
        this.progress = { ...this.progress, cancelled: true };
        return false;
      }
      // The one place a changed pace is picked up. Reading it on every track would let a save move
      // the goalposts mid-run, but a resume is deliberate, and it is the whole reason to hold: you
      // saw a source throttling, so you held it, raised the delay, and let it go on.
      if (gate === 'held') pauseMs = Math.max(0, this.settings.read().relookupPauseMs);
      return true;
    };

    try {
      for (const [index, key] of keys.entries()) {
        // Asked before the wait as well as after it. A delay raised during a hold has to apply to the
        // very next request rather than the one after it — that first request is the entire reason
        // anyone intervened.
        if (!(await mayContinue())) break;

        // Between tracks, not before the first. The per-host floors keep a single lookup polite and say
        // nothing about a hundred in a row, and a rate limit measured over a longer window than any
        // per-request gap is exactly what this is for.
        if (index > 0 && pauseMs > 0) await this.waitBetween(pauseMs);

        // And again after it, because the wait is as long as someone set it to be: a Stop pressed
        // during the wait should not go unanswered for the length of it.
        if (!(await mayContinue())) break;

        const track = this.trackForKey(key);
        if (!track) {
          this.progress = { ...this.progress, skipped: this.progress.skipped + 1 };
          continue;
        }

        // Named while it is being asked about, so the page can say what it is waiting on rather than
        // only how far along it is.
        this.progress = {
          ...this.progress,
          current: [track.artist, track.title].filter(Boolean).join(' — ') || key,
        };
        try {
          // `force` to bypass the cache, and no `identityFirst`: the identity is already on record,
          // and `withKnownIdentity` puts it back into the question.
          await this.resolve(track, { force: true });
          this.progress = { ...this.progress, done: this.progress.done + 1 };
        } catch (error) {
          this.progress = { ...this.progress, skipped: this.progress.skipped + 1 };
          this.store.log(
            'warn',
            null,
            `re-lookup failed for ${key}: ${redact(error instanceof Error ? error.message : String(error))}`,
          );
        }
        // Cleared as soon as the answer is in, so a name here means a request in the air and nothing
        // else. That is exactly what separates "paused" from "pausing, one track to go", and leaving
        // the last name standing through every inter-track wait would blur the two.
        this.progress = { ...this.progress, current: null };
      }
    } finally {
      const { done, skipped, cancelled, total } = this.progress;
      this.relooking = false;
      this.cancelRequested = false;
      // Kept rather than reset, so the page can show how it ended instead of the readout vanishing at
      // the moment the answer arrives.
      this.progress = { ...this.progress, running: false, current: null };
      this.store.log(
        'info',
        null,
        (cancelled ? `re-lookup stopped after ${done} of ${total}` : `re-looked up ${done} track${done === 1 ? '' : 's'}`) +
          (skipped > 0 ? `, skipped ${skipped}` : ''),
      );
    }
    return this.relookupProgress;
  }

  /**
   * Waits out a pause, and says whether the run may carry on.
   *
   * Called between tracks rather than mid-flight: a lookup already in the air is going to finish
   * either way, and abandoning its answer would waste the requests it has already spent. Stop is
   * honoured while holding, so a pause can never trap a run.
   */
  private async holdOrStop(): Promise<'go' | 'held' | 'stop'> {
    if (this.cancelRequested) return 'stop';
    if (!this.pauseRequested) return 'go';

    // Naming nothing while it holds is what lets the page tell "paused" from "pausing, one to go".
    this.progress = { ...this.progress, current: null };
    this.store.log('info', null, `re-lookup paused at ${this.progress.done} of ${this.progress.total}`);
    while (this.pauseRequested && !this.cancelRequested) await sleep(PAUSE_POLL_MS);
    if (this.cancelRequested) return 'stop';
    this.store.log('info', null, 're-lookup resumed');
    return 'held';
  }

  /**
   * Waits between tracks, without sitting out the wait once asked to stop or hold.
   *
   * Polled rather than slept in one go, so the controls answer at the same speed whatever the delay is
   * set to. Someone who raised it to half a minute because a source was throttling should not be left
   * wondering for half a minute whether Stop registered.
   */
  private async waitBetween(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (!this.cancelRequested && !this.pauseRequested) {
      const left = until - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(PAUSE_POLL_MS, left));
    }
  }

  /** Holds the run in progress after the track it is on, or lets it go on again. */
  pauseRelookup(paused: boolean): boolean {
    if (!this.relooking) return false;
    this.pauseRequested = paused;
    return true;
  }

  /** Asks the run in progress to stop after the track it is on. */
  cancelRelookup(): boolean {
    if (!this.relooking) return false;
    this.cancelRequested = true;
    this.store.log('info', null, 're-lookup asked to stop');
    return true;
  }

  get relookupProgress(): RelookupProgress {
    // `paused` is derived rather than stored: a request to hold that outlived its run would be a
    // readout nobody could clear.
    return { ...this.progress, paused: this.pauseRequested && this.relooking };
  }

  /**
   * The query that reproduces a stored key, so a re-lookup updates the entry instead of duplicating it.
   *
   * This is the whole care in this operation. `cacheKey` prefers a Spotify id, then an ISRC, then the
   * name and duration — so handing it an ISRC the track did not have when it was first filed produces
   * a *different* key, and the re-lookup writes a second entry while the original sits there stale.
   * Exactly the tracks that learned their ISRC afterwards are the ones this would happen to, which is
   * to say the ones worth revisiting.
   *
   * So the ISRC is offered and then withdrawn if it moves the key. Nothing is lost by leaving it out:
   * `withKnownIdentity` reads it back from the store by key, which is why that step exists.
   */
  private trackForKey(key: string): TrackQuery | null {
    const entry = this.store.getEntry(key);
    const extras = this.store.extras(key);

    // Extras as well as the entry, because "Forget lyrics" leaves the entry and the archive deleted and
    // the artwork and tempo behind. Those rows show in the library — it lists the union of both tables
    // — so a re-lookup aimed at one has to be able to find its title.
    const title = entry?.title || extras?.title || '';
    const artist = entry?.artist || extras?.artist || '';
    if (!title) return null;

    const known = this.store.identityFor(key);
    const base: TrackQuery = {
      title,
      artist,
      album: entry?.album ?? '',
      durationMs: entry?.durationMs || known.durationMs || 0,
      spotifyId: entry?.spotifyId ?? undefined,
      isrc: known.isrc ?? undefined,
    };

    // The care in this whole operation is the key, not the loop. `cacheKey` prefers a Spotify id, then
    // an ISRC, then the name and a two-second duration bucket — so a query rebuilt from what is known
    // *now* can hash to somewhere else entirely, and the re-lookup then writes a second entry while the
    // original sits there stale. Two ways that happens, and both are commonest on exactly the tracks
    // worth revisiting:
    //
    // - an ISRC learned after the track was first filed under its name, and
    // - a duration learned after it was filed with none, which moves the bucket.
    //
    // So candidates are tried in order of how much they preserve, and the key itself is the authority
    // on its own identifying fields — it is the only record of what they were.
    const candidates: TrackQuery[] = [base, { ...base, isrc: undefined }];

    if (key.startsWith('sp:')) {
      candidates.push({ ...base, spotifyId: key.slice(3) });
    } else if (key.startsWith('isrc:')) {
      candidates.push({ ...base, spotifyId: undefined, isrc: key.slice(5) });
    } else if (key.startsWith('q:')) {
      // The bucket is the only surviving trace of the duration this was filed under. Multiplying it
      // back is exact for keying — `floor(bucket * 2000 / 2000)` is the bucket — and at most two
      // seconds out for matching, which is inside the band the matcher scores as a perfect duration.
      // Tried last, so a real duration that still lands in the same bucket is preferred.
      const bucket = Number(key.slice(2).split('|').at(-1));
      if (Number.isFinite(bucket)) {
        candidates.push({
          ...base,
          spotifyId: undefined,
          isrc: undefined,
          durationMs: bucket * 2_000,
        });
      }
    }

    for (const candidate of candidates) {
      if (cacheKey(candidate) === key) return candidate;
    }

    // Nothing reproduces it. Refusing is right: a duplicate is worse than a track left alone, and
    // `withKnownIdentity` would have put the identity back for matching anyway.
    this.store.log('warn', null, `cannot re-look up ${key}: no query reproduces that key`);
    return null;
  }

  /**
   * Harvest a track's extras, at most once per process per track.
   *
   * Bounded three ways, because this runs on every lookup: once per key while the process
   * lives, skipped when the extras and the identity are both already on record, and never
   * awaited.
   */
  /**
   * Fill in identity the caller did not have.
   *
   * Never overrides what was sent: a phone that knows its own duration is describing the file it
   * is playing, which is a better authority than a record of something that matched before.
   */
  private withKnownIdentity(key: string, track: TrackQuery): TrackQuery {
    const known = this.store.identityFor(key);
    if (!known.isrc && !known.durationMs) return track;
    return {
      ...track,
      isrc: track.isrc ?? known.isrc ?? undefined,
      durationMs: track.durationMs > 0 ? track.durationMs : (known.durationMs ?? 0),
    };
  }

  /**
   * Kick off a harvest without waiting for it.
   *
   * Detached on purpose: the caller asked for words, and none of this may make them slower or
   * fail anywhere they can see.
   */
  private harvestAfter(config: Config, key: string, track: TrackQuery): void {
    void this.harvestOnce(config, key, track);
  }

  /**
   * Sources that are worth asking again about a track already in the cache.
   *
   * A cached answer used to stand for the full refresh window whatever it was missing, so a track
   * first played during an outage — or before a source was configured, or before it was enabled —
   * kept the poorer answer for thirty days. Nothing knew a better one had ever been missed.
   *
   * Only two cases qualify, and the rest are deliberately left alone:
   *
   * - **Never asked.** No attempt recorded, which means the source was off, unconfigured, or added
   *   since. It has never had the chance to answer.
   * - **Could not be reached.** A timeout, a refused token, a 500. The reason may well be gone, and
   *   after this long it is worth finding out.
   *
   * A source that answered "no lyrics for this track" is *not* re-asked. That is a real answer, and
   * re-asking it on every play would be six wasted requests a song for a result that will not change.
   * The thirty-day refresh already covers a catalogue that grows.
   */
  private staleSources(key: string, config: Config): Provider[] {
    const attempts = this.store.attemptsFor(key);

    // The archive counts as an attempt — but only as much of one as it can honestly prove.
    //
    // `attempts` began empty on every database that already had a cache, so without this the first hit
    // after the upgrade treated every source as never asked and re-fetched ones whose answers were
    // sitting in `raw`. Inferred as a record rather than a bare "seen", because two details matter:
    // a body that was superseded or never usable is not an answer, and an archived body says nothing
    // about whether an ISRC was in hand — so it must count as name-searched, or every legacy Apple and
    // AMLL row would look already-exact and the ISRC rule below could never fire for the caches that
    // most need it.
    const inferred = new Map(attempts);
    for (const raw of this.store.getRaw(key)) {
      if (!raw.ok) continue;
      if (inferred.has(raw.provider)) continue;
      inferred.set(raw.provider, { outcome: 'lyrics', at: raw.fetchedAt, hadIsrc: false });
    }

    // Whether the question itself has improved since the source was asked. An ISRC learned after the
    // fact is exactly that: the same source, asked exactly rather than by a title that might belong
    // to a dozen recordings. The app has had this idea for a while, under the name `freshen`; the
    // server only ever asked "did it answer?", never "was it answering something worse?".
    const isrc = this.store.isrcFor(key);

    return activeProviders(config).filter((provider) => {
      const attempt = inferred.get(provider.id);
      if (!attempt) return true;

      // Asked by name, and an ISRC is known now. Only for the two sources that can use one — for the
      // rest nothing has changed, and re-asking them would be requests spent to receive the same
      // answer.
      if (isrc && provider.usesIsrc && !attempt.hadIsrc) return true;

      // Never asked, only postponed: ask as soon as anything asks again, because the reason it was
      // skipped was measured in seconds and has almost certainly passed.
      if (attempt.outcome === 'deferred') return true;

      if (attempt.outcome !== 'unreachable') return false;
      return Date.now() - attempt.at > RETRY_UNREACHABLE_MS;
    });
  }

  /**
   * Asks the sources a cached track never got an answer from, then re-merges.
   *
   * In the background, and never awaited: the cached answer has already gone back to the caller. The
   * point is that the *next* play is better, not that this one is slower — asking six sources takes
   * seconds, and a lookup that already had an answer in hand must not spend them.
   */
  private upgradeAfter(config: Config, key: string, track: TrackQuery): void {
    void this.upgradeOnce(config, key, track);
  }

  private async upgradeOnce(config: Config, key: string, track: TrackQuery): Promise<void> {
    // In flight, not "already tried". This used to be a memo held for the life of the process, which
    // silently outranked the six-hour cooldown it was supposed to complement: a source that was still
    // unreachable on the first attempt was never asked again until a restart, however long the server
    // ran. The cooldown in `staleSources` is what stops repeated plays becoming repeated requests;
    // this only stops two lookups for the same track overlapping.
    if (this.upgrading.has(key)) return;

    const stale = this.staleSources(key, config);
    if (stale.length === 0) return;

    this.upgrading.add(key);
    try {
      await this.runUpgrade(config, key, track, stale);
    } finally {
      this.upgrading.delete(key);
    }
  }

  private async runUpgrade(
    config: Config,
    key: string,
    track: TrackQuery,
    stale: Provider[],
  ): Promise<void> {

    const enriched = this.withKnownIdentity(key, track);
    const hadIsrc = Boolean(enriched.isrc?.trim());
    let gained = 0;

    // Which providers said they could not be reached, so the record is not overwritten below. Exactly
    // as `fetchAndMerge` does it: a provider reports a failure through `unreachable` and *then*
    // returns null, so writing 'none' on the null would turn every outage into a settled "no lyrics
    // here" — and `staleSources` never retries those.
    const unreachable = new Set<string>();

    // Which of these are being re-asked *because* an ISRC turned up — meaning they answered before on a
    // title alone, and are about to be asked exactly. If one of those now says it has nothing, the body
    // it gave earlier was matched to some other recording: the same source, asked properly, does not
    // have this song. That body is why the merge is wrong, and nothing else would ever remove it.
    const before = this.store.attemptsFor(key);
    const supersedable = new Set(
      stale
        .filter((provider) => {
          const attempt = before.get(provider.id);
          return Boolean(
            provider.usesIsrc && attempt?.outcome === 'lyrics' && attempt.hadIsrc === false,
          );
        })
        .map((provider) => provider.id),
    );
    let superseded = 0;

    await Promise.all(
      stale.map(async (provider) => {
        try {
          const answer = await provider.fetch(enriched, {
            config,
            log: (level, message) => this.store.log(level, provider.id, redact(message)),
            unreachable: (detail) => {
              unreachable.add(provider.id);
              // "Not due yet" is not a failure: nothing was asked, so nothing should be written down as
              // having been tried. Recorded separately so the cooldown below can be none at all.
              const deferred = detail.includes(PACED_MARKER);
              this.store.recordAttempt(key, provider.id, deferred ? 'deferred' : 'unreachable', hadIsrc);
              this.store.log('warn', provider.id, redact(detail));
            },
            learn: () => {
              // Left to the lookup and the harvest. An upgrade is about the words; identity and
              // artwork have their own paths, and writing them from here would duplicate that
              // logic in a place nobody would think to look for it.
            },
          });
          if (!answer) {
            if (!unreachable.has(provider.id)) {
              this.store.recordAttempt(key, provider.id, 'none', hadIsrc);

              // Asked exactly, and it has nothing. Its earlier name-matched body is not merely older,
              // it is about a different recording — so it stops being merged from. Flagged rather than
              // deleted: the archive is the point of this server, and the evidence is worth keeping.
              if (supersedable.has(provider.id)) {
                this.store.supersedeRaw(
                  key,
                  provider.id,
                  'superseded: asked again by ISRC and this source has no such recording',
                );
                superseded++;
                this.store.log(
                  'info',
                  provider.id,
                  `dropped an earlier name match for ${key}: asked by ISRC, it has nothing`,
                );
              }
            }
            return;
          }
          this.store.recordAttempt(key, provider.id, 'lyrics', hadIsrc);
          this.store.putRaw({
            key,
            provider: provider.id,
            body: answer.raw.body,
            contentType: answer.raw.contentType,
            ok: true,
            note: answer.note ?? null,
          });
          gained++;
        } catch (error) {
          this.store.recordAttempt(key, provider.id, 'unreachable', hadIsrc);
          this.store.log(
            'warn',
            provider.id,
            redact(error instanceof Error ? error.message : String(error)),
          );
        }
      }),
    );

    // Withdrawing a body changes the merge as surely as adding one does.
    if (gained === 0 && superseded === 0) return;

    // Re-merged from the whole archive rather than merged with what just arrived, so the new source
    // competes for the spine on the same terms as everything else. Whether it is an improvement is
    // the merge's decision, which is the only place that knows.
    if (this.remerge(key, config)) {
      this.store.log(
        'info',
        null,
        `upgraded ${key}: ${gained} source${gained === 1 ? '' : 's'} that had not answered before` +
          (superseded > 0 ? `, ${superseded} withdrawn as the wrong recording` : ''),
      );
    }
  }

  private async harvestOnce(config: Config, key: string, track: TrackQuery): Promise<void> {
    if (this.harvested.has(key)) return;
    this.harvested.add(key);
    // A cap rather than an unbounded set: this is a memo, not a record.
    if (this.harvested.size > 4_000) this.harvested.clear();

    try {
      // What the harvest adds that a provider cannot: Spotify's audio analysis and an artist
      // image, both of which need requests nobody makes while looking for words. So the question
      // is whether *those* are present — not whether an extras row exists at all.
      //
      // Any provider reporting a palette or an album name creates that row mid-lookup, and Apple's
      // report includes an ISRC, so the old guard treated the commonest successful path as already
      // harvested and never collected the analysis at all. Which is the one thing here that cannot
      // be fetched later: Spotify withdrew the endpoint.
      const already = this.store.extras(key);
      if (already?.analysis && already.artistImageUrl && this.store.isrcFor(key)) return;
      await harvest(this.store, config, key, track);
    } catch {
      // Best effort by definition.
    }
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

      // It returned nothing, which may mean it *cleared* this entry — every source it was built from is
      // rejected now. The snapshot above is from before that, so falling through would serve the very
      // document this just decided was unusable. Read it again and answer from what is true now.
      const after = this.store.getEntry(key);
      if (!after?.merged) return null;
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
    // Recorded against every attempt below: what was asked matters as much as what came back.
    const hadIsrc = Boolean(track.isrc?.trim());
    const providers = activeProviders(config);
    if (providers.length === 0) {
      this.store.log('warn', null, 'no sources are both enabled and configured');
      return { document: null, key, source: 'absent', ms: Math.round(performance.now() - started) };
    }

    const candidates: Candidate[] = [];
    const unreachable: string[] = [];
    /**
     * Of those, the ones that were never actually asked — the host was paced and its turn had not come.
     *
     * Kept apart because the outcome decides the cooldown, and the two deserve opposite ones: six hours
     * for a service having a bad day, none at all for a source that was a few seconds early. The detail
     * string is the only place that distinction exists by the time the recording happens, so it is
     * noticed here rather than reconstructed later.
     */
    const deferred = new Set<string>();

    await Promise.all(
      providers.map(async (provider) => {
        const ctx = {
          config,
          log: (level: 'info' | 'warn' | 'error', message: string) =>
            this.store.log(level, provider.id, redact(message)),
          unreachable: (detail: string) => {
            unreachable.push(provider.id);
            if (detail.includes(PACED_MARKER)) deferred.add(provider.id);
            this.store.log('warn', provider.id, redact(detail));
          },
          learn: (extras: LearnedExtras) => {
            // Identity where the matcher can see it, presentation where the renderer can.
            this.store.noteIdentity(key, {
              isrc: extras.isrc,
              durationMs: extras.durationMs,
            });
            if (
              extras.coverUrl ||
              extras.artistImageUrl ||
              extras.tempo ||
              extras.palette ||
              extras.analysis ||
              extras.metadata
            ) {
              // Only what this provider knows. Anything absent is left alone rather than written
              // as null, so a source with a palette cannot erase another's tempo.
              this.store.saveExtras({
                key,
                title: track.title,
                artist: track.artist,
                coverUrl: extras.coverUrl,
                artistImageUrl: extras.artistImageUrl,
                tempo: extras.tempo,
                palette: extras.palette,
                analysis: extras.analysis,
                metadata: extras.metadata,
                source: provider.id,
              });
            }
          },
        };
        try {
          const answer = await provider.fetch(track, ctx);
          if (!answer) {
            // Two very different silences, and the provider has already said which through
            // `unreachable`. Recording them apart is what lets a later lookup re-ask the one that
            // failed without pestering the one that simply has no lyrics for this track.
            this.store.recordAttempt(
              key,
              provider.id,
              deferred.has(provider.id)
                ? 'deferred'
                : unreachable.includes(provider.id)
                  ? 'unreachable'
                  : 'none',
              hadIsrc,
            );
            return;
          }
          this.store.recordAttempt(key, provider.id, 'lyrics', hadIsrc);

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
          this.store.recordAttempt(key, provider.id, 'unreachable', hadIsrc);
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
      album: track.album ?? '',
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
      // Superseded: kept on disk as evidence, never merged from again. See `supersedeRaw`.
      if (!raw.ok) continue;
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

    const result =
      candidates.length === 0
        ? null
        : merge(candidates, {
            durationMs: entry?.durationMs ?? 0,
            preferredTranslationLang: config.translationLang,
          });

    if (!result?.document) {
      // Nothing usable left — every archived body either fails to parse now or was judged the wrong
      // song. Returning quietly would leave the old merge standing, which is the worst outcome: it was
      // built from exactly those sources, so the lyrics that are wrong stay cached and served, and
      // nothing re-fetches until the thirty-day refresh. Six entries in the archive are this, all of
      // them NetEase answering "instrumental, please enjoy" as the only source.
      //
      // So it becomes a cached miss instead, which is a state this already has: empty `merged` means
      // "nothing found", carries the short negative TTL rather than the long refresh, and so asks the
      // providers again in a couple of days. The archive and the extras are untouched — the raw bodies
      // are evidence, and the artwork was never in question.
      if (entry?.merged) {
        this.store.putEntry({
          key,
          title: entry.title,
          artist: entry.artist,
          album: entry.album,
          durationMs: entry.durationMs,
          spotifyId: entry.spotifyId,
          isrc: entry.isrc,
          merged: '',
          mergeVersion: MERGE_VERSION,
        });
        this.store.log('warn', null, `re-merge left ${key} with nothing usable; it now reads as a miss`);
      }
      return null;
    }

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

  /**
   * Recomputes every entry the current algorithm has not seen. Network-free, and deliberately not
   * instant.
   *
   * It yields the event loop every few entries because it is slower than it looks: 386 entries took 68
   * seconds on the real archive, most of it the pairwise alignment the cross-check needs. Run straight
   * through, that is 68 seconds during which nothing is answered — including the proxy's health check,
   * which polls every three seconds and would conclude the container is broken and fail the deploy.
   * Correctness never depended on this pass anyway: `fromCache` re-merges an out-of-date entry the
   * moment it is asked for, so this is only eager warming and can afford to be polite.
   */
  async remergeAll(): Promise<{ attempted: number; rebuilt: number }> {
    const keys = this.store.keysBelowVersion(MERGE_VERSION);
    let rebuilt = 0;
    for (const [index, key] of keys.entries()) {
      if (this.remerge(key)) rebuilt++;
      // Often enough that a health check never waits more than a few entries for a turn.
      if (index % 5 === 4) await new Promise((resolve) => setImmediate(resolve));
    }
    if (keys.length > 0) {
      this.store.log('info', null, `re-merged ${rebuilt}/${keys.length} entries at v${MERGE_VERSION}`);
    }
    return { attempted: keys.length, rebuilt };
  }
}
