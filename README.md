<div align="center">

# Melisma Server

**A personal lyrics server: holds the tokens your phone shouldn't, merges every source into one
document, and remembers the answer.**

![Node 24+](https://img.shields.io/badge/Node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-5fd7c4)
![SQLite built in](https://img.shields.io/badge/storage-node%3Asqlite-003B57?logo=sqlite&logoColor=white)
![Deploy: Kamal](https://img.shields.io/badge/deploy-Kamal%202-8b93a7)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)

</div>

Built for [**Melisma**](https://github.com/MelismaApp/melisma), an Android lyrics app.
The app works well without it — this makes it better at the two things a phone cannot do itself:

1. **It holds the credentials.** Apple Music has the best lyrics that exist: syllable timings with
   official romanizations and translations. Getting them needs two tokens that have no business
   being inside an APK, so they live here instead.
2. **It merges instead of racing.** No source is best at everything. One supplies the timing, the
   rest lend translations, readings, background vocals and credits. The result is better than any
   single source returned.

> [!IMPORTANT]
> Run this for yourself, with your own accounts. It is not built to be shared, and sharing it is
> what gets accounts terminated — see [Sharing it](#sharing-it).

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Point the app at it](#point-the-app-at-it)
- [Tokens](#tokens)
- [Deploying it](#deploying-it)
- [Configuration](#configuration)
- [API](#api)
- [How it works](#how-it-works)
- [Sharing it](#sharing-it)
- [Docs](#docs)
- [Licence](#licence)

## What it does

🎼 **Merges six sources into one document.** Apple Music, AMLL, NetEase, Musixmatch, Spotify and
LRCLIB, all asked at once — then one is chosen to own the timing and the rest are borrowed from, a
field at a time.

🔁 **Renews the Spotify token by itself.** The image carries a Chromium and drives it, because
Spotify closed the endpoint that used to trade a cookie for a token. Paste one cookie, once.

🗃️ **Archives every raw response.** Improving the merge is then a local recompute rather than
thousands of fresh requests to services doing this for free.

🎨 **Fetches everything that is not the words.** Cover art, a colour palette, tempo, and Spotify's
audio analysis — down the same request, so the app's now-playing screen needs no second lookup.

🩹 **Never files an outage as an answer.** A 404 means "no lyrics here" and is remembered; a
timeout or a 429 means the question never got through, so the cache is left as it was.

📚 **Has an admin page** for pasting tokens, testing each source against a real track, browsing
everything cached, and watching a live log — with a bulk re-lookup that can be paused mid-run
when a source starts throttling.

⚙️ **Installs nothing.** Node 24 and zero dependencies. No build step, no lockfile, no container
required to run it.

### What it gives the app

One request, one finished document — no fan-out from the phone and no tokens on it. It is ranked
**first** in the app's source list by default, because an answer it already has cost nobody a
request. Lyrics the phone found and the server could not can be **contributed back** — a
region-locked endpoint, or a rate limit the server hit — archived so they merge in from then on.

## Quick start

Needs **Node 24 or newer** and nothing else. TypeScript runs directly; SQLite is built into Node.

```sh
git clone https://github.com/MelismaApp/melisma-server
cd melisma-server
npm start
```

```
melisma-server listening on http://127.0.0.1:8787
admin:   http://127.0.0.1:8787/
api key: 41edb5cc…
```

Open the admin page, paste that key to sign in, and it already works: **LRCLIB, AMLL, NetEase and
Musixmatch need no account**, and between them cover most music including word-by-word timing.
[Tokens](#tokens) add to that.

| Command | |
|---|---|
| `npm start` | run it |
| `npm run dev` | run it, restarting on change |
| `npm test` | the suite — no network required |
| `npm run key` | print the API key |
| `node scripts/key.ts --new` | rotate it |
| `node scripts/key.ts --set <value>` | use one you chose |

Prefer a container? `make docker-build && make docker-run` runs it on :8787 with a volume.

<details>
<summary><b>About the API key</b></summary>

One key does both jobs: the admin page asks for it, the app sends it. It is generated on first boot
and printed once — and a printed key is no use once the terminal has scrolled, hence `npm run key`.

`BL_API_KEY` in the environment overrides the stored one, which is how the deployment sets it. When
that is in play `npm run key` says so, rather than confidently printing a key the running server is
not using.

Rotating invalidates the old key immediately: the admin page asks again on its next visit, and the
app needs the new value.
</details>

<details>
<summary><b>A key per person or device</b></summary>

**Users** in the admin page makes a key for each phone or person, beside the admin key. It goes in
the app's cache server key field and looks lyrics up exactly as the admin key does, from the same
shared cache. Signing in to the admin page with it shows only the songs asked for with that key,
under **Cache**, with **Recently asked** and **Most asked for** counting that key's lookups alone.

It reaches nothing else: not the tokens, the settings, the log, the source tests, or anything that
spends the server's tokens or changes the cache. A key is shown once and kept only as a hash, and
**Revoke** ends it and every page session opened with it. The admin key keeps working everywhere,
the app included, and the admin sees every song, or anyone's with **Asked by**.
</details>

## Point the app at it

In Melisma: **Settings → Developer**

| Field | Value |
|---|---|
| **Cache server URL** | `http://<your-machine>:8787` — no trailing slash, no `/v1` |
| **Cache server key** | the admin key, or one from **Users**. Only needed if the server is **not** on your own network |

A lookup from your own machine or your own Wi-Fi is let through without a key, because a lookup can
only cause a lyric fetch. Anything [deployed](#deploying-it) off your network always wants the key.

To check it end to end, use **Try a track** in the admin page: it runs a real lookup for any track
you name and shows what every source returned, including why a candidate lost.

## Tokens

All optional. A source with no credential is skipped rather than queried, so leaving one enabled
while you go and find its token costs nothing.

| I want… | Paste this | Lasts |
|---|---|---|
| Apple's word-by-word lyrics, romanizations and translations | [Apple developer + media user token](docs/TOKENS.md#apple-music) | months / session |
| The lyrics the Spotify app shows | [Spotify `sp_dc` cookie](docs/TOKENS.md#spotify-sp_dc-cookie) | ~1 year |
| Reliable ISRCs and cover art | [Spotify client id + secret](docs/TOKENS.md#spotify-application) | forever |
| A wider Musixmatch catalogue | [Musixmatch user token](docs/TOKENS.md#musixmatch) | months |
| Regional NetEase catalogues | [NetEase cookie](docs/TOKENS.md#netease) | months |

**→ [docs/TOKENS.md](docs/TOKENS.md) has step-by-step instructions for every one**, including why the
`sp_dc` cookie is the only Spotify setup worth doing.

Paste them into the **Tokens** tab, then check them in **Sources**: each source has a **Test**
button, and *Test the sources* runs a real lookup through every one and reports what each said. Or
set them as [environment variables](#configuration), in which case the page shows them read-only.

## Deploying it

Docker plus [Kamal 2](https://kamal-deploy.org) (`gem install kamal`). `kamal-proxy` listens on :80;
put a Cloudflare Tunnel or another TLS terminator in front of it — TLS is not terminated here.

```sh
cp .kamal/secrets.sample .kamal/secrets   # registry login, BL_API_KEY, any tokens
$EDITOR config/deploy.yml                 # replace the TODO(...) markers
make setup                                # one-time bootstrap and first deploy
make deploy                               # every time after that
```

**1. `config/deploy.yml`** — four markers:

| | |
|---|---|
| `image` | your registry path, e.g. `you/melisma-server` |
| `servers.web` | the VM's IP or hostname |
| `ssh.user` | a user with Docker access on that VM |
| `registry` | Docker Hub, GHCR, OCIR — server and credentials |

Also check `builder.arch`. It is `arm64` for an Oracle Ampere host; change it if your VM is x86.

**2. `.kamal/secrets`** — the registry login is required, and `BL_API_KEY` is strongly recommended so
the key is known before first boot and survives a rebuilt volume:

```sh
node -e "console.log(crypto.randomBytes(24).toString('hex'))"
```

Tokens can go here *or* be pasted into the admin page afterwards — the database is on a volume, so
they persist either way, and pasting needs no redeploy. Anything left blank is simply not passed to
the container.

**3. Day to day:**

| Target | |
|---|---|
| `make deploy` | rebuild and ship |
| `make logs` / `make app-logs` | tail |
| `make remote-key` | print the deployed API key |
| `make console` | shell inside the container |
| `make backup` | copy the database here, timestamped |
| `make rollback` | previous image |

There is nothing to compile, so the image is `node:24-alpine` plus the source — no `npm ci`, no build
stage, no lockfile to keep in step.

> [!WARNING]
> **Back up the volume.** `better-lyrics-data:/data` holds the cache *and* the credentials. Lose it
> and you re-fetch every track and re-paste every token. That is what `make backup` is for. It keeps
> the old name on purpose — renaming a volume does not move it, it creates an empty one.

> [!CAUTION]
> **Leave `BL_ALLOW_LOCAL_NETWORK: "0"` alone.** The local-network exception exists so a phone on your
> own Wi-Fi needs no key. Behind `kamal-proxy` every request arrives from the Docker bridge, which
> *is* a private address — so leaving it on would hand that exception to the whole internet. The
> server independently refuses the exception whenever it sees an `X-Forwarded-For` header, which
> `kamal-proxy` always sets, so there are two locks. The consequence is that a deployed server always
> wants the key, including from the app, which is the right way round.

## Configuration

All of this is editable in the admin page and stored in the database, so none of it needs a restart.
An environment variable overrides the stored value and shows read-only in the page.

| Variable | Default | |
|---|---|---|
| `BL_API_KEY` | generated | the one key, for the app and the admin page |
| `BL_HOST` | `127.0.0.1` | `0.0.0.0` in a container |
| `BL_PORT` | `8787` | |
| `BL_DATA` | `./data/better-lyrics.db` | database path (old name kept: it points at existing data) |
| `BL_ALLOW_LOCAL_NETWORK` | `1` | let this machine and the LAN look up without a key |
| `BL_TRANSLATION_LANG` | `en` | which translation to prefer when a source ships several |
| `BL_TOKEN_REFRESH_MINUTES` | `50` | how often to renew the Spotify token |
| `BL_TOKEN_REFRESH_COMMAND` | — | replace the built-in browser harvest with your own command |
| `BL_LRCLIB_URL` `BL_NETEASE_URL` `BL_AMLL_URL` `BL_APPLE_API` `BL_APPLE_STOREFRONT` | | endpoint overrides |
| `BL_APPLE_BEARER_TOKEN` `BL_APPLE_MEDIA_USER_TOKEN` `BL_SP_DC_COOKIE` `BL_SPOTIFY_WEB_TOKEN` `BL_SPOTIFY_CLIENT_ID` `BL_SPOTIFY_CLIENT_SECRET` `BL_MUSIXMATCH_USER_TOKEN` `BL_NETEASE_COOKIE` | | the [tokens](docs/TOKENS.md) |

Admin page only, with no environment override: how long to trust "no lyrics exist" (48 h), how long
before a found document is refreshed (30 days), the pause between tracks in a bulk re-lookup (1 s),
and each source's on/off switch and priority.

## API

```
GET  /v1/health
GET  /v1/lyrics?title=&artist=&album=&durationMs=&spotifyId=&isrc=
     [&format=ttml|json] [&force=1] [&cacheOnly=1]
POST /v1/warm        {title, artist, album, durationMs, spotifyId?}
POST /v1/contribute  {track:{…}, provider, format:"lrc"|"ttml"|"json", body}
PUT  /v1/language    {spotifyId?, isrc?, title, artist, language:"nan"|"zh"|"yue"|null}
```

A lookup returns TTML in an envelope — `{status, data:{format, lyrics, source, providerName}}` —
which is what the app expects and any other lyrics server could produce. `format=json` gives the
structured model with its provenance and candidate list; `format=ttml` the bare file. `X-Cache` is
`cache`, `remerge`, `network` or `absent`. A tagged song's language comes as `X-Lyrics-Language` and
`X-Lyrics-Language-Source`; only the admin key can tag one.

Authentication follows what a route can reach: `/admin/*` always needs the key, since it is the only
surface that can read a credential, while a lookup is let through from your own network. A user key
reaches the lookups and a read-only view of its own songs; everything else answers `403`.

**Full contract → [docs/CACHE-SERVER.md](docs/CACHE-SERVER.md).**

## How it works

Ask every enabled source at once, pick **one** to own the timing, then borrow everything else onto it
a field at a time, checking after each borrow that nothing broke. Timing is never averaged: a lyric
half a second out is harder to sing to than one with no timing at all. Identity comes first where it
can — the Spotify id or ISRC is established before the others are searched, because a title matches
the wrong song far more often than an ISRC does.

**The merge, the cache, the token harvest and the security posture →
[docs/DESIGN.md](docs/DESIGN.md).**

## Sharing it

**Don't** — at least not the Apple part.

Caching solves the rate limit. It does not solve the licence: lyrics fetched with your
`media-user-token` are licensed to *you*, and a server answering for other people is redistributing
Apple's content however the bytes got there. One person, their own tokens, their own devices is a
defensible line, and that is what user keys are for: your phones, or your household. Account termination is the ordinary outcome of the alternative.

The version of this idea that *does* help other people already exists: the
[AMLL TTML Database](https://github.com/amll-dev/amll-ttml-db) is CC0, community-made, and exactly
this cache built in the open. `format=ttml` exists so timings from here can be contributed back to it.

If you expose it anyway, know what is at stake: the database holds your Spotify cookie and Apple
tokens **in the clear**. The file is `chmod 600`, the server binds to `127.0.0.1` by default, the
admin surface always demands the key, and secrets are masked in the API and stripped from the log —
that is the whole of it ([the full posture](docs/DESIGN.md#security-posture)). Put nothing in front
of this that you would not put a password manager behind.

## Docs

| | |
|---|---|
| **[TOKENS.md](docs/TOKENS.md)** | Every token, step by step, and what each one buys |
| **[DESIGN.md](docs/DESIGN.md)** | The merge, the cache, the token harvest, the security posture |
| **[CACHE-SERVER.md](docs/CACHE-SERVER.md)** | The request/response contract, and why each call was settled that way |

## Licence

**AGPL-3.0** — see [LICENSE](LICENSE).

Chosen for what it says about running this as a service rather than inherited from anywhere: §13
means anyone who runs a *modified* version where others can reach it has to offer them the source.
Plain GPL does not, and a lyrics server is precisely the case that gap was written for. It also
matches the app.

Unlike the app — which is AGPL because it is a genuine port of
[Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics), animation curves and all — nothing here
derives from it. The server shares the app's TTML dialect and its line/syllable shape so the two can
talk to each other, and a format and a data shape are not a port. There is no rendering code here at
all.

None of this touches the lyrics themselves: they belong to their writers and publishers, and no code
licence changes what the sources' own terms allow. See [Sharing it](#sharing-it).

## Credits

The sources, none of them affiliated with this:
[AMLL TTML Database](https://github.com/amll-dev/amll-ttml-db) (CC0, community-timed),
[LRCLIB](https://lrclib.net), NetEase Cloud Music, Musixmatch, Spotify, Apple Music.

Lyrics belong to their writers and publishers. This stores a cache on one machine.
