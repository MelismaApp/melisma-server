# Wiring the app to this server

The contract, written down so the app side can be built without reading the server's source.

The intent is that the server is **additive**: the app keeps its own providers and its own
cache exactly as they are, and asks the server *alongside* them. If the server is off,
unreachable, or the toggle is off, nothing changes. That is what makes it safe to leave behind
a developer switch while it is still being tested.

## What the app needs

Two settings, behind a developer menu:

| Setting | Default | Notes |
|---|---|---|
| Server enabled | off | Off means the app never contacts it |
| Server URL | empty | e.g. `http://192.168.1.20:8787` |
| API key | empty | Printed by the server on first boot |

The key goes in `Authorization: Bearer <key>` on every request.

## Asking for lyrics

```
GET {base}/v1/lyrics
      ?title=…&artist=…&album=…&durationMs=…
      [&spotifyId=…] [&isrc=…]
      [&cacheOnly=1]
```

Send the Spotify track id whenever the media session gave one — it identifies the recording
rather than describing it, and it lets the server hit Apple and the community database by id
instead of searching by name.

`200` with:

```json
{
  "key": "sp:7Cd17G3oNQ34OWUwS8ZxfR",
  "source": "cache",
  "ms": 1,
  "document": {
    "kind": "syllable",
    "language": "ja",
    "songWriters": ["米津玄師"],
    "hasRomanization": true,
    "hasTranslation": true,
    "lines": [
      {
        "role": "lead",
        "startMs": 1372,
        "endMs": 2705,
        "text": "夢ならば",
        "syllables": [
          { "text": "夢", "startMs": 1372, "endMs": 1749, "partOfWord": false }
        ],
        "oppositeAligned": false,
        "rtl": false,
        "romanized": "yu me na ra ba",
        "translated": "如果只是一场梦",
        "translationLang": "zh-CN"
      }
    ],
    "provenance": {
      "timing": "amll",
      "syllables": ["musixmatch"],
      "translation": "netease",
      "romanization": "amll",
      "songWriters": ["netease"]
    },
    "candidates": [ … ],
    "algorithmVersion": 1
  }
}
```

`404` means nothing was found. The body still carries `key`, `source` and `candidates`, which
is what makes a failure diagnosable rather than just empty.

The `document` shape is deliberately the app's own model:

| Field | Maps to |
|---|---|
| `kind` | `LyricsKind` — `syllable` / `line` / `static` |
| `lines[].role` | `LineRole` — `lead` / `background` / `interlude` |
| `lines[].syllables[].partOfWord` | `Syllable.partOfWord` |
| `lines[].oppositeAligned` | duet alignment |
| `romanized` / `translated` | the line's reading and translation |

Two things the server deliberately does **not** do, because the app already does them better:

- **Interludes.** The app inserts its own three-dot lines from the gaps. The server never
  emits `role: "interlude"`.
- **Romanization and translation it could generate.** The server only ever passes on what a
  source actually supplied. Kuromoji and ML Kit are on the phone and stay there.

## Running it beside the normal lookup

The useful shape while testing: fire both, take the better answer.

```kotlin
// Sketch, not final code — the app side is a separate piece of work.
val local = async { normalLookup(request) }
val remote = async { if (settings.serverEnabled) serverLookup(request) else null }

// The server merges every source including the ones the app asks itself, so when it answers
// at all it is the more complete document. Falling back rather than replacing means a server
// that is off, slow or wrong costs nothing.
val document = remote.await() ?: local.await()
```

Worth being careful about:

- **Timeout it short and never block on it.** A server that is asleep must not delay lyrics
  the app could have found on its own.
- **Compare before preferring.** The app's `qualityScore` already ranks word-timed above
  line-timed; run the server's answer through the same comparison rather than trusting it
  because it is the server's.
- **Cache the server's answer like any other provider's.** It is one more source, not a
  different tier.

## Prefetching

```
POST {base}/v1/warm
{"title": "…", "artist": "…", "album": "…", "durationMs": 255000, "spotifyId": "…"}
```

Returns `202` immediately and resolves in the background. Send it for the next queued track,
under the same guard the app already uses — only when the queue entry has a Spotify id or a
duration, so the key it warms is the key that will be read back.

## Contributing back

The phone reaches things the server sometimes cannot: a region-locked endpoint, or a provider
whose rate limit the server's IP has hit. Anything the app found is worth adding to the
archive.

```
POST {base}/v1/contribute
{
  "track":    { "title": "…", "artist": "…", "durationMs": 255000, "spotifyId": "…" },
  "provider": "musixmatch",
  "format":   "lrc",
  "body":     "[00:01.00]<00:01.00>…"
}
```

`format` is `lrc`, `ttml` or `json` (the app's own document model). It is archived as
`app:<provider>` — never overwriting a real fetch — and the track is re-merged immediately, so
a contributed translation can end up attached to timings the server found itself.

Only send this for documents the app is confident about. It is stored permanently.

## Checking the connection

```
GET {base}/v1/health
```

Returns each source with `enabled`, `configured` and `wordLevel`, plus cache counts. Enough
for the developer menu to show "server reachable, 4 of 6 sources ready" rather than a
checkbox with no feedback.
