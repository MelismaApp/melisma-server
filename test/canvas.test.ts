import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { Settings } from '../src/config.ts';
import { Store, type StoredCanvas } from '../src/db.ts';
import {
  backfillCanvas,
  canvasBackfillProgress,
  CANVAS_RECHECK_MS,
  canvasIsDue,
  harvest,
  harvestCanvas,
  readCanvas,
} from '../src/harvest.ts';
import { concat, decode, integer, lengthDelimited, submessages, text } from '../src/protobuf.ts';
import { createApp, start, type App } from '../src/server.ts';

/**
 * Spotify Canvas: reading the undocumented reply, deciding when to ask, and serving it only for the
 * Spotify id it was fetched for.
 *
 * The replies here are built from the field numbers observed on the live endpoint, since there is no
 * published schema to build them from.
 */

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const OTHER = '7qiZfU4dY1lWllzX7mPBI3';
const VIDEO = `https://canvaz.scdn.co/upload/artist/abc/video/${ID}.cnvs.mp4`;

function varint(field: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let left = field * 8; ; ) {
    const byte = left % 128;
    left = Math.floor(left / 128);
    bytes.push(left > 0 ? byte | 0x80 : byte);
    if (left === 0) break;
  }
  for (let left = value; ; ) {
    const byte = left % 128;
    left = Math.floor(left / 128);
    bytes.push(left > 0 ? byte | 0x80 : byte);
    if (left === 0) break;
  }
  return Uint8Array.from(bytes);
}

function canvasMessage(
  entity: string,
  url: string,
  /** `[height, width, url]`, in field order. */
  stills: Array<[number, number, string]> = [],
): Uint8Array {
  return lengthDelimited(
    1,
    concat([
      lengthDelimited(1, 'c0ffee'),
      lengthDelimited(2, url),
      lengthDelimited(3, 'f11e'),
      varint(4, 3),
      lengthDelimited(5, `spotify:track:${entity}`),
      lengthDelimited(
        6,
        concat([
          lengthDelimited(1, 'spotify:artist:abc'),
          lengthDelimited(2, 'Someone'),
          lengthDelimited(3, 'https://i.scdn.co/image/a'),
        ]),
      ),
      lengthDelimited(8, 'artist'),
      lengthDelimited(11, 'spotify:canvas:c0ffee'),
      ...stills.map(([height, width, stillUrl]) =>
        lengthDelimited(
          13,
          concat([varint(1, height), varint(2, width), lengthDelimited(3, stillUrl)]),
        ),
      ),
    ]),
  );
}

const TTL = varint(2, 3600);

let app: App;
let server: ReturnType<typeof start>;
let base: string;

before(async () => {
  app = createApp(':memory:');
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  app.store.close();
});

// ---- the wire format ------------------------------------------------------

test('a message decodes into its fields, repeated ones in order', () => {
  const message = decode(concat([lengthDelimited(1, 'a'), varint(2, 300), lengthDelimited(1, 'b')]));
  assert.deepEqual(
    message.get(1)!.map((field) => new TextDecoder().decode(field.value as Uint8Array)),
    ['a', 'b'],
  );
  assert.equal(integer(message, 2), 300);
});

test('a varint past 32 bits is not wrapped', () => {
  // `<<` is 32-bit in JavaScript; a reader built on it would return a negative number here.
  assert.equal(integer(decode(varint(1, 2 ** 40 + 5)), 1), 2 ** 40 + 5);
});

test('fixed-width fields are stepped over, not misread as the rest of the message', () => {
  const fixed32 = Uint8Array.from([(3 << 3) | 5, 1, 2, 3, 4]);
  const fixed64 = Uint8Array.from([(4 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8]);
  const message = decode(concat([fixed32, fixed64, lengthDelimited(5, 'after')]));
  assert.equal(text(message, 5), 'after');
  // Only a varint is returned as a number.
  assert.equal(integer(message, 3), null);
});

test('a truncated message throws rather than returning half of itself', () => {
  const whole = lengthDelimited(1, 'hello');
  assert.throws(() => decode(whole.subarray(0, whole.length - 1)), /past the end/);
  assert.throws(() => decode(Uint8Array.from([0x80, 0x80])), /varint/);
});

test('a field that is not a message is skipped by submessages, not fatal', () => {
  // Field 1 here is a string whose bytes are not valid protobuf; the real message beside it still reads.
  const message = decode(
    concat([
      lengthDelimited(1, Uint8Array.from([0xff, 0xff])),
      lengthDelimited(1, lengthDelimited(2, 'ok')),
    ]),
  );
  assert.deepEqual(submessages(message, 1).map((sub) => text(sub, 2)), ['ok']);
});

// ---- reading a reply ------------------------------------------------------

test('a Canvas is read with its stills, smallest first, height before width on the wire', () => {
  // The sizes of a live record's stills, for a 1080×1920 video.
  const canvas = readCanvas(
    concat([
      canvasMessage(ID, VIDEO, [
        [512, 288, 'https://i.scdn.co/image/ab67ba6900002e9f'],
        [256, 144, 'https://i.scdn.co/image/ab67ba6900002ea6'],
      ]),
      TTL,
    ]),
    ID,
  );
  assert.equal(canvas?.url, VIDEO);
  assert.equal(canvas?.spotifyId, ID);
  assert.deepEqual(canvas?.thumbnails, [
    { width: 144, height: 256, url: 'https://i.scdn.co/image/ab67ba6900002ea6' },
    { width: 288, height: 512, url: 'https://i.scdn.co/image/ab67ba6900002e9f' },
  ]);
  assert.equal(canvas?.type, 3);
  assert.equal(canvas?.artistName, 'Someone');
  assert.equal(canvas?.uri, 'spotify:canvas:c0ffee');
});

test('a reply with only the TTL is Spotify saying there is no Canvas', () => {
  assert.deepEqual(readCanvas(TTL, ID), { spotifyId: ID, url: null, thumbnails: [] });
});

test('a Canvas for a different track is not an answer about this one', () => {
  // Null, not "none": recording "none" here would hide a real Canvas for a week.
  assert.equal(readCanvas(concat([canvasMessage(OTHER, VIDEO), TTL]), ID), null);
});

test('a URL the app would drop is recorded as no Canvas', () => {
  for (const url of ['http://canvaz.scdn.co/x.mp4', 'https://example.com/x.mp4', 'not a url']) {
    assert.equal(readCanvas(canvasMessage(ID, url), ID)?.url, null, url);
  }
  const stills = readCanvas(
    canvasMessage(ID, VIDEO, [[256, 144, 'https://evil.example/256.jpg']]),
    ID,
  )?.thumbnails;
  assert.deepEqual(stills, []);
});

test('a reply that is not protobuf throws', () => {
  assert.throws(() => readCanvas(new TextEncoder().encode('{"error":"nope"}'), ID));
});

// ---- when to ask ----------------------------------------------------------

function extrasWith(canvas: StoredCanvas | null, checkedAt: number | null) {
  const store = new Store(':memory:');
  if (canvas) store.saveCanvas(`sp:${canvas.spotifyId}`, canvas, checkedAt ?? Date.now());
  return store.extras(`sp:${ID}`, { hit: false });
}

test('a Canvas is due when never asked, and again after a week — "none" included', () => {
  const now = Date.now();
  assert.equal(canvasIsDue(null, ID, now), true);

  const none = { spotifyId: ID, url: null, thumbnails: [] };
  assert.equal(canvasIsDue(extrasWith(none, now - 1_000), ID, now), false);
  assert.equal(canvasIsDue(extrasWith(none, now - CANVAS_RECHECK_MS - 1), ID, now), true);

  const found = { spotifyId: ID, url: VIDEO, thumbnails: [] };
  assert.equal(canvasIsDue(extrasWith(found, now - 1_000), ID, now), false);
  assert.equal(canvasIsDue(extrasWith(found, now - CANVAS_RECHECK_MS - 1), ID, now), true);
});

test('never due without a real Spotify id', () => {
  assert.equal(canvasIsDue(null, undefined), false);
  assert.equal(canvasIsDue(null, 'spotify:track:x'), false);
  assert.equal(canvasIsDue(null, `${ID}/../x`), false);
});

// ---- the store ------------------------------------------------------------

test('an answer replaces the last one, and a re-check that changed nothing is not an update', () => {
  const store = new Store(':memory:');
  const key = `sp:${ID}`;
  store.saveCanvas(key, { spotifyId: ID, url: VIDEO, thumbnails: [] }, 1_000);
  store.saveCanvas(key, { spotifyId: ID, url: VIDEO, thumbnails: [] }, 2_000);
  let held = store.extras(key, { hit: false })!;
  assert.equal(held.canvasCheckedAt, 2_000);
  assert.equal(held.updatedAt, 1_000);

  // Removed since: the old URL must not survive.
  store.saveCanvas(key, { spotifyId: ID, url: null, thumbnails: [] }, 3_000);
  held = store.extras(key, { hit: false })!;
  assert.equal(held.canvas?.url, null);
  assert.equal(held.updatedAt, 3_000);
});

test('a Canvas stored before the stills were identified reads with them the right way round', () => {
  const store = new Store(':memory:');
  const legacy = { spotifyId: ID, url: VIDEO, variants: [{ width: 256, height: 144, url: 'https://i.scdn.co/image/a' }] };
  store.saveCanvas(`sp:${ID}`, legacy as unknown as StoredCanvas);
  const canvas = store.extras(`sp:${ID}`, { hit: false })?.canvas as unknown as Record<string, unknown>;
  assert.deepEqual(canvas.thumbnails, [{ width: 144, height: 256, url: 'https://i.scdn.co/image/a' }]);
  assert.equal(canvas.variants, undefined);
});

test('a Canvas does not disturb the rest of the extras', () => {
  const store = new Store(':memory:');
  const key = `sp:${ID}`;
  store.saveExtras({ key, title: 'Song', artist: 'Someone', tempo: 120, source: 'spotify' });
  store.saveCanvas(key, { spotifyId: ID, url: VIDEO, thumbnails: [] });
  store.saveExtras({ key, coverUrl: 'https://i.scdn.co/image/c', source: 'applemusic' });
  const held = store.extras(key, { hit: false })!;
  assert.equal(held.tempo, 120);
  assert.equal(held.canvas?.url, VIDEO);
  assert.equal(held.coverUrl, 'https://i.scdn.co/image/c');
});

test('the backfill queue is Spotify-keyed tracks without a current answer', () => {
  const store = new Store(':memory:');
  const now = Date.now();
  store.saveExtras({ key: `sp:${ID}`, title: 'Fresh', source: 'spotify' });
  store.saveExtras({ key: `sp:${OTHER}`, title: 'Checked', source: 'spotify' });
  store.saveCanvas(`sp:${OTHER}`, { spotifyId: OTHER, url: null, thumbnails: [] }, now);
  store.saveExtras({ key: 'q:song|someone|100', title: 'No id', source: 'applemusic' });
  assert.deepEqual(store.keysNeedingCanvas(now - CANVAS_RECHECK_MS), [`sp:${ID}`]);
  assert.deepEqual(
    store.keysNeedingCanvas(now + 1).sort(),
    [`sp:${ID}`, `sp:${OTHER}`].sort(),
  );
});

// ---- asking Spotify -------------------------------------------------------

const realFetch = globalThis.fetch;
let asked: Array<{ url: string; body: Uint8Array | null; headers: Record<string, string> }> = [];
let reply: (entity: string) => Response;

function stubSpotify() {
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // Anything else reaching the network from here is a test that fails on a train.
    if (!url.startsWith('https://spclient.wg.spotify.com/canvaz-cache/')) {
      throw new Error(`unexpected request to ${url}`);
    }
    const body = init?.body instanceof Uint8Array ? init.body : null;
    asked.push({ url, body, headers: init?.headers as Record<string, string> });
    const entity = body ? text(submessages(decode(body), 1)[0]!, 1)!.slice('spotify:track:'.length) : '';
    return reply(entity);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function protobuf(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status, headers: { 'Content-Type': 'application/protobuf' } });
}

function withToken() {
  const store = new Store(':memory:');
  const settings = new Settings(store);
  settings.update({ 'secret.spotifyWebToken': 'Bearer a-player-token' });
  return { store, config: settings.read() };
}

const quiet = () => {};

test('the request is the entity URI as protobuf, with the player token', async () => {
  stubSpotify();
  reply = (entity) => protobuf(concat([canvasMessage(entity, VIDEO), TTL]));
  const { store, config } = withToken();

  const result = await harvestCanvas(store, config, `sp:${ID}`, ID, quiet);
  assert.equal(result.canvas?.url, VIDEO);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.headers.Authorization, 'Bearer a-player-token');
  assert.equal(asked[0]!.headers['Content-Type'], 'application/x-protobuf');
  assert.equal(store.extras(`sp:${ID}`, { hit: false })?.canvas?.url, VIDEO);
});

test('a failed request records nothing, so a held Canvas survives it', async () => {
  stubSpotify();
  const { store, config } = withToken();
  store.saveCanvas(`sp:${ID}`, { spotifyId: ID, url: VIDEO, thumbnails: [] }, 1_000);

  for (const status of [401, 500]) {
    reply = () => new Response('{"error":"no"}', { status });
    const result = await harvestCanvas(store, config, `sp:${ID}`, ID, quiet);
    assert.equal(result.canvas, null);
    assert.equal(result.status, status);
  }
  const held = store.extras(`sp:${ID}`, { hit: false })!;
  assert.equal(held.canvas?.url, VIDEO);
  assert.equal(held.canvasCheckedAt, 1_000);
});

test('an empty reply is no answer either, so it does not record "none"', async () => {
  stubSpotify();
  const { store, config } = withToken();
  store.saveCanvas(`sp:${ID}`, { spotifyId: ID, url: VIDEO, thumbnails: [] }, 1_000);

  reply = () => protobuf(new Uint8Array(0));
  assert.equal((await harvestCanvas(store, config, `sp:${ID}`, ID, quiet)).canvas, null);
  const held = store.extras(`sp:${ID}`, { hit: false })!;
  assert.equal(held.canvas?.url, VIDEO);
  assert.equal(held.canvasCheckedAt, 1_000);
});

test('without a player token, nothing is asked', async () => {
  stubSpotify();
  const store = new Store(':memory:');
  const config = new Settings(store).read();
  assert.deepEqual(await harvestCanvas(store, config, `sp:${ID}`, ID, quiet), {
    canvas: null,
    status: 0,
  });
  assert.equal(asked.length, 0);
});

test('the backfill asks each Spotify track once and records both answers', async () => {
  stubSpotify();
  reply = (entity) =>
    entity === ID ? protobuf(concat([canvasMessage(ID, VIDEO), TTL])) : protobuf(TTL);
  const { store, config } = withToken();
  store.saveExtras({ key: `sp:${ID}`, title: 'Has one', source: 'spotify' });
  store.saveExtras({ key: `sp:${OTHER}`, title: 'Has none', source: 'spotify' });
  store.saveExtras({ key: 'q:song|someone|100', title: 'No id', source: 'applemusic' });

  const messages: string[] = [];
  const run = backfillCanvas(store, config, (_level, message) => messages.push(message), 0);
  assert.equal(run.pending, 2);
  // One at a time: a second run would ask every track twice.
  assert.match(backfillCanvas(store, config, quiet).skipped ?? '', /^already filling in Canvas — \d+ of 2$/);
  assert.equal(canvasBackfillProgress().running, true);
  assert.equal(canvasBackfillProgress().total, 2);
  await run.done;

  assert.equal(asked.length, 2);
  assert.equal(store.extras(`sp:${ID}`, { hit: false })?.canvas?.url, VIDEO);
  assert.equal(store.extras(`sp:${OTHER}`, { hit: false })?.canvas?.url, null);
  assert.ok(store.extras(`sp:${OTHER}`, { hit: false })?.canvasCheckedAt);
  assert.match(messages.at(-1)!, /1 of 2 tracks have one, 1 have none/);
  // Said at the start too, so a run of several minutes is visible from its first second.
  assert.match(messages[0]!, /asking Spotify about 2 tracks/);
  assert.deepEqual(
    { ...canvasBackfillProgress(), startedAt: 0 },
    { running: false, total: 2, done: 2, found: 1, none: 1, startedAt: 0, stopped: null },
  );

  // Both answered, so a second run has nothing to do.
  assert.equal(backfillCanvas(store, config, quiet).pending, 0);
});

test('the backfill stops at a refused token rather than grinding through the rest', async () => {
  stubSpotify();
  reply = () => new Response('', { status: 401 });
  const { store, config } = withToken();
  store.saveExtras({ key: `sp:${ID}`, title: 'One', source: 'spotify' });
  store.saveExtras({ key: `sp:${OTHER}`, title: 'Two', source: 'spotify' });

  const messages: string[] = [];
  await backfillCanvas(store, config, (_level, message) => messages.push(message), 0).done;
  assert.equal(asked.length, 1);
  assert.match(messages.at(-1)!, /stopped at HTTP 401, 1 not reached/);
  assert.equal(canvasBackfillProgress().stopped, 'stopped at HTTP 401');
  assert.equal(store.keysNeedingCanvas(Date.now()).length, 2);
});

test('a track whose other extras are complete is still asked about its Canvas, once an hour', async () => {
  stubSpotify();
  reply = (entity) => protobuf(concat([canvasMessage(entity, VIDEO), TTL]));
  const app = createApp(':memory:');
  try {
    app.settings.update({ 'secret.spotifyWebToken': 'a-player-token' });
    const key = `sp:${ID}`;
    // Everything the old guard looked for, so the full harvest is skipped.
    app.store.saveExtras({
      key,
      title: 'Complete',
      artistImageUrl: 'https://i.scdn.co/image/artist',
      analysis: { track: { tempo: 120 } },
      source: 'spotify',
    });
    app.store.noteIdentity(key, { isrc: 'GBUM71029604' });

    const track = { title: 'Complete', artist: 'Someone', album: '', durationMs: 200_000, spotifyId: ID };
    const harvestOnce = (app.resolver as unknown as {
      harvestOnce(config: unknown, key: string, track: unknown): Promise<void>;
    }).harvestOnce.bind(app.resolver);

    await harvestOnce(app.settings.read(), key, track);
    assert.equal(asked.length, 1);
    assert.equal(app.store.extras(key, { hit: false })?.canvas?.url, VIDEO);

    await harvestOnce(app.settings.read(), key, track);
    assert.equal(asked.length, 1);
    // The server's own reads are not somebody asking about the track.
    assert.equal(app.store.library({ search: 'Complete' }).rows[0]?.hits, 0);
  } finally {
    app.store.close();
  }
});

test('the full harvest keeps a Canvas even when every other Spotify call failed', async () => {
  // The stub refuses the catalogue and the analysis, which is a 429'd token on a bad day.
  stubSpotify();
  reply = (entity) => protobuf(concat([canvasMessage(entity, VIDEO), TTL]));
  const { store, config } = withToken();
  const track = { title: 'New', artist: 'Someone', album: '', durationMs: 200_000, spotifyId: ID };

  await harvest(store, config, `sp:${ID}`, track);
  assert.equal(store.extras(`sp:${ID}`, { hit: false })?.canvas?.url, VIDEO);

  // And never for an id the caller did not give.
  const unnamed = withToken();
  await harvest(unnamed.store, unnamed.config, 'q:new|someone|100', { ...track, spotifyId: undefined });
  assert.equal(asked.length, 1);
});

test('a Canvas request that failed is not retried on every play', async () => {
  // Nothing is recorded for a failure, so without a memo the next play would ask again at once.
  stubSpotify();
  reply = () => new Response('', { status: 500 });
  const app = createApp(':memory:');
  try {
    app.settings.update({ 'secret.spotifyWebToken': 'a-player-token' });
    const key = `sp:${ID}`;
    app.store.saveExtras({
      key,
      title: 'Complete',
      artistImageUrl: 'https://i.scdn.co/image/artist',
      analysis: { track: { tempo: 120 } },
      source: 'spotify',
    });
    app.store.noteIdentity(key, { isrc: 'GBUM71029604' });

    const track = { title: 'Complete', artist: 'Someone', album: '', durationMs: 200_000, spotifyId: ID };
    const harvestOnce = (app.resolver as unknown as {
      harvestOnce(config: unknown, key: string, track: unknown): Promise<void>;
    }).harvestOnce.bind(app.resolver);

    await harvestOnce(app.settings.read(), key, track);
    await harvestOnce(app.settings.read(), key, track);
    assert.equal(asked.length, 1);
    assert.equal(app.store.extras(key, { hit: false })?.canvasCheckedAt, null);
  } finally {
    app.store.close();
  }
});

// ---- serving it -----------------------------------------------------------

test('/v1/extras serves the Canvas for the Spotify id asked about', async () => {
  const small = { width: 144, height: 256, url: 'https://i.scdn.co/image/small' };
  app.store.saveCanvas(`sp:${ID}`, { spotifyId: ID, url: VIDEO, thumbnails: [small] });

  const body = (await (
    await realFetch(`${base}/v1/extras?title=Song&spotifyId=${ID}`)
  ).json()) as Record<string, unknown>;
  assert.equal(body.canvasUrl, VIDEO);
  assert.deepEqual(body.canvasThumbnails, [small]);
});

test('/v1/extras never serves a Canvas recorded for another id, or one recorded as none', async () => {
  // Written under one key for a different id — only possible by a bug, and exactly what must not show.
  app.store.saveCanvas(`sp:${OTHER}`, { spotifyId: ID, url: VIDEO, thumbnails: [] });
  let body = (await (
    await realFetch(`${base}/v1/extras?title=Song&spotifyId=${OTHER}`)
  ).json()) as Record<string, unknown>;
  assert.equal(body.canvasUrl, undefined);

  app.store.saveCanvas(`sp:${ID}`, { spotifyId: ID, url: null, thumbnails: [] });
  body = (await (
    await realFetch(`${base}/v1/extras?title=Song&spotifyId=${ID}`)
  ).json()) as Record<string, unknown>;
  assert.equal(body.canvasUrl, undefined);
  assert.equal(body.canvasThumbnails, undefined);
});
