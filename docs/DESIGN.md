# Design notes

Why the server does what it does. The [README](../README.md) covers running it; this covers the
decisions. The API contract has its own page: [CACHE-SERVER.md](CACHE-SERVER.md).

## The merge

The timing is not negotiable. Mixing two sources' timings produces something worse than either,
because a lyric half a second out is harder to sing to than one with no timing at all. So one source
is chosen to own it, and everything else is borrowed.

1. **Ask every enabled source at once.** In parallel, not in turn — a fallback chain stops at the
   first answer, and the first answer is rarely the best one.
2. **Pick the backbone.** Word-timed beats line-timed beats unsynced. Within a tier, the user's
   priority breaks the tie. A candidate holding far fewer lines than the others is passed over: a
   six-line file for a forty-line song is a fragment or a wrong match, and letting it win because it
   is word-timed would throw away most of the song.
3. **Line the others up against it.** Needleman–Wunsch over the line sequences, scoring each pair on
   text similarity and timing proximity. Order-preserving by construction — two sources may disagree
   about how many lines a chorus is, but never about what comes before what.
4. **Borrow, one field at a time.**
   - *Syllables*, for lines the backbone has none for. Accepted only when the words match and a
     uniform shift of under 1.5 s puts them inside the line's window. Never stretched.
   - *Translations*, preferring a source whose declared language matches yours. Otherwise a Chinese
     translation of a Japanese song wins by being first, which is no use to an English reader.
   - *Readings*, per-syllable when the two sources split the line identically, whole-line otherwise.
   - *Background vocals*, *duet parts*, *songwriters*, *language*.
5. **Check after every borrow.** Monotonic lines, ordered syllables inside their line's window.
   Anything that breaks an invariant is rolled back, so a bad source can leave the result no better
   than the backbone but never worse.

Text is never overwritten from another source. Only blanks are filled.

## Identity before words

A title is a weak identifier — covers, live versions, remasters and two different songs with the
same name all collide. An ISRC is exact.

So a lookup resolves *identity* first where it can: the Spotify id or the ISRC is established, then
the other sources are searched by that rather than by a name. This is the main reason the Spotify
application credentials are worth setting up; `api.spotify.com` rate-limits a web-player token far
too hard to depend on for it.

Tracks first cached before this existed were matched on title alone. **Fill in missing ISRCs** and
then **Look up again** in the admin page revisits them with what is known now — and takes care that
a re-lookup updates the original entry rather than filing a second one under a key that has since
changed.

## Why keep every raw response

Because the merge will get better, and a merged document is only as good as the algorithm that
produced it. Every provider's raw body is archived next to the merged result, so improving the merge
is a local recompute over data already on disk rather than thousands of fresh requests to services
doing this for free. Bump `MERGE_VERSION` and everything is rebuilt on the next boot, offline.

It is also good manners. LRCLIB asks people not to hammer it, and the AMLL endpoint is one
volunteer's server. A cache turns one query per track *ever* into the steady state.

## An outage is never written down as an answer

A 404 means this track has no lyrics here, and is worth remembering. A timeout, a 429, a 5xx or an
expired token means the question never got through. Recording the second as the first would hide the
track for the whole negative TTL and, on a refresh, replace a document that was perfectly good.

So when nothing is found and something was unreachable, the cache is left exactly as it was and
whatever was already there is served. Each attempt is recorded with its outcome, and a cache hit
re-asks only the sources that never got to answer — in the background, then re-merges. A source that
answered "no lyrics for this track" is left alone: that is a real answer, and re-asking it every play
would be wasted requests for a result that will not change.

The same care applies to a source that refuses in the body rather than the status. Musixmatch answers
`200` with a rate-limit code inside, which the transport cannot see — so that path reports itself
unreachable and backs the host off, rather than being filed as a settled miss for every track in a
bulk run.

## Keeping the Spotify token alive

Spotify closed the endpoint that turned an `sp_dc` cookie into an access token — it answers `400
usage of this endpoint is not permitted under the Spotify Developer Terms`, cookie or no cookie. The
token the web player itself uses still works on everything here, and it lasts about an hour.

Only a browser can mint one, so **the image carries a Chromium and the server drives it**. Paste an
`sp_dc` cookie and that is the whole setup: on a schedule the server opens the player, reads the
`Authorization` header off the player's own request, and stores it. One deployment, nothing to point
at, no second container.

A cookie rather than a password, deliberately. `sp_dc` still authenticates the *player* even though
it can no longer be traded for a token, so nothing stores a password and there is no login form for
two-factor auth or a CAPTCHA to interrupt — the difference between a job that runs for a year and one
that breaks the first time Spotify shows a challenge. The cookie lasts about a year.

Nothing here defeats a protection: it signs in as you, with your own cookie, and takes a header your
browser would have received anyway.

### No Playwright

The harvest talks to Chromium over the DevTools protocol directly. `src/browser/cdp.ts` is about two
hundred lines and Node 24 already has the WebSocket client it needs. Playwright would bundle its own
Chromium and a native toolchain on top of Alpine's, and be the server's only npm dependency, for a
job with no forms to fill in and no elements to wait for.

If the harvest ever *does* need to drive a login form, that trade is worth revisiting — a form is
where a real library earns its size.

### The external override

`BL_TOKEN_REFRESH_COMMAND` replaces the built-in harvest with a command whose stdout is JSON of
token name to value:

```json
{"spotifyWebToken": "BQD…", "appleMediaUserToken": "Aq…"}
```

For renewing something the built-in harvest knows nothing about, or for driving a browser on a
machine with a residential IP — challenged far less often than a datacenter one.
`examples/refresh-spotify-token.mjs` is a Playwright script that does exactly this, including the
username-and-password path.

It comes from the environment and **cannot be set from the admin page**: an admin session should not
get to choose what the host executes, or one stolen key becomes arbitrary code on the machine holding
your Apple tokens.

## Rate limits, and bulk operations

Each host has a minimum interval between requests, which keeps a single lookup polite. It says
nothing about a hundred lookups in a row, and Musixmatch's guest token is limited over a longer
window than any per-request gap covers.

So a bulk re-lookup has its own delay between tracks (**Settings → Cache lifetime**), and can be
paused and resumed while it runs. Pause matters more than stop: a re-lookup forces past the cache, so
abandoning a long run and starting again re-spends every request already made. Resuming re-reads the
delay, which is the point — you see a source throttling, hold the run, raise the delay, let it go on.

## Security posture

The whole of it, stated plainly:

- The database holds your Spotify cookie and Apple tokens **in the clear**. Not encrypted at rest,
  because a passphrase on every boot is the wrong trade for a personal service.
- The file is `chmod 600`, and the server binds to `127.0.0.1` by default.
- `/admin/*` always demands the API key, or a session cookie obtained by presenting it. It is the
  only surface that can read a credential.
- A *lookup* can only cause a lyric fetch, so it is allowed from this machine or the private network
  without a key — that is what lets the app work while sending no authentication.
- The local-network exception is refused whenever an `X-Forwarded-For` header is present, because a
  reverse proxy on the same host looks local no matter who is really behind it.
- Secrets are masked in the admin API — reading one back in full takes a separate explicit request —
  and stripped from the log before anything is written.

That is not defence in depth. It is enough for one machine holding one person's tokens, and it is
the reason [Sharing it](../README.md#sharing-it) says what it says.
