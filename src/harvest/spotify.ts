/**
 * Getting a fresh Spotify web token, with a browser.
 *
 * Spotify closed the endpoint that traded an `sp_dc` cookie for an access token — it answers `400
 * usage of this endpoint is not permitted under the Spotify Developer Terms`, cookie or no cookie.
 * The token the web player itself uses still works on everything this server reads, and it lasts
 * about an hour.
 *
 * So the only way to mint one is to be the player: load open.spotify.com with the cookie, and read
 * the `Authorization` header off the requests it makes to its own API. Nothing is bypassed or
 * defeated — it signs in as the operator, with the operator's own cookie, and takes a header their
 * browser would have received anyway.
 *
 * **A cookie, not a password.** `sp_dc` still authenticates the player even though it can no longer
 * be traded for a token, so no password is stored anywhere and there is no login form for
 * two-factor auth or a CAPTCHA to interrupt. That is the difference between a job that runs for a
 * year and one that breaks the first time Spotify shows a challenge. The cookie lasts about a year;
 * when it expires, paste a new one.
 */

import { Browser, findChromium, type CdpEvent } from './cdp.ts';

export interface HarvestResult {
  token: string | null;
  /** What happened, in terms the admin page can show. */
  detail: string;
}

/** Below this a bearer is one of the anonymous tokens handed out before sign-in. */
const MIN_TOKEN_LENGTH = 100;

export function chromiumAvailable(): boolean {
  return findChromium() !== null;
}

export async function harvestSpotifyToken(
  spDcCookie: string,
  options: { timeoutMs?: number } = {},
): Promise<HarvestResult> {
  const cookie = spDcCookie.trim();
  if (!cookie) return { token: null, detail: 'no sp_dc cookie is set' };
  if (!chromiumAvailable()) {
    return { token: null, detail: 'no Chromium in this image — set BL_CHROMIUM to its path' };
  }

  const timeoutMs = options.timeoutMs ?? 90_000;
  let browser: Browser | null = null;

  try {
    browser = await Browser.open({ timeoutMs });

    // Watch requests rather than trying to read the token out of the page. It appears as a header
    // on the player's first authenticated call, long before the interface finishes rendering, and
    // it is never written anywhere a script could reach.
    let token: string | null = null;
    let sawAnyBearer = false;

    browser.on((event: CdpEvent) => {
      if (event.method !== 'Network.requestWillBeSent') return;
      const request = event.params.request as
        | { url?: string; headers?: Record<string, string> }
        | undefined;
      const url = request?.url ?? '';
      if (!url.includes('spotify.com')) return;

      // Header names are not case-normalised in the protocol.
      const auth = Object.entries(request?.headers ?? {}).find(
        ([name]) => name.toLowerCase() === 'authorization',
      )?.[1];
      if (!auth?.startsWith('Bearer ')) return;

      sawAnyBearer = true;
      const value = auth.slice(7).trim();
      if (value.length >= MIN_TOKEN_LENGTH) token ??= value;
    });

    await browser.send('Network.enable');
    await browser.send('Page.enable');

    // Set on `.spotify.com` so it is sent to both the accounts host and the player.
    await browser.send('Network.setCookie', {
      name: 'sp_dc',
      value: cookie,
      domain: '.spotify.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    });

    await browser.send('Page.navigate', { url: 'https://open.spotify.com/' });

    // The token shows up within a second or two of the page loading. Poll rather than wait on a
    // load event: the interesting moment is a request, and requests start before load fires.
    const deadline = Date.now() + Math.min(timeoutMs, 45_000);
    while (!token && Date.now() < deadline) {
      await sleep(250);
    }

    if (token) {
      return { token, detail: `harvested a token of ${token.length} characters` };
    }
    if (sawAnyBearer) {
      // Short tokens only: the player loaded, but as a logged-out visitor.
      return {
        token: null,
        detail:
          'the player loaded but only issued an anonymous token — the sp_dc cookie has expired, ' +
          'so copy a fresh one from a signed-in browser',
      };
    }
    return {
      token: null,
      detail: 'the player made no authenticated request — it may not have loaded at all',
    };
  } catch (error) {
    return { token: null, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    browser?.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
