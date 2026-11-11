// Upstream update checker. Reads only the stored snapshot (SQLite `files` table) and issues
// upstream GETs; it never edits a repo and never talks to Ottr. Rows are one JSON document
// per `updates` row; `update_seen` records when a chrome-for-testing version or a
// path-tracked head commit was first observed, because cft publishes no timestamps of its
// own and a commit's committer date is publisher-writable; `osv_cache` holds raw OSV
// records (null for a 404) by CVE id across runs.

import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAP_AGENTS_DIR } from './data.mjs';
import { SHIPPED_PIN, SHIPPED_REPO, shippedSkills } from './shipped.mjs';

const DAY_MS = 7 * 24 * 60 * 60 * 1000;
const toolRoot = dirname(dirname(fileURLToPath(import.meta.url))); // lib/../ = tool checkout
const TIER_A_MS = 2 * 24 * 60 * 60 * 1000;
// Age gate by security tier: B (OSV-corroborated) 0, A (upstream CVE claim) 2 days, else 7 days.
const gateMs = tier => (tier === 'B' ? 0 : tier === 'A' ? TIER_A_MS : DAY_MS);
const UPSTREAMS_FILE = 'upstreams.json';
const SKILL_LOCK = `user/${SNAP_AGENTS_DIR}/.skill-lock.json`;
const BUN_LOCK = 'user/omp/plugins/bun.lock';

// Upstream API bases come from env at call time so tests can point at a local fake.
const ghBase = () => process.env.ALATE_TEST_GITHUB_API_BASE || 'https://api.github.com';
const npmBase = () => process.env.ALATE_TEST_NPM_BASE || 'https://registry.npmjs.org';
const pypiBase = () => process.env.ALATE_TEST_PYPI_BASE || 'https://pypi.org';
const nodeBase = () => process.env.ALATE_TEST_NODE_DIST_BASE || 'https://nodejs.org/dist';
const nodeBlogBase = () => process.env.ALATE_TEST_NODE_BLOG_BASE || 'https://nodejs.org/en/blog/release';
const osvBase = () => process.env.ALATE_TEST_OSV_BASE || 'https://api.osv.dev/v1';
// OSV cache TTLs: a record for 6 h, a 404 for 1 h so a new record shows up soon.
const OSV_HIT_MS = 6 * 60 * 60 * 1000;
const OSV_MISS_MS = 60 * 60 * 1000;
const cftBase = () =>
  process.env.ALATE_TEST_CFT_BASE || 'https://googlechromelabs.github.io/chrome-for-testing';
const cisaBase = () => process.env.ALATE_TEST_CISA_BASE || 'https://www.cisa.gov';
const certEuBase = () => process.env.ALATE_TEST_CERTEU_BASE || 'https://cert.europa.eu';

async function getJson(url, token) {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!res.ok) {
    // GitHub shares 60 unauthenticated requests per hour per egress IP: behind a company
    // NAT the budget is gone for everyone. Name the limit, the reset and the fix instead
    // of a bare 403/429.
    if (url.startsWith(ghBase()) && (res.status === 403 || res.status === 429) &&
        res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : 'an unknown time';
      throw new Error(`GitHub rate limit, resets at ${when}; add a github.com token in Settings`);
    }
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  return res.json();
}

// Row error text for a failed check. A network-level fetch failure wraps the OS error in
// err.cause (Node's fetch), so the code shows next to "fetch failed"; when that code is
// ETIMEDOUT or ECONNREFUSED while a proxy env var is set, a proxy-only egress is the
// likely cause and the text gains the "proxy?" hint. The proxy URL itself, often carrying
// credentials, is never printed.
const proxySet = () => ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(k => process.env[k]);
export function rowErrorText(err) {
  const msg = String(err?.message ?? err); // never includes the token
  const code = err?.cause?.code;
  if (typeof code !== 'string') return msg;
  const hint = (code === 'ETIMEDOUT' || code === 'ECONNREFUSED') && proxySet() ? '; proxy?' : '';
  return `${msg} (${code}${hint})`;
}

// ponytail: regex RSS reader for the two flat feeds below (no CDATA, no nested items); swap for
// an XML parser if a feed changes shape. A text field stays HTML-escaped: ids and words still match.
const rssItems = xml => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, s]) => {
  const tag = t => (s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? '').trim();
  return { title: tag('title'), link: tag('link'), text: tag('description') };
});
const getText = url => fetch(url).then(r => (r.ok ? r.text() : ''), () => '');

// Alerts as { source, title, text }. CISA's RSS description names the CVEs. CERT-EU's RSS
// often does not, so each advisory's JSON (`content_markdown`) is the text. Every failed
// GET drops its alerts only (fail closed).
async function fetchAlerts() {
  const cisa = rssItems(await getText(`${cisaBase()}/cybersecurity-advisories/all.xml`))
    .map(i => ({ source: `cisa:${i.link}`, title: i.title, text: i.text }));
  const ids = rssItems(await getText(`${certEuBase()}/publications/security-advisories-rss`))
    .map(i => i.link.match(/\/security-advisories\/(\d{4}-\d+)\/?$/)?.[1]).filter(Boolean);
  const eu = await Promise.all(ids.map(id => getJson(`${certEuBase()}/publications/security-advisories/${id}/json`)
    .then(d => ({ source: `cert-eu:${id}`, title: String(d.title ?? ''), text: String(d.content_markdown ?? '') })).catch(() => null)));
  return [...cisa, ...eu.filter(Boolean)];
}

function snapshotBytes(db, path) {
  const row = db.prepare('SELECT content FROM files WHERE path = ?').get(path);
  return row ? Buffer.from(row.content) : null;
}

// An empty file means "no entries" (a captured bun.lock can be empty), never fatal.
// A malformed non-empty file still throws: the run keeps the previous rows.
function snapshotJson(db, path) {
  const bytes = snapshotBytes(db, path);
  const src = bytes ? bytes.toString('utf8').trim() : '';
  return src ? JSON.parse(src) : null;
}

export function initUpdates(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS updates (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS update_seen (key TEXT PRIMARY KEY, seenAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS osv_cache (id TEXT PRIMARY KEY, fetchedAt TEXT NOT NULL, record TEXT);
  `);
}

// One OSV record (or null) by CVE id. The raw record is cached, never a verdict: the tier B
// repo binding is recomputed each run. Fail closed: a non-ok non-404 status, a bad body, or a
// fetch error gives null and is never cached.
async function osvLookup(db, id) {
  const row = db.prepare('SELECT fetchedAt, record FROM osv_cache WHERE id = ?').get(id);
  if (row && Date.now() - Date.parse(row.fetchedAt) < (row.record == null ? OSV_MISS_MS : OSV_HIT_MS)) {
    return JSON.parse(row.record); // a cached 404 is SQL NULL, and JSON.parse(null) is null
  }
  try {
    const res = await fetch(`${osvBase()}/vulns/${encodeURIComponent(id)}`);
    if (!res.ok && res.status !== 404) return null;
    const rec = res.ok ? await res.json() : null;
    db.prepare('INSERT OR REPLACE INTO osv_cache (id, fetchedAt, record) VALUES (?, ?, ?)')
      .run(id, new Date().toISOString(), rec == null ? null : JSON.stringify(rec));
    return rec;
  } catch {
    return null;
  }
}

// Dotted numeric compare: strip one leading v/V, missing segment counts as 0, a segment
// compares by its numeric prefix (NaN -> 0).
const numSeg = s => {
  const m = /^\d+/.exec(String(s));
  return m ? Number(m[0]) : 0;
};
function cmpVer(a, b) {
  const pa = String(a).replace(/^[vV]/, '').split('.');
  const pb = String(b).replace(/^[vV]/, '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = numSeg(pa[i]) - numSeg(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}
export { cmpVer };

const aged = (iso, ms) =>
  iso != null && Number.isFinite(Date.parse(iso)) && Date.now() - Date.parse(iso) >= ms;
const weekOld = iso => aged(iso, DAY_MS);

// True when u is https://github.com/<owner>/<repo>[...] exactly (no look-alike hosts).
function isRepoUrl(u, repo) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.hostname !== 'github.com') return false;
  const want = repo.toLowerCase().split('/');
  const [o, n] = url.pathname.split('/').filter(Boolean).map(s => s.toLowerCase());
  return o === want[0] && n?.replace(/\.git$/, '') === want[1];
}
// affected[] entries bound to the repo: by a range repo URL; else the single entry of a record whose references name the
// repo, unless that entry's own range repo names another repository (explicit package identity wins over a reference).
function boundEntries(rec, repo) {
  const entries = (rec.affected ?? []).filter(a => a && typeof a === 'object');
  const byRange = entries.filter(a => (a.ranges ?? []).some(r => isRepoUrl(r?.repo, repo)));
  if (byRange.length) return byRange;
  if (entries.length !== 1 || (entries[0].ranges ?? []).some(r => r?.repo != null)) return [];
  return (rec.references ?? []).some(r => isRepoUrl(r?.url, repo)) ? entries : [];
}
const semverLike = r => r?.type === 'SEMVER' || r?.type === 'ECOSYSTEM';
// SemVer 2.0 order: the core compares like cmpVer, a release ranks above its prereleases, and
// prerelease identifiers compare numeric < alphanumeric, numbers numerically, a shorter list first.
function cmpSemver(a, b) {
  const split = s => {
    const m = /^([^-+]*)(?:-([^+]*))?/.exec(String(s));
    return [m[1], m[2] == null ? null : m[2].split('.')];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  const d = cmpVer(ca, cb);
  if (d !== 0 || (pa == null && pb == null)) return d;
  if (pa == null) return 1;
  if (pb == null) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export { cmpSemver };
// OSV range rule: walk events in version order; introduced <= v sets, fixed <= v clears, last_affected < v clears.
// Every supported order is SemVer 2.0 (see comparable), so ranges compare with cmpSemver.
function inRange(r, v) {
  const key = e => e.introduced ?? e.fixed ?? e.last_affected;
  const evs = (r.events ?? []).filter(e => e && key(e) != null).sort((a, b) => cmpSemver(key(a), key(b)));
  let hit = false;
  for (const e of evs) {
    if (e.introduced != null) { if (cmpSemver(v, e.introduced) >= 0) hit = true; }
    else if (e.fixed != null) { if (cmpSemver(v, e.fixed) >= 0) hit = false; }
    else if (cmpSemver(v, e.last_affected) > 0) hit = false;
  }
  return hit;
}
// Ecosystems whose own version rule is SemVer 2.0. An ECOSYSTEM range of any other ecosystem has no comparator here.
// ponytail: PEP 440, dpkg, RPM, Maven, ... fail closed to tier A; add a comparator per ecosystem to accept them.
const SEMVER_ECOSYSTEMS = new Set(['npm', 'crates.io']);
const SEMVER_VER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const isSemver = v => SEMVER_VER.test(String(v));
// An entry is comparable when each SEMVER/ECOSYSTEM range has a SemVer order, and its event versions (or '0' for
// introduced), its versions[] list, and both checked versions are SemVer. Otherwise no verdict.
const comparable = (a, vs) => (a.ranges ?? []).filter(semverLike).every(r =>
  (r.type === 'SEMVER' || SEMVER_ECOSYSTEMS.has(a.package?.ecosystem)) &&
  (r.events ?? []).every(e => !e || ((e.introduced == null || e.introduced === '0' || isSemver(e.introduced)) &&
    [e.fixed, e.last_affected].every(x => x == null || isSemver(x))))) &&
  [...vs, ...(a.versions ?? [])].every(isSemver);
// versions[] membership by the same SemVer rule (build metadata ignored).
const affects = (a, v) => (a.versions ?? []).some(x => cmpSemver(x, v) === 0) || (a.ranges ?? []).some(r => semverLike(r) && inRange(r, v));
// Tier B: the candidate leaves every bound interval the installed version is in.
function fixedBy(rec, repo, candidate, current) {
  const bound = boundEntries(rec, repo);
  return current != null && bound.some(a => (a.ranges ?? []).some(semverLike)) &&
    bound.every(a => comparable(a, [current, candidate])) &&
    bound.some(a => affects(a, current)) && !bound.some(a => affects(a, candidate));
}

// Release-author security signals (tier A): CVE and GHSA ids in the body, a security-release
// line, or a published repo advisory patched in version v. Tier B when a live OSV record for a
// cited CVE has affected entries bound to the repo that cover the installed version (current)
// and not v, or when a CISA/CERT-EU alert names a cited CVE and the row's advisoryProduct in its
// title. See specs/security-fast-path.md.
// Horizontal whitespace only: `\s` would let every line start rescan the next lines (quadratic).
const SECURITY_LINE = /^[ \t#>*_-]*security (?:fix(?:es)?|releases?|updates?)\b/im;
async function securityOf(repo, body, osv, advisories, v, current, alerts, advisoryProduct) {
  const text = String(body); // a missing body reads "undefined": no signal
  // ponytail: first 20 ids of each kind only, bounds OSV calls per release.
  const uniq = ids => [...new Set(ids)].slice(0, 20);
  const cves = uniq((text.match(/CVE-\d{4}-\d{4,}/gi) ?? []).map(s => s.toUpperCase()));
  const patched = (await advisories()).filter(a => Array.isArray(a?.vulnerabilities) &&
    a.vulnerabilities.some(x => String(x?.patched_versions).match(/\d+(?:\.\d+)*/g)?.some(t => cmpVer(t, v) === 0)));
  const ghsas = uniq((`${text}\n${patched.map(a => a.ghsa_id)}`.match(/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/gi) ?? [])
    .map(s => `GHSA${s.slice(4).toLowerCase()}`));
  if (!cves.length && !ghsas.length && !SECURITY_LINE.test(text)) return null;
  const sources = [];
  // Whole word, case-insensitive: `PHP` matches "Critical Vulnerabilities in PHP", not "PHPUnit".
  const product = typeof advisoryProduct === 'string' && advisoryProduct.trim()
    ? new RegExp(`(?<![\\w-])${RegExp.escape(advisoryProduct.trim())}(?![\\w-])`, 'i') : null;
  for (const id of cves) {
    const rec = await osv(id);
    if (rec && !rec.withdrawn && fixedBy(rec, repo, v, current)) sources.push(`osv:${id}`);
    if (!product) continue;
    const cve = new RegExp(`${id}(?!\\d)`, 'i');
    for (const a of await alerts()) if (product.test(a.title) && cve.test(`${a.title}\n${a.text}`)) sources.push(a.source);
  }
  return { cves, ghsas, sources: [...new Set(sources)], tier: sources.length ? 'B' : 'A' };
}
const stripTag = v => String(v).replace(/^[vV]/, '').split('-')[0];
// A stable release tag parses into a prefix and a dotted version: `skill-v4.7.0` -> prefix
// `skill-`, version `4.7.0`; `v1.0.0` and `1.0.0` share the empty prefix. A tag with no
// trailing numeric version, or with a `-` suffix after the version (`v1.2.0-rc1`), never parses.
const TAG_VER = /^(.*?-)?[vV]?(\d+(?:\.\d+)*)$/;

// owner/name from a github.com URL, or null.
function originRepo(origin) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(origin ?? ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

// Current version from a pin file. The key takes one of three forms: an `ARG <key>=<tag>`
// name, a `FROM <key>:<tag>` image name (the image's own FROM line, flags tolerated), or a
// `<package>@` prefix of a `<package>@<version>` token in a JSON file (an mcp.json args
// array). A key that matches nothing returns null, which the caller reports as an error
// row. All matches strip a registry/tag colon part, one leading v and a `-distro` suffix.
function pinCurrent(bytes, key) {
  const text = bytes.toString('utf8');
  const esc = RegExp.escape(key);
  let m = new RegExp(`^\\s*ARG\\s+${esc}=(\\S+)`, 'm').exec(text);
  if (m) return stripTag(m[1].split(':').pop());
  if (key.endsWith('@')) {
    m = new RegExp(`${esc}([^\\s"',]+)`).exec(text);
    return m ? stripTag(m[1]) : null;
  }
  // A plain key also matches a `<package>==<version>` token (a pinned Python MCP server
  // in an mcp.json args array). The version is everything after `==`; no registry/tag
  // strip applies, unlike the `@` form.
  m = new RegExp(`${esc}==([^\\s"',]+)`).exec(text);
  if (m) return m[1];
  m = new RegExp(`^\\s*FROM\\s+(?:--\\S+\\s+)*${esc}:(\\S+)`, 'm').exec(text);
  return m ? stripTag(m[1]) : null;
}

// ponytail: hand-rolled JSONC stripper (comments outside strings, trailing commas); swap for
// a real JSONC parser if bun.lock grows constructs this breaks on.
function parseJsonc(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

async function runReleaseCheck(check, origin, current, token, fastPath, osv, alerts) {
  const repo = check.repo || originRepo(origin);
  if (!repo) throw new Error(`cannot parse repo from origin ${origin ?? '(none)'}`);
  const rels = await getJson(`${ghBase()}/repos/${repo}/releases?per_page=100`, token);
  const rel = [];
  for (const r of rels ?? []) {
    if (r.draft || r.prerelease) continue;
    let v = String(r.tag_name ?? '');
    if (check.tagPrefix && v.startsWith(check.tagPrefix)) v = v.slice(check.tagPrefix.length);
    if (check.tagSuffix && v.endsWith(check.tagSuffix)) v = v.slice(0, v.length - check.tagSuffix.length);
    if (!v || v.includes('-')) continue; // prerelease-shaped after stripping
    rel.push({ v, publishedAt: r.published_at, notesUrl: r.html_url, body: r.body });
  }
  rel.sort((a, b) => cmpVer(b.v, a.v));
  const latest = rel[0] ?? null;
  let target = null;
  // Published repo advisories, fetched once per row and only for a young candidate. Fail closed.
  let adv;
  const advisories = () => (adv ??= getJson(`${ghBase()}/repos/${repo}/security-advisories?state=published&per_page=100`, token)
    .then(a => (Array.isArray(a) ? a : []), () => []));
  for (const x of rel) {
    if (cmpVer(x.v, current ?? '') <= 0) break;
    if (fastPath && !weekOld(x.publishedAt)) x.security = await securityOf(repo, x.body, osv, advisories, x.v, current, alerts, check.advisoryProduct);
    if (aged(x.publishedAt, gateMs(x.security?.tier))) { target = x; break; }
  }
  const pick = target ?? latest;
  return {
    latest: latest?.v ?? null,
    target: target?.v ?? null,
    publishedAt: pick?.publishedAt ?? null,
    notesUrl: pick?.notesUrl ?? null,
    ...(pick?.security ? { security: pick.security } : {}),
  };
}

// Newest commit on a path/branch; target is the head sha only when this checker first saw it
// a week ago and it differs from current (prefix-tolerant compare). The committer date is
// publisher-writable (GIT_COMMITTER_DATE), so the age gate never reads it: the row is gated
// on its first-seen moment in update_seen, exactly like cft. The soak is continuous: a head
// that leaves the ref loses its row, so a returning sha starts its soak over.
async function runPathCheck(db, rowKey, repo, check, current, token, now) {
  const qs = new URLSearchParams({ per_page: '1' });
  if (check.path) qs.set('path', check.path);
  if (check.branch) qs.set('sha', check.branch);
  const [head] = await getJson(`${ghBase()}/repos/${repo}/commits?${qs}`, token);
  if (!head?.sha) throw new Error(`no commit found on ${repo}`);
  const seenKey = `${rowKey}|${head.sha}`;
  // The soak is continuous first-seen: a sha that left the ref and later returned (force-push
  // revert, then restore) must not inherit its stale row, so drop its siblings first. substr
  // keeps the prefix match exact for row keys holding LIKE wildcards.
  db.prepare('DELETE FROM update_seen WHERE substr(key, 1, ?) = ? AND key != ?')
    .run(rowKey.length + 1, `${rowKey}|`, seenKey);
  db.prepare('INSERT OR IGNORE INTO update_seen (key, seenAt) VALUES (?, ?)').run(seenKey, now);
  const publishedAt = db.prepare('SELECT seenAt FROM update_seen WHERE key = ?').get(seenKey).seenAt;
  const cur = current == null ? '' : String(current);
  const same = cur !== '' && (cur === head.sha || head.sha.startsWith(cur));
  const target = !same && weekOld(publishedAt) ? head.sha : null;
  return { latest: head.sha, target, publishedAt, notesUrl: head.html_url ?? null };
}

async function runNpmCheck(pkg, current) {
  const doc = await getJson(`${npmBase()}/${pkg}`);
  const times = doc.time ?? {};
  const stable = Object.keys(times).filter(
    v => v !== 'created' && v !== 'modified' && !v.includes('-')
  );
  stable.sort((a, b) => cmpVer(b, a));
  const latest = stable[0] ?? null;
  const target = stable.find(v => cmpVer(v, current ?? '') > 0 && weekOld(times[v])) ?? null;
  const pick = target ?? latest;
  return {
    latest,
    target,
    publishedAt: pick ? times[pick] : null,
    notesUrl: `https://www.npmjs.com/package/${pkg}`,
  };
}

// PyPI JSON gives `releases` (version -> file list) instead of npm's `time` map. A PEP 440
// stable version is an optional epoch, a numeric release and an optional `.postN` —
// pre-releases (a/b/rc), dev releases, hyphen and legacy shapes never reach the pick.
// Ranking is PEP 440 order (epoch, release segments, `.postN` strictly above the bare
// release); the upload time (iso field first, legacy field as the fallback) only feeds the
// age gate. The shared cmpVer cannot order these, so this check keeps its own comparator.
const PYPI_STABLE = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:\.post(\d+))?$/i;
function pypiKey(v) {
  const m = PYPI_STABLE.exec(String(v).toLowerCase().split('+')[0]);
  if (!m) return null;
  const release = m[2].split('.').map(Number);
  return { rel: [Number(m[1] ?? 0), ...release], post: Number(m[3] ?? 0) };
}
// Release segments compare first (missing segments as 0), then the post number:
// 1.0.post2 < 1.0.1 (rel [0,1,0] < [0,1,0,1]) and 1.3.0.post1 > 1.3.0 (equal rel, post 1 > 0).
function cmpPypiKey(a, b) {
  const n = Math.max(a.rel.length, b.rel.length);
  for (let i = 0; i < n; i++) {
    const d = (a.rel[i] ?? 0) - (b.rel[i] ?? 0);
    if (d) return d;
  }
  return a.post - b.post;
}
async function runPypiCheck(pkg, current) {
  const doc = await getJson(`${pypiBase()}/pypi/${pkg}/json`);
  const keys = new Map();
  const times = new Map();
  for (const [v, files] of Object.entries(doc.releases ?? {})) {
    const key = pypiKey(v);
    if (!key) continue;
    const t = (files ?? []).map(f => f.upload_time_iso_8601 ?? f.upload_time).find(Boolean);
    if (!t) continue;
    keys.set(v, key);
    times.set(v, t);
  }
  const stable = [...times.keys()].sort((a, b) => cmpPypiKey(keys.get(b), keys.get(a)));
  const latest = stable[0] ?? null;
  const currentKey = pypiKey(current ?? '') ?? { rel: [-1], post: 0 };
  const target = stable.find(v => cmpPypiKey(keys.get(v), currentKey) > 0 && weekOld(times.get(v))) ?? null;
  const pick = target ?? latest;
  return {
    latest,
    target,
    publishedAt: pick ? times.get(pick) : null,
    notesUrl: `https://pypi.org/project/${pkg}`,
  };
}

// index.json flags security releases; their blog announcement lists the CVEs. The flag alone
// is tier A; the shared advisory pass with repo nodejs/node can lift the gate (tier B).
// ponytail: no GitHub repo advisories here (the row has no token); add them if Node starts
// publishing patched versions there.
async function runNodeCheck(check, current, fastPath, osv, alerts) {
  const entries = await getJson(`${nodeBase()}/index.json`);
  const list = (entries ?? []).filter(
    e => String(e.version).startsWith(`v${check.major}.`) && !String(e.version).includes('-')
  );
  list.sort((a, b) => cmpVer(b.version, a.version));
  const bare = e => String(e.version).replace(/^v/, '');
  const blogUrl = e => `${nodeBlogBase()}/v${bare(e)}`;
  const latestE = list[0] ?? null;
  // Advisory data lives here, never on the upstream entry: index.json fields are untrusted input.
  const advisory = new Map();
  let targetE = null;
  for (const e of list) {
    if (cmpVer(e.version, current ?? '') <= 0) break;
    if (fastPath && e.security === true && !weekOld(e.date)) {
      // A failed announcement fetch or body read yields no CVE ids: the flag still gives tier A.
      const text = await fetch(blogUrl(e)).then(r => (r.ok ? r.text() : '')).catch(() => '');
      advisory.set(e, (await securityOf('nodejs/node', text, osv, async () => [], bare(e), current, alerts, check.advisoryProduct))
        ?? { cves: [], ghsas: [], sources: [], tier: 'A' });
    }
    if (aged(e.date, gateMs(advisory.get(e)?.tier))) { targetE = e; break; }
  }
  const pick = targetE ?? latestE;
  const sec = advisory.get(pick);
  return {
    latest: latestE ? bare(latestE) : null,
    target: targetE ? bare(targetE) : null,
    publishedAt: pick?.date ?? null,
    notesUrl: sec ? blogUrl(pick) : `${nodeBase()}/`,
    ...(sec ? { security: sec } : {}),
  };
}

// cft publishes no time, so the age gate runs on when the checker first saw the version.
async function runCftCheck(db, rowKey, check, current, now) {
  const doc = await getJson(`${cftBase()}/last-known-good-versions.json`);
  const version = doc.channels?.[check.channel]?.version;
  if (!version) throw new Error(`channel ${check.channel} not found`);
  const seenKey = `${rowKey}|${version}`;
  db.prepare('INSERT OR IGNORE INTO update_seen (key, seenAt) VALUES (?, ?)').run(seenKey, now);
  const seenAt = db.prepare('SELECT seenAt FROM update_seen WHERE key = ?').get(seenKey).seenAt;
  const cur = current == null ? '' : String(current);
  const target = cur !== version && cmpVer(version, cur) > 0 && weekOld(seenAt) ? version : null;
  return {
    latest: version,
    target,
    publishedAt: seenAt,
    notesUrl: `${cftBase()}/last-known-good-versions.json`,
  };
}

function runCheck(db, rowKey, name, check, origin, current, token, now, fastPath, osv, alerts) {
  switch (check?.type) {
    case 'github-release':
      return runReleaseCheck(check, origin, current, token, fastPath, osv, alerts);
    case 'github-path': {
      const repo = check.repo || originRepo(origin);
      if (!repo) throw new Error(`cannot parse repo from origin ${origin ?? '(none)'}`);
      return runPathCheck(db, rowKey, repo, check, current, token, now);
    }
    case 'npm':
      return runNpmCheck(check.package ?? name, current);
    case 'pypi':
      return runPypiCheck(check.package ?? name, current);
    case 'node-dist':
      return runNodeCheck(check, current, fastPath, osv, alerts);
    case 'chrome-for-testing':
      return runCftCheck(db, rowKey, check, current, now);
    default:
      throw new Error(`unknown check type ${check?.type}`);
  }
}

// Release lists, tag trees, repo metadata, and file compares for the skill and plugin row
// builders, memoized per repo (tag) for one collectRows call: many rows share one repo, and
// every run must see fresh upstream data, so the caches never outlive the call.
function makeRowFetchers(token) {
  const relPromises = new Map();
  const treePromises = new Map();
  const stableReleases = repo => {
    let p = relPromises.get(repo);
    if (!p) {
      p = getJson(`${ghBase()}/repos/${repo}/releases?per_page=100`, token).then(rels =>
        (rels ?? [])
          .filter(r => !r.draft && !r.prerelease && typeof r.tag_name === 'string')
          .map(r => {
            const m = TAG_VER.exec(r.tag_name);
            return m && { ...r, prefix: m[1] ?? '', version: m[2] };
          })
          .filter(Boolean)
      );
      relPromises.set(repo, p);
    }
    return p;
  };
  // Repo metadata (the archived flag) and the commit a tag points at, memoized per repo
  // (tag) for this collectRows call: plugins and skills can share a repo.
  const infoPromises = new Map();
  const repoInfo = repo => {
    let p = infoPromises.get(repo);
    if (!p) {
      p = getJson(`${ghBase()}/repos/${repo}`, token);
      infoPromises.set(repo, p);
    }
    return p;
  };
  const commitPromises = new Map();
  const tagCommit = (repo, tag) => {
    const key = `${repo}\u0000${tag}`;
    let p = commitPromises.get(key);
    if (!p) {
      p = getJson(`${ghBase()}/repos/${repo}/commits/${encodeURIComponent(tag)}`, token)
        .then(c => c?.sha ?? null);
      commitPromises.set(key, p);
    }
    return p;
  };
  const tagTree = (repo, tag) => {
    const key = `${repo}\u0000${tag}`;
    let p = treePromises.get(key);
    if (!p) {
      p = getJson(`${ghBase()}/repos/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`, token);
      treePromises.set(key, p);
    }
    return p;
  };
  const folderSha = async (repo, tag, dir) =>
    ((await tagTree(repo, tag)).tree ?? []).find(t => t.type === 'tree' && t.path === dir)?.sha ?? null;

  // File-level diffs between two release tags, for rows whose current is a tag. Commit-mode rows
  // and rows whose current is a SHA get none: no base commit is known for them.
  const comparePromises = new Map();
  const diffList = async (repo, base, head, dir) => {
    const key = `${repo}\u0000${base}\u0000${head}`;
    let p = comparePromises.get(key);
    if (!p) {
      p = getJson(`${ghBase()}/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, token);
      comparePromises.set(key, p);
    }
    const cmp = await p;
    // ponytail: cap at 50 file links per row; raise it if a real skill update ever carries more.
    return (cmp.files ?? [])
      .filter(f => typeof f.filename === 'string' && f.filename.startsWith(`${dir}/`))
      .slice(0, 50)
      .map(f => ({
        file: f.filename,
        url: `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}#diff-${createHash('sha256').update(f.filename).digest('hex')}`,
      }));
  };

  // Pick the one release stream a skill tracks. First rule that applies:
  // a. the upstreams item's check.tagPrefix — calibration knob: it pins the stream exactly, so
  //    a prefix with no published stream counts as no releases;
  // b. the lock ref names a stable tag: that tag's prefix;
  // c. exactly one stream whose prefix contains `skill` (case-insensitive);
  // d. the stream with the empty prefix;
  // e. exactly one stream in total;
  // f. none: the repo counts as having no stable release.
  const pickStream = (rels, ref, item) => {
    const streams = new Map();
    for (const r of rels) {
      if (!streams.has(r.prefix)) streams.set(r.prefix, []);
      streams.get(r.prefix).push(r);
    }
    let s = null;
    const knob = item?.check?.tagPrefix;
    if (typeof knob === 'string') {
      s = streams.get(knob) ?? null;
    } else {
      const m = ref == null ? null : TAG_VER.exec(String(ref));
      const skillStreams = [...streams.keys()].filter(pre => /skill/i.test(pre));
      // An unprefixed ref (`v1.0.0`) leaves m[1] undefined; stableReleases stores that stream as ''.
      const refPrefix = m ? (m[1] ?? '') : null;
      if (refPrefix !== null && streams.has(refPrefix)) s = streams.get(refPrefix);
      else if (skillStreams.length === 1) s = streams.get(skillStreams[0]);
      else if (streams.has('')) s = streams.get('');
      else if (streams.size === 1) s = rels;
    }
    // Newest first by parsed version; the copy keeps the memoized per-repo list unsorted.
    return [...(s ?? [])].sort((a, b) => cmpVer(b.version, a.version));
  };
  return { stableReleases, repoInfo, tagCommit, folderSha, diffList, pickStream };
}

// Skills: one row per skill-lock entry. A repo with a usable release stream puts the row on
// that stream's tags; otherwise the row tracks the ref head by SHA as before.
function buildSkillRows(ctx) {
  const { db, dataRepo, token, now, plan, taken, itemByName } = ctx;
  const { stableReleases, folderSha, diffList, pickStream } = ctx.fetchers;
  const lock = snapshotJson(db, SKILL_LOCK);
  for (const [name, entry] of Object.entries(lock?.skills ?? {})) {
    taken.add(name);
    const item = itemByName.get(name);
    const row = {
      name,
      kind: item?.kind ?? 'skill',
      origin: item?.origin ?? entry.sourceUrl,
      repo: dataRepo,
      pin: { file: SKILL_LOCK, key: name },
      current: entry.skillFolderHash,
      managedBy: item?.managedBy,
    };
    plan.push({
      rowKey: `skill:${name}`,
      row,
      run: async () => {
        const repo = originRepo(entry.sourceUrl);
        if (!repo) throw new Error(`cannot parse repo from sourceUrl ${entry.sourceUrl}`);
        const dir = entry.skillPath.split('/').slice(0, -1).join('/');
        const ref = entry.ref ?? entry.branch; // skills CLI 1.7 locks write `ref`

        // No usable release stream: the CLI installed the ref head, so keep the head/path behavior.
        const releases = pickStream(await stableReleases(repo), ref, item);
        if (releases.length === 0) {
          const head = await runPathCheck(db, `skill:${name}`, repo, { path: dir, branch: ref }, row.current, token, now);
          const treeSha = await folderSha(repo, ref ?? 'HEAD', dir);
          // Folder gone at HEAD: the newest commit on the path is the deletion. The CLI could
          // never reinstall it, so auto-drop the update and serve a notification row instead.
          if (treeSha === null) return { ...head, current: row.current, target: null, removed: true };
          // A folder-hash mismatch marks the skill outdated; the head-age rule decides target.
          const outdated = treeSha !== row.current;
          // current === latest exactly when the installed tree equals the head tree: a tree
          // SHA can never equal a commit SHA, so an up-to-date skill reports the head commit.
          return {
            ...head,
            current: outdated ? row.current : head.latest,
            target: outdated && weekOld(head.publishedAt) ? head.latest : null,
          };
        }

        // Release mode: the row reports the release tags of the picked stream, not SHAs. The
        // installed folder is matched to a release by comparing tree SHAs at each tag.
        const latest = releases[0];
        if ((await folderSha(repo, latest.tag_name, dir)) === null)
          // Folder gone at the newest release: a notification row, never an update.
          return {
            current: row.current,
            latest: latest.tag_name,
            target: null,
            removed: true,
            publishedAt: latest.published_at ?? null,
            notesUrl: latest.html_url ?? null,
          };
        // ponytail: match the installed folder against the 10 newest releases only; walk
        // the full paginated list if a real repo ever outgrows this cap.
        let current = null;
        let currentVer = null;
        for (const r of releases.slice(0, 10)) {
          if ((await folderSha(repo, r.tag_name, dir)) === row.current) {
            current = r.tag_name;
            currentVer = r.version;
            break;
          }
        }
        // No tag matched the installed folder: a lock `ref` equal to a release tag pins current.
        if (current === null && releases.some(r => r.tag_name === ref)) {
          current = ref;
          currentVer = releases.find(r => r.tag_name === ref).version;
        }
        // Target = newest week-old release in the stream newer than current (by parsed version)
        // whose folder differs from the install.
        let target = null;
        for (const r of releases) {
          if (!weekOld(r.published_at)) continue;
          if (currentVer !== null && cmpVer(r.version, currentVer) <= 0) continue;
          const sha = await folderSha(repo, r.tag_name, dir);
          // A release without the skill folder can never be installed: never a target.
          if (sha === null || sha === row.current) continue;
          target = r;
          break;
        }
        const pick = target ?? latest;
        // Diffs only when current is a release tag distinct from the picked tag; otherwise no
        // base tag is known (a SHA current or current === pickTag means no diff is served).
        let diffs = null;
        if (current !== null && current !== pick.tag_name) {
          diffs = await diffList(repo, current, pick.tag_name, dir);
        }
        return {
          current: current ?? row.current,
          latest: latest.tag_name,
          target: target?.tag_name ?? null,
          publishedAt: pick.published_at ?? null,
          notesUrl: pick.html_url ?? null,
          ...(diffs?.length ? { diffs } : {}),
        };
      },
    });
  }
}

// Ottr's shipped skills vendored at one pinned commit (lib/shipped.mjs). A pin whose name
// the snapshot carries is suppressed: the data repo copy wins and its own lock or upstreams
// row already reports updates, same rule as the installer. Suppression mirrors the
// installer's override detection (collectSkillDirs): the FIRST whole segment named
// skills/managed-skills on the path is the override root, the skill must be its immediate
// child, and at least one file must live inside the folder. Deeper skills-named segments
// sit inside an already-collected skill and are never seen, so they neither count nor hide
// a row. GLOB cannot express first-root-wins, so the pattern only gathers candidates
// (`*` crosses slashes) and the rule runs in JS. GLOB specials in the name go into
// character classes.
const SKILL_ROOT_NAMES = new Set(['skills', 'managed-skills']);

function isOverridePath(path, name) {
  const seg = path.split('/');
  const root = seg.findIndex(s => SKILL_ROOT_NAMES.has(s));
  return root !== -1 && seg[root + 1] === name && seg.length > root + 2;
}

function snapshotHasSkillDir(db, name) {
  const glob = name.replace(/[[*?]/g, c => `[${c}]`);
  const rows = db
    .prepare(`SELECT path FROM files WHERE path GLOB ?`)
    .all(`user/*${glob}/*`);
  return rows.some(r => isOverridePath(r.path, name));
}

// One row per vendored skill folder of the pinned whole tree (lib/shipped.mjs enumerates
// shipped/ottr/.agents/skills), so a new Ottr skill rows without an alate code change.
// Fail closed: a missing or unreadable vendored tree throws, and a broken tool install
// plans no shipped rows rather than rows built from an empty enumeration.
function buildShippedRows(ctx) {
  const { db, token, now, plan } = ctx;
  const { folderSha } = ctx.fetchers;
  let pins;
  try {
    pins = shippedSkills(toolRoot);
  } catch {
    return;
  }
  for (const pin of pins) {
    if (snapshotHasSkillDir(db, pin.name)) continue;
    const row = {
      name: pin.name,
      // image-pin is the pin-applied-in-the-owning-repo kind: Ottr's card generator then
      // falls back to this repo's documented steps (the re-pin: copy the vendored tree at
      // the new upstream commit, bump SHIPPED_PIN.commit) instead of the skills CLI, for
      // the update and for a removed row alike (both inherit these static row fields).
      kind: 'image-pin',
      origin: `${SHIPPED_PIN.source}/tree/${SHIPPED_PIN.commit}/${pin.path}`,
      repo: SHIPPED_REPO,
      pin: { file: 'lib/shipped.mjs', key: pin.name },
      // current is the pinned commit itself. The outdated decision is a tree compare in
      // run() below; runPathCheck still records the first-seen soak and its target is discarded.
      current: SHIPPED_PIN.commit,
    };
    plan.push({
      rowKey: `shipped-skill:${pin.name}`,
      row,
      // A shipped-pin error means the pin itself is broken (the pin commit lost the folder),
      // so a target computed by an earlier, different pin is stale work the board would
      // still schedule; checkUpdates must clear it.
      errorClearsTarget: true,
      run: async () => {
        // Tree compare, not commit compare: after a re-pin the path's newest commit can sit
        // BELOW the pin (the re-pin already carries that content), so a commit compare would
        // offer an ancestor as a target. Compare the folder tree at the pin with the tree at
        // HEAD, exactly like the lock-driven rows compare the installed folder hash.
        const head = await runPathCheck(db, `shipped-skill:${pin.name}`, SHIPPED_PIN.repo, { path: pin.path }, SHIPPED_PIN.commit, token, now);
        const pinTree = await folderSha(SHIPPED_PIN.repo, SHIPPED_PIN.commit, pin.path);
        const headTree = await folderSha(SHIPPED_PIN.repo, 'HEAD', pin.path);
        if (pinTree === null) throw new Error(`pin ${SHIPPED_PIN.commit} has no folder at ${pin.path}`);
        if (headTree === null) return { ...head, current: row.current, target: null, removed: true };
        const outdated = headTree !== pinTree;
        return { ...head, current: row.current, target: outdated && weekOld(head.publishedAt) ? head.latest : null };
      },
    });
  }
}

// Plugins: the direct deps of the root workspace in bun.lock; transitive packages are not plugins.
function buildPluginRows(ctx) {
  const { db, dataRepo, token, now, plan, taken, itemByName } = ctx;
  const { stableReleases, repoInfo, tagCommit, pickStream } = ctx.fetchers;
  const bunBytes = snapshotBytes(db, BUN_LOCK);
  const bunSrc = bunBytes ? bunBytes.toString('utf8') : '';
  const bun = bunSrc.trim() ? parseJsonc(bunSrc) : null;
  const deps = bun?.workspaces?.['']?.dependencies ?? {};
  const packages = bun?.packages ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    const lockedFull = packages[name]?.[0];
    if (typeof lockedFull !== 'string') continue;
    const locked = lockedFull.startsWith(`${name}@`) ? lockedFull.slice(name.length + 1) : lockedFull;
    const item = itemByName.get(name);
    // Workspaces specs carry no sha (`github:Owner/repo`); the locked short sha lives in
    // the packages entry (`<name>@github:Owner/repo#sha`). A `#ref` in the spec names a
    // tag or branch the user pinned.
    const gitRepo = String(spec).startsWith('github:')
      ? /^github:([^/#]+)\/([^/#]+)(?:#(.*))?/.exec(String(spec))
      : null;
    const specRef = gitRepo?.[3];
    const lockedSha = gitRepo && lockedFull.includes('#') ? lockedFull.split('#').pop() : null;
    const gm = gitRepo && lockedSha ? { 1: gitRepo[1], 2: gitRepo[2], 3: lockedSha } : null;
    // npm checks: an `npm:<package>` or `npm:<package>@<range>` spec names the package; a
    // plain semver-range spec checks the dependency name itself.
    let npmPkg = null;
    if (!gm) {
      const s = String(spec);
      if (s.startsWith('npm:')) {
        const body = s.slice(4);
        const cut = body.startsWith('@') ? body.indexOf('/', 1) + 1 : 0;
        const at = body.indexOf('@', cut);
        npmPkg = at === -1 ? body : body.slice(0, at);
      } else if (/^[~^><=*v\d.\s]+$/.test(s) && /^[~^><=*v\d.\s]+$/.test(String(locked))) {
        npmPkg = name;
      }
    }
    if (!gm && npmPkg == null) continue; // ponytail: alias and git+https specs are skipped; add parsers when a real plugin uses one
    taken.add(name);
    const row = {
      name,
      kind: item?.kind ?? 'plugin',
      origin: item?.origin ?? (gm ? `https://github.com/${gm[1]}/${gm[2]}` : null),
      repo: dataRepo,
      pin: { file: BUN_LOCK, key: name },
      current: gm ? gm[3] : locked,
      managedBy: item?.managedBy,
    };
    plan.push({
      rowKey: `plugin:${name}`,
      row,
      run: async () => {
        if (!gm) return runNpmCheck(npmPkg, row.current);
        const repo = `${gm[1]}/${gm[2]}`;
        // A gone repo (metadata 404) fails the row like the head check always did; an
        // archived repo never ships another release, so it keeps the head behavior.
        if ((await repoInfo(repo))?.archived) return runPathCheck(db, `plugin:${name}`, repo, { path: '' }, row.current, token, now);
        // Release mode: the row reports the picked stream's tags, like the skill rows.
        const releases = pickStream(await stableReleases(repo), specRef, item);
        if (releases.length === 0) return runPathCheck(db, `plugin:${name}`, repo, { path: '' }, row.current, token, now);
        const latest = releases[0];
        let current = null;
        let currentVer = null;
        // A release tag in the spec pins current exactly (`github:Owner/repo#v5.3.3`).
        const refTag = specRef != null ? TAG_VER.exec(specRef) : null;
        if (refTag) {
          current = specRef;
          currentVer = refTag[2];
        } else {
          // ponytail: match the locked sha against the commits of the 10 newest tags only;
          // walk the full list if a real repo ever outgrows this cap.
          for (const r of releases.slice(0, 10)) {
            const sha = await tagCommit(repo, r.tag_name);
            if (sha != null && sha.startsWith(gm[3])) {
              current = r.tag_name;
              currentVer = r.version;
              break;
            }
          }
        }
        // A pin that matches no tag stays a sha and offers no target: it is off-stream,
        // so no release can be called newer than it.
        if (current === null)
          return {
            current: row.current,
            latest: latest.tag_name,
            target: null,
            publishedAt: latest.published_at ?? null,
            notesUrl: latest.html_url ?? null,
          };
        // Target = newest week-old release in the stream newer than current (by parsed version).
        let target = null;
        for (const r of releases) {
          if (!weekOld(r.published_at)) continue;
          if (cmpVer(r.version, currentVer) <= 0) continue;
          target = r;
          break;
        }
        const pick = target ?? latest;
        return {
          current,
          latest: latest.tag_name,
          target: target?.tag_name ?? null,
          publishedAt: pick.published_at ?? null,
          notesUrl: pick.html_url ?? null,
        };
      },
    });
  }
}

// Items not covered by a lock row above. A repeated name plans the first entry plus a
// problem row per extra copy, so two entries never race for one stored id.
function buildUpstreamRows(ctx) {
  const { db, dataRepo, token, now, securityFastPath, osv, alerts, plan, taken, items } = ctx;
  const plannedItems = new Map(); // item name -> copies planned so far
  for (const item of items) {
    if (taken.has(item.name)) continue;
    const copy = (plannedItems.get(item.name) ?? 0) + 1;
    plannedItems.set(item.name, copy);
    const row = {
      name: item.name,
      kind: item.kind,
      origin: item.origin,
      repo: item.pin ? (item.pin.repo && item.pin.repo !== dataRepo ? item.pin.repo : dataRepo) : null,
      pin: item.pin ? { file: item.pin.file, key: item.pin.key } : null,
      current: null,
      managedBy: item.managedBy,
    };
    if (copy > 1) {
      plan.push({
        rowKey: `item:${item.name}#${copy}`,
        row,
        run: async () => {
          throw new Error(`duplicate item name "${item.name}" in ${UPSTREAMS_FILE}; keeping the first entry`);
        },
      });
      continue;
    }
    plan.push({
      rowKey: `item:${item.name}`,
      row,
      run: async () => {
        let current = item.version ?? null;
        if (current == null && item.pin) {
          let bytes = null;
          if (item.pin.repo && item.pin.repo !== dataRepo) {
            const doc = await getJson(
              `${ghBase()}/repos/${item.pin.repo}/contents/${item.pin.file}`,
              token
            );
            bytes = Buffer.from(doc.content ?? '', 'base64');
          } else {
            bytes = snapshotBytes(db, item.pin.file);
          }
          current = bytes ? pinCurrent(bytes, item.pin.key) : null;
          // A pin that resolves to nothing is a broken pin: surface it as an error row,
          // never offer an update against an unknown current.
          if (current == null) throw new Error(`pin ${item.pin.key} not found in ${item.pin.file}`);
        }
        if (!item.check) return { current, latest: null, target: null, publishedAt: null, notesUrl: null };
        const res = await runCheck(db, `item:${item.name}`, item.name, item.check, item.origin, current, token, now, securityFastPath, osv, alerts);
        return { ...res, current };
      },
    });
  }
}

// Builds the row plan: { rowKey, row (static fields), run (check producing the rest) }.
function collectRows(db, { dataRepo, token, now, securityFastPath, osv, alerts }) {
  const plan = [];
  const taken = new Set(); // upstreams item names already covered by a lock row

  const items = snapshotJson(db, UPSTREAMS_FILE)?.items ?? [];
  // First entry with a name wins everywhere: a repeated name plans one row plus a problem row below.
  const itemByName = new Map();
  for (const it of items) if (!itemByName.has(it.name)) itemByName.set(it.name, it);

  const ctx = {
    db, dataRepo, token, now, securityFastPath, osv, alerts,
    plan, taken, items, itemByName,
    fetchers: makeRowFetchers(token),
  };
  buildSkillRows(ctx);
  buildShippedRows(ctx);
  buildPluginRows(ctx);
  buildUpstreamRows(ctx);
  return plan;
}

export async function checkUpdates(db, opts = {}) {
  const ctx = { dataRepo: opts.dataRepo ?? null, token: opts.token ?? null, now: new Date().toISOString() };
  ctx.securityFastPath = opts.securityFastPath !== false;
  // OSV records memoized per run on top of the db cache. No token: OSV needs none, and the
  // GitHub token stays with GitHub.
  const osvMemo = new Map();
  ctx.osv = id => {
    if (!osvMemo.has(id)) osvMemo.set(id, osvLookup(db, id));
    return osvMemo.get(id);
  };
  // CISA and CERT-EU alerts, fetched at most once per run and only when a row binds an
  // advisoryProduct and a young release cites a CVE. Fail closed: a failed feed adds no alerts.
  let alertsMemo;
  ctx.alerts = () => (alertsMemo ??= fetchAlerts());
  // Previous values by internal row key, so a failed check carries the old value forward.
  const prev = new Map();
  for (const r of db.prepare('SELECT value FROM updates').all()) {
    try {
      const v = JSON.parse(r.value);
      if (v?._row) prev.set(v._row, v);
    } catch {}
  }

  const out = [];
  const usedIds = new Set(); // ids handed out this run: the stored id is the table's primary key
  for (const entry of collectRows(db, ctx)) {
    let value;
    try {
      const res = await entry.run();
      value = { ...entry.row, ...res, checkedAt: ctx.now };
      if (entry.row.managedBy != null) value.target = null;
    } catch (err) {
      const msg = rowErrorText(err); // never includes the token
      if (prev.has(entry.rowKey)) {
        value = { ...prev.get(entry.rowKey), error: msg, checkedAt: ctx.now };
        // A flagged row's error means the pin itself broke, so a target computed by an
        // earlier, different pin is stale work; drop it instead of scheduling it.
        if (entry.errorClearsTarget) value.target = null;
        // Fast path off: a carried-forward row loses its security data and any target that only
        // the shorter security gate let through, so it follows the plain 7-day gate.
        if (!ctx.securityFastPath && value.security) {
          delete value.security;
          if (!weekOld(value.publishedAt)) value.target = null;
        }
      } else {
        value = {
          ...entry.row,
          current: null,
          latest: null,
          target: null,
          publishedAt: null,
          error: msg,
          checkedAt: ctx.now,
        };
      }
    }
    const tail = value.target ?? value.latest ?? 'latest';
    value.id = `${value.name}@${tail}`;
    // Rows can share a display name (a repeated upstreams item, or a skill and a plugin with
    // the same name). The row key is unique, so the collision falls back to it: one bad name
    // degrades to an extra row instead of aborting the whole rewrite.
    if (usedIds.has(value.id)) value.id = `${entry.rowKey}:${tail}`;
    for (let n = 2; usedIds.has(value.id); n++) value.id = `${entry.rowKey}:${tail}#${n}`;
    usedIds.add(value.id);
    // qualifiesAt = publishedAt + gate (7 days, 2 days tier A, 0 tier B): when an update may be provisioned (G21).
    value.qualifiesAt = value.publishedAt != null && Number.isFinite(Date.parse(value.publishedAt))
      ? new Date(Date.parse(value.publishedAt) + gateMs(value.security?.tier)).toISOString()
      : null;
    out.push({ id: value.id, json: JSON.stringify({ ...value, _row: entry.rowKey }) });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM updates').run();
    const ins = db.prepare('INSERT INTO updates (id, value) VALUES (?, ?)');
    for (const r of out) ins.run(r.id, r.json);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  let checkedAt = null;
  for (const r of out) {
    const c = JSON.parse(r.json).checkedAt;
    if (c && (!checkedAt || c > checkedAt)) checkedAt = c;
  }
  return { checkedAt, count: out.length };
}

export function loadUpdates(db) {
  const rows = [];
  let checkedAt = null;
  for (const r of db.prepare('SELECT value FROM updates').all()) {
    let v;
    try {
      v = JSON.parse(r.value);
    } catch {
      continue;
    }
    delete v._row;
    if (v.checkedAt && (!checkedAt || v.checkedAt > checkedAt)) checkedAt = v.checkedAt;
    rows.push(v);
  }
  rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''));
  return { checkedAt, updates: rows };
}

// The board (ottr src/updates.ts record()) drops any record that fails these checks and
// logs the count, so the provider routes serve only records that pass: unpinned items,
// items without a check, and npm-alias plugins carry null required fields (repo, pin,
// origin, current, latest, publishedAt, notesUrl) and never reach the board. The
// dashboard's /api/state keeps every row.
const BOARD_KINDS = new Set(['image-pin', 'mcp', 'rule-set', 'skill', 'plugin']);
const boardText = v => typeof v === 'string' && v.length >= 1 && v.length <= 200 && !/\p{Cc}/u.test(v);
const boardHttpUrl = v => {
  if (typeof v !== 'string' || v.length > 2000) return false;
  let protocol = null;
  try { protocol = new URL(v).protocol; } catch { return false; }
  return protocol === 'http:' || protocol === 'https:';
};
const BOARD_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const boardIso = v => typeof v === 'string' && BOARD_ISO.test(v) && Number.isFinite(Date.parse(v));

export function isValidUpdateRecord(v) {
  if (typeof v !== 'object' || v === null) return false;
  const pin = v.pin;
  if (typeof pin !== 'object' || pin === null || !boardText(pin.file) || !boardText(pin.key)) return false;
  if (!boardText(v.id) || !boardText(v.name) || !boardText(v.kind) || !BOARD_KINDS.has(v.kind)) return false;
  if (!boardHttpUrl(v.origin) || !boardText(v.repo) || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v.repo)) return false;
  if (!boardText(v.current) || !boardText(v.latest)) return false;
  if (!(v.target === null || boardText(v.target))) return false;
  if (!boardIso(v.publishedAt) || !boardIso(v.qualifiesAt)) return false;
  if (!boardHttpUrl(v.notesUrl)) return false;
  if (v.managedBy !== undefined && !boardText(v.managedBy)) return false;
  if (v.removed !== undefined && (v.removed !== true || v.target !== null)) return false;
  if (v.diffs !== undefined) {
    if (!Array.isArray(v.diffs) || v.diffs.length > 50) return false;
    for (const d of v.diffs) {
      if (typeof d !== 'object' || d === null || !boardText(d.file) || !boardHttpUrl(d.url)) return false;
    }
  }
  return true;
}
