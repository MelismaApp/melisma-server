/**
 * Keeping the short-lived tokens alive.
 *
 * Spotify closed the endpoint that turned an `sp_dc` cookie into an access token — it answers
 * `400 usage of this endpoint is not permitted under the Spotify Developer Terms`. What still
 * works is a bearer copied out of the web player, and that is good for about an hour. Apple's
 * `media-user-token` dies with a browser session. Neither can be renewed by asking politely.
 *
 * So the only thing that renews them is a browser doing what a browser does: sign in, load the
 * player, and read the `Authorization` header off its own network traffic.
 *
 * **That browser does not live here.** This module runs an external command on a schedule and
 * reads new token values off its stdout. Two reasons, and both are about cost:
 *
 * - The server has no dependencies at all — the image is `node:24-alpine` plus source. Playwright
 *   with a bundled Chromium is several hundred megabytes and a native toolchain, which is a large
 *   price for one hourly job, paid on every deploy.
 * - A browser that logs in needs a password. Keeping that out of this process, and out of this
 *   database, means a leak here is a leak of harvested tokens rather than of an account.
 *
 * `examples/refresh-spotify-token.mjs` is a working script for exactly this. Point
 * `BL_TOKEN_REFRESH_COMMAND` at it, or at anything else that prints the same JSON.
 *
 * The command comes from the environment and **cannot be set through the admin API**. An admin
 * session should not be able to choose what the host executes; that turns one stolen key into
 * arbitrary code on the machine holding the credentials.
 */

import { execFile } from 'node:child_process';

import { SECRET_NAMES, type SecretName, type Settings } from './config.ts';
import { redact } from './http.ts';
import type { Store } from './db.ts';

export interface RefreshOutcome {
  ok: boolean;
  at: number;
  ms: number;
  /** Which secrets the command returned a new value for. */
  updated: SecretName[];
  detail: string;
}

/** Whatever the command prints, keyed by secret name. Unknown keys are ignored. */
type RefreshPayload = Partial<Record<SecretName, string>>;

const MAX_OUTPUT_BYTES = 256 * 1024;

export class Refresher {
  private readonly store: Store;
  private readonly settings: Settings;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: RefreshOutcome | null = null;

  constructor(store: Store, settings: Settings) {
    this.store = store;
    this.settings = settings;
  }

  /** The command, or null when none is configured. Environment only, never settings. */
  get command(): string | null {
    return process.env.BL_TOKEN_REFRESH_COMMAND?.trim() || null;
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
    if (!this.command) return;
    const minutes = Math.max(5, this.settings.read().tokenRefreshMinutes);

    this.store.log('info', null, `token refresh every ${minutes} min`);
    void this.run('boot');

    this.timer = setInterval(
      () => {
        void this.run('schedule');
      },
      minutes * 60_000,
    );
    // The interval must not be the reason the process cannot exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Runs the command and stores whatever it returned.
   *
   * Never throws, and never overlaps itself: a browser launch that hangs would otherwise pile up
   * one process per interval until the host gave out.
   */
  async run(reason: 'boot' | 'schedule' | 'manual'): Promise<RefreshOutcome> {
    const command = this.command;
    if (!command) {
      return this.record({
        ok: false,
        at: Date.now(),
        ms: 0,
        updated: [],
        detail: 'no BL_TOKEN_REFRESH_COMMAND is set',
      });
    }
    if (this.running) {
      return this.record({
        ok: false,
        at: Date.now(),
        ms: 0,
        updated: [],
        detail: 'a refresh is already running',
      });
    }

    this.running = true;
    const started = Date.now();
    try {
      const stdout = await this.execute(command);
      const payload = parsePayload(stdout);
      if (!payload) {
        return this.record({
          ok: false,
          at: started,
          ms: Date.now() - started,
          updated: [],
          detail: 'the command printed nothing that looked like {"spotifyWebToken": "…"}',
        });
      }

      const updated: SecretName[] = [];
      const current = this.settings.read().secrets;
      for (const name of SECRET_NAMES) {
        const value = payload[name]?.trim();
        if (!value || value === current[name]) continue;
        this.settings.update({ [`secret.${name}`]: value });
        updated.push(name);
      }

      const detail =
        updated.length > 0
          ? `refreshed ${updated.join(', ')} (${reason})`
          : `ran, but every token it returned was already current (${reason})`;
      this.store.log('info', null, detail);
      return this.record({ ok: true, at: started, ms: Date.now() - started, updated, detail });
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : String(error));
      this.store.log('error', null, `token refresh failed: ${detail}`);
      return this.record({ ok: false, at: started, ms: Date.now() - started, updated: [], detail });
    } finally {
      this.running = false;
    }
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
    return outcome;
  }

  /** The last outcome, falling back to what was persisted before a restart. */
  status(): {
    configured: boolean;
    command: string | null;
    everyMinutes: number;
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
            detail: stored['refresh.lastDetail'] ?? '',
          }
        : null);

    return {
      configured: Boolean(this.command),
      command: this.command,
      everyMinutes: Math.max(5, this.settings.read().tokenRefreshMinutes),
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
