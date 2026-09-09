/*
 * The admin page. Plain modules, no framework, no build step — it is served straight off disk
 * and edited in place, which is the right trade for a page one person opens on localhost.
 *
 * Authentication is a session cookie set by /admin/api/login, so the API key is typed once and
 * never lives in a URL, a bookmark or the DOM.
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    showLogin();
    throw new Error('locked');
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

let toastTimer;
function toast(message, bad = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

// ---- session --------------------------------------------------------------

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#login-key').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

$('#login-go').addEventListener('click', async () => {
  const apiKey = $('#login-key').value.trim();
  if (!apiKey) return;
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ apiKey }) });
    $('#login-key').value = '';
    showApp();
    await boot();
  } catch {
    toast('That key was not accepted', true);
  }
});

$('#login-key').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#login-go').click();
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---- tabs -----------------------------------------------------------------

$$('#tabs button').forEach((button) => {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
});

function selectTab(name) {
  $$('#tabs button').forEach((button) =>
    button.setAttribute('aria-selected', String(button.dataset.tab === name)),
  );
  $$('main section').forEach((section) => {
    section.hidden = section.id !== `tab-${name}`;
  });
  location.hash = name;
  if (name === 'cache') void loadCache();
  if (name === 'tokens') void loadRefresh();
  if (name === 'log') startLog();
}

// ---- sources --------------------------------------------------------------

let providers = [];

async function loadConfig() {
  const data = await api('/admin/api/config');
  providers = data.providers;
  renderProviders();
  fillSettings(data.config);
  renderAppleExpiry(data.appleTokenExpiresAt);
  renderSpotifyAge(await api('/admin/api/refresh').catch(() => null));
}

function renderProviders() {
  const host = $('#providers');
  host.replaceChildren();

  for (const provider of [...providers].sort((a, b) => a.priority - b.priority)) {
    const status = provider.configured
      ? el('span', { class: 'pill good', text: 'ready' })
      : el('span', {
          class: 'pill warn',
          text: `needs ${provider.requires.join(' + ')}`,
        });

    const result = el('div', { class: 'desc', text: '' });

    const card = el('div', { class: 'card row' }, [
      el('label', { class: 'switch' }, [
        el('input', {
          type: 'checkbox',
          ...(provider.enabled ? { checked: 'checked' } : {}),
          onchange: async (event) => {
            await save({ [`provider.${provider.id}.enabled`]: event.target.checked ? '1' : '0' });
            provider.enabled = event.target.checked;
          },
        }),
        el('span', {}),
      ]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, [
          el('span', { text: provider.label }),
          provider.wordLevel ? el('span', { class: 'pill word', text: 'word-by-word' }) : null,
          status,
        ]),
        el('div', { class: 'desc', text: provider.description }),
        result,
      ]),
      el('input', {
        type: 'number',
        value: provider.priority,
        title: 'Priority — lower wins ties',
        style: 'width: 68px',
        onchange: async (event) => {
          await save({ [`provider.${provider.id}.priority`]: event.target.value });
          provider.priority = Number(event.target.value);
        },
      }),
      el('button', {
        class: 'action',
        text: 'Test',
        onclick: async (event) => {
          const button = event.target;
          button.disabled = true;
          button.textContent = 'Testing…';
          try {
            const test = await api('/admin/api/test', {
              method: 'POST',
              body: JSON.stringify({ provider: provider.id }),
            });
            result.textContent = `${test.ok ? '✓' : '✗'} ${test.detail}${
              test.ms ? ` (${test.ms}ms)` : ''
            }`;
            result.style.color = test.ok ? 'var(--good)' : 'var(--bad)';
          } catch (error) {
            result.textContent = `✗ ${error.message}`;
            result.style.color = 'var(--bad)';
          } finally {
            button.disabled = false;
            button.textContent = 'Test';
          }
        },
      }),
    ]);

    host.append(card);
  }
}

// ---- the source test ------------------------------------------------------

/**
 * Asks every source for one known track and shows what each said.
 *
 * Separate from the per-source Test button, which only proves a credential is accepted. The faults
 * worth finding live in the gap between those two: a token that is accepted and then refused the
 * lyrics, a cookie that reaches the browser without signing it in, a match that lands just under the
 * threshold. All of them pass a credential check.
 */
$('#sources-run').addEventListener('click', async () => {
  const button = $('#sources-run');
  const state = $('#sources-state');
  const host = $('#sources-results');

  button.disabled = true;
  button.textContent = 'Asking every source…';
  state.textContent = '';
  host.replaceChildren();

  try {
    const result = await api('/admin/api/sources', { method: 'POST' });
    const worked = result.sources.filter((source) => source.ok).length;
    state.textContent = `${worked}/${result.sources.length} returned lyrics`;

    host.append(
      el('div', {
        class: 'desc mono',
        text: `${result.track.artist} — ${result.track.title} · ${result.track.spotifyId}`,
      }),
    );

    // Answered first, then the rest: the failures are what anyone opened this to read.
    const order = [...result.sources].sort((a, b) => Number(b.ok) - Number(a.ok));
    for (const source of order) {
      host.append(
        el('div', { class: 'inline', style: 'margin-top: 8px; align-items: baseline' }, [
          el('strong', { text: source.label, style: 'min-width: 140px' }),
          el('span', {
            text: `${source.ok ? '✓' : '✗'} ${source.detail}`,
            style: `color: var(--${source.ok ? 'good' : 'bad'})`,
          }),
          source.ms ? el('span', { class: 'desc', text: `${source.ms}ms` }) : null,
          source.learned?.length
            ? el('span', { class: 'desc', text: `also learned: ${source.learned.join(', ')}` })
            : null,
        ]),
      );
    }
  } catch (error) {
    state.textContent = 'failed';
    host.append(el('div', { text: `✗ ${error.message}`, style: 'color: var(--bad)' }));
  } finally {
    button.disabled = false;
    button.textContent = 'Test the sources';
  }
});

// ---- tokens ---------------------------------------------------------------

/**
 * How old the Spotify token is.
 *
 * Not an expiry: the token is opaque, so there is nothing to decode. But it lasts about an hour,
 * and "refreshed 8 minutes ago" versus "3 hours ago" is the whole diagnosis when Spotify starts
 * returning 401.
 */
function renderSpotifyAge(status) {
  const pill = $('#spotify-token-age');
  if (!pill) return;
  const last = status?.last;
  if (!last?.ok || !last.updated?.includes('spotifyWebToken')) {
    pill.textContent = 'age unknown';
    pill.className = 'pill';
    return;
  }
  const minutes = Math.round((Date.now() - last.at) / 60_000);
  pill.textContent = `refreshed ${when(last.at)}`;
  pill.className = `pill ${minutes < 55 ? 'good' : 'warn'}`;
}

function renderAppleExpiry(expiresAt) {
  const pill = $('#apple-expiry');
  if (!expiresAt) {
    pill.textContent = 'no readable expiry';
    pill.className = 'pill';
    return;
  }
  const days = Math.round((expiresAt - Date.now()) / 86_400_000);
  pill.textContent =
    days < 0 ? `expired ${-days}d ago` : days < 14 ? `expires in ${days}d` : `valid ${days}d`;
  pill.className = `pill ${days < 0 ? 'bad' : days < 14 ? 'warn' : 'good'}`;
}

$$('[data-save-secret]').forEach((button) => {
  button.addEventListener('click', async () => {
    const name = button.dataset.saveSecret;
    const input = $(`#secret-${name}`);
    const value = input.value.trim();
    if (!value) return toast('Nothing to save — paste a value first', true);
    await save({ [`secret.${name}`]: value });
    input.value = '';
    input.placeholder = 'saved';
    await loadConfig();
  });
});

$$('[data-reveal]').forEach((button) => {
  button.addEventListener('click', async () => {
    const name = button.dataset.reveal;
    const input = $(`#secret-${name}`);
    // Deliberately a round trip rather than something held in the page: the value arrives
    // only when it is asked for, and the request is logged.
    const { value } = await api('/admin/api/reveal', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (!value) return toast('Not set');
    input.type = 'text';
    input.value = value;
    setTimeout(() => {
      input.type = 'password';
    }, 20_000);
  });
});

// ---- keeping the short-lived tokens alive ---------------------------------

async function loadRefresh() {
  const status = await api('/admin/api/refresh');
  const state = $('#refresh-state');
  const detail = $('#refresh-detail');

  $('#refresh-minutes').value = status.everyMinutes;
  $('#refresh-run').disabled = !status.configured;

  $('#refresh-command').textContent =
    status.mechanism === 'command'
      ? `$ ${status.command}`
      : status.mechanism === 'browser'
        ? 'Using the Chromium in this image, driven over the DevTools protocol.'
        : (status.reason ?? '');

  // Whether the catalogue calls have a proper credential behind them, which is the difference
  // between an ISRC that arrives and one that arrives when the rate limit happens to allow it.
  const appRole = $('#spotify-app-role');
  if (appRole) {
    const set = status.spotifyAppConfigured;
    appRole.textContent = set ? 'in use for ISRC and artwork' : 'not set — ISRC will be unreliable';
    appRole.className = set ? 'pill good' : 'pill warn';
  }

  // The cookie field says whether it is only a credential or also the refresh's engine.
  const role = $('#sp-dc-role');
  if (role) {
    role.textContent = status.mechanism === 'browser' ? 'powers the auto-refresh' : '';
    role.className = status.mechanism === 'browser' ? 'pill good' : 'pill';
  }

  if (!status.configured) {
    state.textContent = 'nothing to run';
    state.className = 'pill warn';
    detail.textContent = status.reason ?? '';
    detail.style.color = 'var(--muted)';
    return;
  }

  const last = status.last;
  if (!last) {
    state.textContent = 'never run';
    state.className = 'pill warn';
    detail.textContent =
      `Scheduled at most every ${status.everyMinutes} minutes, via the ${status.mechanism}.`;
    return;
  }

  state.textContent = last.ok
    ? `ok ${when(last.at)} · ${status.mechanism}`
    : `failed ${when(last.at)}`;
  state.className = `pill ${last.ok ? 'good' : 'bad'}`;

  // The token's real lifetime, and the schedule that follows from it. Both are worth showing: the
  // interval used to be the whole story, against an assumed hour that was actually 29 minutes.
  const schedule = [];
  if (status.tokenExpiresAt) {
    const minutes = Math.round((status.tokenExpiresAt - Date.now()) / 60_000);
    schedule.push(minutes > 0 ? `token expires in ${minutes} min` : 'token has expired');
  }
  if (status.nextRefreshAt) {
    const minutes = Math.max(0, Math.round((status.nextRefreshAt - Date.now()) / 60_000));
    schedule.push(`next renewal in ${minutes} min`);
  }

  detail.textContent = schedule.length > 0 ? `${last.detail} · ${schedule.join(' · ')}` : last.detail;
  detail.style.color = last.ok ? 'var(--muted)' : 'var(--bad)';
}

$('#refresh-run').addEventListener('click', async (event) => {
  const button = event.target;
  button.disabled = true;
  button.textContent = 'Running…';
  try {
    const result = await api('/admin/api/refresh', { method: 'POST' });
    toast(result.ok ? result.detail : `Failed: ${result.detail}`, !result.ok);
    await loadRefresh();
    // A refreshed token changes what the token fields show.
    await loadConfig();
  } finally {
    button.disabled = false;
    button.textContent = 'Run now';
  }
});

$('#refresh-save-minutes').addEventListener('click', async () => {
  await save({ 'refresh.everyMinutes': $('#refresh-minutes').value });
  toast('Saved. The new interval applies on the next restart.');
  await loadRefresh();
});

// ---- settings -------------------------------------------------------------

function fillSettings(config) {
  $('#set-translationLang').value = config.translationLang ?? '';
  $('#set-refreshDays').value = config.refreshDays ?? '';
  $('#set-negativeTtlHours').value = config.negativeTtlHours ?? '';
  $('#set-endpoint-amll').value = config.amllBaseUrl ?? '';
  $('#set-endpoint-lrclib').value = config.lrclibBaseUrl ?? '';
  $('#set-endpoint-netease').value = config.neteaseBaseUrl ?? '';
  $('#set-endpoint-apple').value = config.appleApiBase ?? '';
  $('#set-endpoint-appleStorefront').value = config.appleStorefront ?? '';
  $('#set-server-host').value = config.host ?? '';
  $('#set-server-port').value = config.port ?? '';
  $('#set-allowLocalNetwork').checked = config.allowLocalNetwork !== false;

  for (const [name, state] of Object.entries(config.secrets ?? {})) {
    const input = $(`#secret-${name}`);
    if (!input) continue;
    input.placeholder = state.fromEnv
      ? 'set by an environment variable'
      : state.set
        ? state.preview
        : 'not set';
    input.disabled = Boolean(state.fromEnv);
  }
}

$('#settings-save').addEventListener('click', async () => {
  await save({
    'merge.translationLang': $('#set-translationLang').value,
    'cache.refreshDays': $('#set-refreshDays').value,
    'cache.negativeTtlHours': $('#set-negativeTtlHours').value,
    'endpoint.amll': $('#set-endpoint-amll').value,
    'endpoint.lrclib': $('#set-endpoint-lrclib').value,
    'endpoint.netease': $('#set-endpoint-netease').value,
    'endpoint.apple': $('#set-endpoint-apple').value,
    'endpoint.appleStorefront': $('#set-endpoint-appleStorefront').value,
    'server.host': $('#set-server-host').value,
    'server.port': $('#set-server-port').value,
    'server.allowLocalNetwork': $('#set-allowLocalNetwork').checked ? '1' : '0',
  });
  toast('Saved. Host and port need a restart.');
});

async function save(patch) {
  await api('/admin/api/config', { method: 'POST', body: JSON.stringify(patch) });
  toast('Saved');
}

// ---- cache ----------------------------------------------------------------

let libraryOffset = 0;
const LIBRARY_PAGE = 50;

function libraryQuery() {
  return new URLSearchParams({
    search: $('#cache-search').value,
    inLyrics: $('#library-in-lyrics').checked ? '1' : '0',
    sort: $('#library-sort').value,
    missing: $('#library-missing').value,
    limit: String(LIBRARY_PAGE),
    offset: String(libraryOffset),
  }).toString();
}

async function loadCache() {
  const [stats, page] = await Promise.all([
    api('/admin/api/stats'),
    api(`/admin/api/library?${libraryQuery()}`),
  ]);

  // Filtered for the same reason as the pager below: a `null` argument to `replaceChildren` is
  // coerced to the text "null", so with nothing stale the row ended "0.2 MB null".
  $('#cache-stats').replaceChildren(
    ...[
      stat(stats.entries, 'tracks'),
      stat(stats.found, 'with lyrics'),
      stat(stats.misses, 'nothing found'),
      stat(stats.extras ?? 0, 'with artwork etc'),
      stat(stats.withIsrc ?? 0, 'with an ISRC'),
      stat(stats.withAnalysis ?? 0, 'with the audio analysis'),
      stat(stats.hits, 'cache hits'),
      stat(stats.rawBodies, 'archived responses'),
      stat(`${(stats.bytes / 1_048_576).toFixed(1)} MB`, 'on disk'),
      stats.stale ? stat(stats.stale, `stale (merge v${stats.mergeVersion})`) : null,
    ].filter(Boolean),
  );
  $('#header-stats').textContent =
    `${stats.entries} tracks · ${stats.found} with lyrics · merge v${stats.mergeVersion}`;

  const body = $('#cache-table tbody');
  body.replaceChildren();

  for (const row of page.rows) {
    body.append(
      el('tr', { class: 'clickable', onclick: () => showEntry(row.key) }, [
        el('td', {}, [
          el('div', { text: row.title || '(no title)' }),
          el('div', { class: 'desc', text: [row.artist, row.album].filter(Boolean).join(' — ') }),
          Object.keys(row.ids).length > 0
            ? el('div', { class: 'desc mono', style: 'font-size: 11px; margin-top: 2px' }, [
                el('span', {
                  // Identity is what turns a fuzzy title match into an exact lookup, so it is
                  // worth seeing without opening the row.
                  text: Object.entries(row.ids)
                    .map(([name, value]) => `${name}:${value}`)
                    .join('  '),
                }),
              ])
            : null,
        ]),
        el('td', {}, lyricsPills(row)),
        el('td', {}, cachedPills(row)),
        el('td', {
          class: 'num',
          text: String(row.hits),
          title: row.lastHitAt ? `last asked for ${when(row.lastHitAt)}` : 'never asked for',
        }),
        el('td', { class: 'desc' }, [
          el('div', { text: when(row.updatedAt) }),
          row.createdAt && row.createdAt !== row.updatedAt
            ? el('div', { style: 'font-size: 11px', text: `first seen ${when(row.createdAt)}` })
            : null,
        ]),
      ]),
    );
  }

  if (page.rows.length === 0) {
    body.append(
      el('tr', {}, [
        el('td', { colspan: '5', class: 'desc', text: 'Nothing here yet — or nothing matches.' }),
      ]),
    );
  }

  // Paging rather than an endless scroll: the point of this view is to answer "what do I have
  // for X", and a count you can read beats a list you have to fall through.
  const shown = page.rows.length;
  const from = page.total === 0 ? 0 : libraryOffset + 1;
  // Filtered, because `replaceChildren` takes nodes *or strings* — so a `null` argument is coerced
  // to the text "null" and printed. With neither pager button needed, the page read "1–6 of 6
  // nullnull". `el` already skips null children; this is the one place that bypasses it.
  $('#library-pager').replaceChildren(
    ...[
      el('span', {
        class: 'desc',
        text: page.total === 0 ? '' : `${from}–${libraryOffset + shown} of ${page.total}`,
      }),
      el('span', { class: 'spacer' }),
      libraryOffset > 0
        ? el('button', {
            class: 'action',
            text: 'Previous',
            onclick: () => {
              libraryOffset = Math.max(0, libraryOffset - LIBRARY_PAGE);
              void loadCache();
            },
          })
        : null,
      libraryOffset + shown < page.total
        ? el('button', {
            class: 'action',
            text: 'Next',
            onclick: () => {
              libraryOffset += LIBRARY_PAGE;
              void loadCache();
            },
          })
        : null,
    ].filter(Boolean),
  );
}

/** What kind of lyrics this song has, at a glance. */
function lyricsPills(row) {
  if (!row.hasLyrics) return [el('span', { class: 'pill warn', text: 'none' })];
  const pills = [];
  if (row.syllableLines > 0) {
    pills.push(
      el('span', {
        class: 'pill word',
        text: `word-by-word ${row.syllableLines}/${row.lines}`,
        title: `${row.syllableLines} of ${row.lines} lines have syllable timings`,
      }),
    );
  } else {
    pills.push(el('span', { class: 'pill', text: `${row.kind ?? 'lyrics'} · ${row.lines}` }));
  }
  if (row.hasRomanization) pills.push(el('span', { class: 'pill', text: 'reading' }));
  if (row.hasTranslation) pills.push(el('span', { class: 'pill', text: 'translation' }));
  if (row.timing) pills.push(el('span', { class: 'pill', text: row.timing }));
  return pills;
}

/** Everything held that is not the words: archived responses, artwork, analysis. */
function cachedPills(row) {
  const pills = [];
  if (row.isrc) {
    pills.push(
      el('span', {
        class: 'pill good',
        text: 'ISRC',
        title: `${row.isrc} — every later lookup for this track can be exact rather than fuzzy`,
      }),
    );
  }
  for (const provider of row.providers) {
    pills.push(
      el('span', { class: 'pill', text: provider, title: 'archived response' }),
    );
  }
  for (const field of row.extrasFields) {
    pills.push(el('span', { class: 'pill good', text: field }));
  }
  if (row.archivedBytes > 0) {
    pills.push(
      el('span', {
        class: 'pill',
        text: `${Math.max(1, Math.round(row.archivedBytes / 1024))} KB`,
        title: 'total archived response size',
      }),
    );
  }

  // What is *not* there, which is the more useful half once a track is working.
  //
  // Each of these has a different cause and a different fix, so they are named rather than counted:
  // no ISRC means every later lookup stays a fuzzy title match, and no tempo or analysis means
  // `api.spotify.com` refused the harvest — routinely, with a 429, because it rate-limits a
  // web-player token hard. The log says which; this says that.
  const absent = [];
  if (!row.isrc) absent.push(['ISRC', 'no ISRC, so lookups for this track stay a fuzzy name match']);
  if (!row.extrasFields.includes('cover')) absent.push(['cover', 'no cover art address']);
  if (!row.extrasFields.includes('tempo')) {
    absent.push(['tempo', 'no tempo — Spotify is the only source for it']);
  }
  // By prefix, not equality: a full analysis is labelled `analysis + beats/bars/…`, so an exact
  // match was false for precisely the richest records — which then showed a green analysis pill and a
  // dashed "no analysis" pill at the same time.
  if (!row.extrasFields.some((field) => field.startsWith('analysis'))) {
    absent.push(['analysis', 'no audio analysis — Spotify has none for many tracks, and never will']);
  }
  for (const [text, title] of absent) {
    pills.push(el('span', { class: 'pill absent', text: `no ${text}`, title }));
  }

  // A wrapping row rather than loose children: the pills used to be laid out in the cell directly and
  // a well-covered track pushed the column off the side of the page.
  return [
    el('div', { class: 'pills' }, pills.length > 0 ? pills : [
      el('span', { class: 'desc', text: '—' }),
    ]),
  ];
}

const reloadLibrary = () => {
  libraryOffset = 0;
  void loadCache();
};

$('#cache-search').addEventListener('input', debounce(reloadLibrary, 250));
$('#library-in-lyrics').addEventListener('change', reloadLibrary);
$('#library-sort').addEventListener('change', reloadLibrary);
$('#library-missing').addEventListener('change', reloadLibrary);
$('#cache-backfill-isrc').addEventListener('click', async (event) => {
  const button = event.target;
  button.disabled = true;
  button.textContent = 'Looking them up…';
  try {
    const result = await api('/admin/api/backfill-isrc', { method: 'POST' });
    if (result.skipped) {
      toast(result.skipped, true);
    } else if (result.looked === 0) {
      toast('Every track with a Spotify id already has its ISRC');
    } else {
      // The unfindable ones are worth naming: an id from the player does not always resolve in the
      // public catalogue, and nothing will ever fill those in, so "4 of 6" would look like a fault.
      toast(
        `${result.found} of ${result.looked} tracks now have an ISRC` +
          (result.missing ? ` — ${result.missing} are not in Spotify's public catalogue` : ''),
      );
    }
    await loadCache();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Fill in missing ISRCs';
  }
});

$('#cache-remerge').addEventListener('click', async () => {
  const result = await api('/admin/api/remerge', { method: 'POST', body: '{}' });
  toast(`Re-merged ${result.rebuilt}/${result.attempted}`);
  await loadCache();
});

async function showEntry(key) {
  const data = await api(`/admin/api/entry?key=${encodeURIComponent(key)}`);
  const host = $('#entry-detail');

  const provenance = data.merged?.provenance;
  // A song can be here for its artwork alone, with no lyrics anybody has written down, so the
  // title has to come from whichever half exists.
  const about = data.entry ?? data.extras ?? {};
  const title = about.title || '(no title)';
  const artist = about.artist || '';

  host.replaceChildren(
    el('h2', { text: artist ? `${artist} — ${title}` : title }),
    el('div', { class: 'card' }, [
      el('div', { class: 'desc mono', text: key }),
      provenance
        ? el('div', { style: 'margin-top: 8px' }, [
            el('div', {}, [
              el('span', { class: 'pill word', text: `timing: ${provenance.timing}` }),
              ...(provenance.syllables ?? []).map((id) =>
                el('span', { class: 'pill', text: `syllables: ${id}` }),
              ),
              provenance.translation
                ? el('span', { class: 'pill', text: `translation: ${provenance.translation}` })
                : null,
              provenance.romanization
                ? el('span', { class: 'pill', text: `reading: ${provenance.romanization}` })
                : null,
              provenance.background
                ? el('span', { class: 'pill', text: `backing: ${provenance.background}` })
                : null,
            ]),
          ])
        : el('div', { class: 'desc', text: 'No lyrics were found for this track.' }),
      el('div', { class: 'inline', style: 'margin-top: 12px' }, [
        el('button', {
          class: 'action',
          text: 'Re-merge',
          onclick: async () => {
            await api('/admin/api/remerge', { method: 'POST', body: JSON.stringify({ key }) });
            toast('Re-merged');
            await showEntry(key);
            await loadCache();
          },
        }),
        el('a', {
          class: 'action',
          href: `/v1/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(
            artist,
          )}&durationMs=${data.entry?.durationMs ?? 0}&format=ttml`,
          target: '_blank',
          rel: 'noreferrer',
          text: 'Download TTML',
          style: 'text-decoration: none',
        }),
        // Two buttons because there are two intents, and one of them is destructive in a way that
        // cannot be undone: the audio analysis came from an endpoint Spotify has since withdrawn.
        el('button', {
          class: 'action danger',
          text: 'Forget the lyrics',
          title: 'Drops the merged lyrics and the archived responses. Artwork and analysis stay.',
          onclick: async () => {
            await api(`/admin/api/entry?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
            toast('Lyrics dropped — the next lookup will be fresh');
            host.replaceChildren();
            await loadCache();
          },
        }),
        data.extras
          ? el('button', {
              class: 'action danger',
              text: 'Forget everything',
              title:
                'Also drops the artwork, palette and audio analysis. The analysis came from an ' +
                'endpoint Spotify withdrew, so this cannot be undone.',
              onclick: async () => {
                if (
                  !confirm(
                    'Also delete the artwork, palette and audio analysis?\n\n' +
                      'Spotify withdrew the analysis endpoint, so the beat and bar grids stored ' +
                      'here are the only copy that will ever exist for this track.',
                  )
                ) {
                  return;
                }
                await api(`/admin/api/entry?key=${encodeURIComponent(key)}&everything=1`, {
                  method: 'DELETE',
                });
                toast('Forgotten');
                host.replaceChildren();
                await loadCache();
              },
            })
          : null,
      ]),
    ]),

    data.raw.length > 0
      ? el('div', { class: 'card', style: 'padding: 0; overflow: hidden' }, [
          el('table', {}, [
            el(
              'thead',
              {},
              el('tr', {}, [
                el('th', { text: 'Archived response' }),
                el('th', { text: 'Type' }),
                el('th', { class: 'num', text: 'Bytes' }),
                el('th', { text: 'Fetched' }),
                el('th', { text: 'Note' }),
                el('th', {}),
              ]),
            ),
            el(
              'tbody',
              {},
              data.raw.map((raw) =>
                el('tr', {}, [
                  el('td', { class: 'mono' }, [
                    el('span', { text: raw.provider }),
                    raw.ok === false ? el('span', { class: 'pill bad', text: 'failed' }) : null,
                  ]),
                  el('td', { class: 'desc', text: raw.contentType }),
                  el('td', { class: 'num', text: String(raw.bytes) }),
                  el('td', { class: 'desc', text: when(raw.fetchedAt) }),
                  el('td', { class: 'desc', text: raw.note ?? '' }),
                  el('td', {}, [
                    el('a', {
                      href: `/admin/api/raw?key=${encodeURIComponent(key)}&provider=${encodeURIComponent(
                        raw.provider,
                      )}`,
                      target: '_blank',
                      rel: 'noreferrer',
                      text: 'view',
                    }),
                  ]),
                ]),
              ),
            ),
          ]),
        ])
      : null,

    data.extras ? extrasCard(data.extras) : null,

    data.merged ? el('div', { class: 'card lyric-preview' }, preview(data.merged)) : null,
  );
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Everything held about a song that is not its words.
 *
 * The artwork is shown rather than described, because a broken cover URL is the sort of thing you
 * only notice by looking. The palette likewise: hex codes tell you nothing, swatches tell you
 * whether it will read on screen.
 */
function extrasCard(extras) {
  const palette = extras.palette ?? null;
  const analysis = extras.analysis ?? null;
  const metadata = extras.metadata ?? null;

  // Spotify's audio analysis nests the summary under `track`, in snake_case — `track.key`,
  // `track.time_signature`, `track.loudness`. Reading them off the top level looked right and
  // silently showed nothing.
  const track = (analysis?.track ?? {});
  const num = (value) => (typeof value === 'number' ? value : null);

  const facts = [];
  if (extras.tempo != null) facts.push(['Tempo', `${Math.round(extras.tempo)} BPM`]);
  if (num(track.key) != null) {
    facts.push(['Key', `${PITCH[track.key] ?? track.key}${track.mode === 0 ? ' minor' : ' major'}`]);
  }
  if (num(track.time_signature) != null) facts.push(['Time', `${track.time_signature}/4`]);
  if (num(track.loudness) != null) facts.push(['Loudness', `${track.loudness.toFixed(1)} dB`]);
  if (num(track.duration) != null) facts.push(['Analysed length', `${track.duration.toFixed(1)} s`]);

  // The grids are the reason this is worth storing at all: Spotify withdrew the endpoint from the
  // public API, so what is here is the only copy there will be.
  const grids = ['beats', 'bars', 'sections', 'tatums']
    .filter((name) => Array.isArray(analysis?.[name]))
    .map((name) => `${analysis[name].length} ${name}`);
  if (grids.length > 0) facts.push(['Grids', grids.join(', ')]);

  return el('div', { class: 'card' }, [
    el('div', { class: 'title' }, [
      el('span', { text: 'Artwork, identity and analysis' }),
      extras.source ? el('span', { class: 'pill', text: extras.source }) : null,
      el('span', { class: 'pill', text: when(extras.updatedAt) }),
    ]),

    el('div', { class: 'inline', style: 'margin-top: 12px; align-items: flex-start; gap: 14px' }, [
      ...[extras.coverUrl, extras.artistImageUrl].filter(Boolean).map((src) =>
        el('img', {
          // Apple leaves its artwork URL as a `{w}x{h}` template so a caller picks its own size.
          src: src.replace('{w}', '256').replace('{h}', '256'),
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
          title: src,
          style:
            'width: 108px; height: 108px; object-fit: cover; border-radius: 8px; ' +
            'border: 1px solid var(--line); flex: none; background: var(--bg)',
        }),
      ),
      palette
        ? el(
            'div',
            { style: 'display: flex; flex-wrap: wrap; gap: 6px; flex: none; max-width: 120px' },
            Object.entries(palette)
              .filter(([, value]) => typeof value === 'string' && /^#?[0-9a-f]{3,8}$/i.test(value))
              .map(([name, value]) =>
                el('div', {
                  title: `${name} ${value}`,
                  style:
                    `width: 34px; height: 34px; border-radius: 6px; ` +
                    `background: ${value.startsWith('#') ? value : `#${value}`}; ` +
                    'border: 1px solid var(--line)',
                }),
              ),
          )
        : null,
      facts.length > 0 ? el('div', { class: 'grow' }, facts.map(factRow)) : null,
    ]),

    // Everything else in the metadata, rendered generically rather than from a list of field names
    // — the whole point of keeping it as a blob is that a provider can start reporting something
    // new without a migration, and a reader with a hard-coded list would quietly undo that.
    metadata ? el('details', { open: 'open', style: 'margin-top: 14px' }, [
      el('summary', { class: 'desc', text: 'Everything known about the recording' }),
      el(
        'div',
        { style: 'margin-top: 8px; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 2px 18px' },
        Object.entries(metadata)
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([field, value]) => factRow([humanise(field), formatValue(value)])),
      ),
    ]) : null,

    analysis
      ? el('details', { style: 'margin-top: 12px' }, [
          el('summary', { class: 'desc', text: 'The audio analysis, as stored' }),
          el('pre', { style: 'margin-top: 8px', text: JSON.stringify(analysis, null, 2) }),
        ])
      : null,
  ]);
}

const PITCH = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

function factRow([label, value]) {
  return el('div', { class: 'desc', style: 'overflow: hidden; text-overflow: ellipsis' }, [
    el('span', { style: 'color: var(--muted)', text: `${label}: ` }),
    el('span', { text: value, title: value }),
  ]);
}

/** `albumTotalTracks` -> `Album total tracks`. */
function humanise(field) {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** A readable rendering of a merged document: syllables underlined, extras indented. */
function preview(document_, limit = 40) {
  return document_.lines.slice(0, limit).map((line) => {
    const parts = [el('span', { class: 'time', text: stamp(line.startMs) })];
    if (line.syllables.length > 0) {
      for (const [index, syllable] of line.syllables.entries()) {
        if (index > 0 && !syllable.partOfWord) parts.push(document.createTextNode(' '));
        parts.push(el('span', { class: 'syl', text: syllable.text }));
      }
    } else {
      parts.push(document.createTextNode(line.text));
    }

    const rows = [el('div', { class: line.role === 'background' ? 'line bg' : 'line' }, parts)];
    if (line.romanized) rows.push(el('div', { class: 'roman', text: line.romanized }));
    if (line.translated) {
      rows.push(
        el('div', {
          class: 'translated',
          text: `${line.translated}${line.translationLang ? `  [${line.translationLang}]` : ''}`,
        }),
      );
    }
    return el('div', {}, rows);
  });
}

// ---- try ------------------------------------------------------------------

$('#try-go').addEventListener('click', async () => {
  const button = $('#try-go');
  button.disabled = true;
  button.textContent = 'Looking up…';
  const host = $('#try-result');
  try {
    const resolution = await api('/admin/api/lookup', {
      method: 'POST',
      body: JSON.stringify({
        title: $('#try-title').value,
        artist: $('#try-artist').value,
        album: $('#try-album').value,
        durationMs: Number($('#try-duration').value) || 0,
        spotifyId: $('#try-spotify').value.trim() || undefined,
        isrc: $('#try-isrc').value.trim() || undefined,
        force: $('#try-force').checked,
      }),
    });

    host.replaceChildren(
      el('div', { class: 'card' }, [
        el('div', { class: 'title' }, [
          el('span', { text: resolution.document ? 'Found' : 'Nothing found' }),
          el('span', { class: 'pill', text: resolution.source }),
          el('span', { class: 'pill', text: `${resolution.ms}ms` }),
          resolution.document
            ? el('span', { class: 'pill word', text: resolution.document.kind })
            : null,
        ]),
        el('div', { class: 'desc mono', text: resolution.key }),
      ]),
      resolution.candidates?.length
        ? el('div', { class: 'card', style: 'padding: 0; overflow: hidden' }, [
            el('table', {}, [
              el(
                'thead',
                {},
                el('tr', {}, [
                  el('th', { text: 'Source' }),
                  el('th', { text: 'Kind' }),
                  el('th', { class: 'num', text: 'Lines' }),
                  el('th', { class: 'num', text: 'Match' }),
                  el('th', { text: 'Extras' }),
                  el('th', { text: 'Outcome' }),
                ]),
              ),
              el(
                'tbody',
                {},
                resolution.candidates.map((candidate) =>
                  el('tr', {}, [
                    el('td', { class: 'mono', text: candidate.provider }),
                    el('td', { text: candidate.kind }),
                    el('td', { class: 'num', text: String(candidate.lines) }),
                    el('td', { class: 'num', text: candidate.match.toFixed(2) }),
                    el('td', {
                      class: 'desc',
                      text: [
                        candidate.hasRomanization ? 'reading' : null,
                        candidate.hasTranslation
                          ? `translation${candidate.translationLang ? ` (${candidate.translationLang})` : ''}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(', '),
                    }),
                    el('td', {
                      class: 'desc',
                      text:
                        candidate.rejected ??
                        (resolution.document?.provenance.timing === candidate.provider
                          ? 'supplied the timing'
                          : 'available for borrowing'),
                    }),
                  ]),
                ),
              ),
            ]),
          ])
        : null,
      resolution.document
        ? el('div', { class: 'card lyric-preview' }, preview(resolution.document))
        : null,
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Look up';
  }
});

// ---- log ------------------------------------------------------------------

let logStream;

/** How severe a line has to be to show, and what it has to contain. */
const LEVEL_ORDER = ['debug', 'info', 'warn', 'error'];

function logFilter() {
  return {
    level: $('#log-level')?.value ?? 'info',
    search: ($('#log-search')?.value ?? '').trim().toLowerCase(),
  };
}

/** Whether a line survives the filter, applied the same way to live lines and fetched ones. */
function logVisible(event, filter) {
  if (LEVEL_ORDER.indexOf(event.level) < LEVEL_ORDER.indexOf(filter.level)) return false;
  if (!filter.search) return true;
  return `${event.provider ?? ''} ${event.message}`.toLowerCase().includes(filter.search);
}

function logRow(event) {
  return el('div', { class: event.level }, [
    el('span', { class: 'at', text: new Date(event.at).toLocaleTimeString() }),
    document.createTextNode(' '),
    el('span', { class: 'lvl', text: `${event.level.toUpperCase()} ` }),
    event.provider ? el('span', { class: 'who', text: `[${event.provider}] ` }) : null,
    el('span', { class: 'msg', text: event.message }),
  ]);
}

/**
 * Loads the history that matches the filter, then keeps up with new lines.
 *
 * Both halves are needed. Filtering only the live stream answers "what is happening", and the
 * question people actually arrive with is "what happened" — which is behind them, in the rows already
 * written. So the filter is applied in SQL for the history and in the page for the stream.
 */
async function refreshLog() {
  const host = $('#log');
  const filter = logFilter();
  try {
    const query = new URLSearchParams({ level: filter.level, limit: '400' });
    if (filter.search) query.set('q', filter.search);
    const data = await api(`/admin/api/events?${query}`);
    // Newest first, which is how the stream prepends.
    host.replaceChildren(...data.events.map(logRow));
  } catch (error) {
    host.replaceChildren(el('div', { class: 'error' }, [el('span', { text: error.message })]));
  }
}

function startLog() {
  void refreshLog();
  if (logStream) return;

  logStream = new EventSource('/admin/api/stream');
  logStream.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (!logVisible(event, logFilter())) return;
    $('#log').prepend(logRow(event));
    while ($('#log').childElementCount > 400) $('#log').lastElementChild.remove();
  };
  logStream.onerror = () => {
    logStream.close();
    logStream = null;
    const live = $('#log-live');
    if (live) {
      live.textContent = 'disconnected';
      live.className = 'pill warn';
    }
  };
}

// Re-fetch rather than filter what is on screen: a line hidden by the old filter was never loaded,
// and hiding rows client-side would silently show fewer than the limit suggests.
$('#log-level').addEventListener('change', () => void refreshLog());
$('#log-search').addEventListener('input', debounce(() => void refreshLog(), 250));


// ---- odds and ends --------------------------------------------------------

function stat(value, label) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'value', text: String(value) }),
    el('div', { class: 'label', text: label }),
  ]);
}

function stamp(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function when(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function safeJson(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function boot() {
  await loadConfig();
  const stats = await api('/admin/api/stats');
  $('#header-stats').textContent = `${stats.entries} tracks · ${stats.found} with lyrics · merge v${stats.mergeVersion}`;
  selectTab(location.hash.slice(1) || 'sources');
}

// A probe rather than a guess: if the cookie is still good, go straight in.
api('/admin/api/stats')
  .then(() => {
    showApp();
    return boot();
  })
  .catch(() => showLogin());
