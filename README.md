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

`npm test` runs the suite. `npm run dev` restarts on change.

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

## API

Every `/v1` route wants `Authorization: Bearer <api key>`.

```
GET  /v1/health
GET  /v1/lyrics?title=&artist=&album=&durationMs=&spotifyId=&isrc=
     &format=json|ttml  &force=1  &cacheOnly=1
POST /v1/warm        {title, artist, album, durationMs, spotifyId?, isrc?}
POST /v1/contribute  {track:{…}, provider, format:"lrc"|"ttml"|"json", body}
```

`GET /v1/lyrics` returns `{key, source, ms, document}` where `document` is the same shape the
app renders, plus a `provenance` block naming which source supplied what. `404` means nothing
was found, and the body still lists every candidate and why it lost. `X-Cache` is `cache`,
`remerge`, `network` or `absent`.

`format=ttml` returns the merged document as TTML — readable by the app, by the community
tooling, and by this server again.

`POST /v1/contribute` accepts lyrics the app found and the server could not: the phone can
reach a region-locked endpoint or a provider whose rate limit the server hit. It is archived
under `app:<provider>` so it can never overwrite a real fetch, and it joins the merge from
then on. See [docs/APP-INTEGRATION.md](docs/APP-INTEGRATION.md).

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
cookie and Apple tokens **in the clear** — not encrypted at rest, because a passphrase on
every boot is the wrong trade for a personal service. It is `chmod 600`, it binds to
`127.0.0.1` by default, and secrets are masked in the admin API and stripped from the log.
That is the whole of it. Put nothing in front of it that you would not put a password
manager behind.

## Credits

The sources, none of them affiliated with this:
[AMLL TTML Database](https://github.com/amll-dev/amll-ttml-db) (CC0, community-timed),
[LRCLIB](https://lrclib.net), NetEase Cloud Music, Musixmatch, Spotify, Apple Music.

Lyrics belong to their writers and publishers. This stores a cache on one machine.
