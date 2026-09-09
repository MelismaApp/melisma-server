/**
 * An app token for Spotify's public catalogue API.
 *
 * The client-credentials grant: a registered application exchanges its id and secret for a token that
 * can read the catalogue but not any user's account. Which is all the harvest wants from
 * `api.spotify.com` — the ISRC, the cover, the album metadata, none of it personal.
 *
 * ### Why this exists alongside the web-player token
 *
 * They are for different hosts and neither replaces the other.
 *
 * - `api.spotify.com` rate-limits a web-player token hard. Measured as a persistent `429 API rate
 *   limit exceeded` that survived a change of address, so the limit follows the token rather than the
 *   IP. An app token has documented quotas, which is the difference between "the ISRC arrives" and
 *   "the ISRC arrives for the tracks that happen to also be on Apple Music".
 * - `spclient.wg.spotify.com` — the lyrics and the audio analysis — does not accept an app token at
 *   all. That is the player's own service and it wants the player's own credential.
 *
 * So: app token for the catalogue, web-player token for everything else, and the harvest asks both.
 *
 * ### What an app token cannot do
 *
 * `audio-features` and `audio-analysis` were closed to applications registered after November 2024,
 * so a new app gets `403` from them however correct its credentials. The tempo therefore still comes
 * from the internal endpoint and the web-player token, and for a track Spotify never analysed it does
 * not come at all.
 */

import { json } from './http.ts';
import type { Config } from './config.ts';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/**
 * Renew this long before the stated expiry.
 *
 * The grant is good for an hour. A minute of slack costs nothing and avoids handing out a token that
 * dies between being fetched and being used.
 */
const MARGIN_MS = 60_000;

interface AppToken {
  value: string;
  expiresAt: number;
  /** Which credentials produced it, so changing them in the admin page takes effect at once. */
  clientId: string;
}

let cached: AppToken | null = null;

/** In flight, so a burst of lookups mints one token rather than one each. */
let minting: Promise<string | null> | null = null;

export interface AppTokenOutcome {
  token: string | null;
  /** What happened, for the log. Null when there was nothing to say. */
  detail: string | null;
}

export function appTokenConfigured(config: Config): boolean {
  return Boolean(config.secrets.spotifyClientId && config.secrets.spotifyClientSecret);
}

/** Forgets the cached token. For tests, and for a credential change. */
export function resetAppToken(): void {
  cached = null;
  minting = null;
}

/**
 * An app token, from the cache when one is still good.
 *
 * Returns null rather than throwing when nothing is configured: this is an optional improvement to
 * the harvest, not a requirement of it.
 */
export async function spotifyAppToken(config: Config): Promise<AppTokenOutcome> {
  const clientId = config.secrets.spotifyClientId?.trim();
  const clientSecret = config.secrets.spotifyClientSecret?.trim();
  if (!clientId || !clientSecret) return { token: null, detail: null };

  if (cached && cached.clientId === clientId && cached.expiresAt > Date.now() + MARGIN_MS) {
    return { token: cached.value, detail: null };
  }

  if (minting) return { token: await minting, detail: null };

  let detail: string | null = null;
  minting = (async () => {
    // Basic auth over the credentials, which is the form the grant specifies. Sent as a header rather
    // than in the body so the secret is not in a place anything is tempted to log.
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const result = await json<{ access_token?: string; expires_in?: number; error?: string }>(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
    );

    const value = result.value?.access_token;
    if (!value) {
      // Worth naming: a wrong secret and a rate limit are the same silence otherwise, and only one of
      // them is worth doing anything about.
      detail =
        result.result.status === 400 || result.result.status === 401
          ? 'Spotify refused the client id and secret — check them in Settings'
          : `could not get an app token from Spotify (HTTP ${result.result.status})`;
      return null;
    }

    cached = {
      value,
      clientId,
      // Spotify states the lifetime; an hour is only the usual answer, not a promise.
      expiresAt: Date.now() + (result.value?.expires_in ?? 3_600) * 1_000,
    };
    return value;
  })().finally(() => {
    minting = null;
  });

  const token = await minting;
  return { token, detail };
}
