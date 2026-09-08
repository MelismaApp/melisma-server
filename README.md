# Better Lyrics Server

A personal caching and merging lyrics server for [Better Lyrics](https://github.com/MangoTornado/better-lyrics).

It does two things the phone cannot:

1. **Holds the credentials.** Apple Music has the best lyrics that exist — syllable timings
   with official romanizations and translations — and getting them needs two tokens that have
   no business being inside an APK. They live here instead.
2. **Merges the sources instead of racing them.** No provider is best at everything. One
   source supplies the timing; the rest lend translations, readings, background vocals and
   credits. The result is a document better than any single source returned.

It is built to be run by one person for themselves. See [Sharing it](#sharing-it).

## Running it

Needs Node 24 or newer, and nothing else — no dependencies, no build step, no container.
TypeScript runs directly, and SQLite is built into Node.

```sh
npm start           # or: node src/main.ts
```

It prints the admin URL and an API key it generated on first boot:

```
better-lyrics-server listening on http://127.0.0.1:8787
admin:   http://127.0.0.1:8787/
api key: 41edb5cc…
```

Open the admin page, paste the key, and paste tokens into the **Tokens** tab. Every source
has a **Test** button that says what is actually wrong rather than just failing.

The **Library** tab is every song the server has been asked about and everything it holds on each —
the merged lyrics, every provider's raw response, and the artwork, palette, tempo and analysis the
tokens turned up. Ordered by artist and title, searchable by name *or by the words themselves*, and
filterable down to what is missing: no lyrics, no word timings, no translation, no artwork.

`npm test` runs the suite. `npm run dev` restarts on change.

### The key

One key does both jobs: the admin page asks for it, and the app sends it. It is generated on
first boot and printed — but a printed key is no use once the terminal has scrolled, so:

```sh
npm run key                       # print it
node scripts/key.ts --new         # rotate it
node scripts/key.ts --set <value> # use one you chose
make remote-key                   # print it on a deployed host
```

`BL_API_KEY` in the environment overrides the stored one, which is how the deployment sets it.
When that is in play `npm run key` says so, rather than confidently printing a key the running
server is not using.

Rotating invalidates the old one immediately: the admin page asks again on its next visit, and
the app needs the new value in **Settings → Developer → Cache server key**.

## The tokens

Everything works with no tokens at all — LRCLIB, the AMLL community database, NetEase and
Musixmatch need no account, and between them cover most music including word-by-word timing.
Tokens add to that.

### Apple Music, without a developer membership

Two tokens, and a subscription only gets you one:

- **Developer token** — a JWT. Normally from an Apple Developer Program membership ($99/yr)
  and a MusicKit key. You do not need one: the web player's own token works. Open
  music.apple.com → DevTools → Network → click a song → find a request to
  `amp-api.music.apple.com` → copy the `Authorization: Bearer eyJ…` value. It is shared by
  every web listener and lasts months. The admin page decodes it and shows the expiry, so
  "the server broke" and "paste a fresh token" are distinguishable.
- **Media user token** — this is the one your subscription gets you. Signed in at
  music.apple.com → DevTools → Application → Cookies → `media-user-token`. It dies with the
  browser session, so if lyrics start returning 403 this is what to replace.

### The rest

| Token | What it adds |
|---|---|
| Spotify `sp_dc` cookie | Spotify's own lyrics — line-timed, but matched to the exact track id, so it is a text reference the merge can trust |
| Musixmatch user token | Optional; the server mints an anonymous one, yours reaches more of the catalogue |
| NetEase cookie | Optional; raises the per-IP limits and unlocks some regional catalogues |

Any of these can also come from the environment (`BL_APPLE_BEARER_TOKEN`,
`BL_SP_DC_COOKIE`, …), in which case the admin page shows them as read-only.

## Keeping the short-lived tokens alive

Spotify closed the endpoint that turned an `sp_dc` cookie into an access token — it answers `400
usage of this endpoint is not permitted under the Spotify Developer Terms`, cookie or no cookie. The
token the web player itself uses still works on everything here, and it lasts about an hour.

Only a browser can mint one, so **the image carries a Chromium and the server drives it**. Paste an
`sp_dc` cookie into the admin page and that is the entire setup: every fifty minutes the server
opens the player, reads the `Authorization` header off the player's own request, and stores it. One
deployment, nothing to point at, no second container.

```
Tokens → Spotify sp_dc cookie → paste → done
```

A cookie rather than a password, deliberately. `sp_dc` still authenticates the *player* even though
it can no longer be traded for a token, so nothing stores a password and there is no login form for
two-factor auth or a CAPTCHA to interrupt — the difference between a job that runs for a year and
one that breaks the first time Spotify shows a challenge. The cookie lasts about a year; paste a new
one when it stops working, which the admin page will tell you.

Nothing here defeats a protection: it signs in as you, with your own cookie, and takes a header your
browser would have received anyway.

### No Playwright

The harvest talks to Chromium over the DevTools protocol directly — `src/harvest/cdp.ts` is about
two hundred lines and Node 24 already has the WebSocket client it needs. Playwright would bundle its
own Chromium and a native toolchain on top of Alpine's, and be the server's only npm dependency, for
a job with no forms to fill in and no elements to wait for. If the harvest ever *does* need to drive
a login form, that trade is worth revisiting — a form is where a real library earns its size.

### The override

`BL_TOKEN_REFRESH_COMMAND` replaces the built-in harvest with an external command whose stdout is
JSON of token name to value:

```json
{"spotifyWebToken": "BQD…", "appleMediaUserToken": "Aq…"}
```

For renewing something the built-in harvest knows nothing about, or for driving a browser on a
machine with a residential IP — challenged far less often than a datacenter one.
`examples/refresh-spotify-token.mjs` is a Playwright script that does exactly this, including the
username-and-password path.

It comes from the environment and **cannot be set from the admin page**: an admin session should not
get to choose what the host executes, or one stolen key becomes arbitrary code on the machine
holding your Apple tokens.

## How the merge works

The timing is not negotiable. Mixing two sources' timings produces something worse than
either, because a lyric half a second out is harder to sing to than one with no timing at
all. So one source is chosen to own it, and everything else is borrowed.

1. **Ask every enabled source at once.** In parallel, not in turn — a fallback chain stops at
   the first answer, and the first answer is rarely the best one.
2. **Pick the backbone.** Word-timed beats line-timed beats unsynced. Within a tier, the
   user's priority breaks the tie. A candidate holding far fewer lines than the others is
   passed over — a six-line file for a forty-line song is a fragment or a wrong match, and
   letting it win because it is word-timed would throw away most of the song.
3. **Line the others up against it.** Needleman–Wunsch over the line sequences, scoring each
   pair on text similarity and timing proximity. Order-preserving by construction: two
   sources may disagree about how many lines a chorus is, but never about what comes before
   what.
4. **Borrow, one field at a time.**
   - *Syllables*, for lines the backbone has none for — accepted only when the words match and
     a uniform shift of under 1.5 s puts them inside the line's window. Never stretched.
   - *Translations*, preferring a source whose declared language matches yours. Otherwise a
     Chinese translation of a Japanese song wins by being first, which is no use to an
     English reader.
   - *Readings*, per-syllable when the two sources split the line identically, whole-line
     otherwise.
   - *Background vocals*, *duet parts*, *songwriters*, *language*.
5. **Check after every borrow.** Monotonic lines, ordered syllables inside their line's
   window. Anything that breaks an invariant is rolled back, so a bad source can leave the
   result no better than the backbone but never worse.

Text is never overwritten from another source. Only blanks are filled.

## Why keep every raw response

Because the merge will get better, and a merged document is only as good as the algorithm
that produced it. Every provider's raw body is archived next to the merged result, so
improving the merge is a local recompute over data already on disk rather than thousands of
fresh requests to services doing this for free. Bump `MERGE_VERSION` and everything is
rebuilt on the next boot, offline.

It is also good manners. LRCLIB asks people not to hammer it, and the AMLL endpoint is one
volunteer's server. A cache turns one query per track *ever* into the steady state.

**An outage is never written down as an answer.** A 404 means this track has no lyrics here and
is worth remembering; a timeout, a 429, a 5xx or an expired token means the question never got
through. Recording the second as the first would hide the track for the whole negative TTL, and
on a refresh it would replace a document that was perfectly good — so when nothing is found and
something was unreachable, the cache is left exactly as it was and whatever was already there is
served.

## API

```
GET  /v1/health
GET  /v1/lyrics?title=&artist=&album=&durationMs=&spotifyId=&isrc=
     [&format=ttml|json] [&force=1] [&cacheOnly=1]
POST /v1/warm        {title, artist, album, durationMs, spotifyId?}
POST /v1/contribute  {track:{…}, provider, format:"lrc"|"ttml"|"json", body}
```

`GET /v1/lyrics` returns the merged document as TTML in an envelope —
`{status, data:{format, lyrics, source, providerName}}` — which is what the app expects, and
which any other lyrics server could also produce. `providerName` names the sources that
actually did the work, so attribution survives the hop through the cache. `format=json` gives
the structured model with its provenance and candidate list instead; `format=ttml` gives the
bare file. `404` means nothing was found, with every candidate and why it lost in the body.
`X-Cache` is `cache`, `remerge`, `network` or `absent`.

**Authentication is split by what a route can reach.** `/admin/*` always needs the API key, or a
session cookie obtained by presenting it — it is the only surface that can read a credential. A
*lookup* (`/v1/lyrics`, `/v1/health`, `/v1/warm`) can only cause a lyric fetch, so a request from
this machine or the private network is allowed through without one; that is what lets the app
work while sending no authentication at all. `POST /v1/contribute` writes to the archive
permanently, so it sits on the admin side and always wants the key. A wrong key is still an error
rather than a fallback. If anything public proxies to this server, turn off **Allow the local
network to look lyrics up without the key** in Settings and give the app the key — the check
reads the connecting socket, and a proxy on the same host looks local whoever is really behind
it.

`POST /v1/contribute` accepts lyrics the app found and the server could not: the phone can
reach a region-locked endpoint or a provider whose rate limit the server hit. Archived under
`app:<provider>` so it can never overwrite a real fetch, and merged in from then on.

The full contract, and why each disagreement with the app was settled the way it was, is in
[docs/CACHE-SERVER.md](docs/CACHE-SERVER.md).

## Sharing it

Don't — at least not the Apple part.

Caching solves the rate limit. It does not solve the licence: lyrics fetched with your
`media-user-token` are licensed to *you*, and a server that answers for other people is
redistributing Apple's content regardless of how the bytes got there. One person, their own
tokens, their own device is a defensible line. Anything past that is not, and account
termination is the ordinary outcome.

The version of this idea that does help other people already exists: the
[AMLL TTML Database](https://github.com/amll-dev/amll-ttml-db) is CC0, community-made, and
exactly this cache built in the open. `format=ttml` exists so timings from here can be
contributed back to it.

If you do expose the server anyway, note what is at stake. The database holds your Spotify
cookie and Apple tokens **in the clear** — not encrypted at rest, because a passphrase on every
boot is the wrong trade for a personal service. It is `chmod 600`, it binds to `127.0.0.1` by
default, the admin surface always demands the key, and secrets are masked in the admin API and
stripped from the log. That is the whole of it. Put nothing in front of it that you would not
put a password manager behind.

## Deploying it

Docker + **Kamal 2**, set up the same way as the flight-search deploy: `kamal-proxy` on :80 with
TLS terminated in front of it by a Cloudflare Tunnel or equivalent.

```sh
cp .kamal/secrets.sample .kamal/secrets   # fill in the registry and BL_API_KEY
$EDITOR config/deploy.yml                 # replace the TODO(...) markers
make setup                                # one-time bootstrap and first deploy
make deploy                               # every time after that
```

There is nothing to compile, so the image is `node:24-alpine` plus the source — no `npm ci`, no
build stage, no lockfile to keep in step. Node 24 is a hard floor rather than a preference:
`node:sqlite` and TypeScript type stripping both come from it.

| Target | |
|---|---|
| `make deploy` | rebuild and ship |
| `make logs` / `make app-logs` | tail |
| `make remote-key` | print the deployed API key |
| `make console` | shell inside the container |
| `make backup` | copy the database here, timestamped |
| `make rollback` | previous image |

### Two things to get right

**The volume.** `better-lyrics-data:/data` holds the cache *and* the credentials. Lose it and you
re-fetch every track and re-paste every token — so it is the one thing worth `make backup`.

**`BL_ALLOW_LOCAL_NETWORK: "0"`, which the shipped config sets.** The local-network exception
exists so a phone on your own Wi-Fi can look lyrics up without a key. Behind `kamal-proxy` every
request arrives from the Docker bridge, which *is* a private address — so leaving it on would hand
that exception to the whole internet. The server independently refuses the exception whenever it
sees an `X-Forwarded-For` header, which `kamal-proxy` always sets, so there are two locks: the
header check covers anything proxied, and the setting covers anything reaching the container
directly. Either alone would do; both is cheap.

The consequence is that a deployed server always wants the key, including from the app. That is
the right way round for something reachable off your own network.

## Credits

The sources, none of them affiliated with this:
[AMLL TTML Database](https://github.com/amll-dev/amll-ttml-db) (CC0, community-timed),
[LRCLIB](https://lrclib.net), NetEase Cloud Music, Musixmatch, Spotify, Apple Music.

Lyrics belong to their writers and publishers. This stores a cache on one machine.
