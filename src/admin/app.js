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

// ---- tokens ---------------------------------------------------------------

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
  });
  toast('Saved. Host and port need a restart.');
});

async function save(patch) {
  await api('/admin/api/config', { method: 'POST', body: JSON.stringify(patch) });
  toast('Saved');
}

// ---- cache ----------------------------------------------------------------

async function loadCache() {
  const [stats, list] = await Promise.all([
    api('/admin/api/stats'),
    api(`/admin/api/entries?search=${encodeURIComponent($('#cache-search').value)}`),
  ]);

  $('#cache-stats').replaceChildren(
    stat(stats.entries, 'tracks'),
    stat(stats.found, 'with lyrics'),
    stat(stats.misses, 'nothing found'),
    stat(stats.hits, 'cache hits'),
    stat(stats.rawBodies, 'archived responses'),
    stat(`${(stats.bytes / 1_048_576).toFixed(1)} MB`, 'on disk'),
    stats.stale ? stat(stats.stale, `stale (merge v${stats.mergeVersion})`) : null,
  );
  $('#header-stats').textContent = `${stats.entries} tracks · ${stats.found} with lyrics · merge v${stats.mergeVersion}`;

  const body = $('#cache-table tbody');
  body.replaceChildren();
  for (const entry of list.entries) {
    const merged = entry.merged ? safeJson(entry.merged) : null;
    body.append(
      el('tr', { class: 'clickable', onclick: () => showEntry(entry.key) }, [
        el('td', {}, [
          el('div', { text: entry.title || '(no title)' }),
          el('div', { class: 'desc', text: entry.artist }),
        ]),
        el('td', { class: 'mono', text: merged?.provenance?.timing ?? '—' }),
        el('td', { text: merged?.kind ?? 'none' }),
        el('td', { class: 'num', text: merged ? String(merged.lines.length) : '0' }),
        el('td', { class: 'num', text: String(entry.hits) }),
        el('td', { class: 'desc', text: when(entry.updatedAt) }),
      ]),
    );
  }
  if (list.entries.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '6', class: 'desc', text: 'Nothing cached yet.' })]));
  }
}

$('#cache-search').addEventListener('input', debounce(loadCache, 250));
$('#cache-remerge').addEventListener('click', async () => {
  const result = await api('/admin/api/remerge', { method: 'POST', body: '{}' });
  toast(`Re-merged ${result.rebuilt}/${result.attempted}`);
  await loadCache();
});

async function showEntry(key) {
  const data = await api(`/admin/api/entry?key=${encodeURIComponent(key)}`);
  const host = $('#entry-detail');

  const provenance = data.merged?.provenance;
  host.replaceChildren(
    el('h2', { text: `${data.entry.artist} — ${data.entry.title}` }),
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
          href: `/v1/lyrics?title=${encodeURIComponent(data.entry.title)}&artist=${encodeURIComponent(
            data.entry.artist,
          )}&durationMs=${data.entry.durationMs}&format=ttml`,
          target: '_blank',
          rel: 'noreferrer',
          text: 'Download TTML',
          style: 'text-decoration: none',
        }),
        el('button', {
          class: 'action danger',
          text: 'Delete',
          onclick: async () => {
            await api(`/admin/api/entry?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
            host.replaceChildren();
            await loadCache();
          },
        }),
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
                el('th', { text: 'Note' }),
                el('th', {}),
              ]),
            ),
            el(
              'tbody',
              {},
              data.raw.map((raw) =>
                el('tr', {}, [
                  el('td', { class: 'mono', text: raw.provider }),
                  el('td', { class: 'desc', text: raw.contentType }),
                  el('td', { class: 'num', text: String(raw.bytes) }),
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

    data.merged ? el('div', { class: 'card lyric-preview' }, preview(data.merged)) : null,
  );
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function startLog() {
  if (logStream) return;
  const host = $('#log');
  host.replaceChildren();
  logStream = new EventSource('/admin/api/stream');
  logStream.onmessage = (message) => {
    const event = JSON.parse(message.data);
    host.prepend(
      el('div', { class: event.level }, [
        el('span', { class: 'at', text: new Date(event.at).toLocaleTimeString() }),
        document.createTextNode(' '),
        event.provider ? el('span', { class: 'who', text: `[${event.provider}] ` }) : null,
        el('span', { class: 'msg', text: event.message }),
      ]),
    );
    while (host.childElementCount > 400) host.lastElementChild.remove();
  };
  logStream.onerror = () => {
    logStream.close();
    logStream = null;
  };
}

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
