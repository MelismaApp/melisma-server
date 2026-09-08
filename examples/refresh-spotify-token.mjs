#!/usr/bin/env node
/**
 * Harvest a fresh Spotify web access token with a headless browser.
 *
 * Spotify closed the endpoint that turned an `sp_dc` cookie into an access token — it now answers
 * `400 usage of this endpoint is not permitted under the Spotify Developer Terms`. The token the
 * web player uses still works on everything the server needs, and it lasts about an hour. The only
 * thing that produces one is a browser being a browser, so: open the player, and read the
 * `Authorization` header off its own network traffic.
 *
 * **You probably do not need this.** The server carries a Chromium and does the same harvest itself
 * — paste an `sp_dc` cookie into the admin page and the token renews on a schedule, in the same
 * container, with nothing else configured. See `src/harvest/spotify.ts`.
 *
 * This exists for the cases the built-in harvest cannot cover: renewing a token from a service the
 * server knows nothing about, driving a browser on a machine with a residential IP (challenged far
 * less often than a datacenter one), or signing in with a username and password rather than a
 * cookie. It reports in through `BL_TOKEN_REFRESH_COMMAND`, which overrides the built-in path.
 *
 *   npm init -y && npm install playwright && npx playwright install chromium
 *   SPOTIFY_USERNAME=… SPOTIFY_PASSWORD=… node examples/refresh-spotify-token.mjs
 *
 * It prints one line of JSON, which is what the server reads:
 *
 *   {"spotifyWebToken":"BQD…"}
 *
 * Then point the server at it:
 *
 *   BL_TOKEN_REFRESH_COMMAND="node /path/to/refresh-spotify-token.mjs"
 *
 * **Prefer `SPOTIFY_SP_DC` to a password.** The cookie can no longer be traded for a token by
 * request, but it still authenticates the *player*, which is all this needs — and it means no
 * password anywhere and nothing for two-factor auth to interrupt. Copy it from a signed-in
 * browser; it lasts about a year. The username and password path exists for when that expires.
 *
 * ### What will break, and when
 *
 * This is automation against a login page, so it is the least durable thing in the project:
 *
 * - **Two-factor auth stops it dead.** Use `SPOTIFY_SP_DC`.
 * - **A CAPTCHA stops it dead.** Same answer. A datacenter IP is challenged far more often than a
 *   home one, so a VM will hit this sooner than a laptop.
 * - **Selectors rot.** The ones below are correct as of writing and are the first thing to check
 *   when this starts failing. `HEADED=1` opens a real window so you can watch where it stops.
 *
 * Nothing here defeats a protection: it signs in as you, with your credentials, and reads a header
 * your own browser would have received. It is also plainly automated access to a service whose
 * terms discourage it, which is a reason to run it for yourself and not on anybody else's behalf.
 */

import { chromium } from 'playwright';

const username = process.env.SPOTIFY_USERNAME;
const password = process.env.SPOTIFY_PASSWORD;
const spDc = process.env.SPOTIFY_SP_DC;
const headed = process.env.HEADED === '1';
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 90_000);

if (!spDc && !(username && password)) {
  fail('set SPOTIFY_SP_DC, or SPOTIFY_USERNAME and SPOTIFY_PASSWORD');
}

/** Everything except the one JSON line goes to stderr, so stdout stays parseable. */
const log = (...args) => console.error('[refresh]', ...args);

function fail(message) {
  console.error(`[refresh] ${message}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({
  // A desktop user agent: the mobile player is a different app with a different flow.
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
});

if (spDc) {
  await context.addCookies([
    {
      name: 'sp_dc',
      value: spDc,
      domain: '.spotify.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    },
  ]);
  log('using the sp_dc cookie');
}

const page = await context.newPage();

// The token arrives as a header on the player's own API calls, so watch requests rather than
// trying to read it out of the page. It appears on the first authenticated call, well before the
// interface has finished rendering.
let token = null;
const seen = new Set();

page.on('request', (request) => {
  const url = request.url();
  if (!/spotify\.com/.test(url)) return;
  const auth = request.headers().authorization;
  if (!auth?.startsWith('Bearer ')) return;

  const value = auth.slice(7).trim();
  // Anonymous tokens are handed out before sign-in and cannot read anything useful. The real ones
  // are long; a short one means the session was not authenticated.
  if (value.length < 100 || seen.has(value)) return;
  seen.add(value);
  token = value;
  log(`token seen on ${new URL(url).pathname}`);
});

try {
  log('opening the player');
  await page.goto('https://open.spotify.com/', {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });

  if (!spDc) {
    log('signing in');
    await page.goto('https://accounts.spotify.com/en/login', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Correct as of writing; the first thing to check when this breaks.
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-button');

    await page.waitForURL(/open\.spotify\.com/, { timeout: timeoutMs }).catch(() => {
      // Landing anywhere else almost always means a challenge rather than a wrong password.
      throw new Error(
        `sign-in did not reach the player — currently at ${page.url()}. ` +
          'A CAPTCHA or a two-factor prompt looks exactly like this; use SPOTIFY_SP_DC instead.',
      );
    });
  }

  // Any signed-in page will do; the player's home makes authenticated calls immediately.
  await page.goto('https://open.spotify.com/', { waitUntil: 'load', timeout: timeoutMs });

  const deadline = Date.now() + 30_000;
  while (!token && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  if (!token) {
    throw new Error(
      'no bearer token appeared. If the player showed a logged-out home page, the cookie has ' +
        'expired — copy a fresh sp_dc from a signed-in browser.',
    );
  }

  // The one line the server reads. Everything else went to stderr.
  console.log(JSON.stringify({ spotifyWebToken: token }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
