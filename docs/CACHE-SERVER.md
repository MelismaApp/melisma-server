# Cache server contract

The server side of the contract the app defines in its own `docs/CACHE-SERVER.md`. Both
documents describe the same wire format; this one says how the server satisfies it and why the
two disagreements were settled the way they were.

Nothing needs configuring in the app beyond the URL. That is the point of the decisions below.

## The request

```
GET {baseUrl}/v1/lyrics?title=…&artist=…&album=…&durationMs=…&spotifyId=…
```

Sent by the app with no authentication and no identifying header. `title` and `artist` arrive
as the media session reported them, uncleaned — every provider here does its own cleaning, so
that is the right way round. `album` and `durationMs` are absent for a track read from a
player's queue, which publishes neither; `spotifyId` is present when playing from Spotify and
is the most useful of the five, because it lets Apple and the community database be queried by
id instead of searched for by name.

`isrc` is also accepted, and preferred over `spotifyId` when present. The app has no way to get
one from a media session so it never sends it — it is there for anything else that can.

A request for a track that is *about to* play looks identical to one for a track playing now.
The app prefetches the next queued item, and no special handling is needed: warming the cache
is the whole job.

## The response

`200` with the envelope the app expects:

```json
{
  "status": 200,
  "data": {
    "format": "ttml",
    "lyrics": "<?xml version=\"1.0\"?><tt …>",
    "source": "amll",
    "providerName": "AMLL TTML Database · timed by cybaka520",
    "key": "sp:7Cd17G3oNQ34OWUwS8ZxfR",
    "cache": "cache",
    "ms": 1
  }
}
```

`key`, `cache` and `ms` are not part of the contract; they are there for whoever is watching
what the server is doing.

**A document with no timing goes out as `format: "lrc"`** — plain text, one line per line —
because TTML has no way to say "unsynced". Serialising it anyway would mean
`itunes:timing="Line"` with every paragraph at 0 ms, and the app would believe it: ordinary
unsynced lyrics would render as line-synced and stuck at the start of the song. The app already
accepts LRC, so this costs nothing.

`404` means nothing was found. The body still carries the key and the full candidate list — the
app treats any non-2xx as "this source contributed nothing", so that detail is for a human
debugging it rather than for the client.

Two other formats are available to anything that asks, and the app never does:

| Query | Response |
|---|---|
| *(none)* | the envelope above |
| `format=ttml` | the bare TTML file, `application/ttml+xml` |
| `format=json` | `{key, source, ms, document}` — the structured model, used by the admin page |

`force=1` ignores the cache; `cacheOnly=1` answers only if it is already cached.

## Decision: TTML in an envelope, not a bespoke JSON document

The server originally returned its internal model as JSON. The app expects TTML — or LRC — in
an envelope. The app's design wins, for a reason that outlives this pairing:

**TTML loses nothing the app renders.** Syllable timings, duet agents, background vocals,
readings, translations with their declared language, songwriters — all of it is already in the
format, which is why Apple and the community database use it. There is a round-trip test.

**And it is a format other things already speak.** A bespoke JSON shape means the app can only
ever point at *this* server. TTML means it can point at a directory of files, a fork of
`amll-ttml-api`, or something not written yet. That is worth more than the small convenience of
the app skipping a parse it already has to be able to do anyway.

The structured model is still served under `format=json`, because the admin page wants the
provenance and the candidate list, not a serialisation.

### Attribution survives the hop

`providerName` is what the app prints under the last line. Without it every track would claim
to come from "a cache server" and the sources that did the work would go unnamed — including,
for the community database, the person who hand-timed the file.

It is built from the merge's provenance, so it says what actually happened:

```
AMLL TTML Database · timed by cybaka520
Musixmatch + NetEase translation, NetEase reading
LRCLIB + AMLL TTML Database timings
```

## Decision: no key for a lookup, always a key for the admin page

The app states that it sends no authentication, and suggests putting the server behind
something that handles it at the network layer. Taken literally that means the app cannot talk
to this server at all, since it required a key everywhere. Taken as advice it is worse than it
sounds: this database holds Apple Music and Spotify credentials, and "put a reverse proxy in
front of it" is more setup than pasting a key, not less.

But the two concerns are not actually in tension, because they are about different surfaces:

- **`/admin/*` can read a credential.** It always requires the API key, or a session cookie
  obtained by presenting it. No exceptions.
- **A lookup can only cause a lyric lookup.** Nothing in `/v1/lyrics`, `/v1/health` or
  `/v1/warm` returns a token or stores anything a caller chose. So a request from this machine
  or from a private network address is allowed through without a key.
- **`/v1/contribute` writes to the archive permanently**, so it is on the admin side of the
  line and always wants the key. An allowlist of routes rather than a `/v1/` prefix, because the
  prefix would have let anything on the Wi-Fi persist arbitrary lyrics into the merge.

The result: the app works exactly as written, the credentials are never reachable without the
key, and a server exposed to the internet is not open by default. An explicit `Authorization:
Bearer` header that does *not* match is still an error rather than something to shrug off and
fall back on — a wrong credential should fail loudly.

The check uses the connecting socket's address and never `X-Forwarded-For`, which is whatever
the client says it is.

**The one case this cannot see:** a public reverse proxy on the same host, whose connections
look local no matter who is really on the other end. Turn off **Settings → Allow the local
network to look lyrics up without the key** for that, and give the app the key.

## Everything that is not the words

`GET /v1/extras` and `POST /v1/extras`, both documented on the app's side. Two things are worth
saying here about *why* the server holds what it holds.

**It collects more than anything reads.** After every lookup, `harvest.ts` asks whatever tokens
are configured for the rest of what they know and files it. The reason is that the tokens are the
scarce resource, not the storage: a Spotify access token is good for about an hour, an Apple
developer token for a few months, and `audio-attributes` — which carries the tempo, the key, the
loudness and the beat, bar and section grids — was withdrawn from the public Web API in November
2024, so a cached copy is the only durable one that exists. A field nobody reads today costs a
few hundred bytes. A field nobody collected today is gone.

What is kept, and what is not: `segments` is dropped. It is one entry per note-level event with a
twelve-value timbre vector each, megabytes for a long track, and nothing a lyrics renderer will
ever read. `beats`, `bars` and `sections` are two orders of magnitude smaller and are the part
that could actually change the rendering — a background can pulse on the beat grid rather than
drift at a rate derived from the tempo.

**Identity is not presentation.** An ISRC and an authoritative duration go on the `entries` row,
not into the extras payload, because the code that needs them is the matcher rather than the
renderer. An ISRC identifies a recording globally and never goes stale, which turns a fuzzy name
match into an exact lookup for every later caller — and the community TTML database indexes on it
directly. An authoritative duration in milliseconds turns the matcher's duration term from a
neutral 0.5 into a decision, which is precisely what is missing for AMLL results, since that
corpus carries no durations at all.

Both are only ever filled in, never overwritten. The first source to identify a recording is as
good as the second, and overwriting invites a worse answer to replace a better one.

One consequence worth knowing: a contribution carrying an ISRC is filed under the *name* key, not
the ISRC key. `cacheKey` prefers an ISRC when it has one, so keying on an ISRC that arrived in
this very request would file the extras under an identity no reader has yet — a phone with no
token knows a title and an artist, which is why it is asking in the first place.

## What the server deliberately does not do

- **Interludes.** The app inserts its own three-dot lines from the gaps between lines. The
  server never emits one.
- **Romanization or translation it would have to generate.** Only what a source actually
  supplied is passed on. Kuromoji and ML Kit are on the phone and belong there — the server
  would be guessing where the app can do it properly, per syllable, into the language the user
  actually chose.

## Two endpoints the app does not use yet

Both exist; neither is needed for the app to work.

```
POST /v1/warm        {title, artist, album, durationMs, spotifyId?}
```

Returns `202` and resolves in the background. The app's current prefetch does a plain `GET`
instead, which warms the cache just as well and needs no extra code — the only difference is
that it waits for a response nobody reads.

```
POST /v1/contribute  {track:{…}, provider, format:"lrc"|"ttml"|"json", body}
```

For lyrics the app found and the server could not: the phone can reach a region-locked
endpoint, or a provider whose rate limit the server's address has hit. Archived as
`app:<provider>` so it can never overwrite a real fetch, and merged in immediately — a
contributed translation can end up attached to timings the server found itself.

Requires the API key, since it writes to the archive permanently — the local-network exception
does not cover it.

Validated with the same reader that will re-merge it later, so a body cannot be accepted and
then silently never used. Markup that is not TTML is refused: the realistic accident is an error
page arriving where lyrics were expected, and a permanent archive entry reading `502 Bad Gateway`
is worse than a rejection. Plain text with no timestamps is accepted, because unsynced lyrics
are a real answer.
