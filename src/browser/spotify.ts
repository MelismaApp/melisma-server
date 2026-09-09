/**
 * Getting a fresh Spotify web token, with a browser.
 *
 * Spotify closed the endpoint that traded an `sp_dc` cookie for an access token — it answers `400
 * usage of this endpoint is not permitted under the Spotify Developer Terms`, cookie or no cookie.
 * The token the web player itself uses still works on everything this server reads. It is short
 * lived — a live one was measured at 29 minutes, not the hour this file used to claim — and it says
 * so itself in the reply that issues it, which is why nothing here guesses at the lifetime.
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
  /**
   * When the token dies, as the player itself states it. Null when it did not say.
   *
   * Worth reading rather than assuming: a live token was measured at **29 minutes**, not the hour
   * this file used to claim, so a refresh scheduled "comfortably inside an hour" spent about twenty
   * minutes of every cycle serving a token that had already died.
   */
  expiresAt: number | null;
  /** What happened, in terms the admin page can show. */
  detail: string;
}

/**
 * A floor on what counts as a bearer at all — not a sign-in test.
 *
 * It used to be documented as the latter, "below this a bearer is one of the anonymous tokens handed
 * out before sign-in", and that is false in a way that mattered: measured against the live player an
 * anonymous token is 140 characters and a signed-in one 403, so every anonymous token cleared this
 * bar and was returned as a success. The player states the answer itself; see {@link TokenPayload}.
 */
const MIN_TOKEN_LENGTH = 100;

/** What the player's `/api/token` reply says about the session it just got. */
export interface TokenPayload {
  anonymous: boolean | null;
  token: string | null;
  expiresAt: number | null;
}

/**
 * Exported for the tests: the browser cannot be driven in a unit test, but this is where the expiry
 * and the signed-in flag are actually read, so it is the part worth pinning against a real reply.
 */
export function parseTokenReply(body: string): TokenPayload | null {
  try {
    const root = JSON.parse(body) as Record<string, unknown>;
    const token = typeof root.accessToken === 'string' ? root.accessToken.trim() : '';
    const stated =
      typeof root.accessTokenExpirationTimestampMs === 'number'
        ? root.accessTokenExpirationTimestampMs
        : null;
    return {
      anonymous: typeof root.isAnonymous === 'boolean' ? root.isAnonymous : null,
      token: token || null,
      // A timestamp already past is a clock skew or a bug rather than an expiry, and taking it
      // would discard a token that has just arrived and works.
      expiresAt: stated !== null && stated > Date.now() ? stated : null,
    };
  } catch {
    return null;
  }
}

/** Reads a response body, or null when it is not there to be read. */
async function readBody(browser: Browser, requestId: string): Promise<string | null> {
  try {
    const result = await browser.send('Network.getResponseBody', { requestId });
    return typeof result.body === 'string' ? result.body : null;
  } catch {
    return null;
  }
}

export function chromiumAvailable(): boolean {
  return findChromium() !== null;
}

export async function harvestSpotifyToken(
  spDcCookie: string,
  options: { timeoutMs?: number } = {},
): Promise<HarvestResult> {
  const cookie = spDcCookie.trim();
  if (!cookie) return { token: null, expiresAt: null, detail: 'no sp_dc cookie is set' };
  if (!chromiumAvailable()) {
    return {
      token: null,
      expiresAt: null,
      detail: 'no Chromium in this image — set BL_CHROMIUM to its path',
    };
  }

  const timeoutMs = options.timeoutMs ?? 90_000;
  let browser: Browser | null = null;

  try {
    browser = await Browser.open({ timeoutMs });

    // Two things are watched. The `Authorization` header on the player's own calls, which is the
    // token; and the reply to `/api/token`, which is the only place the player says whether it is
    // signed in and how long the token lasts. The reply is preferred — its `accessToken` is
    // byte-identical to the header, verified against the live player — and the header is the
    // fallback if the reply is never readable.
    let headerToken: string | null = null;
    let sawAnyBearer = false;
    let payload: TokenPayload | null = null;

    /** `/api/token` replies, and which of them have finished arriving. */
    const tokenReplies = new Set<string>();
    const finished = new Set<string>();
    const alreadyRead = new Set<string>();

    browser.on((event: CdpEvent) => {
      if (event.method === 'Network.requestWillBeSent') {
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
        if (value.length >= MIN_TOKEN_LENGTH) headerToken ??= value;
        return;
      }

      if (event.method === 'Network.responseReceived') {
        const response = event.params.response as { url?: string } | undefined;
        if (response?.url?.includes('/api/token')) {
          tokenReplies.add(String(event.params.requestId));
        }
        return;
      }

      // Only read a body once it is complete — asking earlier fails, and retrying on a timer would
      // be a protocol call every quarter second for nothing.
      if (event.method === 'Network.loadingFinished') {
        finished.add(String(event.params.requestId));
      }
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
    while (Date.now() < deadline) {
      for (const requestId of tokenReplies) {
        if (alreadyRead.has(requestId) || !finished.has(requestId)) continue;
        alreadyRead.add(requestId);
        const body = await readBody(browser, requestId);
        const parsed = body === null ? null : parseTokenReply(body);
        // Prefer a reply that actually carries a token over an earlier one that did not.
        if (parsed && (!payload || (!payload.token && parsed.token))) payload = parsed;
      }

      // Signed out is a final answer, so stop rather than waiting out the timeout for a token that
      // would be refused anyway.
      if (payload?.anonymous === true) break;
      if (payload?.token) break;
      await sleep(250);
    }

    if (payload?.anonymous === true) {
      return {
        token: null,
        expiresAt: null,
        detail:
          'the player loaded but was not signed in, so its token cannot read lyrics — the sp_dc ' +
          'cookie is expired or wrong, so copy a fresh one from a signed-in browser',
      };
    }

    if (payload?.token) {
      const minutes =
        payload.expiresAt === null ? null : Math.round((payload.expiresAt - Date.now()) / 60_000);
      return {
        token: payload.token,
        expiresAt: payload.expiresAt,
        detail:
          `harvested a signed-in token of ${payload.token.length} characters` +
          (minutes === null ? ', with no stated expiry' : `, good for ${minutes} min`),
      };
    }

    if (headerToken) {
      // The header without the reply. Usable, but nothing said when it dies or whether the session
      // is signed in — so the refresher falls back to its interval.
      return {
        token: headerToken,
        expiresAt: null,
        detail:
          `harvested a token of ${headerToken.length} characters from the request header; the ` +
          'token reply could not be read, so its expiry is unknown',
      };
    }

    if (sawAnyBearer) {
      return {
        token: null,
        expiresAt: null,
        detail: 'the player sent a bearer too short to be a real token',
      };
    }
    return {
      token: null,
      expiresAt: null,
      detail: 'the player made no authenticated request — it may not have loaded at all',
    };
  } catch (error) {
    return {
      token: null,
      expiresAt: null,
      detail: error instanceof Error ? error.message : String(error),
    };
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
