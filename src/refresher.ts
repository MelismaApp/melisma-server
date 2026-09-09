/**
 * Keeping the short-lived tokens alive.
 *
 * Spotify closed the endpoint that turned an `sp_dc` cookie into an access token — it answers `400
 * usage of this endpoint is not permitted under the Spotify Developer Terms`. What still works is a
 * bearer copied out of the web player, and that is good for about an hour. Apple's
 * `media-user-token` dies with a browser session. Neither can be renewed by asking politely.
 *
 * So the only thing that renews them is a browser doing what a browser does: sign in, load the
 * player, and read the `Authorization` header off its own network traffic. **That browser is in this
 * image**, and the server drives it over the DevTools protocol — one deployment, nothing to point
 * at, no second container to keep in step.
 *
 * Two mechanisms, in this order:
 *
 * 1. **`BL_TOKEN_REFRESH_COMMAND`**, if set. An external command whose stdout is JSON of secret
 *    name to value. The escape hatch: it can renew anything, including tokens this server knows
 *    nothing about, and it is how a browser running somewhere else would report in.
 * 2. **The built-in harvest**, when an `sp_dc` cookie is set and a Chromium is present. Needs no
 *    configuration beyond the cookie.
 *
 * A cookie rather than a password, deliberately. `sp_dc` still authenticates the *player* even
 * though it can no longer be traded for a token, so nothing here stores a password and there is no
 * login form for two-factor auth or a CAPTCHA to interrupt — which is the difference between a job
 * that runs for a year and one that breaks the first time Spotify shows a challenge.
 *
 * The command comes from the environment and **cannot be set through the admin API**. An admin
 * session should not be able to choose what the host executes; that turns one stolen key into
 * arbitrary code on the machine holding the credentials.
 */

import { execFile } from 'node:child_process';

import { SECRET_NAMES, type SecretName, type Settings } from './config.ts';
import { chromiumAvailable, harvestSpotifyToken } from './browser/spotify.ts';
import { redact } from './http.ts';
import type { Store } from './db.ts';

export interface RefreshOutcome {
  ok: boolean;
  at: number;
  ms: number;
  /** Which secrets came back with a new value. */
  updated: SecretName[];
  detail: string;
  /** Which mechanism ran. */
  via: 'command' | 'browser' | 'none';
}

/** Whatever a refresh produced, keyed by secret name. Unknown keys are ignored. */
type RefreshPayload = Partial<Record<SecretName, string>>;

const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * How far ahead of a stated expiry to renew.
 *
 * Five minutes, comfortably longer than a browser launch takes. Renewing at the moment of expiry
 * would leave every request during that launch using a token that has already died.
 */
const RENEW_MARGIN_MS = 5 * 60_000;

/**
 * The soonest the schedule will fire again.
 *
 * A token that arrives already inside the margin — or a clock that disagrees — must not turn the
 * schedule into a browser launch every few seconds.
 */
const MIN_DELAY_MS = 60_000;

/**
 * When to renew next, given what the token said and the configured ceiling.
 *
 * A free function because the arithmetic is where the edge cases are — an expiry already past, one
 * further out than the ceiling, one so close that the margin would ask for a negative delay — and
 * every one of them is a question about numbers rather than about timers or browsers.
 *
 * The ceiling still applies. It is no longer the whole schedule, but it bounds how long the server
 * can go without looking when nothing stated an expiry, which is the case for a refresh command that
 * reports only a token.
 */
export function nextDelayMs(
  expiresAt: number | null,
  ceilingMs: number,
  now: number = Date.now(),
): number {
  if (expiresAt === null) return ceilingMs;
  const ahead = expiresAt - RENEW_MARGIN_MS - now;
  return Math.min(ceilingMs, Math.max(MIN_DELAY_MS, ahead));
}

export class Refresher {
  private readonly store: Store;
  private readonly settings: Settings;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: RefreshOutcome | null = null;

  /**
   * When the token in hand expires, as the player stated it. Null when nothing said.
   *
   * The schedule was a fixed interval against a lifetime this file assumed was an hour. A live token
   * was measured at 29 minutes, so the default fifty-minute cycle spent about twenty minutes of every
   * hour serving a token that had already died — and the fix is not a smaller constant, it is
   * reading the number the player already provides.
   */
  private tokenExpiresAt: number | null = null;

  constructor(store: Store, settings: Settings) {
    this.store = store;
    this.settings = settings;
  }

  /** The command, or null when none is configured. Environment only, never settings. */
  get command(): string | null {
    return process.env.BL_TOKEN_REFRESH_COMMAND?.trim() || null;
  }

  /**
   * How a refresh would happen right now, if one were asked for.
   *
   * The command wins when it exists: somebody who set it meant it, and it can renew things the
   * built-in harvest knows nothing about.
   */
  get mechanism(): 'command' | 'browser' | 'none' {
    if (this.command) return 'command';
    const hasCookie = Boolean(this.settings.read().secrets.spDcCookie?.trim());
    return hasCookie && chromiumAvailable() ? 'browser' : 'none';
  }

  /** Why nothing would run, in the terms the operator can act on. */
  get unavailableReason(): string | null {
    if (this.mechanism !== 'none') return null;
    if (!chromiumAvailable()) {
      return 'no Chromium in this image, and no BL_TOKEN_REFRESH_COMMAND set';
    }
    return 'no sp_dc cookie set — paste one and the browser can renew the token by itself';
  }

  get lastOutcome(): RefreshOutcome | null {
    return this.last;
  }

  /**
   * Starts the schedule.
   *
   * Runs once at boot, because a container that has just started is exactly when a token is most
   * likely to be stale — it may have been down for a day. Then on the interval, which defaults to
   * fifty minutes: comfortably inside an hour, and not so tight that a slow browser overlaps the
   * next run.
   */
  start(): void {
    const minutes = Math.max(5, this.settings.read().tokenRefreshMinutes);

    // The timer is installed whether or not anything can run yet, and each tick decides for
    // itself. The documented setup is "boot the server, then paste a cookie into the admin page" —
    // and returning early on a cookie-less boot meant that flow never scheduled anything. The
    // status said "browser", a manual run worked, and the token then quietly expired an hour later.
    if (this.mechanism === 'none') {
      this.store.log(
        'info',
        null,
        `token refresh armed for at most every ${minutes} min — ${this.unavailableReason}`,
      );
    } else {
      this.store.log(
        'info',
        null,
        `token refresh at most every ${minutes} min via the ${this.mechanism}, ` +
          'and sooner when a token says it expires before then',
      );
      void this.run('boot');
    }

    this.schedule();
  }

  /**
   * Arms the next run: five minutes before the token expires, or the configured interval.
   *
   * A self-rescheduling timeout rather than a fixed interval, because the right moment is a property
   * of the token in hand and is only known once one has been fetched. The interval is the ceiling —
   * it still bounds how long the server can go without checking when nothing stated an expiry.
   */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);

    const delay = this.nextDelayMs();
    this.timer = setTimeout(() => {
      // Silent when there is still nothing to do: a log line every interval saying the same thing
      // is noise that hides the line that matters. It still re-arms, so pasting a cookie later
      // starts working without a restart.
      if (this.mechanism === 'none') {
        this.schedule();
        return;
      }
      void this.run('schedule');
    }, delay);
    // The timer must not be the reason the process cannot exit.
    this.timer.unref?.();
  }

  private nextDelayMs(): number {
    return nextDelayMs(
      this.tokenExpiresAt,
      Math.max(5, this.settings.read().tokenRefreshMinutes) * 60_000,
    );
  }

  /** When the next scheduled refresh is due, for the admin page. */
  get nextRefreshAt(): number {
    return Date.now() + this.nextDelayMs();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Runs the command and stores whatever it returned.
   *
   * Never throws, and never overlaps itself: a browser launch that hangs would otherwise pile up
   * one process per interval until the host gave out.
   */
  async run(reason: 'boot' | 'schedule' | 'manual'): Promise<RefreshOutcome> {
    const via = this.mechanism;
    if (via === 'none') {
      return this.record({
        ok: false,
        at: Date.now(),
        ms: 0,
        updated: [],
        via,
        detail: this.unavailableReason ?? 'nothing is configured to refresh tokens',
      });
    }
    if (this.running) {
      // A browser launch that hangs would otherwise pile up one process per interval until the
      // host gave out.
      return this.record({
        ok: false,
        at: Date.now(),
        ms: 0,
        updated: [],
        via,
        detail: 'a refresh is already running',
      });
    }

    this.running = true;
    const started = Date.now();
    try {
      const payload =
        via === 'command'
          ? parsePayload(await this.execute(this.command!))
          : await this.harvest();

      if (!payload) {
        return this.record({
          ok: false,
          at: started,
          ms: Date.now() - started,
          updated: [],
          via,
          detail:
            via === 'command'
              ? 'the command printed nothing that looked like {"spotifyWebToken": "…"}'
              : (this.lastHarvestDetail ?? 'the browser returned no token'),
        });
      }

      const updated: SecretName[] = [];
      const current = this.settings.read().secrets;
      for (const name of SECRET_NAMES) {
        const value = payload[name]?.trim();
        if (!value || value === current[name]) continue;
        this.settings.update({ [`secret.${name}`]: value });

        // An environment variable normally outranks the stored value, which is right for a setting
        // somebody chose deliberately and wrong for a token that has just been replaced: the
        // refresh would report success while every provider carried on using the expired value
        // from boot. Dropping it here makes the freshly stored one authoritative. The deployment
        // sets `BL_SPOTIFY_WEB_TOKEN` as a starting value precisely so this happens.
        const environmentName = `BL_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
        if (process.env[environmentName]) {
          delete process.env[environmentName];
          this.store.log(
            'info',
            null,
            `${environmentName} is now stale and has been dropped in favour of the refreshed value`,
          );
        }

        updated.push(name);
      }

      const detail =
        updated.length > 0
          ? `refreshed ${updated.join(', ')} (${reason}, ${via})`
          : `ran, but every token was already current (${reason}, ${via})`;
      this.store.log('info', null, detail);
      return this.record({ ok: true, at: started, ms: Date.now() - started, updated, via, detail });
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : String(error));
      this.store.log('error', null, `token refresh failed: ${detail}`);
      return this.record({
        ok: false,
        at: started,
        ms: Date.now() - started,
        updated: [],
        via,
        detail,
      });
    } finally {
      this.running = false;
      // Re-armed from whatever this run learned, so a manual refresh moves the schedule too rather
      // than leaving the next automatic one pointed at the old token's expiry.
      this.schedule();
    }
  }

  private lastHarvestDetail: string | null = null;

  /** The built-in browser harvest. Spotify only — it is the one with a short-lived token. */
  private async harvest(): Promise<RefreshPayload | null> {
    const cookie = this.settings.read().secrets.spDcCookie ?? '';
    const result = await harvestSpotifyToken(cookie);
    this.lastHarvestDetail = result.detail;
    // Kept even when the harvest failed: a stale expiry would schedule against a token that is no
    // longer there, so forgetting it falls back to the interval, which is the right behaviour.
    this.tokenExpiresAt = result.expiresAt;
    return result.token ? { spotifyWebToken: result.token } : null;
  }

  private execute(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Through a shell on purpose: the value is a command line the operator wrote, and expecting
      // them to split it into argv would be a worse interface for no gain — they already have
      // shell access to set the variable at all.
      execFile(
        '/bin/sh',
        ['-c', command],
        {
          // A browser launch is slow, and slower on a small VM. Generous, but bounded: a hung
          // process must not hold the slot until the next interval.
          timeout: 4 * 60_000,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            const tail = String(stderr || stdout || '')
              .trim()
              .split('\n')
              .slice(-3)
              .join(' / ');
            reject(new Error(tail ? `${error.message} — ${tail}` : error.message));
            return;
          }
          resolve(String(stdout));
        },
      );
    });
  }

  private record(outcome: RefreshOutcome): RefreshOutcome {
    this.last = outcome;
    // Persisted as well as held, so the admin page can say when it last worked after a restart.
    this.store.setSetting('refresh.lastAt', String(outcome.at));
    this.store.setSetting('refresh.lastOk', outcome.ok ? '1' : '0');
    this.store.setSetting('refresh.lastDetail', outcome.detail);
    this.store.setSetting('refresh.lastVia', outcome.via);
    return outcome;
  }

  /** The last outcome, falling back to what was persisted before a restart. */
  status(): {
    configured: boolean;
    mechanism: 'command' | 'browser' | 'none';
    reason: string | null;
    command: string | null;
    chromium: boolean;
    everyMinutes: number;
    /** When the token in hand expires, as the player stated it. Null when nothing said. */
    tokenExpiresAt: number | null;
    /** When the next scheduled refresh is due. */
    nextRefreshAt: number;
    last: RefreshOutcome | null;
  } {
    const stored = this.store.allSettings();
    const last =
      this.last ??
      (stored['refresh.lastAt']
        ? {
            ok: stored['refresh.lastOk'] === '1',
            at: Number(stored['refresh.lastAt']),
            ms: 0,
            updated: [],
            via: (stored['refresh.lastVia'] as 'command' | 'browser' | 'none') ?? 'none',
            detail: stored['refresh.lastDetail'] ?? '',
          }
        : null);

    return {
      configured: this.mechanism !== 'none',
      mechanism: this.mechanism,
      reason: this.unavailableReason,
      command: this.command,
      chromium: chromiumAvailable(),
      everyMinutes: Math.max(5, this.settings.read().tokenRefreshMinutes),
      tokenExpiresAt: this.tokenExpiresAt,
      nextRefreshAt: this.nextRefreshAt,
      last,
    };
  }
}

/**
 * Finds the JSON in the command's output.
 *
 * A browser script prints its own noise — Playwright warnings, a download progress bar — so the
 * last JSON object on stdout wins rather than requiring the whole output to be clean. Demanding
 * silence from a tool that is not silent would make this fail for a reason nobody could see.
 */
export function parsePayload(stdout: string): RefreshPayload | null {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const payload: RefreshPayload = {};
      for (const name of SECRET_NAMES) {
        const value = parsed[name];
        if (typeof value === 'string' && value.trim()) payload[name] = value.trim();
      }
      if (Object.keys(payload).length > 0) return payload;
    } catch {
      /* Not this line. */
    }
  }

  // Also accept the whole output as one object, for a script that pretty-prints.
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const payload: RefreshPayload = {};
    for (const name of SECRET_NAMES) {
      const value = parsed[name];
      if (typeof value === 'string' && value.trim()) payload[name] = value.trim();
    }
    return Object.keys(payload).length > 0 ? payload : null;
  } catch {
    return null;
  }
}
