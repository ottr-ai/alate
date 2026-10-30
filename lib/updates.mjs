// Upstream update checker. Reads only the stored snapshot (SQLite `files` table) and issues
// upstream GETs; it never edits a repo and never talks to Ottr. Rows are one JSON document
// per `updates` row; `update_seen` records when a chrome-for-testing version was first
// observed, because cft publishes no timestamps of its own.

import { createHash } from 'node:crypto';

const DAY_MS = 7 * 24 * 60 * 60 * 1000;
const TIER_A_MS = 2 * 24 * 60 * 60 * 1000;
// Age gate by security tier: B (OSV-corroborated) 0, A (upstream CVE claim) 2 days, else 7 days.
const gateMs = tier => (tier === 'B' ? 0 : tier === 'A' ? TIER_A_MS : DAY_MS);
const UPSTREAMS_FILE = 'upstreams.json';
const SKILL_LOCK = 'user/agents/.skill-lock.json';
const BUN_LOCK = 'user/omp/plugins/bun.lock';

// Upstream API bases come from env at call time so tests can point at a local fake.
const ghBase = () => process.env.ALATE_TEST_GITHUB_API_BASE || 'https://api.github.com';
const npmBase = () => process.env.ALATE_TEST_NPM_BASE || 'https://registry.npmjs.org';
const nodeBase = () => process.env.ALATE_TEST_NODE_DIST_BASE || 'https://nodejs.org/dist';
const osvBase = () => process.env.ALATE_TEST_OSV_BASE || 'https://api.osv.dev/v1';
const cftBase = () =>
  process.env.ALATE_TEST_CFT_BASE || 'https://googlechromelabs.github.io/chrome-for-testing';

async function getJson(url, token) {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
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
  `);
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

// Release-author security signals (tier A): CVE and GHSA ids in the body, a security-release
// line, or a published repo advisory patched in version v. Tier B when an OSV record for a cited
// CVE references the repo. See specs/security-fast-path.md.
// Horizontal whitespace only: `\s` would let every line start rescan the next lines (quadratic).
const SECURITY_LINE = /^[ \t#>*_-]*security (?:fix(?:es)?|releases?|updates?)\b/im;
async function securityOf(repo, body, osv, advisories, v) {
  const text = String(body); // a missing body reads "undefined": no signal
  // ponytail: first 20 ids of each kind only, bounds OSV calls per release.
  const uniq = ids => [...new Set(ids)].slice(0, 20);
  const cves = uniq((text.match(/CVE-\d{4}-\d{4,}/gi) ?? []).map(s => s.toUpperCase()));
  const patched = (await advisories()).filter(a => Array.isArray(a?.vulnerabilities) &&
    a.vulnerabilities.some(x => String(x?.patched_versions).match(/\d+(?:\.\d+)*/g)?.some(t => cmpVer(t, v) === 0)));
  const ghsas = uniq((`${text}\n${patched.map(a => a.ghsa_id)}`.match(/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/gi) ?? [])
    .map(s => `GHSA${s.slice(4).toLowerCase()}`));
  if (!cves.length && !ghsas.length && !SECURITY_LINE.test(text)) return null;
  const ref = new RegExp(`github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'i');
  const sources = [];
  for (const id of cves) {
    const rec = await osv(id);
    if (rec && ref.test(JSON.stringify(rec))) sources.push(`osv:${id}`);
  }
  return { cves, ghsas, sources, tier: sources.length ? 'B' : 'A' };
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

async function runReleaseCheck(check, origin, current, token, fastPath, osv) {
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
    if (fastPath && !weekOld(x.publishedAt)) x.security = await securityOf(repo, x.body, osv, advisories, x.v);
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

// Newest commit on a path/branch; target is the head sha only when the head commit is a
// week old and differs from current (prefix-tolerant compare).
async function runPathCheck(repo, check, current, token) {
  const qs = new URLSearchParams({ per_page: '1' });
  if (check.path) qs.set('path', check.path);
  if (check.branch) qs.set('sha', check.branch);
  const [head] = await getJson(`${ghBase()}/repos/${repo}/commits?${qs}`, token);
  if (!head?.sha) throw new Error(`no commit found on ${repo}`);
  const publishedAt = head.commit?.committer?.date ?? null;
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

async function runNodeCheck(check, current) {
  const entries = await getJson(`${nodeBase()}/index.json`);
  const list = (entries ?? []).filter(
    e => String(e.version).startsWith(`v${check.major}.`) && !String(e.version).includes('-')
  );
  list.sort((a, b) => cmpVer(b.version, a.version));
  const bare = e => String(e.version).replace(/^v/, '');
  const latestE = list[0] ?? null;
  const targetE = list.find(e => cmpVer(e.version, current ?? '') > 0 && weekOld(e.date)) ?? null;
  const pick = targetE ?? latestE;
  return {
    latest: latestE ? bare(latestE) : null,
    target: targetE ? bare(targetE) : null,
    publishedAt: pick?.date ?? null,
    notesUrl: `${nodeBase()}/`,
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

function runCheck(db, rowKey, name, check, origin, current, token, now, fastPath, osv) {
  switch (check?.type) {
    case 'github-release':
      return runReleaseCheck(check, origin, current, token, fastPath, osv);
    case 'github-path': {
      const repo = check.repo || originRepo(origin);
      if (!repo) throw new Error(`cannot parse repo from origin ${origin ?? '(none)'}`);
      return runPathCheck(repo, check, current, token);
    }
    case 'npm':
      return runNpmCheck(check.package ?? name, current);
    case 'node-dist':
      return runNodeCheck(check, current);
    case 'chrome-for-testing':
      return runCftCheck(db, rowKey, check, current, now);
    default:
      throw new Error(`unknown check type ${check?.type}`);
  }
}

// Builds the row plan: { rowKey, row (static fields), run (check producing the rest) }.
function collectRows(db, { dataRepo, token, now, securityFastPath, osv }) {
  const plan = [];
  const taken = new Set(); // upstreams item names already covered by a lock row

  const items = snapshotJson(db, UPSTREAMS_FILE)?.items ?? [];
  const itemByName = new Map(items.map(it => [it.name, it]));

  // Skills: one row per skill-lock entry. A repo with a usable release stream puts the row on
  // that stream's tags; otherwise the row tracks the ref head by SHA as before.
  const lock = snapshotJson(db, SKILL_LOCK);
  // Release lists and tag trees, memoized per repo for this collectRows call: many skills share one repo.
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
          const head = await runPathCheck(repo, { path: dir, branch: ref }, row.current, token);
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

  // Plugins: the direct deps of the root workspace in bun.lock; transitive packages are not plugins.
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
    // the packages entry (`<name>@github:Owner/repo#sha`).
    const gitRepo = String(spec).startsWith('github:')
      ? /^github:([^/#]+)\/([^/#]+)/.exec(String(spec))
      : null;
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
      run: () =>
        gm
          ? runPathCheck(`${gm[1]}/${gm[2]}`, { path: '' }, row.current, token)
          : runNpmCheck(npmPkg, row.current),
    });
  }

  // Items not covered by a lock row above.
  for (const item of items) {
    if (taken.has(item.name)) continue;
    const row = {
      name: item.name,
      kind: item.kind,
      origin: item.origin,
      repo: item.pin ? (item.pin.repo && item.pin.repo !== dataRepo ? item.pin.repo : dataRepo) : null,
      pin: item.pin ? { file: item.pin.file, key: item.pin.key } : null,
      current: null,
      managedBy: item.managedBy,
    };
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
        const res = await runCheck(db, `item:${item.name}`, item.name, item.check, item.origin, current, token, now, securityFastPath, osv);
        return { ...res, current };
      },
    });
  }

  return plan;
}

export async function checkUpdates(db, opts = {}) {
  const ctx = { dataRepo: opts.dataRepo ?? null, token: opts.token ?? null, now: new Date().toISOString() };
  ctx.securityFastPath = opts.securityFastPath !== false;
  // OSV records memoized per run. No token: OSV needs none, and the GitHub token stays with GitHub.
  const osvMemo = new Map();
  ctx.osv = id => {
    if (!osvMemo.has(id)) {
      // Fail closed: a non-ok status or a fetch error means "not corroborated".
      osvMemo.set(id, fetch(`${osvBase()}/vulns/${encodeURIComponent(id)}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null));
    }
    return osvMemo.get(id);
  };
  // Previous values by internal row key, so a failed check carries the old value forward.
  const prev = new Map();
  for (const r of db.prepare('SELECT value FROM updates').all()) {
    try {
      const v = JSON.parse(r.value);
      if (v?._row) prev.set(v._row, v);
    } catch {}
  }

  const out = [];
  for (const entry of collectRows(db, ctx)) {
    let value;
    try {
      const res = await entry.run();
      value = { ...entry.row, ...res, checkedAt: ctx.now };
      if (entry.row.managedBy != null) value.target = null;
    } catch (err) {
      const msg = String(err?.message ?? err); // never includes the token
      if (prev.has(entry.rowKey)) {
        value = { ...prev.get(entry.rowKey), error: msg, checkedAt: ctx.now };
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
    value.id = `${value.name}@${value.target ?? value.latest ?? 'latest'}`;
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
