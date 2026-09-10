# Tokens

**You do not need any of this to start.** LRCLIB, the AMLL community database, NetEase and Musixmatch
need no account at all, they are on by default, and between them they cover most music including
word-by-word timing. This page is for going further.

Every token here is *your own* credential, read out of a browser session you are already signed in
to. There is no account to make for this server, and nothing is sent anywhere except the service it
belongs to.

| I want… | Paste this | Lasts |
|---|---|---|
| Apple's word-by-word lyrics, official romanizations and translations | [Apple developer token](#apple-music) **and** [media user token](#apple-music) | months / browser session |
| The lyrics the Spotify app shows | [`sp_dc` cookie](#spotify-sp_dc-cookie) | ~1 year |
| Reliable ISRCs, cover art and album metadata | [Spotify client id + secret](#spotify-application) | forever |
| A working Spotify token right now, before the first refresh | [Spotify web token](#spotify-web-token) | ~1 hour |
| A wider Musixmatch catalogue | [Musixmatch user token](#musixmatch) | months |
| Regional NetEase catalogues, higher limits | [NetEase cookie](#netease) | months |

**Where they go:** the **Tokens** tab of the admin page. Every one can also be set as an environment
variable instead — `BL_APPLE_BEARER_TOKEN`, `BL_SP_DC_COOKIE`, and so on — in which case the page
shows it as read-only, since the environment wins.

**Where you check them:** the **Sources** tab. Each source has a **Test** button, which proves the
credential is accepted; *Test the sources* runs a real lookup for a known track through every enabled
source, which is the stronger check — a token can be accepted and then refused the lyrics.

A source with nothing to authenticate with is skipped rather than queried, so leaving Apple and
Spotify switched on while you go and find their tokens costs nothing.

---

## Apple Music

**Gives you:** the best lyrics that exist — syllable-level timing, with official romanizations and
translations rather than machine-generated ones. This is the reason the server exists, because these
two tokens cannot safely live inside an app.

Two tokens, and a subscription only gets you one of them.

### 1. Developer token

A JWT that lasts **months**. Normally this comes from an Apple Developer Program membership
($99/yr) and a MusicKit key — **you do not need either.** The web player's own token works, and it is
shared by every web listener.

1. Open [music.apple.com](https://music.apple.com)
2. Open DevTools → **Network**
3. Click any song to start it playing
4. Find a request to `amp-api.music.apple.com`
5. Copy the whole `Authorization` value, starting `Bearer eyJ…`

The admin page decodes it and shows the expiry date on a badge, so "the server is broken" and "paste
a fresh token" stay easy to tell apart.

### 2. Media user token

This is the one your **subscription** gets you, and it identifies you rather than the app.

1. Sign in at [music.apple.com](https://music.apple.com)
2. DevTools → **Application** → Cookies → `music.apple.com`
3. Copy the value of `media-user-token`

It dies with the browser session. **If Apple lyrics suddenly start returning 403, this is the one to
replace** — the developer token above is almost certainly still fine.

> [!IMPORTANT]
> Lyrics fetched with your media user token are licensed to *you*. Keep the server to yourself; see
> [Sharing it](../README.md#sharing-it).

---

## Spotify

Three separate things, for three different jobs. **The cookie is the one worth doing.**

### Spotify `sp_dc` cookie

**Gives you:** Spotify's own line-timed lyrics, matched to the exact track id — so the merge can
trust it as a text reference — plus the audio analysis and the full-size cover.

1. Sign in at [open.spotify.com](https://open.spotify.com)
2. DevTools → **Application** → Cookies → `open.spotify.com`
3. Copy the value of `sp_dc`

Lasts about **a year**, and this is the whole setup. Nothing else to configure.

<details>
<summary>Why a cookie, and why this is the only Spotify step that matters</summary>

Spotify closed the endpoint that turned an `sp_dc` cookie into an access token — it now answers `400
usage of this endpoint is not permitted under the Spotify Developer Terms`, cookie or no cookie. The
token the web player itself uses still works on everything here, and it lasts about an hour.

Only a browser loading the player can mint one, so **the server carries a Chromium and drives it**.
With the cookie set, on a schedule — fifty minutes by default — it opens the player, reads the
`Authorization` header off the player's own request, and stores it. You paste a cookie once and never
paste a token again.

A cookie rather than a password, deliberately: `sp_dc` still authenticates the player, so nothing
stores a password and there is no login form for two-factor auth or a CAPTCHA to interrupt — the
difference between a job that runs for a year and one that breaks the first time Spotify shows a
challenge.
</details>

### Spotify application

**Gives you:** reliable ISRCs, cover art and album metadata. An ISRC is what lets every other source
be searched by *identity* instead of by a title that might match a cover, a live version, or a
different song with the same name.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app**
2. Name it anything. Tick **Web API** only
3. Any redirect URI will do — this grant never uses one, so `http://localhost:8787` is fine
4. Open the app → **Settings** → copy the **Client ID** and, under *View client secret*, the secret

Why bother: `api.spotify.com` rate-limits a web-player token so hard — a persistent `429` that
follows the token rather than the address — that the ISRC and cover art mostly never arrived. An
application token has documented quotas instead.

> [!NOTE]
> This does **not** replace the cookie. Lyrics are not in the public API at all, and the audio
> analysis was closed to applications registered after November 2024. Both still come from the
> player's own token.

### Spotify web token

**Gives you:** nothing the cookie does not, and it goes stale within the hour. Only worth pasting if
you want a working token immediately, before the first automatic refresh runs — or if you are not
setting a cookie at all.

1. Open [open.spotify.com](https://open.spotify.com) and play something
2. DevTools → **Network** → any request to `api-partner.spotify.com`
3. Copy the `Authorization` value, starting `Bearer BQ…`

---

## Musixmatch

**Gives you:** more of the catalogue. Musixmatch already works with **no token** — the server mints
an anonymous one on demand — so this is a coverage upgrade rather than a requirement.

Take the `usertoken` from a signed-in Musixmatch session, then paste it into **Musixmatch user
token**.

> [!TIP]
> Musixmatch rate-limits an anonymous token over a window longer than any per-request gap covers, and
> it answers `200` with the refusal *inside the body*. If a bulk re-lookup starts logging
> `matcher returned 401`, raise **the pause between tracks** in *Settings → Cache lifetime* and use
> **Pause** on the run rather than stopping it.

---

## NetEase

**Gives you:** higher per-IP limits and some regional catalogues. NetEase also works with no
credential at all.

1. Sign in at [music.163.com](https://music.163.com)
2. DevTools → **Application** → Cookies → `music.163.com`
3. Copy the cookie string

---

## When something stops working

| Symptom | Usually |
|---|---|
| Apple returns 403 | the [media user token](#apple-music) expired with the browser session |
| Apple stops entirely, badge shows a past date | the [developer token](#apple-music) finally expired |
| Spotify lyrics stop, admin page says no usable token | the [`sp_dc` cookie](#spotify-sp_dc-cookie) is a year old |
| No ISRC or cover art on new tracks | no [application credentials](#spotify-application), and the player token is rate-limited |
| Musixmatch logs `401` mid-run | throttled — raise the [bulk pause](#musixmatch) |

*Test the sources* on the **Sources** tab runs one real lookup through everything enabled and reports
what each source actually said. The **Log** tab filters by level and searches, which is usually faster
than guessing.
