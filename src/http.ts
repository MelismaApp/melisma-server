/**
 * Outbound HTTP, with manners.
 *
 * Most of what this server talks to is somebody's donated time and bandwidth: LRCLIB is
 * community-run and asks people not to hammer it, the AMLL API is one volunteer's server,
 * and NetEase and Musixmatch are being used through endpoints they never published. So every
 * request is serialised per host behind a minimum interval, and a 429 backs off for real
 * rather than being retried immediately.
 *
 * This is also the only place that touches the network, which makes it the only place that
 * has to remember not to log a token.
 */

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  timeoutMs?: number;
  /** Sent as a Cookie header. Never logged. */
  cookie?: string;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  /** Round-trip time, for the admin page's connection test. */
  ms: number;
  error?: string;
}

const USER_AGENT =
  'BetterLyricsServer/0.1 (personal cache; https://github.com/MangoTornado/better-lyrics-server)';

/** Politeness per host: one request at a time, with a floor on the gap between them. */
const MIN_INTERVAL_MS: Record<string, number> = {
  'lrclib.net': 350,
  'api.amll.dev': 350,
  'music.163.com': 250,
  'apic-desktop.musixmatch.com': 500,
  'amp-api.music.apple.com': 200,
  'spclient.wg.spotify.com': 200,
  'open.spotify.com': 200,
};

const DEFAULT_INTERVAL_MS = 150;

const queues = new Map<string, Promise<unknown>>();
const lastRequestAt = new Map<string, number>();
const backoffUntil = new Map<string, number>();

export async function request(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const host = hostOf(url);
  // Chain onto whatever is already queued for this host, so two lookups for the same track
  // do not race each other into a rate limit.
  const previous = queues.get(host) ?? Promise.resolve();
  const attempt = previous.then(() => run(host, url, options));
  queues.set(
    host,
    attempt.catch(() => undefined),
  );
  return attempt;
}

async function run(host: string, url: string, options: FetchOptions): Promise<FetchResult> {
  const now = Date.now();

  const blockedUntil = backoffUntil.get(host) ?? 0;
  if (blockedUntil > now) {
    return {
      ok: false,
      status: 429,
      body: '',
      contentType: '',
      ms: 0,
      error: `backing off for another ${Math.ceil((blockedUntil - now) / 1000)}s`,
    };
  }

  const interval = MIN_INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS;
  const since = now - (lastRequestAt.get(host) ?? 0);
  if (since < interval) await sleep(interval - since);
  lastRequestAt.set(host, Date.now());

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en',
    ...options.headers,
  };
  if (options.cookie) headers.Cookie = options.cookie;

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await response.text();
    const ms = Math.round(performance.now() - started);

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000;
      backoffUntil.set(host, Date.now() + waitMs);
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
      contentType: response.headers.get('content-type') ?? '',
      ms,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: '',
      contentType: '',
      ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function json<T>(url: string, options: FetchOptions = {}): Promise<{
  value: T | null;
  result: FetchResult;
}> {
  const result = await request(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  if (!result.ok || !result.body) return { value: null, result };
  try {
    return { value: JSON.parse(result.body) as T, result };
  } catch {
    return { value: null, result: { ...result, ok: false, error: 'response was not JSON' } };
  }
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strips anything token-shaped out of a string bound for the log.
 *
 * The log is shown in a browser and kept on disk, and provider errors have a habit of
 * quoting the request back at you.
 */
export function redact(message: string): string {
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1[redacted]')
    .replace(/(sp_dc=)[^;\s]+/gi, '$1[redacted]')
    .replace(/(media-user-token[=:]\s*)[^;\s&]+/gi, '$1[redacted]')
    .replace(/(usertoken=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(eyJ[A-Za-z0-9._-]{20,})/g, '[jwt]');
}
