/**
 * The HTTP surface: a small API for the app, and an admin page for the person running it.
 *
 * Binds to 127.0.0.1 unless told otherwise, because of what is in the database. Every /v1
 * route wants a bearer token; the admin page trades that token for a session cookie once so
 * the browser is not carrying it in a URL or a bookmark.
 *
 * There is no framework here on purpose. The whole router is one switch and it fits on a
 * screen, which is a better trade for a single-user server than a dependency tree.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { Settings, jwtExpiry, randomKey, SECRET_NAMES, type SecretName } from './config.ts';
import { Store, LOG_LEVELS, type LogLevel } from './db.ts';
import { Resolver, reparseByFormat } from './resolver.ts';
import { Refresher } from './refresher.ts';
import { MERGE_VERSION } from './merge.ts';
import { timingFit } from './report.ts';
import { PROVIDERS, providerById } from './providers/index.ts';
import { testSources, TEST_TRACK } from './selftest.ts';
import { backfillIsrc } from './harvest.ts';
import { parseTtml, writeTtml } from './format/ttml.ts';
import { parseLrc, writePlainText } from './format/lrc.ts';
import { cacheKey, type TrackQuery } from './match.ts';
import type { LyricsDocument, MergedDocument } from './model.ts';
import { redact } from './http.ts';

// `URL.pathname` stays percent-encoded, so a checkout under a path with a space in it would
// look for a directory literally called `%20`. fileURLToPath is the one that decodes.
const ADMIN_DIR = fileURLToPath(new URL('./admin/', import.meta.url));

/** Browser sessions, in memory: a restart signing everybody out is the safe default. */
const sessions = new Map<string, number>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface App {
  store: Store;
  settings: Settings;
  resolver: Resolver;
  refresher: Refresher;
}

export function createApp(databasePath: string): App {
  const store = new Store(databasePath);
  const settings = new Settings(store);
  settings.ensureApiKey();
  const resolver = new Resolver(store, settings);
  const refresher = new Refresher(store, settings);
  return { store, settings, resolver, refresher };
}

/**
 * @param overrides host and port, for tests that need an ephemeral port rather than the
 *   configured one.
 */
export function start(
  app: App,
  overrides: { host?: string; port?: number; quiet?: boolean } = {},
): ReturnType<typeof createServer> {
  const stored = app.settings.read();
  const config = {
    ...stored,
    host: overrides.host ?? stored.host,
    port: overrides.port ?? stored.port,
  };
  const server = createServer((request, response) => {
    handle(app, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      app.store.log('error', null, `unhandled: ${message}`);
      if (!response.headersSent) send(response, 500, { error: 'internal error' });
    });
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const where = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;
    const say = overrides.quiet ? () => {} : (line: string) => console.log(line);

    say(`melisma-server listening on ${where}`);
    say(`admin:   ${where}/`);
    say(`api key: ${app.settings.read().apiKey}`);

    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      // Worth being loud about: the database holds the user's Apple and Spotify
      // credentials in the clear, and this server is not the thing to put on the internet.
      if (!overrides.quiet) {
        console.warn(
          `\n!! bound to ${config.host}, so this is reachable from the network.\n` +
            `   The database holds your Apple and Spotify credentials in the clear.\n` +
            `   Only do this behind something that terminates TLS and trusts nobody.\n`,
        );
      }
      app.store.log('warn', null, `bound to ${config.host} — reachable off-host`);
    }

    // Tokens first: a container that has just started may have been down for a day, and every
    // lookup below depends on them. It runs in the background either way.
    app.refresher.start();
    const refresh = app.refresher.mechanism;
    if (refresh !== 'none') {
      say(`token refresh: every ${app.settings.read().tokenRefreshMinutes} min via the ${refresh}`);
    }

    // A merge algorithm newer than the stored entries: bring them up to date from the archive, without
    // asking any provider anything. Started rather than awaited — it takes a minute or so on a library
    // of a few hundred, and the server has to be answering before then. Any entry it has not reached
    // yet is re-merged on the way out of the cache when something asks for it.
    void app.resolver
      .remergeAll()
      .then((caught) => {
        if (caught.attempted > 0) {
          say(`re-merged ${caught.rebuilt}/${caught.attempted} cached entries at v${MERGE_VERSION}`);
        }
      })
      .catch(() => undefined);
  });

  return server;
}

async function handle(app: App, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';

  // ---- unauthenticated ---------------------------------------------------
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return serveStatic(response, 'index.html');
  }
  if (method === 'GET' && /^\/assets\/[\w.-]+$/.test(path)) {
    return serveStatic(response, path.slice('/assets/'.length));
  }
  if (method === 'POST' && path === '/admin/api/login') {
    const body = await readJson<{ apiKey?: string }>(request);
    if (!matchesApiKey(app, body?.apiKey ?? '')) {
      app.store.log('warn', null, 'admin login rejected');
      return send(response, 401, { error: 'wrong key' });
    }
    const token = randomKey();
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    response.setHeader(
      'Set-Cookie',
      `bls_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    return send(response, 200, { ok: true });
  }

  // ---- authenticated -----------------------------------------------------
  if (!isAuthorised(app, request, `${method} ${path}`)) {
    return send(response, 401, { error: 'unauthorised' });
  }

  switch (`${method} ${path}`) {
    case 'GET /v1/health':
      return send(response, 200, health(app));

    case 'GET /v1/lyrics':
      return lyrics(app, url, response);

    case 'POST /v1/warm': {
      const track = trackFromJson(await readJson(request));
      if (!track) return send(response, 400, { error: 'need at least a title' });
      // Fire and forget: the app is prefetching, and it is not waiting for an answer — which is
      // exactly what buys the room to find out what the recording is before asking for its words.
      void app.resolver.resolve(track, { identityFirst: true }).catch(() => undefined);
      return send(response, 202, { ok: true });
    }

    case 'POST /v1/contribute':
      return contribute(app, request, response);

    case 'GET /v1/extras':
      return readExtras(app, url, response);

    case 'GET /v1/status':
      return status(app, response);

    case 'POST /admin/api/logout': {
      const token = cookie(request, 'bls_session');
      if (token) sessions.delete(token);
      response.setHeader('Set-Cookie', 'bls_session=; HttpOnly; Path=/; Max-Age=0');
      return send(response, 200, { ok: true });
    }

    case 'GET /admin/api/config':
      return send(response, 200, {
        config: app.settings.redacted(),
        providers: PROVIDERS.map(describeProvider(app)),
        appleTokenExpiresAt: jwtExpiry(app.settings.read().secrets.appleBearerToken),
        mergeVersion: MERGE_VERSION,
      });

    case 'POST /admin/api/config': {
      const body = await readJson<Record<string, string | null>>(request);
      if (!body) return send(response, 400, { error: 'expected an object' });
      app.settings.update(body);
      app.store.log('info', null, `settings updated: ${Object.keys(body).join(', ')}`);
      return send(response, 200, { config: app.settings.redacted() });
    }

    case 'POST /admin/api/reveal': {
      const body = await readJson<{ name?: string }>(request);
      const name = body?.name as SecretName | undefined;
      if (!name || !SECRET_NAMES.includes(name)) {
        return send(response, 400, { error: 'unknown secret' });
      }
      app.store.log('warn', null, `revealed ${name} to the admin page`);
      return send(response, 200, { value: app.settings.reveal(name) });
    }

    case 'POST /admin/api/test': {
      const body = await readJson<{ provider?: string }>(request);
      const provider = providerById(body?.provider ?? '');
      if (!provider) return send(response, 400, { error: 'unknown source' });
      const config = app.settings.read();
      if (!provider.isConfigured(config)) {
        return send(response, 200, {
          ok: false,
          detail: `needs ${provider.requires.join(' and ')}`,
        });
      }
      // A whole context, not two of its four members. `test` reaches code shared with `fetch` —
      // Spotify's token lookup calls `unreachable`, and its colour reporting calls `learn` — and the
      // types are stripped at runtime, so a partial object did not fail to compile, it threw
      // `ctx.unreachable is not a function` and the admin page said "internal error".
      let detail: string | null = null;
      const result = await provider.test({
        config,
        log: (level, message) => app.store.log(level, provider.id, message),
        unreachable: (reason) => {
          // Kept rather than dropped: it is usually a better account of the failure than the
          // summary the test itself returns.
          detail = reason;
          app.store.log('warn', provider.id, redact(reason));
        },
        learn: () => {
          // A test is not a lookup. Anything it happens to notice belongs to no track here, and
          // filing it under one would be worse than losing it.
        },
      });
      return send(response, 200, detail && !result.ok ? { ...result, detail } : result);
    }

    case 'POST /admin/api/sources': {
      // Every source, one known track, real lookups. See `selftest.ts` for why this exists
      // alongside the per-source credential check above.
      const reports = await testSources(app.store, app.settings.read());
      const worked = reports.filter((report) => report.ok).length;
      app.store.log('info', null, `source test: ${worked}/${reports.length} returned lyrics`);
      return send(response, 200, { track: TEST_TRACK, sources: reports });
    }

    case 'POST /admin/api/backfill-isrc': {
      // Exact, not matched: every one of these already has a Spotify id, which names one recording.
      const result = await backfillIsrc(app.store, app.settings.read(), (level, message) =>
        app.store.log(level, 'spotify', message),
      );
      return send(response, 200, result);
    }

    case 'POST /admin/api/relookup': {
      const body = await readJson<{ keys?: string[] }>(request);
      // No keys means the whole library. Bounded by `allKeys`, which is a personal cache rather than
      // a catalogue.
      const keys = Array.isArray(body?.keys) && body.keys.length > 0
        ? body.keys.filter((key) => typeof key === 'string')
        : app.store.allKeys();

      if (app.resolver.relookupProgress.running) {
        return send(response, 409, {
          error: app.resolver.relookupProgress.paused
            ? 'a re-lookup is already running, and paused — resume or stop it first'
            : 'a re-lookup is already running',
        });
      }
      app.store.log('info', null, `re-looking up ${keys.length} track(s) with what is known now`);
      // Not awaited: this asks six sources per track and the page has a live view of the result.
      void app.resolver.relookup(keys).catch(() => undefined);
      return send(response, 202, { queued: keys.length });
    }

    case 'POST /admin/api/forget': {
      const body = await readJson<{ keys?: string[]; everything?: boolean }>(request);
      const keys = (Array.isArray(body?.keys) ? body.keys : []).filter(
        (key) => typeof key === 'string' && key,
      );
      if (keys.length === 0) return send(response, 400, { error: 'nothing selected' });

      // Opt in for the extras, the same as the single-entry delete: they hold the audio analysis,
      // which came from an endpoint Spotify has withdrawn and cannot be fetched again.
      const includeExtras = body?.everything === true;
      for (const key of keys) app.store.deleteEntry(key, { includeExtras });
      app.store.log(
        'warn',
        null,
        `deleted ${includeExtras ? 'everything for' : 'the lyrics of'} ${keys.length} track(s)`,
      );
      return send(response, 200, { deleted: keys.length });
    }

    case 'GET /admin/api/fit':
      // Cheap enough to answer inline: it reads the merged documents, which already hold their timings
      // and name their source, rather than reparsing the archive.
      return send(response, 200, timingFit(app.store));

    case 'POST /admin/api/drop-source': {
      const body = await readJson<{ key?: string; provider?: string }>(request);
      const key = typeof body?.key === 'string' ? body.key : '';
      const provider = typeof body?.provider === 'string' ? body.provider : '';
      if (!key || !provider) return send(response, 400, { error: 'need a key and a provider' });

      // The body stays on disk, marked unusable, so the evidence survives and the reason is recorded
      // next to it. Then re-merge at once: the point of the action is that the answer changes now.
      app.store.supersedeRaw(key, provider, 'dropped by hand: timings did not fit the track');
      app.store.log('warn', null, `dropped ${provider} for ${key}: timings did not fit the track`);
      const document = app.resolver.remerge(key);

      return send(response, 200, {
        dropped: provider,
        // What owns the timing now — or nothing, if that source was the only one that answered.
        timing: document?.provenance?.timing ?? null,
        lines: document?.lines.length ?? 0,
      });
    }

    case 'GET /admin/api/relookup':
      return send(response, 200, app.resolver.relookupProgress);

    case 'POST /admin/api/relookup/pause': {
      const body = await readJson<{ paused?: boolean }>(request);
      // Explicit rather than a toggle: two pages open on the same run would otherwise flip each
      // other's state and neither would show what it asked for.
      const paused = body?.paused !== false;
      const changed = app.resolver.pauseRelookup(paused);
      return send(response, 200, { changed, progress: app.resolver.relookupProgress });
    }

    case 'POST /admin/api/relookup/cancel': {
      const stopping = app.resolver.cancelRelookup();
      // 200 either way: "there was nothing to stop" is an answer, not a failure, and the page may
      // simply be a second later than the run finishing.
      return send(response, 200, { stopping, progress: app.resolver.relookupProgress });
    }

    case 'GET /admin/api/refresh':
      return send(response, 200, app.refresher.status());

    case 'POST /admin/api/refresh':
      // Deliberately no way to *set* the command here: an admin session should not be able to
      // choose what the host executes. Only to run what the environment already chose.
      return send(response, 200, await app.refresher.run('manual'));

    case 'GET /admin/api/stats':
      return send(response, 200, {
        ...app.store.stats(),
        mergeVersion: MERGE_VERSION,
        stale: app.store.keysBelowVersion(MERGE_VERSION).length,
      });

    case 'GET /admin/api/library': {
      // The options are named once, here, so adding one means adding it in a single place. The
      // previous shape repeated each list inside its own validation, and a filter missing from
      // that copy was accepted by the URL, dropped silently, and answered with everything — which
      // reads exactly like a filter that found nothing to exclude.
      const pick = <T extends string>(name: string, allowed: readonly T[], fallback?: T) => {
        const value = url.searchParams.get(name) ?? '';
        return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
      };

      return send(response, 200, {
        ...app.store.library({
          search: url.searchParams.get('search') ?? undefined,
          inLyrics: url.searchParams.get('inLyrics') === '1',
          sort: pick('sort', LIBRARY_SORTS, 'song'),
          missing: pick('missing', LIBRARY_MISSING),
          limit: Number(url.searchParams.get('limit') ?? 50),
          offset: Number(url.searchParams.get('offset') ?? 0),
        }),
      });
    }

    case 'GET /admin/api/entries':
      return send(response, 200, {
        entries: app.store.listEntries({
          search: url.searchParams.get('search') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 50),
          offset: Number(url.searchParams.get('offset') ?? 0),
        }),
      });

    case 'GET /admin/api/entry': {
      const key = url.searchParams.get('key') ?? '';
      const entry = app.store.getEntry(key);
      const extras = app.store.extras(key);
      // A track can have artwork and a tempo and no lyrics anybody has written down, so either
      // half is enough to have something to show.
      if (!entry && !extras) return send(response, 404, { error: 'no such entry' });
      return send(response, 200, {
        key,
        entry: entry ? { ...entry, merged: undefined } : null,
        merged: entry?.merged ? JSON.parse(entry.merged) : null,
        extras,
        raw: app.store.getRaw(key).map((raw) => ({
          provider: raw.provider,
          contentType: raw.contentType,
          bytes: raw.body.length,
          fetchedAt: raw.fetchedAt,
          // Stored on every row and never surfaced until now: a failed archived response looked
          // exactly like a good one.
          ok: raw.ok,
          note: raw.note,
        })),
      });
    }

    case 'GET /admin/api/raw': {
      const key = url.searchParams.get('key') ?? '';
      const provider = url.searchParams.get('provider') ?? '';
      const raw = app.store.getRaw(key).find((entry) => entry.provider === provider);
      if (!raw) return send(response, 404, { error: 'no such archived response' });
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void response.end(raw.body);
    }

    case 'DELETE /admin/api/entry': {
      const key = url.searchParams.get('key') ?? '';
      // Opt in, because the extras hold the one thing here that cannot be fetched again.
      const includeExtras = url.searchParams.get('everything') === '1';
      app.store.deleteEntry(key, { includeExtras });
      app.store.log('info', null, `deleted ${includeExtras ? 'everything for' : 'the lyrics of'} ${key}`);
      return send(response, 200, { ok: true });
    }

    case 'POST /admin/api/remerge': {
      const body = await readJson<{ key?: string }>(request);
      if (body?.key) {
        const document = app.resolver.remerge(body.key);
        return send(response, 200, { ok: Boolean(document), document });
      }
      return send(response, 200, app.resolver.remergeAll());
    }

    case 'POST /admin/api/lookup': {
      const body = await readJson<Record<string, unknown>>(request);
      const track = trackFromJson(body);
      if (!track) return send(response, 400, { error: 'need at least a title' });
      const resolution = await app.resolver.resolve(track, { force: body?.force === true });
      return send(response, 200, resolution);
    }

    case 'GET /admin/api/events': {
      const level = url.searchParams.get('level');
      return send(response, 200, {
        levels: LOG_LEVELS,
        events: app.store.recentEvents(Number(url.searchParams.get('limit')) || 200, {
          // An unrecognised level is ignored rather than refused: this is a log viewer, and the
          // useful failure mode is "you see everything", not a 400.
          level: LOG_LEVELS.includes(level as never) ? (level as LogLevel) : undefined,
          provider: url.searchParams.get('provider') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
        }),
      });
    }

    case 'GET /admin/api/stream':
      return stream(app, request, response);

    default:
      return send(response, 404, { error: 'no such route' });
  }
}

// ---- the app-facing lookup ------------------------------------------------

async function lyrics(app: App, url: URL, response: ServerResponse): Promise<void> {
  const track = trackFromParams(url.searchParams);
  if (!track) return send(response, 400, { error: 'need at least a title' });

  const resolution = await app.resolver.resolve(track, {
    force: url.searchParams.get('force') === '1',
    cacheOnly: url.searchParams.get('cacheOnly') === '1',
  });

  if (!resolution.document) {
    // Any non-2xx reads as "nothing found" to the app, which does not distinguish a miss
    // from a failure — a source that cannot answer simply contributes nothing. The body is
    // for a human debugging it.
    return send(response, 404, {
      status: 404,
      key: resolution.key,
      source: resolution.source,
      candidates: resolution.candidates,
      ms: resolution.ms,
    });
  }

  const format = url.searchParams.get('format');
  const credit = creditFor(app, resolution.key, resolution.document);
  response.setHeader('X-Cache', resolution.source);
  response.setHeader('X-Lyrics-Source', resolution.document.provenance.timing);

  // Bare TTML, for saving a file or handing to the community tooling.
  if (format === 'ttml') {
    response.writeHead(200, { 'Content-Type': 'application/ttml+xml; charset=utf-8' });
    return void response.end(writeTtml(resolution.document));
  }

  // The structured document, for the admin page and anything that wants the model rather
  // than a serialisation of it.
  if (format === 'json') {
    return send(response, 200, {
      key: resolution.key,
      source: resolution.source,
      ms: resolution.ms,
      document: resolution.document,
    });
  }

  // The default, and what the app asks for: TTML in an envelope.
  //
  // TTML rather than the structured document deliberately. It carries everything the app
  // renders — syllables, agents, background vocals, readings, translations with their
  // language — and unlike a bespoke JSON shape it is a format other things already speak, so
  // the app can point at any lyrics server rather than only at this one.
  //
  // Except for a document with no timing at all, which TTML cannot express without inventing
  // some: it would go out as line-synced with every line at 0 ms, and the app would believe
  // it. Plain text says what is actually known.
  const unsynced = resolution.document.kind === 'static';
  return send(response, 200, {
    status: 200,
    data: {
      format: unsynced ? 'lrc' : 'ttml',
      lyrics: unsynced ? writePlainText(resolution.document) : writeTtml(resolution.document),
      source: resolution.document.provenance.timing,
      providerName: credit,
      // Not part of the contract; useful when watching what the server is doing.
      key: resolution.key,
      cache: resolution.source,
      ms: resolution.ms,
    },
  });
}

/**
 * Who to credit under the last line.
 *
 * The attribution has to survive the hop through the cache, or every track ends up claiming
 * to come from "a cache server" and the sources that actually did the work — including the
 * volunteer who hand-timed the file — go unnamed.
 */
function creditFor(app: App, key: string, document: MergedDocument): string {
  const label = (id: string): string => {
    const contributed = id.startsWith('app:');
    const provider = providerById(contributed ? id.slice(4) : id);
    const name = provider?.label ?? id;
    return contributed ? `${name} (via the app)` : name;
  };

  const provenance = document.provenance;
  let credit = label(provenance.timing);

  // The archived note is where a provider recorded something worth passing on, which for the
  // community database is the name of the person who timed it.
  const note = app.store.getRaw(key).find((raw) => raw.provider === provenance.timing)?.note;
  if (note && /by /i.test(note)) credit += ` · ${note}`;

  const borrowed: string[] = [];
  for (const id of provenance.syllables) borrowed.push(`${label(id)} timings`);
  if (provenance.translation && provenance.translation !== provenance.timing) {
    borrowed.push(`${label(provenance.translation)} translation`);
  }
  if (provenance.romanization && provenance.romanization !== provenance.timing) {
    borrowed.push(`${label(provenance.romanization)} reading`);
  }
  if (provenance.background && provenance.background !== provenance.timing) {
    borrowed.push(`${label(provenance.background)} backing vocals`);
  }

  return borrowed.length > 0 ? `${credit} + ${borrowed.join(', ')}` : credit;
}

/**
 * Accepts a document the app already fetched.
 *
 * The phone can reach sources the server sometimes cannot — a region-locked endpoint, or a
 * provider the server's IP has been rate limited by — and anything it found is worth adding to
 * the archive. It goes in as another candidate and the track is re-merged, so a contributed
 * translation can end up attached to timings the server found itself.
 */
async function contribute(
  app: App,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson<{
    track?: Record<string, unknown>;
    provider?: string;
    format?: string;
    body?: string;
  }>(request);

  const track = trackFromJson(body?.track);
  if (!track || !body?.body) return send(response, 400, { error: 'need a track and a body' });

  const format = (body.format ?? '').toLowerCase();
  const contentType =
    format === 'ttml'
      ? 'application/ttml+xml'
      : format === 'json'
        ? 'application/json'
        : 'text/plain';

  // Validated with the very reader that will re-merge it later, so "accepted" and "usable"
  // cannot drift apart — the alternative is a 200 for something that is then quietly ignored
  // forever.
  const doc = reparseByFormat(body.body, contentType);
  if (!doc || doc.lines.length === 0) {
    return send(response, 400, { error: 'could not read that as lyrics' });
  }

  const key = cacheKey(track);
  // Namespaced so a contribution never overwrites what the server fetched itself, and so it
  // is obvious in the admin page where a line came from.
  const provider = `app:${(body.provider ?? 'unknown').replace(/[^\w-]/g, '')}`;
  app.store.putRaw({
    key,
    provider,
    body: body.body,
    contentType,
    ok: true,
    note: 'contributed by the app',
  });
  app.store.log('info', null, `contribution for ${track.artist} — ${track.title} via ${provider}`);

  const document = app.resolver.remerge(key);
  return send(response, 200, { ok: true, key, merged: Boolean(document) });
}

// ---- log tail -------------------------------------------------------------

function stream(app: App, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let lastId = 0;
  let lastRevision = '';
  // What the page was last told about a re-lookup, so the final state goes out exactly once.
  //
  // The running flag has to be part of this. Keying on `startedAt` alone never sends the end of a run
  // that was watched: while it goes, that value is already recorded, so the moment it finishes both
  // tests fail and the page is left showing a live job with its controls disabled until it is
  // reloaded.
  let lastRelookupState = '';
  const push = () => {
    const events = app.store.recentEvents(50).filter((event) => event.id > lastId);
    for (const event of events.reverse()) {
      lastId = Math.max(lastId, event.id);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Progress on a bulk re-lookup, while there is one. Sent every tick rather than only on a change:
    // a readout that stops updating is indistinguishable from a job that has stalled, and the whole
    // point of this is to be able to tell.
    const relookup = app.resolver.relookupProgress;
    const relookupState = `${relookup.startedAt}:${relookup.running}`;
    if (relookup.running || relookupState !== lastRelookupState) {
      lastRelookupState = relookupState;
      response.write(`data: ${JSON.stringify({ kind: 'relookup', ...relookup })}\n\n`);
    }

    // And whether the library changed, so the page can refresh itself instead of being reloaded.
    // Sent only when the fingerprint moves: a tick that says nothing costs the browser nothing, and
    // re-fetching a table nobody changed would fight with whatever the reader was doing to it.
    const revision = app.store.cacheRevision();
    if (revision !== lastRevision) {
      const first = lastRevision === '';
      lastRevision = revision;
      // Not on the first tick. The page has just loaded the library itself; telling it to do so again
      // immediately would be a wasted round trip on every connection.
      if (!first) response.write(`data: ${JSON.stringify({ kind: 'cache', revision })}\n\n`);
    }
  };

  // Polling the table rather than wiring an emitter through everything: the log is already
  // in SQLite, and a personal server's log does not need sub-second latency.
  push();
  const timer = setInterval(push, 1_000);
  const stop = () => {
    clearInterval(timer);
    response.end();
  };
  request.on('close', stop);
  request.on('error', stop);
}

// ---- helpers --------------------------------------------------------------

function health(app: App) {
  const config = app.settings.read();
  return {
    ok: true,
    mergeVersion: MERGE_VERSION,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      enabled: config.providers[provider.id]?.enabled ?? false,
      configured: provider.isConfigured(config),
      wordLevel: provider.wordLevel,
    })),
    cache: app.store.stats(),
  };
}

/**
 * What this server can currently do, source by source.
 *
 * The app has its own version of this for the sources it reaches directly, and it is the most
 * useful thing in its developer menu: a source switched off, one whose token has expired, and one
 * that answered and found nothing are indistinguishable from the lyrics screen. Pointing the app
 * at a server moves every one of those failures out of its reach — so the server has to be able
 * to answer the same question about itself.
 *
 * Asked in parallel, with the same `test` the admin page uses. No credential is returned, only
 * whether one works: the app may know that Apple's token has expired, not what it was.
 */
async function status(app: App, response: ServerResponse): Promise<void> {
  const config = app.settings.read();
  const started = performance.now();

  const sources = await Promise.all(
    PROVIDERS.map(async (provider) => {
      const named = { id: provider.id, name: provider.label };
      if (config.providers[provider.id]?.enabled === false) {
        return { ...named, ok: false, detail: 'Off on the server' };
      }
      if (!provider.isConfigured(config)) {
        return { ...named, ok: false, detail: `Needs ${provider.requires.join(' and ')}` };
      }

      try {
        const result = await provider.test({
          config,
          log: (level, message) => app.store.log(level, provider.id, redact(message)),
          unreachable: (detail) => app.store.log('warn', provider.id, redact(detail)),
          learn: () => undefined,
        });
        return { ...named, ok: result.ok, ms: result.ms, detail: redact(result.detail ?? '') };
      } catch (error) {
        return {
          ...named,
          ok: false,
          detail: redact(error instanceof Error ? error.message : 'the test threw'),
        };
      }
    }),
  );

  send(response, 200, {
    ok: sources.some((source) => source.ok),
    ms: Math.round(performance.now() - started),
    mergeVersion: MERGE_VERSION,
    cache: app.store.stats(),
    sources,
  });
}

function describeProvider(app: App) {
  const config = app.settings.read();
  return (provider: (typeof PROVIDERS)[number]) => ({
    id: provider.id,
    label: provider.label,
    description: provider.description,
    requires: provider.requires,
    wordLevel: provider.wordLevel,
    configured: provider.isConfigured(config),
    enabled: config.providers[provider.id]?.enabled ?? false,
    priority: config.providers[provider.id]?.priority ?? 99,
  });
}

function trackFromParams(params: URLSearchParams): TrackQuery | null {
  const title = (params.get('title') ?? '').trim();
  if (!title) return null;
  return {
    title,
    artist: (params.get('artist') ?? '').trim(),
    album: (params.get('album') ?? '').trim(),
    durationMs: Number.parseInt(params.get('durationMs') ?? '0', 10) || 0,
    spotifyId: params.get('spotifyId')?.trim() || undefined,
    isrc: params.get('isrc')?.trim() || undefined,
  };
}

/**
 * Artwork and tempo for a track, if some token has ever reported them here.
 *
 * The point of holding these: a Spotify access token lasts an hour and an Apple developer token
 * a few months, but a cover URL and a tempo, once known, are true forever. A phone with no
 * token can still be told what one found.
 */
function readExtras(app: App, url: URL, response: ServerResponse): void {
  const track = trackFromParams(url.searchParams);
  if (!track) return void send(response, 400, { error: 'need at least a title' });

  const found = app.store.extras(cacheKey(track));
  if (!found) return void send(response, 404, { error: 'nothing held for this track' });

  send(response, 200, {
    coverUrl: found.coverUrl ?? undefined,
    artistImageUrl: found.artistImageUrl ?? undefined,
    tempo: found.tempo ?? undefined,
    palette: found.palette ?? undefined,
    analysis: found.analysis ?? undefined,
    metadata: found.metadata ?? undefined,
    // Identity lives on the cache entry rather than here, because the matcher is what needs
    // it — but a caller asking about a track may as well be told.
    isrc: app.store.isrcFor(cacheKey(track)) ?? undefined,
    source: found.source || undefined,
  });
}

function trackFromJson(body: unknown): TrackQuery | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const title = String(record.title ?? '').trim();
  if (!title) return null;
  return {
    title,
    artist: String(record.artist ?? '').trim(),
    album: String(record.album ?? '').trim(),
    durationMs: Number(record.durationMs ?? 0) || 0,
    spotifyId: record.spotifyId ? String(record.spotifyId) : undefined,
    isrc: record.isrc ? String(record.isrc) : undefined,
  };
}

/**
 * Two different questions, so two different answers.
 *
 * `/admin` is the only surface that can read a credential, and it always wants the key or a
 * session. `/v1` can only cause lyric lookups, and the app that calls it is designed to send
 * no authentication at all — so a request arriving from this machine or the local network is
 * allowed through, which is what makes the app work as written without leaving the tokens or a
 * public deployment open. See `allowLocalNetwork` for the reverse-proxy caveat.
 */
function isAuthorised(app: App, request: IncomingMessage, route: string): boolean {
  const header = request.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return matchesApiKey(app, header.slice(7).trim());
  }

  const token = cookie(request, 'bls_session');
  if (token) {
    const expiry = sessions.get(token);
    if (expiry && expiry >= Date.now()) return true;
    if (expiry) sessions.delete(token);
  }

  if (LOCAL_ROUTES.has(route) && app.settings.read().allowLocalNetwork) {
    // A forwarded request's socket belongs to whatever forwarded it, not to the client. Behind
    // kamal-proxy, nginx or a Cloudflare tunnel that socket is on the Docker bridge or
    // loopback — so without this check the "local network" exception would let the entire
    // internet through. The header cannot be trusted to say *who* the client is, but its mere
    // presence is enough to know the socket does not.
    if (request.headers['x-forwarded-for'] ?? request.headers.forwarded) return false;
    return isLocalAddress(request.socket.remoteAddress);
  }
  return false;
}

/**
 * The routes the local network may use without a key.
 *
 * An allowlist rather than a `/v1/` prefix, and by method rather than by path, because the
 * things under that prefix are not alike: a lookup reads, and a `POST` writes something other
 * clients will later be served. A blanket exception let anything on the Wi-Fi persist arbitrary
 * lyrics into the merge — or, once extras existed, name any URL on the internet as a track's
 * cover art. Both are more than the app needs and more than the documentation promised.
 *
 * `POST /v1/warm` is the exception that proves the rule: it accepts no content, only a track to
 * go and look up, so it is a read that happens to populate the cache.
 */
/** The library's sort and filter options: the single definition the route validates against. */
const LIBRARY_SORTS = ['song', 'recent', 'hits', 'lines', 'added'] as const;
const LIBRARY_MISSING = [
  'lyrics',
  'extras',
  'syllables',
  'translation',
  'isrc',
  'analysis',
] as const;

const LOCAL_ROUTES = new Set([
  'GET /v1/lyrics',
  'GET /v1/health',
  'GET /v1/extras',
  'GET /v1/status',
  'POST /v1/warm',
]);

/**
 * Whether the connecting socket is this machine or the private network.
 *
 * The socket's own address, never a header: `X-Forwarded-For` is whatever the client says it
 * is, and trusting it here would turn the whole check into a formality.
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4 over a dual-stack socket as ::ffff:192.168.1.5.
  const host = address.replace(/^::ffff:/i, '').toLowerCase();

  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;

  const octets = host.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

/** Constant-time, so a wrong key cannot be found one character at a time. */
function matchesApiKey(app: App, offered: string): boolean {
  const expected = app.settings.read().apiKey;
  if (!expected || !offered) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(offered);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readJson<T>(request: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A contributed TTML file is the largest thing anyone posts here; a megabyte is a
    // generous ceiling and stops an accident filling memory.
    if (size > 1_000_000) return null;
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(response: ServerResponse, name: string): Promise<void> {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ADMIN_DIR, safe));
    response.writeHead(200, {
      'Content-Type': MIME[extname(safe)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    send(response, 404, { error: 'not found' });
  }
}
