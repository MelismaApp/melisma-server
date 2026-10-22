/**
 * Relays the cache server's Musixmatch requests from Cloudflare's network. Musixmatch's load balancer
 * refuses the server's own address with a 403; Cloudflare's it answers.
 *
 * Behind Cloudflare Access, with a service token as the only way in. The Access token on each request
 * is verified here as well, so one that reaches this some other way is refused, and with no Access
 * settings everything is refused. Only the four calls the server makes are relayed, to one host.
 */

const UPSTREAM = 'https://apic.musixmatch.com/ws/1.1/';
const CALLS = new Set(['token.get', 'matcher.track.get', 'track.richsync.get', 'track.subtitle.get']);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

export default {
  async fetch(request, env) {
    if (!(await fromAccess(request, env))) return new Response('forbidden\n', { status: 403 });

    const url = new URL(request.url);
    const call = url.pathname.match(/^\/ws\/1\.1\/([\w.]+)$/)?.[1];
    if (request.method !== 'GET' || !call || !CALLS.has(call)) {
      return new Response('not relayed\n', { status: 404 });
    }

    const upstream = await fetch(`${UPSTREAM}${call}${url.search}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};

/**
 * Whether the request carries a valid Access token for this application: signed by the team's key,
 * for this application's audience, from the team's issuer, and in date.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
async function fromAccess(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
  const audience = env.ACCESS_AUD;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!team || !audience || !token) return false;

  const [head, body, signature] = token.split('.');
  if (!head || !body || !signature) return false;
  let header, claims;
  try {
    header = JSON.parse(text(decode(head)));
    claims = JSON.parse(text(decode(body)));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256') return false;

  const jwk = (await keys(team)).find((key) => key.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${head}.${body}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signature), signed))) return false;

  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return (
    audiences.includes(audience) &&
    claims.iss === team &&
    typeof claims.exp === 'number' &&
    claims.exp > now &&
    (claims.nbf === undefined || claims.nbf <= now)
  );
}

let certs = null;

/** The team's signing keys, kept for an hour; Access rotates them every six weeks. */
async function keys(team) {
  if (certs && certs.team === team && Date.now() - certs.at < 3_600_000) return certs.keys;
  const response = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!response.ok) return [];
  certs = { team, keys: (await response.json()).keys ?? [], at: Date.now() };
  return certs.keys;
}

function decode(part) {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')), (c) =>
    c.charCodeAt(0),
  );
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}
