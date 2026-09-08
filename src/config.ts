/**
 * Configuration, held in the database rather than a file so the admin page can change it
 * without a restart.
 *
 * Secrets are the whole reason this server exists — it holds the Apple tokens the phone
 * cannot safely carry — so they get specific treatment: they are never included in a normal
 * settings response, only a masked preview and a "this is set" flag. Reading one back in
 * full takes a separate, explicit request. That is not real security (the process can read
 * them, and so can anyone with the file) but it stops a token being splashed across a
 * screenshot or a browser cache, which is the realistic way a personal server leaks one.
 */

import type { Store } from './db.ts';

export interface ProviderSetting {
  enabled: boolean;
  /** Lower is more trusted. Breaks ties when two sources are equally precise. */
  priority: number;
}

export interface Config {
  /** Required on every /v1 request. Generated on first boot if unset. */
  apiKey: string;
  host: string;
  port: number;

  /** Language the merge should prefer for translations, as a BCP-47 prefix. */
  translationLang: string;
  /** How long to trust "no lyrics exist" before asking again. */
  negativeTtlHours: number;
  /** How long before a found document is re-fetched to pick up newly added sources. */
  refreshDays: number;

  providers: Record<string, ProviderSetting>;

  lrclibBaseUrl: string;
  neteaseBaseUrl: string;
  amllBaseUrl: string;
  appleApiBase: string;
  appleStorefront: string;

  secrets: Record<SecretName, string>;
}

export const SECRET_NAMES = [
  'spDcCookie',
  'musixmatchUserToken',
  'neteaseCookie',
  'appleBearerToken',
  'appleMediaUserToken',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Everything on by default, because a source with no credentials is skipped rather than
 * queried — so leaving Apple and Spotify enabled costs nothing and means pasting a token is
 * the only step. Priority is trust, not order of attempt: they are all asked at once.
 *
 * Apple leads because when it answers it answers with everything, and it is the source the
 * phone cannot reach on its own. That is the reason this server exists.
 */
export const PROVIDER_DEFAULTS: Record<string, ProviderSetting> = {
  apple: { enabled: true, priority: 0 },
  amll: { enabled: true, priority: 1 },
  netease: { enabled: true, priority: 2 },
  musixmatch: { enabled: true, priority: 3 },
  spotify: { enabled: true, priority: 4 },
  lrclib: { enabled: true, priority: 5 },
};

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  translationLang: 'en',
  negativeTtlHours: 48,
  refreshDays: 30,
  lrclibBaseUrl: 'https://lrclib.net',
  neteaseBaseUrl: 'https://music.163.com',
  amllBaseUrl: 'https://api.amll.dev',
  appleApiBase: 'https://amp-api.music.apple.com',
  appleStorefront: 'us',
};

export class Settings {
  // Written out rather than a constructor parameter property: Node runs this TypeScript by
  // stripping the types, which means no syntax that would have to generate code.
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * The current configuration.
   *
   * Environment variables win over stored values, so a container or a launch script can
   * override anything without touching the database.
   */
  read(): Config {
    const raw = this.store.allSettings();
    const value = (key: string, envKey: string): string | undefined =>
      process.env[envKey] ?? raw[key];

    const providers: Record<string, ProviderSetting> = {};
    for (const [id, fallback] of Object.entries(PROVIDER_DEFAULTS)) {
      providers[id] = {
        enabled: bool(raw[`provider.${id}.enabled`], fallback.enabled),
        priority: int(raw[`provider.${id}.priority`], fallback.priority),
      };
    }

    const secrets = {} as Record<SecretName, string>;
    for (const name of SECRET_NAMES) {
      secrets[name] = value(`secret.${name}`, `BL_${screamingSnake(name)}`) ?? '';
    }

    return {
      apiKey: value('server.apiKey', 'BL_API_KEY') ?? '',
      host: value('server.host', 'BL_HOST') ?? DEFAULTS.host,
      port: int(value('server.port', 'BL_PORT'), DEFAULTS.port),

      translationLang: value('merge.translationLang', 'BL_TRANSLATION_LANG') ?? DEFAULTS.translationLang,
      negativeTtlHours: int(raw['cache.negativeTtlHours'], DEFAULTS.negativeTtlHours),
      refreshDays: int(raw['cache.refreshDays'], DEFAULTS.refreshDays),

      providers,

      lrclibBaseUrl: trimSlash(value('endpoint.lrclib', 'BL_LRCLIB_URL') ?? DEFAULTS.lrclibBaseUrl),
      neteaseBaseUrl: trimSlash(value('endpoint.netease', 'BL_NETEASE_URL') ?? DEFAULTS.neteaseBaseUrl),
      amllBaseUrl: trimSlash(value('endpoint.amll', 'BL_AMLL_URL') ?? DEFAULTS.amllBaseUrl),
      appleApiBase: trimSlash(value('endpoint.apple', 'BL_APPLE_API') ?? DEFAULTS.appleApiBase),
      appleStorefront: (value('endpoint.appleStorefront', 'BL_APPLE_STOREFRONT') ?? DEFAULTS.appleStorefront)
        .toLowerCase(),

      secrets,
    };
  }

  /** Mints and stores an API key. Called once, on first boot. */
  ensureApiKey(): string {
    const existing = this.read().apiKey;
    if (existing) return existing;
    const key = randomKey();
    this.store.setSetting('server.apiKey', key);
    this.store.log('info', null, 'generated a new API key');
    return key;
  }

  update(patch: Record<string, string | null>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (!isWritable(key)) continue;
      this.store.setSetting(key, value === null ? null : String(value).trim());
    }
  }

  /**
   * The configuration as the admin page should see it: everything except the secrets
   * themselves, which appear as a length and a last-four preview.
   */
  redacted(): Record<string, unknown> {
    const config = this.read();
    const secrets: Record<string, { set: boolean; preview: string; fromEnv: boolean }> = {};
    for (const name of SECRET_NAMES) {
      const value = config.secrets[name];
      secrets[name] = {
        set: value.length > 0,
        preview: mask(value),
        fromEnv: Boolean(process.env[`BL_${screamingSnake(name)}`]),
      };
    }
    return { ...config, apiKey: mask(config.apiKey), secrets };
  }

  reveal(name: SecretName): string {
    return this.read().secrets[name] ?? '';
  }
}

/** Shows enough to recognise a value without showing enough to use it. */
export function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(24, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Which settings keys the admin page may write.
 *
 * An allowlist by shape rather than a denylist, because the alternative is an endpoint that
 * lets a stray request write anything into the settings table.
 */
function isWritable(key: string): boolean {
  if (key.startsWith('provider.')) {
    return /^provider\.[a-z]+\.(enabled|priority)$/.test(key);
  }
  if (key.startsWith('secret.')) {
    return SECRET_NAMES.some((name) => key === `secret.${name}`);
  }
  return [
    'server.apiKey',
    'server.host',
    'server.port',
    'merge.translationLang',
    'cache.negativeTtlHours',
    'cache.refreshDays',
    'endpoint.lrclib',
    'endpoint.netease',
    'endpoint.amll',
    'endpoint.apple',
    'endpoint.appleStorefront',
  ].includes(key);
}

export function randomKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function int(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function screamingSnake(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase();
}

/**
 * A JWT's expiry, without verifying it.
 *
 * The Apple token is a JWT lifted from the web player and it does expire, so the admin page
 * shows when — the difference between "the server is broken" and "paste a fresh token".
 * Nothing is trusted from this beyond a date to display.
 */
export function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
