// alate client: overview, file index, editor with proof marks, updates, settings.
// Only relative imports: the repo gate bans bare specifiers, and server.ts serves this page same-origin.
// All dynamic text goes through textContent/createTextNode, never innerHTML.

import { diffLines } from './diff.mjs';

// ---------- DOM helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

// ---------- formatting ----------

function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' kB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function relTime(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return String(iso);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
function dateOnly(iso) { return iso ? String(iso).slice(0, 10) : ''; }
const short = (v) => (typeof v === 'string' && /^[0-9a-f]{20,}$/.test(v) ? v.slice(0, 7) : v);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401) showLogin(); // app key required over a non-loopback bind
    const err = new Error((data && data.error) || 'The server answered ' + res.status + '.');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- state ----------

let state = null;        // GET /api/state
let files = [];          // GET /api/files -> [{ path, bytes }]
let settings = null;     // GET /api/settings
let busy = false;        // a write or import is running
const drafts = new Map(); // path -> { base, original, text, binary, bytes, isNew }
const openFolders = new Set();
const closedGroups = new Set();
let filterText = '';

const hasSource = () => !!(state && state.source);

// ---------- file groups (data-repo contract order) ----------

const GROUPS = [
  { key: 'rules', name: 'Rules', test: (p) => !p.includes('/') && /\.mdc?$/.test(p) && p !== 'AGENTS.md' && p !== 'README.md', strip: (p) => p },
  { key: 'user', name: 'User layer', test: (p) => p.startsWith('user/') && !SKILL_RE.test(p) && !p.startsWith('user/omp/plugins/'), strip: (p) => p.slice(5) },
  { key: 'skills', name: 'Skills', test: (p) => SKILL_RE.test(p), strip: (p) => p.replace(/^user\/(omp\/agent\/)?/, '') },
  { key: 'plugins', name: 'Plugins', test: (p) => p.startsWith('user/omp/plugins/'), strip: (p) => p.slice('user/omp/plugins/'.length) },
  { key: 'projects', name: 'Projects', test: (p) => p.startsWith('projects/'), strip: (p) => p.slice(9) },
  { key: 'repo', name: 'Repository', test: () => true, strip: (p) => p },
];
const SKILL_RE = /^user\/(omp\/agent\/(skills|managed-skills)|\.agents\/skills)\//;
const groupOf = (path) => GROUPS.find((g) => g.test(path));

// Inventory path of a skill, plugin source, or config file (the snapshot layout).
const SKILL_ROOT = { skills: 'user/omp/agent/skills/', 'managed-skills': 'user/omp/agent/managed-skills/', 'agents-skills': 'user/.agents/skills/' };
const skillPath = (s) => (SKILL_ROOT[s.origin] || 'user/omp/agent/skills/') + s.name + '/SKILL.md';

// ---------- routing ----------

function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
function fileHref(p) { return '#/file/' + encodePath(p); }

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  if (hash.startsWith('/file/')) {
    try { return { view: 'file', path: hash.slice(6).split('/').map(decodeURIComponent).join('/') }; } catch { return { view: 'overview' }; }
  }
  if (hash === '/new') return { view: 'new' };
  if (hash === '/updates') return { view: 'updates' };
  if (hash === '/settings') return { view: 'settings' };
  return { view: 'overview' };
}

// ---------- shell ----------

function renderShell() {
  const src = state && state.source;
  document.body.classList.toggle('no-source', !src);
  $('views').hidden = !src;
  $('index').hidden = !src;
  const line = $('source');
  line.textContent = '';
  if (src) {
    const spec = src.kind === 'repo' ? src.name + (src.ref ? '@' + src.ref : '') : src.spec;
    line.append(h('b', { text: spec }));
    if (src.importedSha) line.append(' at ' + src.importedSha.slice(0, 7));
    line.append(' · imported ' + relTime(src.importedAt));
    line.title = src.kind === 'repo' ? 'GitHub repo ' + spec : 'Local path ' + src.name;
  }
  const route = parseRoute();
  for (const a of $('views').querySelectorAll('a')) {
    if (a.dataset.view === route.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const ready = updateRows().filter((u) => updateStatus(u).ready).length;
  const updLink = $('views').querySelector('[data-view="updates"]');
  updLink.textContent = 'Updates';
  if (ready) updLink.append(h('span', { class: 'count', text: String(ready) }), h('span', { class: 'visually-hidden', text: ' ready' }));
  renderBanner();
}

function renderBanner() {
  const b = $('banner');
  const up = state && state.update;
  const show = !!(up && up.available && state.source && state.source.kind === 'repo');
  b.hidden = !show;
  document.body.classList.toggle('has-banner', show);
  b.textContent = '';
  if (!show) return;
  b.append(
    h('span', { text: 'agent-data has newer commits on GitHub (checked ' + relTime(up.checkedAt) + ').' }),
    h('button', { type: 'button', class: 'linkish', onclick: () => doImport(state.source.spec, 'repo'), text: 'Import them now' }),
  );
}

// ---------- index (file tree) ----------

function buildTree(paths, strip) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = strip(p).split('/');
    let node = root;
    for (const seg of parts.slice(0, -1)) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  return root;
}

function treeList(node, depth, keyPrefix, current) {
  const ul = h('ul');
  for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const key = keyPrefix + '/' + name;
    const containsCurrent = current && hasPath(child, current);
    const open = filterText || openFolders.has(key) || containsCurrent;
    const det = h('details', { class: 'folder', open },
      h('summary', null, h('span', { text: name })),
      treeList(child, depth + 1, key, current));
    det.firstChild.style.setProperty('--depth', depth);
    det.addEventListener('toggle', () => { if (det.open) openFolders.add(key); else openFolders.delete(key); });
    ul.append(h('li', null, det));
  }
  for (const f of node.files) {
    const d = drafts.get(f.path);
    const dirty = d && isDirty(d);
    const a = h('a', { href: fileHref(f.path), class: dirty ? 'dirty' : null, 'aria-current': f.path === current ? 'page' : null, title: f.path },
      h('span', { text: f.name }),
      dirty ? h('span', { class: 'visually-hidden', text: ' (unsaved)' }) : null);
    a.style.setProperty('--depth', depth);
    ul.append(h('li', null, a));
  }
  return ul;
}

function hasPath(node, path) {
  return node.files.some((f) => f.path === path) || [...node.dirs.values()].some((c) => hasPath(c, path));
}

function renderTree() {
  const tree = $('tree');
  const scroll = tree.scrollTop;
  tree.textContent = '';
  const route = parseRoute();
  const current = route.view === 'file' ? route.path : null;
  const q = filterText.toLowerCase();
  // New files that only exist as drafts still appear in the index.
  const all = [...files.map((f) => f.path), ...[...drafts.keys()].filter((p) => drafts.get(p).isNew)];
  const visible = q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
  for (const g of GROUPS) {
    const paths = visible.filter((p) => groupOf(p) === g).sort();
    if (!paths.length && (q || g.key === 'repo')) continue;
    const det = h('details', { class: 'group', open: q || !closedGroups.has(g.key) },
      h('summary', null, h('span', { text: g.name }), h('span', { class: 'n', text: plural(paths.length, 'file') })),
      paths.length ? treeList(buildTree(paths, g.strip), 0, g.key, current) : h('p', { class: 'empty', text: 'No files.' }));
    det.addEventListener('toggle', () => { if (det.open) closedGroups.delete(g.key); else closedGroups.add(g.key); });
    tree.append(det);
  }
  if (q && !visible.length) tree.append(h('p', { class: 'empty', text: 'No file path contains "' + filterText + '".' }));
  tree.scrollTop = scroll;
}

// ---------- views ----------

function render() {
  renderShell();
  if (!state) return;
  const galley = $('galley');
  galley.classList.remove('editing');
  galley.textContent = '';
  if (!hasSource()) { galley.append(onboardingView()); return; }
  renderTree();
  const route = parseRoute();
  if (route.view === 'file') return void fileView(route.path);
  if (route.view === 'new') return void newFileView();
  if (route.view === 'updates') galley.append(updatesView());
  else if (route.view === 'settings') galley.append(settingsView());
  else galley.append(overviewView());
}

// ---------- overview ----------

function entry(href, name, desc, aside, asideAlert) {
  return h('li', null,
    href ? h('a', { href, text: name }) : h('span', { text: name }),
    h('span', { class: 'desc clamp', text: desc || '' }),
    h('span', { class: 'aside' + (asideAlert ? ' alert' : ''), text: aside || '' }));
}

function part(title, count, ...body) {
  return h('section', { class: 'part', 'aria-label': title },
    h('h2', null, h('span', { text: title }), count != null ? h('span', { class: 'n', text: count }) : null),
    ...body);
}

const STATUS_COPY = { sync: 'in sync', changed: 'changed on this machine', missing: 'missing on this machine', uncaptured: 'not captured', unknown: 'not checked' };
const DRIFT = new Set(['changed', 'missing', 'uncaptured']);

function overviewView() {
  const inv = state.inventory || {};
  const user = inv.user || { configFiles: [], others: [], skills: [], extensions: [], plugins: [] };
  const projects = inv.projects || { contextFiles: [], named: [] };
  const rules = inv.rules || [];
  const src = state.source;
  const has = new Set(files.map((f) => f.path));
  const link = (p) => (has.has(p) ? fileHref(p) : null);

  const sheet = h('article', { class: 'sheet' });
  const spec = src.kind === 'repo' ? src.name + (src.ref ? '@' + src.ref : '') : src.spec;
  sheet.append(h('header', { class: 'sheet-head' },
    h('h1', { text: src.kind === 'repo' ? spec : src.name.split(/[\\/]/).filter(Boolean).pop() || spec }),
    h('p', { class: 'meta', text: (src.kind === 'repo' ? 'GitHub repo' : 'Local path ' + src.name) + (src.importedSha ? ' · commit ' + src.importedSha.slice(0, 7) : '') + ' · imported ' + relTime(src.importedAt) }),
    h('p', { class: 'totals' },
      plural(rules.length, 'rule'), ', ', plural(user.skills.length, 'skill'), ', ', plural(user.plugins.length, 'plugin'), ', ',
      plural(projects.named.length, 'project'), ', and ', plural(files.length, 'file'), ' in total. Pick a file in the index to edit it, or ',
      h('a', { href: '#/new', text: 'add a new file' }), '.')));

  // Changes since the previous import, and scan warnings.
  const ch = state.changes;
  if (ch) {
    const items = [];
    const NAMES = { rules: 'Rules', skills: 'Skills', plugins: 'Plugins', extensions: 'Extensions', user: 'User layer', projects: 'Projects' };
    for (const [k, label] of Object.entries(NAMES)) {
      const c = ch[k];
      if (!c) continue;
      for (const [verb, list] of [['added', c.added], ['removed', c.removed], ['changed', c.updated]]) {
        if (list && list.length) items.push(h('li', null, label + ' ' + verb + ': ', ...list.flatMap((n, i) => [i ? ', ' : '', h('code', { text: n })])));
      }
    }
    if (items.length) sheet.append(part('Changed since you last imported', null, h('ul', { class: 'changes' }, items)));
  }
  if (inv.warnings && inv.warnings.length) {
    sheet.append(part('Warnings', String(inv.warnings.length), h('ul', { class: 'changes warnings' }, inv.warnings.map((w) => h('li', { text: w })))));
  }

  sheet.append(part('Rules', String(rules.length),
    rules.length ? h('ul', { class: 'entries' }, rules.map((r) => entry(link(r.name), r.name, r.description || 'No description in the frontmatter.', bytes(files.find((f) => f.path === r.name)?.bytes))))
      : h('p', { class: 'note', text: 'No rules in this data repo. A rule is a root *.md or *.mdc file with a description in its frontmatter.' })));

  const userRows = [
    ...user.configFiles.map((f) => entry(link('user/' + f.path), f.path, 'Config file', bytes(f.bytes))),
    ...(user.others || []).map((f) => entry(link('user/' + f.path), f.path, 'Lock and manifest file', bytes(f.bytes))),
    ...user.extensions.map((x) => entry(null, x, 'Extension', '')),
  ];
  sheet.append(part('User layer', String(userRows.length),
    userRows.length ? h('ul', { class: 'entries' }, userRows) : h('p', { class: 'note', text: 'No user layer in this data repo.' })));

  sheet.append(part('Skills', String(user.skills.length),
    user.skills.length ? h('ul', { class: 'entries' }, user.skills.map((s) => entry(link(skillPath(s)), s.name, s.description || 'No description in SKILL.md.', s.origin)))
      : h('p', { class: 'note', text: 'No skills in this data repo.' })));

  sheet.append(part('Plugins', String(user.plugins.length),
    user.plugins.length ? h('ul', { class: 'entries' }, user.plugins.map((p) => entry(link('user/omp/plugins/' + p.origin), p.name, p.version || '', 'from ' + p.origin)))
      : h('p', { class: 'note', text: 'No plugins in this data repo.' })));

  const projectBlocks = projects.named.map((p) => {
    const entries = Array.isArray(p.entries) ? p.entries : [];
    const drift = entries.filter((e) => DRIFT.has(e.status)).length;
    const live = p.live === 'gone' ? 'project folder missing on this machine' : p.live === 'off' ? 'not compared with this machine' : drift ? plural(drift, 'file') + ' differ from this machine' : 'in sync with this machine';
    return h('div', { class: 'project' },
      h('h3', null, h('span', { text: p.name }), h('span', { class: drift || p.live === 'gone' ? 'alert' : '', text: live })),
      entries.length ? h('ul', { class: 'entries' }, entries.map((e) => entry(link('projects/' + p.name + '/' + e.path), e.path, STATUS_COPY[e.status] || e.status, bytes(e.bytes), DRIFT.has(e.status))))
        : h('p', { class: 'note', text: 'No snapshot files.' }));
  });
  sheet.append(part('Projects', String(projects.named.length),
    projects.contextFiles.length ? h('p', { class: 'note', text: 'Context files captured per project: ' + projects.contextFiles.join(', ') + '.' }) : null,
    ...(projectBlocks.length ? projectBlocks : [h('p', { class: 'note', text: 'No projects in projects/projects.json.' })])));

  const ups = updateRows();
  const ready = ups.filter((u) => updateStatus(u).ready).length;
  sheet.append(part('Updates', String(ups.length),
    h('p', { class: 'note' }, ups.length ? plural(ready, 'update') + ' ready to apply. ' : 'No update sources in this snapshot. ', h('a', { href: '#/updates', text: 'Open the updates table' }), '.')));
  return sheet;
}

// ---------- updates ----------

function updateRows() { return (state && state.updates && Array.isArray(state.updates.updates)) ? state.updates.updates : []; }

function updateStatus(u) {
  if (u.error) return { text: 'Check failed' };
  if (u.managedBy) return { text: 'Managed by ' + u.managedBy };
  if (u.current && u.latest && u.current === u.latest) return { text: 'Up to date' };
  if (u.target && u.target !== u.current) return { text: 'Ready: ' + short(u.target), ready: true };
  if (u.latest && u.latest !== u.current) return { text: u.qualifiesAt ? 'Newer ' + short(u.latest) + ', waits until ' + dateOnly(u.qualifiesAt) : 'Newer: ' + short(u.latest) };
  return { text: 'No data' };
}

function safeLink(href, label) {
  return /^https?:\/\//i.test(String(href || '')) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label }) : document.createTextNode(href ? String(href) : '');
}

function updatesView() {
  const ups = updateRows();
  const checked = state.updates && state.updates.checkedAt;
  const sheet = h('article', { class: 'sheet' },
    h('header', { class: 'sheet-head' },
      h('h1', { text: 'Updates' }),
      h('p', { class: 'lede', text: 'Newer versions of the skills, plugins, and pinned tools in agent-data. A version is ready after it is 7 days old. Last check: ' + (checked ? new Date(checked).toLocaleString() : 'never') + '.' })));
  if (!ups.length) {
    sheet.append(h('p', { class: 'note', text: 'No update sources in this snapshot: add upstreams.json, user/agents/.skill-lock.json, or user/omp/plugins/bun.lock.' }));
    return sheet;
  }
  const head = ['Name', 'Status', 'Current', 'Target', 'Latest', 'Origin', 'Notes', 'Last error'];
  const rows = ups.map((u) => {
    const st = updateStatus(u);
    const v = (x) => h('td', { class: 'v', title: x || null, text: x ? short(x) : '' });
    return h('tr', null,
      h('td', { class: 'name' }, u.name, h('span', { class: 'kind', text: u.kind })),
      h('td', { class: 'state' + (st.ready ? ' ready' : ''), text: st.text }),
      v(u.current), v(u.target), v(u.latest),
      h('td', null, u.origin ? safeLink(u.origin, u.origin.replace(/^https?:\/\/(www\.)?/, '')) : ''),
      h('td', null, u.notesUrl ? safeLink(u.notesUrl, 'notes') : ''),
      h('td', { class: 'err', text: u.error || '' }));
  });
  sheet.append(h('div', { class: 'table-wrap' },
    h('table', { class: 'updates' }, h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col', text: t })))), h('tbody', null, rows))));
  return sheet;
}

// ---------- source form (onboarding and settings) ----------

function sourceForm({ submitLabel, onCancel }) {
  const kindName = 'kind-' + Math.random().toString(36).slice(2, 8);
  const input = h('input', { type: 'text', id: 'source-input', autocomplete: 'off', spellcheck: 'false', required: true });
  const label = h('label', { for: 'source-input' });
  const hint = h('p', { class: 'hint' });
  const status = h('p', { class: 'form-status', role: 'status' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const radio = (value, text, checked) => h('label', null, h('input', { type: 'radio', name: kindName, value, checked }), h('span', { text }));
  const seg = h('fieldset', { class: 'seg' }, h('legend', { text: 'Source type' }), radio('repo', 'GitHub repo', true), radio('path', 'Local path'));
  const kind = () => seg.querySelector('input:checked').value;
  // The key field lets a first run import a private repo before Settings is reachable.
  const keyInput = h('input', { type: 'password', id: 'source-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'ghp_… or github_pat_…' });
  const keyField = h('div', { class: 'field' },
    h('label', { for: 'source-key', text: 'GitHub key (only for a private repo)' }), keyInput,
    h('p', { class: 'hint', text: 'alate needs push access to commit your edits. The server stores the key and never sends it back.' }));
  const sync = () => {
    const repo = kind() === 'repo';
    label.textContent = repo ? 'Repo as owner/name, with an optional @branch' : 'Path to a checkout of the data repo';
    input.placeholder = repo ? 'owner/data-repo' : '../agent-data';
    hint.textContent = repo ? 'alate clones it, and pushes your edits back to it.' : 'alate reads the folder. When it is a git checkout, alate commits and pushes your edits.';
    keyField.hidden = !repo || !!(settings && settings.tokenSet);
  };
  seg.addEventListener('change', sync);
  sync();
  const submit = h('button', { type: 'submit', class: 'btn', text: submitLabel });
  const example = h('button', { type: 'button', class: 'btn quiet', text: 'Use the bundled example' });
  const form = h('form', { class: 'source-form', novalidate: true },
    seg,
    h('div', { class: 'field' }, label, input, hint),
    keyField,
    h('div', { class: 'row' }, submit, example, onCancel ? h('button', { type: 'button', class: 'btn quiet', onclick: onCancel, text: 'Cancel' }) : null),
    status, error);
  const run = async (source, k) => {
    error.hidden = true;
    if (!source) { error.textContent = 'Enter a repo or a path.'; error.hidden = false; input.focus(); return; }
    submit.disabled = example.disabled = true;
    status.textContent = k === 'repo' ? 'Cloning ' + source + '…' : 'Reading ' + source + '…';
    try {
      if (k === 'repo' && keyInput.value) { settings = await api('POST', '/api/settings', { token: keyInput.value }); keyInput.value = ''; }
      await doImport(source, k);
    } catch (e) {
      status.textContent = '';
      error.textContent = e.message;
      error.hidden = false;
      submit.disabled = example.disabled = false;
    }
  };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); run(input.value.trim(), kind()); });
  example.addEventListener('click', () => run('examples/data', 'path'));
  return form;
}

// The URL ends its line: zero-deps.test.mjs reads `import'` plus a later quote as a module specifier.
const postImport = (source, kind) => api('POST', '/api/import',
  { source, kind });

async function doImport(source, kind) {
  busy = true;
  try {
    const res = await postImport(source, kind);
    state = { ...res.state, updates: state && state.updates };
    await refresh();
    if (location.hash !== '#/') location.hash = '#/'; else render();
  } finally {
    busy = false;
  }
}

function onboardingView() {
  return h('section', { class: 'onboard', 'aria-labelledby': 'ob-h' },
    h('h1', { id: 'ob-h', text: 'Connect your data repo' }),
    h('p', { class: 'lede', text: 'alate shows every file in the repo that provisions your agents: rules, the user layer, skills, plugins, and project snapshots. You can edit any of them here. alate commits and pushes each change.' }),
    sourceForm({ submitLabel: 'Import' }));
}

// ---------- settings ----------

function settingsView() {
  const src = state.source;
  const sheet = h('article', { class: 'sheet' }, h('header', { class: 'sheet-head' }, h('h1', { text: 'Settings' })));

  const sourceBody = h('div');
  const showSource = () => {
    sourceBody.textContent = '';
    sourceBody.append(
      h('dl', { class: 'kv' },
        h('dt', { text: 'Type' }), h('dd', { text: src.kind === 'repo' ? 'GitHub repo' : 'Local path' }),
        h('dt', { text: 'Source' }), h('dd', { text: src.kind === 'repo' ? src.spec : src.name }),
        h('dt', { text: 'Commit' }), h('dd', { text: src.importedSha || 'not recorded' }),
        h('dt', { text: 'Imported' }), h('dd', { text: new Date(src.importedAt).toLocaleString() + ' (' + relTime(src.importedAt) + ')' })),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: async (ev) => {
          ev.target.disabled = true; ev.target.textContent = 'Importing…';
          try { await doImport(src.spec, src.kind); } catch (e) { ev.target.disabled = false; ev.target.textContent = 'Import again'; alertLine(sourceBody, e.message); }
        }, text: 'Import again' }),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => {
          sourceBody.textContent = '';
          sourceBody.append(sourceForm({ submitLabel: 'Import this source', onCancel: showSource }));
          sourceBody.querySelector('input[type="text"]').focus();
        }, text: 'Change source' })));
  };
  showSource();
  sheet.append(part('Data source', null, sourceBody));

  // GitHub key: write-only on the server.
  const s = settings || { tokenSet: false, autoUpdate: false };
  const tokenInput = h('input', { type: 'password', id: 'gh-token', autocomplete: 'off', spellcheck: 'false', placeholder: 'ghp_… or github_pat_…' });
  const tokenStatus = h('p', { class: 'form-status', role: 'status', text: s.tokenSet ? 'A GitHub key is stored.' : 'No GitHub key is stored.' });
  const saveKey = async () => {
    try {
      settings = await api('POST', '/api/settings', { token: tokenInput.value });
      tokenInput.value = '';
      tokenStatus.textContent = settings.tokenSet ? 'Key saved. A GitHub key is stored.' : 'Key removed. No GitHub key is stored.';
    } catch (e) { tokenStatus.textContent = e.message; }
  };
  tokenInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveKey(); } });
  const auto = h('input', { type: 'checkbox', id: 'auto-update', checked: s.autoUpdate });
  auto.addEventListener('change', async () => {
    try { settings = await api('POST', '/api/settings', { autoUpdate: auto.checked }); } catch (e) { auto.checked = !auto.checked; tokenStatus.textContent = e.message; }
  });
  sheet.append(part('GitHub key', null,
    h('p', { class: 'note', text: 'alate uses this key to clone and push the data repo and to check for updates. The server stores it in its config file and never sends it back. Save an empty field to remove it.' }),
    h('div', { class: 'field' }, h('label', { for: 'gh-token', text: 'Personal access token' }), h('div', { class: 'row' }, tokenInput, h('button', { type: 'button', class: 'btn', onclick: saveKey, text: 'Save key' }))),
    tokenStatus,
    h('label', { class: 'check' }, auto, 'Import again automatically when the GitHub repo has new commits')));

  // App key for Ottr and other callers.
  const out = h('div', { role: 'status' });
  const keyBtn = h('button', { type: 'button', class: 'btn quiet', text: 'Create a new app key' });
  keyBtn.addEventListener('click', async () => {
    if (!confirm('Create a new app key? The current key stops working immediately.')) return;
    keyBtn.disabled = true;
    try {
      const { key } = await api('POST', '/api/key');
      out.textContent = '';
      out.append(h('code', { class: 'key-value', text: key }),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => navigator.clipboard.writeText(key), text: 'Copy key' }),
        h('p', { class: 'note', text: 'alate shows this key once. Store it in the caller now.' }));
    } catch (e) { out.textContent = e.message; } finally { keyBtn.disabled = false; }
  });
  sheet.append(part('App key', null,
    h('p', { class: 'note', text: 'Callers such as Ottr send this key as "Authorization: Bearer <key>" to POST /config and POST /provision.' }),
    keyBtn, out));
  return sheet;
}

function alertLine(parent, msg) {
  parent.querySelector('.form-error')?.remove();
  parent.append(h('p', { class: 'form-error', role: 'alert', text: msg }));
}

const isDirty = (d) => d.isNew || d.text !== d.original;

// A textarea always holds LF. The editor diffs LF text and writes CRLF back when the file had it,
// so a save never rewrites every line ending of a Windows checkout.
const lf = (s) => (s ?? '').replaceAll('\r\n', '\n');
const loaded = (f) => ({ base: f.hash, original: lf(f.content), eol: /\r\n/.test(f.content ?? '') ? '\r\n' : '\n', binary: f.binary, bytes: f.bytes });

function markText(hk) {
  const first = hk.start + 1;
  const range = hk.count > 1 ? 'Lines ' + first + '–' + (first + hk.count - 1) : 'Line ' + first;
  if (!hk.count) return hk.start === 0 ? plural(hk.old.length, 'line') + ' deleted at the top' : plural(hk.old.length, 'line') + ' deleted after line ' + hk.start;
  if (!hk.old.length) return range + ' added';
  return range + ' changed';
}

function quoteOf(hk) {
  if (!hk.old.length) return null;
  const line = hk.old.find((l) => l.trim()) ?? hk.old[0];
  const text = line.length > 90 ? line.slice(0, 90) + '…' : line || '(empty line)';
  return hk.old.length > 1 ? text + ' (and ' + plural(hk.old.length - 1, 'more line') + ')' : text;
}

// ---------- file view ----------

let editor = null; // { path, draft, textarea, backdrop, margin, stack, status, commit, discard }

async function fileView(path) {
  const galley = $('galley');
  let d = drafts.get(path);
  if (!d) {
    galley.append(h('p', { class: 'sheet meta', role: 'status', text: 'Opening ' + path + '…' }));
    try {
      const f = await api('GET', '/api/file?path=' + encodeURIComponent(path));
      d = { ...loaded(f), text: lf(f.content) };
      drafts.set(path, d);
    } catch (e) {
      if (parseRoute().path !== path) return;
      galley.textContent = '';
      galley.append(h('article', { class: 'sheet' }, h('header', { class: 'sheet-head' }, h('h1', { text: path }),
        h('p', { class: 'lede alert', text: e.status === 404 ? 'This file is not in the imported snapshot. It may be deleted, or the index is out of date.' : e.message }),
        h('p', null, h('a', { href: '#/', text: 'Back to the overview' })))));
      return;
    }
    if (parseRoute().path !== path) return; // the visitor moved on while it loaded
  }
  galley.textContent = '';
  mountEditor(path, d);
}

function describe(path) {
  const inv = state.inventory || {};
  const rule = (inv.rules || []).find((r) => r.name === path);
  if (rule) return rule.description;
  const skill = (inv.user?.skills || []).find((s) => skillPath(s) === path);
  return skill ? skill.description : null;
}

function mountEditor(path, d) {
  const galley = $('galley');
  galley.classList.add('editing');
  const name = path.split('/').pop();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'repo root';
  const group = groupOf(path);

  const deleteBtn = d.isNew ? null : h('button', { type: 'button', class: 'btn danger', text: 'Delete file' });
  const head = h('header', { class: 'file-head' },
    h('div', { class: 'title sheet-head' },
      h('h1', { text: name }),
      h('p', { class: 'meta', text: [group.name, dir, d.isNew ? 'new file' : bytes(d.bytes)].join(' · ') }),
      describe(path) ? h('p', { class: 'lede clamp', text: describe(path) }) : null),
    h('div', { class: 'actions' }, deleteBtn));

  if (d.binary) {
    galley.append(head, h('div', { class: 'binary' },
      h('p', { text: 'This is a binary file (' + bytes(d.bytes) + '). alate can delete it, but it cannot edit it as text.' })));
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteFile(path, d, deleteBtn, galley.querySelector('.binary')));
    return;
  }

  const textarea = h('textarea', { 'aria-label': 'Text of ' + path, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'soft' });
  textarea.value = d.text;
  const backdrop = h('div', { class: 'backdrop', 'aria-hidden': 'true' });
  const stack = h('div', { class: 'stack' }, backdrop, textarea);
  const margin = h('aside', { class: 'margin', 'aria-label': 'Changes in this file' });
  const scroller = h('div', { class: 'paper-scroll' }, h('div', { class: 'editor' }, stack, margin));

  const msgInput = h('input', { type: 'text', id: 'commit-msg', maxlength: '500', autocomplete: 'off', spellcheck: 'true', placeholder: 'alate: ' + (d.isNew ? 'add ' : 'edit ') + path });
  const status = h('p', { class: 'status', role: 'status' });
  const discard = h('button', { type: 'button', class: 'btn quiet', text: 'Discard changes' });
  const commit = h('button', { type: 'submit', class: 'btn', text: 'Commit and push' });
  const press = h('form', { class: 'press', 'aria-label': 'Commit' },
    h('div', { class: 'msg' }, h('label', { for: 'commit-msg', text: 'Commit message' }), msgInput),
    discard, commit, status);

  galley.append(head, scroller, press);
  if (flash) { status.className = 'status ok'; status.textContent = flash; flash = null; }
  editor = { path, d, textarea, backdrop, margin, stack, status, commit, discard, msgInput };

  textarea.addEventListener('input', () => { d.text = textarea.value; schedulePaint(); });
  textarea.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); press.requestSubmit(); }
  });
  press.addEventListener('submit', (ev) => { ev.preventDefault(); saveFile(path, d); });
  discard.addEventListener('click', () => {
    if (!confirm('Discard your changes to ' + path + '?')) return;
    if (d.isNew) { drafts.delete(path); location.hash = '#/'; return; }
    d.text = d.original; textarea.value = d.text; status.textContent = ''; paint();
  });
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteFile(path, d, deleteBtn, status));
  paint();
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paint(); });
}

// Rebuild the line mirror behind the textarea, then place one proof mark per hunk beside its lines.
function paint() {
  if (!editor || !editor.textarea.isConnected) return;
  const { d, backdrop, margin, stack, commit, discard } = editor;
  const lines = d.text.split('\n');
  const hunks = d.isNew ? (d.text ? [{ start: 0, count: lines.length, old: [] }] : []) : diffLines(d.original.split('\n'), lines);
  const changed = new Set();
  const frag = document.createDocumentFragment();
  const rows = lines.map((l) => { const div = document.createElement('div'); div.className = 'ln'; div.textContent = l || ' '; frag.append(div); return div; });
  for (const hk of hunks) {
    for (let k = 0; k < hk.count; k++) changed.add(hk.start + k);
    if (!hk.count) {
      if (hk.start < rows.length) rows[hk.start].classList.add('del-above'); else rows[rows.length - 1].classList.add('del-below');
    }
  }
  for (const k of changed) rows[k]?.classList.add('chg');
  backdrop.textContent = '';
  backdrop.append(frag);

  margin.textContent = '';
  if (!hunks.length) {
    margin.append(h('h2', { text: 'Proof marks' }), h('p', { class: 'clean', text: 'No changes yet. Each change you make gets a mark here.' }));
  } else {
    const marks = hunks.map((hk) => {
      const row = rows[Math.min(hk.start, rows.length - 1)];
      const mk = h('div', { class: 'mark' }, markText(hk), quoteOf(hk) ? h('q', { text: quoteOf(hk) }) : null);
      mk.dataset.top = String(stack.offsetTop + row.offsetTop);
      margin.append(mk);
      return mk;
    });
    let floor = 0;
    for (const mk of marks) {
      const top = Math.max(+mk.dataset.top, floor);
      mk.style.top = top + 'px';
      floor = top + mk.offsetHeight + 8;
    }
  }
  const dirty = isDirty(d);
  commit.disabled = !dirty || busy;
  discard.disabled = !dirty || busy;
  updateDirtyMarker(editor.path, dirty);
}

function updateDirtyMarker(path, dirty) {
  const a = $('tree').querySelector('a[aria-current="page"]');
  if (!a || a.getAttribute('title') !== path || a.classList.contains('dirty') === dirty) return;
  a.classList.toggle('dirty', dirty);
  a.querySelector('.visually-hidden')?.remove();
  if (dirty) a.append(h('span', { class: 'visually-hidden', text: ' (unsaved)' }));
}

function setBusy(on) {
  busy = on;
  if (!editor) return;
  editor.textarea.readOnly = on;
  editor.commit.textContent = on ? 'Pushing…' : 'Commit and push';
  paint();
}

async function saveFile(path, d) {
  const { status, msgInput } = editor;
  status.className = 'status';
  if (!isDirty(d)) return;
  setBusy(true);
  status.textContent = 'Committing and pushing ' + path + '…';
  try {
    const content = d.eol === '\r\n' ? d.text.replaceAll('\n', '\r\n') : d.text;
    const res = await api('PUT', '/api/file', { path, content, base: d.isNew ? null : d.base, message: msgInput.value.trim() || undefined });
    await afterWrite(res);
    // Remount from the new snapshot; the press bar shows the result.
    drafts.delete(path);
    flash = pushNote(res);
    render();
  } catch (e) {
    status.className = 'status error';
    if (e.status === 409 && /changed/i.test(e.message)) await rebase(path, d, status);
    else status.textContent = e.message;
  } finally {
    setBusy(false);
  }
}

// The file changed upstream: import the new snapshot, keep the visitor's text, and compare it
// with the new version.
async function rebase(path, d, status) {
  status.textContent = 'agent-data changed this file since you opened it. Reading the new version…';
  try {
    const src = state.source;
    const res = await postImport(src.spec, src.kind);
    await afterWrite(res);
    renderTree();
  } catch (e) { status.textContent = e.message; return; }
  try {
    const f = await api('GET', '/api/file?path=' + encodeURIComponent(path));
    Object.assign(d, loaded(f), { isNew: false });
    status.textContent = 'agent-data changed this file since you opened it. Your text is still here. The marks now compare it with the new version. Check them, then commit again.';
  } catch (e) {
    if (e.status !== 404) { status.textContent = e.message; return; }
    Object.assign(d, { base: null, original: '', isNew: true });
    status.textContent = 'agent-data no longer has this file. Your text is still here. Commit to add it again.';
  }
}

function pushNote(res) {
  const sha = res.commit ? res.commit.slice(0, 7) : '';
  if (res.pushed) return 'Pushed ' + sha + '. agent-data has the change.';
  if (sha) return 'Committed ' + sha + ', but did not push' + (res.warning ? ': ' + res.warning : '.');
  return 'Saved. The folder is not a git checkout, so there is no commit.';
}

async function deleteFile(path, d, btn, statusEl) {
  if (!confirm('Delete ' + path + ' from agent-data? alate commits and pushes the deletion.')) return;
  btn.disabled = true;
  setBusy(true);
  try {
    const res = await api('DELETE', '/api/file', { path, base: d.base, message: editor?.msgInput.value.trim() || undefined });
    await afterWrite(res);
    drafts.delete(path);
    flash = pushNote(res).replace('the change', 'the deletion');
    location.hash = '#/';
  } catch (e) {
    statusEl.className = 'status error';
    statusEl.textContent = e.message;
    btn.disabled = false;
  } finally {
    setBusy(false);
  }
}

let flash = null; // one-shot status line after a navigation

async function afterWrite(res) {
  if (res && res.state) state = { ...res.state, updates: res.state.updates ?? (state && state.updates) };
  files = (await api('GET', '/api/files')).files;
  renderShell();
}

// ---------- new file ----------

function newFileView() {
  const galley = $('galley');
  const input = h('input', { type: 'text', id: 'new-path', autocomplete: 'off', spellcheck: 'false', placeholder: 'my-rule.md' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'path-field' },
    h('label', { for: 'new-path', text: 'Path of the new file' }),
    h('p', { class: 'hint', text: 'Relative to the repo root. Examples: a rule is "my-rule.md", a skill is "user/omp/agent/skills/my-skill/SKILL.md".' }),
    h('div', { class: 'row' }, input, h('button', { type: 'submit', class: 'btn', text: 'Start the file' })),
    err);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const p = input.value.trim().replace(/^\/+/, '');
    const bad = !p || p.includes('\\') || p.split('/').some((s) => !s || s === '.' || s === '..' || s === '.git');
    if (bad) { err.textContent = 'Use a relative path with "/" between folders, without "..", empty parts, or .git.'; err.hidden = false; return; }
    if (files.some((f) => f.path === p)) { location.hash = fileHref(p); return; }
    drafts.set(p, { base: null, original: '', text: '', binary: false, bytes: 0, isNew: true });
    location.hash = fileHref(p);
  });
  galley.append(h('article', { class: 'sheet' }, h('header', { class: 'sheet-head' }, h('h1', { text: 'New file' })), form));
  input.focus();
}

// ---------- loading and refresh ----------

async function refresh() {
  const next = await api('GET', '/api/state');
  const changedImport = !state || !state.source || !next.source || state.source.importedAt !== next.source.importedAt;
  state = next;
  if (state.source && (changedImport || !files.length)) files = (await api('GET', '/api/files')).files;
  if (!settings) settings = await api('GET', '/api/settings').catch(() => null);
}

async function load() {
  try {
    await refresh();
    render();
  } catch (e) {
    if (e.status === 401) return; // api() already switched to the login view
    const galley = $('galley');
    galley.textContent = '';
    galley.append(h('section', { class: 'onboard' },
      h('h1', { text: 'alate is not answering' }),
      h('p', { class: 'lede alert', text: 'The page could not load data from the alate server (' + e.message + '). Check that "node server.ts" is running.' }),
      h('button', { type: 'button', class: 'btn', onclick: load, text: 'Try again' })));
  }
}

window.addEventListener('hashchange', () => {
  document.body.classList.remove('index-open');
  $('files-toggle').setAttribute('aria-expanded', 'false');
  editor = null;
  render();
  $('galley').scrollTop = 0;
  // A file view shows the flash in its press bar once it mounts (fileView loads first).
  if (flash && parseRoute().view !== 'file') {
    $('galley').querySelector('.sheet-head')?.append(h('p', { class: 'lede', role: 'status', text: flash }));
    flash = null;
  }
});

window.addEventListener('beforeunload', (ev) => {
  if ([...drafts.values()].some(isDirty)) ev.preventDefault();
});
window.addEventListener('resize', schedulePaint);

$('filter').addEventListener('input', (ev) => { filterText = ev.target.value.trim(); renderTree(); });
$('files-toggle').addEventListener('click', () => {
  const open = !document.body.classList.contains('index-open');
  document.body.classList.toggle('index-open', open);
  $('files-toggle').setAttribute('aria-expanded', String(open));
});

// Poll so server-side imports and update checks show up. Never repaint a view with input in it.
setInterval(async () => {
  if (busy || document.hidden || !state || !state.source) return;
  try {
    await refresh();
    renderShell();
    renderTree();
    const v = parseRoute().view;
    if (v === 'overview' || v === 'updates') render();
  } catch { /* the next tick retries; load() shows hard failures */ }
}, 60000);

// ---------- login (app key over a non-loopback bind) ----------
// ---------- theme ----------

// Three-state switch, defaulting to system: stored in localStorage, resolved to an
// explicit [data-theme] on <html>. The head bootstrap in index.html does the same
// resolution before first paint; this section owns everything after it.
const THEMES = ['system', 'light', 'dark'];
const THEME_KEY = 'alate.theme';
const mqDark = matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'system';
  } catch { return 'system'; }
}

function applyTheme() {
  const choice = storedTheme();
  document.documentElement.dataset.theme = choice === 'system' ? (mqDark.matches ? 'dark' : 'light') : choice;
  $('theme-toggle').textContent = 'Theme: ' + choice;
}

$('theme-toggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch { /* session-only choice */ }
  applyTheme();
});

// Follow the OS while on system.
mqDark.addEventListener('change', () => { if (storedTheme() === 'system') applyTheme(); });

applyTheme();


function showLogin() {
  $('login-error').hidden = true;
  $('login-view').hidden = false;
  $('login-key').focus();
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const key = $('login-key').value;
  $('login-error').hidden = true;
  if (!key) return;
  $('login-btn').disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const err = $('login-error');
      err.textContent = res.status === 401 ? 'Wrong key.' : 'Sign-in failed (' + res.status + ').';
      err.hidden = false;
      return;
    }
    $('login-key').value = '';
    $('login-view').hidden = true;
    await load();
  } catch {
    const err = $('login-error');
    err.textContent = 'Could not reach the dashboard server.';
    err.hidden = false;
  } finally {
    $('login-btn').disabled = false;
  }
});
load();
// PWA: register the offline shell where the browser allows it (loopback and HTTPS).
// A plain-HTTP LAN bind has no secure context, so the property is absent and this skips.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
