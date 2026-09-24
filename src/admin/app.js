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

/**
 * Whose page this is. A user's key opens the library on their own songs and nothing else; the server
 * enforces that, and this only stops the page offering what would be refused.
 */
let role = 'admin';

async function applyRole() {
  const me = await api('/admin/api/me');
  role = me.role;
  document.body.classList.toggle('user', role === 'user');
  const who = $('#whoami');
  who.hidden = role !== 'user';
  who.textContent = role === 'user' ? me.name : '';
}

$('#login-go').addEventListener('click', async () => {
  const apiKey = $('#login-key').value.trim();
  if (!apiKey) return;
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ apiKey }) });
    $('#login-key').value = '';
    showApp();
    await boot();
  } catch (error) {
    if (error.message !== 'locked') {
      // Signed in, then something on the way failed: say what, rather than blaming the key.
      toast(error.message, true);
      return;
    }
    toast('That key was not accepted', true);
  }
});

$('#login-key').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#login-go').click();
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
  // Nothing of the last person's stays on the page for the next one.
  $('#cache-table tbody').replaceChildren();
  $('#entry-detail').replaceChildren();
  logStream?.close();
  logStream = null;
  showLogin();
});

// ---- tabs -----------------------------------------------------------------

$$('#tabs button').forEach((button) => {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
});

function selectTab(name) {
  if (role === 'user') name = 'cache';
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
  if (name === 'users') void loadUsers();
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

/**
 * The order the sources are in, dragged by a handle.
 *
 * It was a number box per row, which is a worse version of the question: the order is what matters and
 * the numbers are how it happens to be stored, so editing them meant reading six boxes, working out what
 * to type, and typing it. The app has a handle you drag; so does this now.
 *
 * Three decisions carried over from the app's version, each for its own reason:
 *
 *  - **The handle is the only drag target.** A row you can grab anywhere is a row you reorder by accident
 *    while trying to flick a switch or select a label.
 *  - **Rows move the moment a neighbour is passed**, compared against that neighbour's own midpoint rather
 *    than an assumed row height — a source with a two-line description is half again as tall as one
 *    without.
 *  - **The order is saved on drop, not during.** Six settings writes per dragged pixel would be absurd,
 *    and a value that goes out to storage and comes back arrives too late to draw.
 *
 * Pointer events rather than the native drag-and-drop API, which was the first attempt and is the obvious
 * choice until you try it on a phone: `dragstart` is never fired by a touch gesture in either mobile
 * Safari or Android Chrome, so the handle did nothing at all there. Pointer events are one code path for
 * mouse, touch and pen, which is both less code than two and the only version that works everywhere.
 *
 * Arrow keys on a focused handle do the same job, for the keyboard and as a fallback.
 */
function grip() {
  const handle = el('div', {
    class: 'grip',
    tabindex: '0',
    role: 'button',
    title: 'Drag to reorder, or use the arrow keys',
    'aria-label': 'Reorder this source',
  });
  // Three lines, drawn rather than shipped: an image for six pixels of chrome is not worth a request.
  handle.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" /></svg>';
  return handle;
}

/** Reads the order off the page, stores it, and saves only what moved. */
async function commitOrder() {
  const host = $('#providers');
  const order = [...host.children].map((card) => card.dataset.provider);

  const patch = {};
  for (const [index, id] of order.entries()) {
    const provider = providers.find((candidate) => candidate.id === id);
    if (!provider || provider.priority === index) continue;
    provider.priority = index;
    patch[`provider.${id}.priority`] = String(index);
  }
  if (Object.keys(patch).length === 0) return;

  await save(patch);
  renderProviders();
}

/** Moves a card one place up or down, for the keyboard. */
async function nudge(card, delta) {
  const sibling = delta < 0 ? card.previousElementSibling : card.nextElementSibling;
  if (!sibling) return;
  card.parentElement.insertBefore(delta < 0 ? card : sibling, delta < 0 ? sibling : card);
  await commitOrder();
  // The re-render replaced the node, so focus has to be put back where the hand is.
  const moved = [...$('#providers').children].find((row) => row.dataset.provider === card.dataset.provider);
  moved?.querySelector('.grip')?.focus();
}

/** The drag in progress: which row, which pointer, and the finger's offset from where it started. */
let dragging = null;

/**
 * Keeps the dragged row under the finger after the DOM moves it.
 *
 * Reordering changes the row's layout position, so the transform that was following the finger is
 * suddenly measured from somewhere else and the row jumps by a row's height. Correcting by the
 * neighbour's height is close and wrong — the cards have margins — so the layout position is measured
 * either side of the move and the difference is taken out of the baseline.
 */
function reanchor(card, move, clientY) {
  const layoutTopBefore = card.getBoundingClientRect().top - dragging.dy;
  move();
  const layoutTopAfter = card.getBoundingClientRect().top - dragging.dy;
  dragging.startY += layoutTopAfter - layoutTopBefore;
  // And `dy` is measured from that baseline, so it has to be taken again. Leaving it stale left the row
  // sitting a row's height away from the finger until the next pointer event arrived — visible as a jump
  // on every crossing, and worse at the end of a move where no further event comes.
  dragging.dy = clientY - dragging.startY;
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

    const handle = grip();
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      void nudge(card, event.key === 'ArrowUp' ? -1 : 1);
    });

    handle.addEventListener('pointerdown', (event) => {
      // Left button only for a mouse; any contact for a finger or a pen.
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // Stops the page scrolling under the finger instead of the row moving. `touch-action: none` on the
      // handle does most of this; this covers the rest.
      event.preventDefault();

      dragging = { card, pointerId: event.pointerId, startY: event.clientY, dy: 0 };
      card.classList.add('dragging');

      // Capture keeps every later move and the release coming to this handle once the finger has left
      // it, which is what makes the drag work at all over any distance. Attempted last and allowed to
      // fail: it throws if the pointer is not one the browser considers active, and doing it first meant
      // a throw there abandoned the drag before it had started.
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* Without capture the drag still works as long as the pointer stays over the handle. */
      }
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;

      dragging.dy = event.clientY - dragging.startY;
      card.style.transform = `translateY(${dragging.dy}px)`;

      // Past a neighbour's own midpoint, because the rows are not all the same height: a source with a
      // two-line description is half again as tall as one without.
      //
      // A loop rather than one swap per move, and that is not theoretical tidiness: one move can cross
      // several rows. A flick does it, and so does any automated drag that jumps straight to its target —
      // which is exactly how this was caught, by a test that moved a row four places in a single step and
      // saw nothing happen at all.
      for (;;) {
        const above = card.previousElementSibling;
        if (above) {
          const box = above.getBoundingClientRect();
          if (event.clientY < box.top + box.height / 2) {
            reanchor(card, () => host.insertBefore(card, above), event.clientY);
            continue;
          }
        }

        const below = card.nextElementSibling;
        if (below) {
          const box = below.getBoundingClientRect();
          if (event.clientY > box.top + box.height / 2) {
            reanchor(card, () => host.insertBefore(card, below.nextElementSibling), event.clientY);
            continue;
          }
        }
        break;
      }
      card.style.transform = `translateY(${dragging.dy}px)`;
    });

    const release = (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      dragging = null;
      card.classList.remove('dragging');
      card.style.transform = '';
      void commitOrder();
    };
    handle.addEventListener('pointerup', release);
    // A cancelled pointer still has to put the row down — otherwise it stays lifted and the order is
    // never saved.
    handle.addEventListener('pointercancel', release);

    const card = el('div', { class: 'card row', 'data-provider': provider.id }, [
      handle,
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
  $('#set-relookupPauseMs').value = config.relookupPauseMs ?? '';
  $('#set-musixmatchMs').value = config.musixmatchPaceMs ?? '';
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
    'cache.relookupPauseMs': $('#set-relookupPauseMs').value,
    'throttle.musixmatchMs': $('#set-musixmatchMs').value,
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
    askedBy: role === 'admin' ? $('#library-asked-by').value : '',
    limit: String(LIBRARY_PAGE),
    offset: String(libraryOffset),
  }).toString();
}

// ---- selecting rows -------------------------------------------------------

/** Whether the checkbox column is showing, and which keys are ticked. */
let selecting = false;
const selected = new Set();

/** The keys on screen, so "all on this page" means exactly that. */
let visibleKeys = [];

function toggleSelected(key) {
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  renderSelection();
  void loadCache();
}

/**
 * Reflects the selection into the page.
 *
 * The count is a pill rather than part of the button labels, because those buttons are destructive and
 * should say what they do — "Forget 41" reads like a track number.
 */
function renderSelection() {
  $('#cache-selection').hidden = !selecting;
  $$('#cache-table th.pick').forEach((cell) => {
    cell.hidden = !selecting;
  });
  $('#cache-select-mode').textContent = selecting ? 'Stop selecting' : 'Select';

  const count = selected.size;
  $('#cache-selected-count').textContent = count === 0 ? 'none selected' : `${count} selected`;
  for (const id of [
    '#cache-relookup-selected',
    '#cache-forget-selected',
    '#cache-forget-everything-selected',
  ]) {
    $(id).disabled = count === 0;
  }
}

$('#cache-select-mode').addEventListener('click', () => {
  selecting = !selecting;
  if (!selecting) selected.clear();
  renderSelection();
  void loadCache();
});

$('#cache-select-cancel').addEventListener('click', () => {
  selecting = false;
  selected.clear();
  renderSelection();
  void loadCache();
});

$('#cache-select-all').addEventListener('change', (event) => {
  // This page only, deliberately. "Everything matching the filter", behind one checkbox, next to a
  // delete button, is not something to offer casually.
  for (const key of visibleKeys) {
    if (event.target.checked) selected.add(key);
    else selected.delete(key);
  }
  renderSelection();
  void loadCache();
});

/**
 * Shows how a bulk re-lookup is getting on.
 *
 * Fed by the stream, which already ticks once a second — the right cadence for this, and no new polling.
 * The server sends it every tick while a run is going rather than only when the numbers change, because
 * a readout that stops updating looks exactly like a job that has stalled, and telling those apart is
 * the entire point.
 */
let relookupRun = null;
let relookupTrack = '';

function renderRelookup(progress) {
  const state = $('#relookup-state');
  const stop = $('#relookup-stop');
  const pause = $('#relookup-pause');
  // Both ways in, so a run cannot be started on top of one already going from the other button.
  const starts = [$('#cache-relookup'), $('#cache-relookup-selected')];

  // The name is remembered for as long as the run lasts. The server reports `current` as null between
  // lookups, which is the honest answer to "what is in the air" and a flickering readout if shown
  // literally — it would drop the track name during every inter-track wait.
  if (progress.startedAt !== relookupRun) {
    relookupRun = progress.startedAt;
    relookupTrack = '';
  }
  if (progress.current) relookupTrack = progress.current;

  if (progress.running) {
    const at = progress.done + progress.skipped;
    // A held run that still names a track has one lookup left in the air, and saying so is the
    // difference between "it is waiting for me" and "it is ignoring me".
    const held = progress.paused && !progress.current;
    state.hidden = false;
    state.className = progress.paused ? 'pill warn' : 'pill';
    state.textContent =
      (held ? 'paused, ' : progress.paused ? 'pausing, ' : '') +
      `${at} of ${progress.total}` +
      (relookupTrack ? ` — ${relookupTrack}` : '') +
      (progress.skipped ? ` (${progress.skipped} skipped)` : '');
    state.title = relookupTrack;
    stop.hidden = false;
    pause.hidden = false;
    pause.textContent = progress.paused ? 'Resume' : 'Pause';
    for (const button of starts) button.disabled = true;
    return;
  }

  stop.hidden = true;
  pause.hidden = true;
  starts[0].disabled = false;
  // Not enabled blindly: the selected-rows button is disabled when nothing is selected, and that rule
  // outlives the run.
  renderSelection();

  // Nothing has run this session: no readout rather than a row of zeroes.
  if (!progress.startedAt) {
    state.hidden = true;
    return;
  }

  state.hidden = false;
  state.className = progress.cancelled ? 'pill warn' : 'pill good';
  state.textContent = progress.cancelled
    ? `stopped after ${progress.done} of ${progress.total}`
    : `looked up ${progress.done} of ${progress.total}` +
      (progress.skipped ? `, skipped ${progress.skipped}` : '');
}

$('#relookup-pause').addEventListener('click', async (event) => {
  const button = event.target;
  // Read off the label rather than kept in a variable: the stream is the only thing that knows the
  // real state, and it has already written it here.
  const paused = button.textContent === 'Pause';
  button.disabled = true;
  try {
    const result = await api('/admin/api/relookup/pause', {
      method: 'POST',
      body: JSON.stringify({ paused }),
    });
    if (!result.changed) toast('Nothing was running');
    // Resuming re-reads the delay, which is the point of pausing when a source starts throttling.
    else if (!paused) toast('Carrying on, at the delay set now');
    renderRelookup(result.progress);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#relookup-stop').addEventListener('click', async (event) => {
  const button = event.target;
  button.disabled = true;
  try {
    const result = await api('/admin/api/relookup/cancel', { method: 'POST' });
    // It stops after the track it is on rather than mid-flight: a lookup already in the air will
    // finish either way, and throwing its answer away would waste the requests it has spent.
    toast(result.stopping ? 'Stopping after the current track' : 'Nothing was running');
    renderRelookup(result.progress);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function runRelookup(keys) {
  const button = keys ? $('#cache-relookup-selected') : $('#cache-relookup');
  button.disabled = true;
  try {
    const result = await api('/admin/api/relookup', {
      method: 'POST',
      body: JSON.stringify(keys ? { keys } : {}),
    });
    // It runs in the background and the library updates itself, so this reports what was started
    // rather than pretending to describe a finished job.
    toast(`Asking every source again for ${result.queued} track(s)`);
    // The stream will take over within the second; this fills the gap so the button state changes at
    // the moment it is pressed rather than a beat later.
    renderRelookup({ running: true, total: result.queued, done: 0, skipped: 0, cancelled: false, paused: false, startedAt: Date.now(), current: null });
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---- timings that do not fit the track -------------------------------------

/**
 * The report, and the two things worth doing about a row.
 *
 * Which action applies depends on whether anything else answered for that track. With another source in
 * the archive, dropping this one is instant and free — the merge picks a different backbone from bodies
 * already on disk. With nothing else, dropping leaves no lyrics at all, so the only real move is to ask
 * the sources again.
 */
let fitRows = [];

function renderFit(report) {
  fitRows = report.rows;
  const host = $('#fit-results');
  host.replaceChildren();

  $('#fit-state').textContent = report.serious
    ? `${report.serious} to look at`
    : report.rows.length
      ? 'nothing serious'
      : 'all fit';
  $('#fit-state').className = report.serious ? 'pill warn' : 'pill good';
  $('#fit-summary').textContent =
    `checked ${report.checked} cached track(s)` +
    (report.withoutDuration ? ` · ${report.withoutDuration} had no duration to check against` : '');
  $('#fit-relookup').hidden = report.rows.length === 0;

  if (report.rows.length === 0) {
    host.append(el('div', { class: 'desc', text: 'Every cached document fits the track the player reported.' }));
    return;
  }

  const table = el('table');
  table.append(
    el('tr', {}, [
      el('th', { text: '' }),
      el('th', { text: 'Track' }),
      el('th', { text: 'Timing from' }),
      el('th', { text: 'Runs to' }),
      el('th', { text: 'Player said' }),
      el('th', { text: 'Past the end' }),
      el('th', { text: '' }),
    ]),
  );

  for (const row of report.rows) {
    const drop = el('button', {
      class: 'action',
      text: row.alternatives > 0 ? `Drop ${row.provider}` : 'Nothing else answered',
    });
    drop.disabled = row.alternatives === 0;
    drop.title =
      row.alternatives > 0
        ? `Stop merging ${row.provider} for this track and rebuild it from the ${row.alternatives} other source(s) already on disk. The body stays archived.`
        : 'This is the only source that answered, so dropping it would leave no lyrics. Look it up again instead.';
    drop.addEventListener('click', () => void dropSource(row, drop));

    table.append(
      el('tr', {}, [
        el('td', { text: row.serious ? '!' : '', class: row.serious ? 'bad' : '' }),
        el('td', {}, [
          el('div', { text: row.title }),
          el('div', { class: 'desc', text: row.artist }),
        ]),
        el('td', { text: row.provider || '—' }),
        el('td', { class: 'mono', text: clock(row.lastTimingMs) }),
        el('td', { class: 'mono', text: clock(row.durationMs) }),
        el('td', { text: `${Math.round(row.pastEndShare * 100)}%` }),
        el('td', {}, [drop]),
      ]),
    );
  }
  host.append(table);
}

function clock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function dropSource(row, button) {
  button.disabled = true;
  button.textContent = 'Dropping…';
  try {
    const result = await api('/admin/api/drop-source', {
      method: 'POST',
      body: JSON.stringify({ key: row.key, provider: row.provider }),
    });
    toast(
      result.timing
        ? `Dropped ${result.dropped}; ${result.timing} owns the timing now (${result.lines} lines)`
        : `Dropped ${result.dropped}; nothing else could carry it, so the track has no lyrics now`,
    );
    await runFit();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = `Drop ${row.provider}`;
  }
}

async function runFit() {
  const button = $('#fit-run');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    renderFit(await api('/admin/api/fit'));
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Check the library';
  }
}

$('#fit-run').addEventListener('click', () => void runFit());

// Opening the card is a request for the answer; making people press a second button for it is noise.
$('#fit-card').addEventListener('toggle', () => {
  if ($('#fit-card').open && fitRows.length === 0) void runFit();
});

$('#fit-relookup').addEventListener('click', () => {
  // Only the tracks this report named, which is the point of offering it here rather than sending
  // someone to the library to find them by hand.
  void runRelookup(fitRows.map((row) => row.key));
});

/**
 * Asks again only where the answer could actually change.
 *
 * The whole library is the obvious button and the wrong one: Musixmatch tolerates one request every
 * thirty to sixty seconds, so four hundred tracks is hours of requests, and most of them were matched by
 * a Spotify id and answered by everything that was ever going to answer. The server works out which ones
 * have a reason, and says what the reasons are before anything is asked.
 */
$('#cache-relookup-worth').addEventListener('click', async () => {
  const button = $('#cache-relookup-worth');
  button.disabled = true;
  try {
    const set = await api('/admin/api/relookup/candidates');
    if (set.candidates.length === 0) {
      toast(`Nothing to re-ask: all ${set.total} tracks were matched by an identity and answered`);
      return;
    }

    const reasons = Object.entries(set.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
    toast(`${set.candidates.length} of ${set.total} worth asking — ${reasons}`);
    await runRelookup(set.candidates.map((c) => c.key));
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#cache-relookup').addEventListener('click', () => void runRelookup(null));
$('#cache-relookup-selected').addEventListener('click', () => void runRelookup([...selected]));

for (const [id, everything, label] of [
  ['#cache-forget-selected', false, 'the lyrics of'],
  ['#cache-forget-everything-selected', true, 'everything for'],
]) {
  $(id).addEventListener('click', async () => {
    const keys = [...selected];
    if (keys.length === 0) return;
    // Confirmed, because it cannot be undone — and `everything` includes the audio analysis, which
    // Spotify will not serve again.
    const detail = everything
      ? '\n\nThis also drops the artwork, tempo and audio analysis. The analysis came from an endpoint Spotify has withdrawn and cannot be fetched again.'
      : '';
    if (!confirm(`Forget ${label} ${keys.length} track(s)?${detail}`)) return;

    try {
      const result = await api('/admin/api/forget', {
        method: 'POST',
        body: JSON.stringify({ keys, everything }),
      });
      toast(`Forgot ${result.deleted} track(s)`);
      selected.clear();
      renderSelection();
      await loadCache();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/**
 * The counter row and the header line, from one stats reply.
 *
 * Lifted out of `loadCache` so a live update renders exactly what a page load does — two copies of
 * this would drift, and the one that drifted would be the one nobody watches.
 */
function renderStats(stats) {
  if (role === 'user') {
    $('#cache-stats').replaceChildren(
      stat(stats.tracks, 'songs asked for'),
      stat(stats.found, 'with lyrics'),
      stat(stats.misses, 'nobody had lyrics for'),
      stat(stats.hits, 'lookups'),
    );
    $('#header-stats').textContent = `${stats.tracks} songs · ${stats.found} with lyrics`;
    return;
  }
  // Filtered for the same reason as the pager below: a `null` argument to `replaceChildren` is
  // coerced to the text "null", so with nothing stale the row ended "0.2 MB null".
  $('#cache-stats').replaceChildren(
    ...[
      // `tracks` rather than `entries`: the table below lists the union of both, and counting one of
      // them here made the artwork and ISRC figures look larger than the whole.
      stat(stats.tracks ?? stats.entries, 'tracks'),
      stat(stats.found, 'with lyrics'),
      stat(stats.misses, 'asked, nobody had it'),
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
    `${stats.tracks ?? stats.entries} tracks · ${stats.found} with lyrics · merge v${stats.mergeVersion}`;
}

async function loadCache() {
  const [stats, page] = await Promise.all([
    api('/admin/api/stats'),
    api(`/admin/api/library?${libraryQuery()}`),
  ]);

  renderStats(stats);

  const body = $('#cache-table tbody');
  body.replaceChildren();

  for (const row of page.rows) {
    body.append(
      el('tr', {
        class: 'clickable',
        // In select mode the row toggles its own checkbox rather than opening the detail: aiming for a
        // checkbox and getting a detail pane is the sort of thing that makes a bulk delete dangerous.
        onclick: () => (selecting ? toggleSelected(row.key) : showEntry(row.key)),
      }, [
        selecting
          ? el('td', { class: 'pick' }, [
              el('input', {
                type: 'checkbox',
                style: 'width: auto',
                ...(selected.has(row.key) ? { checked: 'checked' } : {}),
                onclick: (event) => {
                  // Otherwise the row handler toggles it straight back.
                  event.stopPropagation();
                  toggleSelected(row.key);
                },
              }),
            ])
          : null,
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
          title: row.askedAt ? `last asked for ${when(row.askedAt)}` : 'never asked for',
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
        el('td', {
          colspan: selecting ? '6' : '5',
          class: 'desc',
          text: 'Nothing here yet — or nothing matches.',
        }),
      ]),
    );
  }

  // Paging rather than an endless scroll: the point of this view is to answer "what do I have
  // for X", and a count you can read beats a list you have to fall through.
  visibleKeys = page.rows.map((row) => row.key);
  $('#cache-select-all').checked =
    visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));

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
$('#library-asked-by').addEventListener('change', reloadLibrary);
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

$('#cache-backfill-canvas').addEventListener('click', async () => {
  try {
    const result = await api('/admin/api/backfill-canvas', { method: 'POST' });
    if (result.skipped) toast(result.skipped, !result.skipped.startsWith('already'));
    else if (result.pending === 0) toast('Every Spotify track has a Canvas answer from the last week');
    else {
      toast(`Asking Spotify about ${result.pending} tracks, one a second`);
      // Straight away, rather than on the stream's next tick a second from now.
      renderCanvas(await api('/admin/api/backfill-canvas'));
    }
  } catch (error) {
    toast(error.message, true);
  }
});

/**
 * The Canvas backfill's readout, on its own button: the button is where it was started, and a run of
 * several minutes needs to say how far it has got. Disabled while it runs, so it cannot be started
 * twice.
 */
let canvasRun = null;
function renderCanvas(state) {
  const button = $('#cache-backfill-canvas');
  const finished = canvasRun !== null && canvasRun === state.startedAt && !state.running;
  button.disabled = state.running;
  button.textContent = state.running
    ? `Filling in Canvas · ${state.done} of ${state.total}`
    : 'Fill in Canvas';
  if (state.running) {
    canvasRun = state.startedAt;
  } else if (finished) {
    canvasRun = null;
    toast(
      state.stopped
        ? `Canvas ${state.stopped} after ${state.done} of ${state.total}`
        : `Canvas: ${state.found} of ${state.done} tracks have one`,
      Boolean(state.stopped),
    );
    void loadCache();
  }
}

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

  host.replaceChildren(...[
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
        role === 'admin' ? el('button', {
          class: 'action',
          text: 'Re-merge',
          onclick: async () => {
            await api('/admin/api/remerge', { method: 'POST', body: JSON.stringify({ key }) });
            toast('Re-merged');
            await showEntry(key);
            await loadCache();
          },
        }) : null,
        el('a', {
          class: 'action',
          href: `/v1/lyrics?${downloadQuery(key, title, artist, data.entry?.durationMs ?? 0)}`,
          target: '_blank',
          rel: 'noreferrer',
          text: 'Download TTML',
          style: 'text-decoration: none',
        }),
        // Two buttons because there are two intents, and one of them is destructive in a way that
        // cannot be undone: the audio analysis came from an endpoint Spotify has since withdrawn.
        role === 'admin' ? el('button', {
          class: 'action danger',
          text: 'Forget the lyrics',
          title: 'Drops the merged lyrics and the archived responses. Artwork and analysis stay.',
          onclick: async () => {
            await api(`/admin/api/entry?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
            toast('Lyrics dropped — the next lookup will be fresh');
            host.replaceChildren();
            await loadCache();
          },
        }) : null,
        data.extras && role === 'admin'
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
    // `replaceChildren` prints a null as the text "null", so a track with nothing archived, no extras
    // and no lyrics ended in "nullnullnull".
  ].filter(Boolean));
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The query that fetches exactly this cached entry.
 *
 * By the id in its key, because a track cached under its Spotify id or ISRC has a different key from
 * its title and artist: asking by name missed the cache and ran a fresh lookup. Cache-only, so a
 * download never spends a request.
 */
function downloadQuery(key, title, artist, durationMs) {
  const params = new URLSearchParams({ title, artist, durationMs: String(durationMs) });
  if (key.startsWith('sp:')) params.set('spotifyId', key.slice(3));
  else if (key.startsWith('isrc:')) params.set('isrc', key.slice(5));
  params.set('format', 'ttml');
  params.set('cacheOnly', '1');
  return params.toString();
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

  // The features that stand in when Spotify has no analysis, from ReccoBeats: energy, valence and so on.
  const features = analysis?.features && typeof analysis.features === 'object' ? analysis.features : null;
  if (features) {
    for (const [name, value] of Object.entries(features)) {
      if (name === 'tempo' || value === null || value === undefined) continue;
      facts.push([humanise(name), typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : formatValue(value)]);
    }
  }

  const canvas = extras.canvas ?? null;
  const canvasUrl = canvas?.url ?? null;

  // Everything stored, as rows: the URLs as links so they can be opened or copied, and the Canvas's
  // answer even when it is "none", which is an answer worth seeing.
  const stored = [];
  if (extras.coverUrl) stored.push(linkRow('Cover', extras.coverUrl));
  if (extras.artistImageUrl) stored.push(linkRow('Artist image', extras.artistImageUrl));
  if (canvasUrl) stored.push(linkRow('Canvas', canvasUrl));
  for (const variant of canvas?.variants ?? []) {
    stored.push(linkRow(`Canvas ${variant.width}×${variant.height}`, variant.url));
  }
  if (canvas) {
    stored.push(
      factRow([
        'Canvas checked',
        `${when(extras.canvasCheckedAt)}${canvasUrl ? '' : ' — Spotify has none for this track'}`,
      ]),
    );
    for (const [label, value] of [
      ['Canvas uploaded by', canvas.artistName],
      ['Canvas URI', canvas.uri],
      ['Canvas id', canvas.id],
      ['Canvas type', canvas.type],
      ['Canvas for', canvas.spotifyId],
    ]) {
      if (value !== undefined && value !== null && value !== '') stored.push(factRow([label, String(value)]));
    }
  } else if (extras.key?.startsWith('sp:')) {
    stored.push(factRow(['Canvas', 'not asked about yet']));
  }
  if (extras.isrc) stored.push(factRow(['ISRC', extras.isrc]));
  if (extras.durationMs) stored.push(factRow(['Duration', `${stamp(extras.durationMs)} (${extras.durationMs} ms)`]));
  for (const [name, value] of Object.entries(palette ?? {})) {
    stored.push(factRow([humanise(name), formatValue(value)]));
  }

  // The row minus the analysis, which has its own section and can be large.
  const { analysis: _analysis, ...rest } = extras;

  return el('div', { class: 'card' }, [
    el('div', { class: 'title' }, [
      el('span', { text: 'Artwork, Canvas, identity and analysis' }),
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
      // Played, like the artwork is shown: whether it is the right video is only obvious by looking.
      canvasUrl ? canvasPreview(canvas.variants?.[0]?.url ?? canvasUrl, canvasUrl) : null,
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

    stored.length > 0
      ? el('details', { open: 'open', style: 'margin-top: 14px' }, [
          el('summary', { class: 'desc', text: 'Artwork, Canvas and identity, as stored' }),
          el(
            'div',
            { style: 'margin-top: 8px; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 2px 18px' },
            stored,
          ),
        ])
      : null,

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

    // Everything else in the row, whatever it holds: a field added later shows up here without this
    // page being taught about it.
    el('details', { style: 'margin-top: 12px' }, [
      el('summary', { class: 'desc', text: 'Everything else, as stored' }),
      el('pre', { style: 'margin-top: 8px', text: JSON.stringify(rest, null, 2) }),
    ]),
  ]);
}

/**
 * The Canvas, looping, at the smallest size stored. Muted through the property: the attribute does
 * not mute a video made in script, and the browser only autoplays one that is muted.
 */
function canvasPreview(src, title) {
  const video = el('video', {
    src,
    loop: '',
    autoplay: '',
    playsinline: '',
    preload: 'metadata',
    title,
    style:
      'width: 61px; height: 108px; object-fit: cover; border-radius: 8px; ' +
      'border: 1px solid var(--line); flex: none; background: var(--bg)',
  });
  video.muted = true;
  return video;
}

/** A stored URL, as a link: to open it, or to copy it. */
function linkRow(label, url) {
  return el('div', { class: 'desc', style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap' }, [
    el('span', { style: 'color: var(--muted)', text: `${label}: ` }),
    el('a', { href: url.replace('{w}', '1000').replace('{h}', '1000'), target: '_blank', rel: 'noreferrer', text: url, title: url }),
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
  startStream();
}

/**
 * One connection for the whole page, opened at boot and kept.
 *
 * It used to be opened by the log tab, which meant the library only changed when the page was
 * reloaded — a new track appeared on the server and the view sat there stale. The same stream now
 * carries a `cache` event when the library's fingerprint moves, so the page refreshes itself.
 */
function startStream() {
  if (logStream) return;

  logStream = new EventSource('/admin/api/stream');
  logStream.onmessage = (message) => {
    const event = JSON.parse(message.data);

    if (event.kind === 'cache') {
      cacheChanged();
      return;
    }

    if (event.kind === 'relookup') {
      renderRelookup(event);
      return;
    }

    if (event.kind === 'canvas') {
      renderCanvas(event);
      return;
    }

    // A log line. Rendered even when the log tab is hidden, so switching to it shows what happened
    // rather than only what happens next.
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
    // Reconnect, because a stream that dies quietly is indistinguishable from a server with nothing
    // to say — and the whole point of this is that the page stops needing to be reloaded.
    setTimeout(startStream, 5_000);
  };
}

/**
 * The library changed on the server. Bring the page up to date.
 *
 * Debounced, because a single lookup writes an entry, then extras, then a re-merge — three
 * fingerprint changes in a couple of seconds for one track's worth of news.
 *
 * The counters refresh wherever you are, since the header shows them and the question they answer is
 * "is it collecting anything". The table only refreshes when it is on screen: re-rendering rows behind
 * a tab nobody is looking at is work for nothing, and doing it *while* someone is typing in the search
 * box would pull the results out from under them.
 */
const cacheChanged = debounce(async () => {
  const onCacheTab = !$('#tab-cache').hidden;
  const typing = document.activeElement === $('#cache-search');

  try {
    if (onCacheTab && !typing) {
      await loadCache();
    } else {
      await refreshCounters();
    }
  } catch {
    // A refresh nobody asked for must not raise anything: the next change tries again.
  }
}, 700);

/** The two counter rows, without touching the table. */
async function refreshCounters() {
  const stats = await api('/admin/api/stats');
  renderStats(stats);
}

// Re-fetch rather than filter what is on screen: a line hidden by the old filter was never loaded,
// and hiding rows client-side would silently show fewer than the limit suggests.
$('#log-level').addEventListener('change', () => void refreshLog());
$('#log-search').addEventListener('input', debounce(() => void refreshLog(), 250));


// ---- users ----------------------------------------------------------------

async function loadUsers() {
  const { users } = await api('/admin/api/users');
  const body = $('#users-table tbody');
  body.replaceChildren(
    ...users.map((user) =>
      el('tr', {}, [
        el('td', {}, [
          el('span', { text: user.name }),
          user.revokedAt ? el('span', { class: 'pill', text: 'revoked', style: 'margin-left: 8px' }) : null,
        ]),
        el('td', { class: 'mono desc', text: `…${user.keyHint}` }),
        el('td', { class: 'num', text: String(user.tracks) }),
        el('td', { class: 'desc', text: user.lastUsedAt ? when(user.lastUsedAt) : 'never' }),
        el('td', { class: 'desc', text: when(user.createdAt) }),
        el('td', {}, [
          user.revokedAt
            ? null
            : el('button', {
                class: 'action danger',
                text: 'Revoke',
                onclick: async () => {
                  if (!confirm(`Revoke the key for ${user.name}? Anything using it stops working.`)) return;
                  await api('/admin/api/users/revoke', {
                    method: 'POST',
                    body: JSON.stringify({ id: user.id }),
                  });
                  toast(`Revoked ${user.name}`);
                  await loadUsers();
                },
              }),
        ]),
      ]),
    ),
  );
  if (users.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '6', class: 'desc', text: 'No keys yet.' })]));
  }
  renderAskedBy(users);
}

/** The library's "asked by" choices, kept in step with the users. */
function renderAskedBy(users) {
  const select = $('#library-asked-by');
  const current = select.value;
  select.replaceChildren(
    el('option', { value: '', text: 'Asked by anyone' }),
    el('option', { value: '0', text: 'Asked with the admin key' }),
    ...users.map((user) =>
      el('option', { value: String(user.id), text: `Asked by ${user.name}${user.revokedAt ? ' (revoked)' : ''}` }),
    ),
  );
  select.value = [...select.options].some((option) => option.value === current) ? current : '';
}

$('#user-add').addEventListener('click', async () => {
  const name = $('#user-name').value.trim();
  if (!name) return toast('Give the key a name', true);
  try {
    const { user, key } = await api('/admin/api/users', { method: 'POST', body: JSON.stringify({ name }) });
    $('#user-name').value = '';
    $('#user-new-name').textContent = user.name;
    $('#user-new-key').value = key;
    $('#user-new').hidden = false;
    $('#user-new-key').select();
    await loadUsers();
  } catch (error) {
    toast(error.message, true);
  }
});

$('#user-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#user-add').click();
});

$('#user-new-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#user-new-key').value);
    toast('Copied');
  } catch {
    // Clipboard access needs a secure context; the field is selected, so copying by hand works.
    $('#user-new-key').select();
    toast('Select and copy it by hand', true);
  }
});

// Cleared, not only hidden: the key should not sit in the page after it has been copied.
$('#user-new-done').addEventListener('click', () => {
  $('#user-new-key').value = '';
  $('#user-new').hidden = true;
});

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
  await applyRole();
  if (role === 'user') {
    // Their library, and nothing that would only be refused: no config, no log, no live stream.
    selectTab('cache');
    return;
  }
  await loadConfig();
  await refreshCounters();
  await api('/admin/api/users').then(({ users }) => renderAskedBy(users)).catch(() => {});
  // A run started before this page was opened, or before it was reloaded, still has a readout — and the
  // readout is in the header, so it is worth having before a tab is even chosen.
  await api('/admin/api/relookup').then(renderRelookup).catch(() => {});
  await api('/admin/api/backfill-canvas').then(renderCanvas).catch(() => {});
  // Before the first tab is chosen, so the page is live wherever it opens.
  startStream();
  selectTab(location.hash.slice(1) || 'sources');
}

// A probe rather than a guess: if the cookie is still good, go straight in.
api('/admin/api/stats')
  .then(() => {
    showApp();
    return boot();
  })
  .catch(() => showLogin());
