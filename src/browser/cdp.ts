/**
 * A very small Chrome DevTools Protocol client.
 *
 * Enough to launch a headless Chromium, set a cookie, open a page and watch the requests it makes.
 * That is all the token harvest needs, and it is a fraction of what a browser-automation library
 * does — so this exists instead of one.
 *
 * The reason is the image. Playwright bundles its own Chromium and a native toolchain, several
 * hundred megabytes on top of `node:24-alpine`, and would be the server's only dependency. Node 24
 * already has a WebSocket client, and Alpine already packages Chromium, so the protocol underneath
 * is reachable directly for about two hundred lines. The server stays dependency-free and the
 * deployment stays one container.
 *
 * What is deliberately missing: selectors, waiting for elements, frames, screenshots, retries. If
 * the harvest ever needs to fill in a login form, that judgement should be revisited — a form is
 * where a real library earns its size. Signing in with a cookie needs none of it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Deletes the temporary profile, and never fails the job that was using it.
 *
 * `SIGKILL` is not synchronous. Chromium's own child processes can still be writing into the profile
 * while this walks it, and `rmSync` then throws `ENOTEMPTY` — `force` forgives a missing file, not a
 * directory that refilled itself. That exception escaped through `harvestSpotifyToken`'s `finally`
 * and turned a *successful* harvest into `token refresh failed: ENOTEMPTY`, which is the worst way to
 * lose a token you already had in hand.
 *
 * So: let Node retry the races it knows about, then try once more after the browser has finished
 * dying, then stop caring. It is a directory under `/tmp` that the host reclaims anyway — the only
 * real cost of losing it is a stale session cookie on a disk that is already trusted with the
 * database.
 */
function removeQuietly(directory: string, attempt = 0): void {
  try {
    // `maxRetries` exists for exactly this: it retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM.
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    if (attempt >= 2) return;
    const timer = setTimeout(() => removeQuietly(directory, attempt + 1), 1_000);
    // Must not hold the process open on the way out.
    timer.unref?.();
  }
}

/** Where Chromium usually is, in the order worth trying. */
const CANDIDATES = [
  process.env.BL_CHROMIUM,
  '/usr/bin/chromium-browser', // Alpine
  '/usr/bin/chromium', // Debian, Arch
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChromium(): string | null {
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A launched browser and an open protocol connection to one page in it.
 *
 * Single use: `open`, do the work, `close`. Nothing here is designed to be held across jobs — a
 * browser that lives for hours is a browser that accumulates whatever the page did to it, and an
 * hourly job has no reason to pay that.
 */
export class Browser {
  private readonly process: ChildProcess;
  private readonly profileDir: string;
  private readonly socket: WebSocket;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners: ((event: CdpEvent) => void)[] = [];
  private sessionId: string | null = null;
  private nextId = 1;
  private closed = false;

  private constructor(process: ChildProcess, profileDir: string, socket: WebSocket) {
    this.process = process;
    this.profileDir = profileDir;
    this.socket = socket;

    socket.addEventListener('message', (message) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      const id = frame.id as number | undefined;
      if (typeof id === 'number') {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        const error = frame.error as { message?: string } | undefined;
        if (error) waiter.reject(new Error(error.message ?? 'protocol error'));
        else waiter.resolve((frame.result as Record<string, unknown>) ?? {});
        return;
      }

      if (typeof frame.method === 'string') {
        const event: CdpEvent = {
          method: frame.method,
          params: (frame.params as Record<string, unknown>) ?? {},
        };
        for (const listener of this.listeners) listener(event);
      }
    });
  }

  static async open(options: { executable?: string; timeoutMs?: number } = {}): Promise<Browser> {
    const executable = options.executable ?? findChromium();
    if (!executable) throw new Error('no Chromium found — set BL_CHROMIUM to its path');

    const profileDir = mkdtempSync(join(tmpdir(), 'bls-chromium-'));
    const child = spawn(
      executable,
      [
        // Port 0 lets the kernel pick; the real one is announced on stderr.
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--headless=new',
        // Required to run headless as an unprivileged user in a container. It is the browser's own
        // sandbox being dropped, and the only page it will ever open is one we chose.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
        '--window-size=1280,800',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const cleanup = () => {
      child.kill('SIGKILL');
      removeQuietly(profileDir);
    };

    let endpoint: string;
    try {
      endpoint = await readEndpoint(child, options.timeoutMs ?? 30_000);
    } catch (error) {
      cleanup();
      throw error;
    }

    const socket = new WebSocket(endpoint);
    try {
      await once(socket, 'open', options.timeoutMs ?? 30_000);
    } catch (error) {
      cleanup();
      throw error;
    }

    const browser = new Browser(child, profileDir, socket);

    // One page, attached "flat" so its events and commands ride the same socket as the browser's
    // rather than needing a second connection.
    const target = (await browser.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId?: string;
    };
    if (!target.targetId) {
      browser.close();
      throw new Error('could not open a page');
    }
    const attached = (await browser.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (!attached.sessionId) {
      browser.close();
      throw new Error('could not attach to the page');
    }
    browser.sessionId = attached.sessionId;

    return browser;
  }

  /** Sends a command and waits for its reply. Session-scoped once a page is attached. */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('the browser is closed'));

    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method, params };
    // Target.* commands are the browser's own; everything else belongs to the page.
    if (this.sessionId && !method.startsWith('Target.')) frame.sessionId = this.sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        this.socket.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(listener: (event: CdpEvent) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error('the browser closed'));
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      /* Already gone. */
    }
    this.process.kill('SIGKILL');
    // The profile holds the session cookie that was just used. It is a temporary directory, but
    // leaving it behind would leave that on disk for no reason.
    removeQuietly(this.profileDir);
  }
}

/**
 * Reads the WebSocket endpoint Chromium announces on stderr.
 *
 * `--remote-debugging-port=0` means the port is not known in advance, and the announcement is the
 * only place it appears. Reading it is also how we find out the browser started at all — a missing
 * shared library shows up here as an error line rather than as a silent hang.
 */
function readEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Chromium did not report a debugging endpoint within ${Math.round(timeoutMs / 1000)}s` +
            (buffer.trim() ? ` — ${buffer.trim().split('\n').slice(-2).join(' / ')}` : ''),
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    const finish = (result: string | Error) => {
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match) finish(match[0]);
    });

    child.once('error', (error) => finish(error));
    child.once('exit', (code) =>
      finish(
        new Error(
          `Chromium exited with ${code} before it was ready` +
            (buffer.trim() ? ` — ${buffer.trim().split('\n').slice(-2).join(' / ')}` : ''),
        ),
      ),
    );
  });
}

function once(socket: WebSocket, event: 'open', timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the browser connection timed out')), timeoutMs);
    timer.unref?.();
    socket.addEventListener(event, () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the browser connection failed'));
    });
  });
}
