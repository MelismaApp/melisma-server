/**
 * Musixmatch, through the token its **mobile** client issues itself.
 *
 * `richsync` is the prize here: word-by-word timing for most Western music, with no account
 * needed — the anonymous token is minted on demand and cached.
 *
 * Note the host and client id, which changed. The desktop app is discontinued and
 * `apic-desktop.musixmatch.com` with `web-desktop-app-v1.0` now answers `200` with a token of
 * fifty-six zeros; a request carrying that is *accepted* and returns lyrics for an unrelated
 * song — asking for Kenshi Yonezu's "Lemon" came back with Drake. Verified against the live
 * service: `apic.musixmatch.com` with `android-player-v1.0` issues real tokens, matches the
 * right track, and still reaches richsync.
 *
 * Undocumented in every respect, so each step reports what actually happened rather than
 * collapsing to "not found": when this breaks, the useful question is *which* call broke.
 */

import { backOff, isUnavailable, json, query, request, type FetchResult } from '../http.ts';
import { MATCH_THRESHOLD, cleanTitleOf, primaryArtistOf, score, type TrackQuery } from '../match.ts';
import { parseRichSync } from '../format/musixmatch.ts';
import { parseLrc } from '../format/lrc.ts';
import type { Config } from '../config.ts';
import type { Provider, ProviderAnswer, ProviderContext } from './types.ts';

const API = 'https://apic.musixmatch.com/ws/1.1';

/** The API, or the relay in front of it when one is set. See `worker/relay.js`. */
function apiOf(config: Config): string {
  return config.musixmatchRelayUrl ? `${config.musixmatchRelayUrl}/ws/1.1` : API;
}

/**
 * Body statuses that mean "I will not answer", not "there is nothing to answer with".
 *
 * Musixmatch replies HTTP 200 and puts the real status here. 401 is the guest token being rate-limited
 * — the commonest of these by far — and 429 and the 5xx range are the obvious rest.
 */
const REFUSALS = new Set([401, 402, 429, 500, 502, 503]);

/** How long to leave Musixmatch alone once it has refused. Its guest-token limit is per-hour-ish. */
const THROTTLED_BACKOFF_MS = 10 * 60_000;
const APP_ID = 'android-player-v1.0';

/**
 * Which client id to take from a pasted `musixmatchUserToken` cookie, in order.
 *
 * A signed-in musixmatch.com session carries one token per Musixmatch client, and a token only
 * works with the client it was issued for. Tested against the live endpoint: on this host all
 * of these work, `web-desktop-app-v1.0` is refused outright, and the `-dev` and `-pp` variants
 * are staging clients that have no business being pointed at the live API.
 */
const COOKIE_APP_IDS = [
  'android-player-v1.0',
  'mxm-pro-web-v1.0',
  'mxm-pro-android-v1.0',
  'mxm-pro-ios-v1.0',
  'mxm-com-v1.0',
  'mxm-account-v1.0',
  'community-app-v1.0',
  'mxm-studio-v1.0',
  'mxm-experiments-v1.0',
  'musixmatch-podcasts-v2.0',
  'musixmatch-publishers-v2.0',
  'mxm-backoffice-v1.0',
] as const;

/**
 * A 403 is the API's load balancer turning away the address, whatever the token or client: measured
 * from a cloud host, while the same requests from home were answered.
 */
const ADDRESS_REFUSED = "Musixmatch refuses this server's address (HTTP 403); a new token will not help";
const RELAY_REFUSED = 'the Musixmatch relay refused the request (HTTP 403): check its Access service token';

function refused(config: Config): string {
  return config.musixmatchRelayUrl ? RELAY_REFUSED : ADDRESS_REFUSED;
}

/** A token and the client id it was issued for. Neither works without the other. */
interface Credential {
  token: string;
  appId: string;
  /** Pasted by the owner, as opposed to minted here. */
  own?: boolean;
  /** One of several, out of a pasted cookie. */
  fromCookie?: boolean;
}

/**
 * The pasted tokens Musixmatch refused, set aside for a while in favour of an anonymous one, as the app
 * does. Refused means `401 renew` in the body: a bare token pasted from the musixmatch.com cookie
 * belongs to a web client and does not work under the Android client id it is paired with here, and
 * not every token in a cookie is accepted either. A different paste is tried at once.
 */
let refusedOwn: { paste: string; at: number } | null = null;
const REFUSED_OWN_RETRY_MS = 60 * 60 * 1000;
/** The cookie client that last worked, tried first from then on. */
let workingClient: string | null = null;
/** How many pasted tokens one lookup may try: each costs a request against the pace. */
const OWN_ATTEMPTS = 3;
const PASTE_THE_COOKIE =
  'a bare token only works with the client it was issued for; paste the whole musixmatchUserToken cookie instead';
const COOKIE_STALE =
  'every token in the pasted cookie was refused; sign in to musixmatch.com again and paste a fresh musixmatchUserToken cookie';

type Matched = { value: Envelope<MatcherBody> | null; result: FetchResult };

function tokenRefused(matched: Matched): boolean {
  return matched.result.ok && matched.value?.message?.header?.status_code === 401;
}

/** `401 renew`, `401 captcha`: the body's status with Musixmatch's one-word reason, when it gives one. */
function bodyStatus(matched: Matched): string {
  const header = matched.value?.message?.header;
  return [header?.status_code ?? 'nothing', header?.hint].filter(Boolean).join(' ');
}

/**
 * The matcher's answer, with the credential it took: the pasted tokens in turn, then a guest's.
 *
 * A cookie holds a token per client and not every one is accepted — on a real cookie the
 * `mxm-pro-web` token was refused while `mxm-com` matched — so a refusal moves on to the next, and
 * the client that worked goes first from then on. When every pasted token is refused they are set
 * aside for an hour and a guest token is asked for instead.
 */
async function matchWithCredentials(
  track: TrackQuery,
  ctx: ProviderContext,
  warn: (message: string) => void,
): Promise<{ credential: Credential; matched: Matched } | null> {
  const own = ownCredentials(ctx.config);
  for (const credential of own.slice(0, OWN_ATTEMPTS)) {
    const matched = await askMatcher(track, credential, ctx);
    if (!tokenRefused(matched)) {
      workingClient = credential.appId;
      return { credential, matched };
    }
    warn(`musixmatch: the pasted token for ${credential.appId} was refused (${bodyStatus(matched)})`);
  }
  if (own.length > 0) {
    refusedOwn = { paste: ctx.config.secrets.musixmatchUserToken.trim(), at: Date.now() };
    warn(`musixmatch: ${own[0]!.fromCookie ? COOKIE_STALE : PASTE_THE_COOKIE}. Asking as a guest meanwhile`);
  }
  const guest = await anonymousCredential(ctx);
  if (!guest) return null;
  return { credential: guest, matched: await askMatcher(track, guest, ctx) };
}

/** The pasted tokens worth trying now: none while the paste is set aside, the client that worked first. */
function ownCredentials(config: Config): Credential[] {
  const paste = config.secrets.musixmatchUserToken.trim();
  const own = parseUserTokens(paste);
  if (own.length === 0) return [];
  // By the whole paste rather than any one token: which token comes first changes with the client
  // that last worked, and a paste changed since is tried at once.
  const setAside = refusedOwn && refusedOwn.paste === paste && Date.now() - refusedOwn.at < REFUSED_OWN_RETRY_MS;
  if (setAside) return [];
  const preferred = own.filter((credential) => credential.appId === workingClient);
  return [...preferred, ...own.filter((credential) => credential.appId !== workingClient)];
}

async function askMatcher(
  track: TrackQuery,
  credential: Credential,
  ctx: ProviderContext,
): Promise<{ value: Envelope<MatcherBody> | null; result: FetchResult }> {
  return json<Envelope<MatcherBody>>(
    `${apiOf(ctx.config)}/matcher.track.get?${query({
      format: 'json',
      app_id: credential.appId,
      usertoken: credential.token,
      q_track: cleanTitleOf(track),
      q_artist: primaryArtistOf(track),
      q_album: track.album,
      q_duration: track.durationMs > 0 ? Math.round(track.durationMs / 1000) : undefined,
      // Checked against the live service: an ISRC it knows wins over the names, one it does not
      // falls back to them. The score below still has to pass either way.
      track_isrc: track.isrc,
    })}`,
    { headers: clientHeaders(ctx.config) },
  );
}

/** The anonymous token, kept for the process's lifetime — minting one per lookup is rude. */
let guestToken: { value: string; mintedAt: number } | null = null;
const GUEST_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

interface Envelope<T> {
  message?: {
    header?: { status_code?: number; hint?: string };
    body?: T;
  };
}

interface MatcherBody {
  track?: {
    track_id?: number;
    commontrack_id?: number;
    track_name?: string;
    artist_name?: string;
    album_name?: string;
    track_length?: number;
    has_richsync?: number;
    has_subtitles?: number;
    instrumental?: number;
  };
}

export const musixmatch: Provider = {
  id: 'musixmatch',
  label: 'Musixmatch',
  description: 'Word-by-word for most Western music. Works with no account; a token lifts the rate limit.',
  requires: [],
  wordLevel: true,
  isConfigured: () => true,

  async fetch(track: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null> {
    const answer = await matchWithCredentials(track, ctx, (message) => ctx.log('warn', message));
    if (!answer) return null;
    const { credential, matched } = answer;

    if (matched.result.status === 403) ctx.unreachable(refused(ctx.config));
    else if (isUnavailable(matched.result)) ctx.unreachable(`matcher: ${matched.result.error}`);
    const found = matched.value?.message?.body?.track;
    if (!found?.track_id) {
      const hint = matched.value?.message?.header?.status_code;

      // The transport saw a 200; the refusal is in the body. Which is the whole trap here: without
      // this, a throttled token looked exactly like a source that had nothing for the track, and
      // "nothing for the track" is recorded as settled and never asked again. A bulk re-lookup would
      // quietly write that against every song in the library.
      if (hint && REFUSALS.has(hint)) {
        ctx.unreachable(`matcher refused the token (${bodyStatus(matched)} in the body, HTTP 200)`);
        // And stop asking for a while. The status is the guest token being rate-limited, so the next
        // request would be refused too — and each one that is refused *while looking like an answer*
        // costs another track its record.
        backOff(apiOf(ctx.config), THROTTLED_BACKOFF_MS);
        return null;
      }

      if (hint && hint !== 200) ctx.log('info', `musixmatch: matcher returned ${hint}`);
      return null;
    }
    if (found.instrumental) return null;

    const match = score(
      track,
      found.track_name ?? '',
      found.artist_name ?? '',
      (found.track_length ?? 0) * 1000,
    );
    if (match < MATCH_THRESHOLD) {
      ctx.log('info', `musixmatch: matched "${found.track_name}" but only scored ${match.toFixed(2)}`);
      return null;
    }

    // Free, and already in hand from the match that just succeeded.
    ctx.learn({
      durationMs: found.track_length && found.track_length > 0 ? found.track_length * 1000 : null,
      metadata: {
        musixmatchTrackId: found.track_id,
        musixmatchCommontrackId: found.commontrack_id || undefined,
        albumName: found.album_name || undefined,
        hasRichsync: Boolean(found.has_richsync) || undefined,
      },
    });

    // Word-level first: a richsync makes this source worth having, a subtitle makes it
    // merely another line-timed opinion.
    if (found.has_richsync) {
      const rich = await json<Envelope<{ richsync?: { richsync_body?: string } }>>(
        `${apiOf(ctx.config)}/track.richsync.get?${query({
          format: 'json',
          app_id: credential.appId,
          usertoken: credential.token,
          track_id: found.track_id,
        })}`,
        { headers: clientHeaders(ctx.config) },
      );
      const body = rich.value?.message?.body?.richsync?.richsync_body;
      if (body) {
        const doc = parseRichSync(body);
        if (doc) {
          return {
            doc,
            match,
            raw: { body, contentType: 'application/json' },
            note: 'richsync (word-timed)',
          };
        }
      }
    }

    if (found.has_subtitles) {
      const subtitle = await json<Envelope<{ subtitle?: { subtitle_body?: string } }>>(
        `${apiOf(ctx.config)}/track.subtitle.get?${query({
          format: 'json',
          app_id: credential.appId,
          usertoken: credential.token,
          track_id: found.track_id,
        })}`,
        { headers: clientHeaders(ctx.config) },
      );
      const body = subtitle.value?.message?.body?.subtitle?.subtitle_body;
      if (body) {
        const doc = parseLrc(body);
        if (doc) {
          return {
            doc,
            match,
            raw: { body, contentType: 'text/plain' },
            note: 'subtitle (line-timed)',
          };
        }
      }
    }

    return null;
  },

  async test(ctx: ProviderContext) {
    const started = performance.now();
    let why: string | undefined;
    const quietly = { ...ctx, unreachable: (detail: string) => (why ??= detail) };
    // The same path a lookup takes, with each step told rather than hidden: the test is where a
    // refused token gets noticed.
    const notes: string[] = [];
    const sample = { title: 'Bohemian Rhapsody', artist: 'Queen', album: '', durationMs: 0 };
    const answer = await matchWithCredentials(sample, quietly, (message) => notes.push(message.replace(/^musixmatch: /, '')));
    if (!answer) {
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        detail: [...notes, why ?? 'could not obtain a token — the anonymous mint is the usual thing to break'].join('. '),
      };
    }
    const { credential, matched } = answer;
    if (matched.result.status === 403) return { ok: false, ms: matched.result.ms, detail: refused(ctx.config) };
    const status = matched.value?.message?.header?.status_code;
    const name = matched.value?.message?.body?.track?.track_name;
    const who = credential.own ? `the pasted token for ${credential.appId}` : 'a guest token';
    return {
      ok: status === 200 && Boolean(name),
      ms: matched.result.ms,
      detail: [
        ...notes,
        status === 200 && name
          ? `${who} works, matched "${name}"`
          : `${who} was obtained but the matcher returned ${bodyStatus(matched)}`,
      ].join('. '),
    };
  },

  // The archived body is either a richsync payload or an LRC subtitle, and the content type
  // recorded alongside it is the only thing that says which.
  reparse: (body, contentType) =>
    contentType.includes('json') ? parseRichSync(body) : parseLrc(body),
};

/** The anonymous token, minted once and kept. See `guestToken`. */
async function anonymousCredential(ctx: ProviderContext): Promise<Credential | null> {
  if (guestToken && Date.now() - guestToken.mintedAt < GUEST_TOKEN_TTL_MS) {
    return { token: guestToken.value, appId: APP_ID };
  }

  const minted = await json<Envelope<{ user_token?: string }>>(
    `${apiOf(ctx.config)}/token.get?${query({ format: 'json', app_id: APP_ID })}`,
    { headers: clientHeaders(ctx.config) },
  );

  if (minted.result.status === 403) {
    ctx.unreachable(refused(ctx.config));
    return null;
  }

  // The response is a 200 whose body carries the real status. `401 captcha` means the mint is
  // rate-limiting this address — a wait rather than a refusal, so it must not be reported as
  // this track having no lyrics.
  const status = minted.value?.message?.header?.status_code;
  if (status === 401) {
    ctx.unreachable(`token mint is throttling (${minted.value?.message?.header?.hint ?? '401'})`);
    return null;
  }

  const value = minted.value?.message?.body?.user_token;
  if (!value || !isUsableToken(value)) {
    // Without a token nothing can be asked at all, so this is an outage rather than a miss.
    ctx.unreachable('no usable anonymous token');
    return null;
  }
  guestToken = { value, mintedAt: Date.now() };
  return { token: value, appId: APP_ID };
}

/**
 * Read whatever was pasted into the Musixmatch secret.
 *
 * Accepts a bare token or the whole `musixmatchUserToken` cookie from a signed-in
 * musixmatch.com session — percent-encoded or not, on its own or inside a full cookie header.
 * That cookie is the form a person actually has to hand, and it carries one token per client;
 * picking a client the endpoint accepts is this function's job rather than theirs.
 */
export function parseUserToken(raw: string | undefined): Credential | null {
  return parseUserTokens(raw)[0] ?? null;
}

/** Every usable token in the paste, in the order the clients are preferred. A bare token is one. */
export function parseUserTokens(raw: string | undefined): Credential[] {
  const value = raw?.trim();
  if (!value) return [];

  // Decode before deciding what this is: a cookie copied out of a browser arrives
  // percent-encoded, and `%7B%22tokens%22…` contains neither a brace nor an equals sign.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not encoded, or not validly — either way the raw string is what we have.
  }

  const afterName = decoded.includes('musixmatchUserToken=')
    ? decoded.slice(decoded.indexOf('musixmatchUserToken=') + 'musixmatchUserToken='.length)
    : decoded;
  const jsonPart = afterName.split(';')[0].trim();

  if (jsonPart.startsWith('{')) {
    let tokens: Record<string, unknown> | undefined;
    try {
      tokens = (JSON.parse(jsonPart) as { tokens?: Record<string, unknown> }).tokens;
    } catch {
      return [];
    }
    if (!tokens) return [];
    const found: Credential[] = [];
    for (const appId of COOKIE_APP_IDS) {
      const token = tokens[appId];
      if (typeof token === 'string' && isUsableToken(token)) found.push({ token, appId, own: true, fromCookie: true });
    }
    return found;
  }

  // A bare token says nothing about its client, so it is paired with the one used for the
  // anonymous mint and allowed to fail. Pasting the cookie is better because it says.
  return looksLikeToken(decoded) ? [{ token: decoded, appId: APP_ID, own: true }] : [];
}

/**
 * Whether a token is worth sending.
 *
 * The discontinued desktop endpoint answers with fifty-six zeros, and a request carrying that
 * returns lyrics for an unrelated song — worse than no token at all. Any token made of a single
 * repeated character is refused: the zeros, the older `UpgradeOnly…` placeholder, and whatever
 * comes next.
 */
function isUsableToken(token: string): boolean {
  const value = token.trim();
  if (value.length < 8) return false;
  if (value.startsWith('UpgradeOnly')) return false;
  return new Set(value).size > 1;
}

/** Long, and hex. Without this, any stray line of text was sent as a credential. */
function looksLikeToken(token: string): boolean {
  const value = token.trim();
  return value.length >= 32 && /^[0-9a-fA-F]+$/.test(value) && isUsableToken(value);
}

/**
 * The headers the endpoint expects.
 *
 * Tested against the live service: a plain browser user agent is enough on this host, and the
 * `musixmatch://` origin the desktop app sent is not required.
 */
function clientHeaders(config: Config): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    // The relay's Cloudflare Access service token. Sent only to the relay.
    ...(config.musixmatchRelayUrl
      ? {
          'CF-Access-Client-Id': config.secrets.musixmatchRelayClientId,
          'CF-Access-Client-Secret': config.secrets.musixmatchRelayClientSecret,
        }
      : {}),
  };
}
