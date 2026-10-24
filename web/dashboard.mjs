// Dashboard core for the alate web UI: inventory scan and data-repo import.
// HTTP serving lives in server.ts; this module is transport-free.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSourceInside, checkDestination, cloneCommand, descriptionText, gitAuthEnv, parseDataSpec, redactSecrets } from '../lib/data.mjs';

// Test hook: point the dashboard's GitHub traffic at a local fixture remote.
const GH_BASE = process.env.ALATE_TEST_GH_BASE ?? 'https://github.com';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const NOT_RULES = new Set(['AGENTS.md', 'README.md']);

// Frontmatter description of a markdown file: '' when absent. Metadata only — the body is never rendered.
function mdDescription(file) {
  const text = readFileSync(file, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return (front && descriptionText(front[1])) ?? '';
}

// CRLF-normalized comparison basis (same as sync-projects.mjs)
const norm = b => b.toString('latin1').replaceAll('\r\n', '\n');

// Relative '/'-separated paths of regular files under dir; symlinks are never followed; [] when missing.
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = base => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out;
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n++;
  }
  return n;
}

const USER_CONFIGS = ['omp/agent/config.yml', 'omp/agent/mcp.json', 'omp/agent/optimizer.json', 'omp/marketplaces.json'];
// Counted under user/ but not listed elsewhere; every counted file needs a row (F2).
const USER_OTHERS = [
  'omp/plugins/package.json',
  'omp/plugins/bun.lock',
  'omp/plugins/omp-plugins.lock.json',
  'omp/plugins/installed_plugins.json',
  '.agents/.skill-lock.json',
];
const SKILL_DIRS = [
  ['user/omp/agent/skills', 'skills'],
  ['user/omp/agent/managed-skills', 'managed-skills'],
  ['user/.agents/skills', 'agents-skills'],
];

// Read-only inventory of a data repo. Missing pieces are empty, never fatal; findings land in warnings.
function scanInventory(dir, liveRoot = null) {
  const warnings = [];
  const rules = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.mdc?$/.test(entry.name) || NOT_RULES.has(entry.name)) continue;
    const file = join(dir, entry.name);
    assertSourceInside(dir, file);
    rules.push({ name: entry.name, description: mdDescription(file) });
  }

  const configFiles = [];
  for (const rel of USER_CONFIGS) {
    const file = join(dir, 'user', rel);
    if (!existsSync(file)) continue;
    assertSourceInside(dir, file);
    configFiles.push({ path: rel, bytes: statSync(file).size });
  }

  const skills = [];
  for (const [rel, origin] of SKILL_DIRS) {
    const base = join(dir, ...rel.split('/'));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      assertSourceInside(dir, join(base, entry.name));
      const skillMd = join(base, entry.name, 'SKILL.md');
      skills.push({ name: entry.name, origin, description: existsSync(skillMd) ? mdDescription(skillMd) : '' });
    }
  }

  const others = [];
  for (const rel of USER_OTHERS) {
    const file = join(dir, 'user', ...rel.split('/'));
    if (!existsSync(file)) continue;
    assertSourceInside(dir, file);
    others.push({ path: rel, bytes: statSync(file).size });
  }
  others.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const extBase = join(dir, 'user', 'omp', 'agent', 'extensions');
  let extensions = [];
  if (existsSync(extBase)) {
    try {
      assertSourceInside(dir, extBase);
      extensions = readdirSync(extBase).sort();
    } catch {
      warnings.push('user/omp/agent/extensions: link escapes the data repo; skipped');
    }
  }

  const plugins = [];
  const seen = new Set();
  const addPlugins = names => {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      plugins.push({ name });
    }
  };
  const readJson = rel => {
    const file = join(dir, ...rel.split('/'));
    if (!existsSync(file)) return null;
    assertSourceInside(dir, file);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      warnings.push(`${rel}: unparseable JSON, skipped`);
      return null;
    }
  };
  const pkg = readJson('user/omp/plugins/package.json');
  for (const name of Object.keys(pkg?.dependencies ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    plugins.push({ name, version: pkg.dependencies[name], origin: 'package.json' });
  }
  const lock = readJson('user/omp/plugins/omp-plugins.lock.json');
  const lockNames = Object.keys(lock?.plugins ?? lock ?? {});
  const lockStart = plugins.length;
  addPlugins(lockNames);
  for (let i = lockStart; i < plugins.length; i++) plugins[i].origin = 'omp-plugins.lock.json';
  const installed = readJson('user/omp/plugins/installed_plugins.json');
  const instNames = Object.keys(installed?.plugins ?? installed ?? {});
  const instStart = plugins.length;
  addPlugins(instNames);
  for (let i = instStart; i < plugins.length; i++) plugins[i].origin = 'installed_plugins.json';

  const projects = { contextFiles: [], named: [] };
  const manifest = readJson('projects/projects.json');
  if (manifest) {
    projects.contextFiles = Array.isArray(manifest.contextFiles) && manifest.contextFiles.every(f => typeof f === 'string')
      ? manifest.contextFiles
      : (warnings.push('projects/projects.json: contextFiles must be an array of strings; ignored'), []);
    // W3: the contract requires a non-null object — absent/null/shape-wrong all warn and skip
    let table = null;
    if (manifest.projects !== null && typeof manifest.projects === 'object' && !Array.isArray(manifest.projects)) table = manifest.projects;
    else warnings.push('projects/projects.json: projects must be an object; ignored');
    for (const [name, extras] of Object.entries(table ?? {})) {
      // F1: a projects.json key is a single path segment, never a traversal
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
        warnings.push(`projects/projects.json: rejected unsafe project name "${name}"`);
        continue;
      }
      if (!Array.isArray(extras) || !extras.every(f => typeof f === 'string')) {
        warnings.push(`projects/projects.json: extras for "${name}" must be an array of strings; project skipped`);
        continue;
      }
      const projectDir = join(dir, 'projects', name);
      // a missing snapshot dir is tolerated like every other missing piece
      const snapRels = existsSync(projectDir) ? (assertSourceInside(dir, projectDir), listFiles(projectDir)) : [];
      const liveDir = liveRoot ? join(liveRoot, name) : null;
      let live = liveRoot ? (existsSync(liveDir) ? 'checked' : 'gone') : 'off';
      if (live === 'checked') {
        try { assertSourceInside(liveRoot, liveDir); } catch {
          live = 'off';
          warnings.push(`${name}: live project dir escapes the workspace; drift not checked`);
        }
      }
      const entries = [];
      for (const snapRel of snapRels) {
        const snapFile = join(projectDir, ...snapRel.split('/'));
        let status;
        if (live === 'off') status = 'unknown';
        else {
          const liveFile = join(liveDir, ...snapRel.split('/'));
          status = !existsSync(liveFile) ? 'missing' : (norm(readFileSync(snapFile)) === norm(readFileSync(liveFile)) ? 'sync' : 'changed');
        }
        entries.push({ path: snapRel, bytes: statSync(snapFile).size, status });
      }
      if (live === 'checked') {
        for (const rel of [...projects.contextFiles, ...extras]) {
          if (snapRels.includes(rel)) continue;
          // manifest paths are client-controlled data: validate before use
          const segments = rel.replaceAll('\\', '/').split('/');
          if (segments.some(s => s === '' || s === '.' || s === '..')) {
            warnings.push(`${name}: rejected unsafe snapshot path "${rel}"`);
            continue;
          }
          const liveFile = join(liveDir, ...segments);
          // assertSourceInside realpaths its target, so it is only valid for existing paths
          if (!existsSync(liveFile) || !statSync(liveFile).isFile()) continue;
          try { assertSourceInside(liveDir, liveFile); } catch {
            warnings.push(`${name}: rejected unsafe snapshot path "${rel}"`);
            continue;
          }
          entries.push({ path: rel, bytes: statSync(liveFile).size, status: 'uncaptured' });
        }
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      projects.named.push({ name, extras: extras.length, files: snapRels.length, live, entries });
    }
  } else if (existsSync(join(dir, 'projects'))) {
    warnings.push('projects/projects.json: missing or unparseable; showing what exists');
  }

  // U3: an absent user/ is normal (rules-only repo), not an escape
  let userFiles = 0;
  if (existsSync(join(dir, 'user'))) {
    try {
      assertSourceInside(dir, join(dir, 'user'));
      userFiles = countFiles(join(dir, 'user'));
    } catch {
      warnings.push('user/: link escapes the data repo; count skipped');
    }
  }
  return {
    rules,
    user: { configFiles, others, skills, extensions, plugins },
    projects,
    counts: {
      rules: rules.length,
      skills: skills.length,
      plugins: plugins.length,
      extensions: extensions.length,
      projects: projects.named.length,
      userFiles,
    },
    warnings,
  };
}

// Added/removed by name between two inventories; sections absent from previous are all added.
function sectionChanges(prevNames, nextNames) {
  const prev = new Set(prevNames);
  return {
    added: nextNames.filter(n => !prev.has(n)),
    removed: [...prev].filter(n => !nextNames.includes(n)),
    updated: [], // S7: filled when both sides have the name and the metadata differs
  };
}
function computeChanges(prev, next) {
  // names in both inventories whose scanned metadata changed
  const withUpdates = (prevList, nextList, sig) => {
    const ch = sectionChanges(prevList.map(x => x.name), nextList.map(x => x.name));
    const prevSig = new Map(prevList.map(x => [x.name, sig(x)]));
    for (const nx of nextList) {
      if (prevSig.has(nx.name) && prevSig.get(nx.name) !== sig(nx)) ch.updated.push(nx.name);
    }
    return ch;
  };
  // W1: User layer changes track the displayed records, not every file under user/.
  // ponytail: content edits to a same-path config file stay invisible — we never read file bodies, only names/sizes.
  const userIds = inv => [...new Set([
    ...(inv?.user?.configFiles ?? []).map(f => f.path),
    ...(inv?.user?.others ?? []).map(f => f.path),
    ...(inv?.user?.extensions ?? []),
  ])];
  // W2: Projects changes cover named projects plus context files, prefixed to stay distinct
  const projList = inv => [
    ...(inv?.projects?.contextFiles ?? []).map(f => ({ name: '@context/' + f })),
    ...(inv?.projects?.named ?? []),
  ];
  const changes = {
    rules: withUpdates(prev?.rules ?? [], next.rules, r => r.description),
    skills: withUpdates(prev?.user?.skills ?? [], next.user.skills, s => s.origin + '\u0000' + s.description),
    plugins: withUpdates(prev?.user?.plugins ?? [], next.user.plugins, p => p.version + '\u0000' + p.origin),
    extensions: sectionChanges(prev?.user?.extensions ?? [], next.user.extensions),
    user: sectionChanges(userIds(prev), userIds(next)),
    projects: withUpdates(projList(prev), projList(next), p => (p.extras ?? 0) + '\u0000' + (p.files ?? 0)),
  };
  return changes;
}

function loadState(db) {
  const row = db.prepare('SELECT value FROM state WHERE id = 1').get();
  return row ? JSON.parse(row.value) : { source: null, inventory: null, previous: null, changes: null };
}

// Resolve a source string to { dir, temp, source }. Throws Error with a client-safe message on failure.
// kind: 'repo' clones, 'path' reads a local directory, absent prefers a local directory.
function resolveSource(spec, kind, token) {
  const asGiven = existsSync(spec);
  if (kind !== 'repo' && (asGiven || existsSync(resolve(repoRoot, spec)))) {
    const dir = resolve(asGiven ? spec : resolve(repoRoot, spec));
    return { dir, temp: false, source: { kind: 'path', spec, name: dir, ref: '', importedSha: '' } };
  }
  if (kind === 'path') {
    throw Object.assign(new Error(`no local data repo at ${spec}`), { status: 400 });
  }
  const parsed = parseDataSpec(spec);
  if (!parsed || (!asGiven && (/^([A-Za-z]:[\\/]|\\\\)/.test(spec) || parsed.name.startsWith('.')))) {
    throw Object.assign(new Error(`no data repo at ${spec}; pass a local path or owner/name[@ref]`), { status: 400 });
  }
  return cloneRepo(spec, parsed.name, parsed.ref, token);
}

// A local dir of that name wins over the GitHub URL (cloneRepo, remoteHead and pushes agree).
const remoteUrl = name => (existsSync(name) ? name : `${GH_BASE}/${name}`);

// Clone a GitHub repo into a fresh temp dir; temp: true so importSource cleans it up.
function cloneRepo(spec, name, ref, token) {
  const url = remoteUrl(name);
  const active = token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), 'alate-dashboard-'));
  const { args: gitArgs, env } = cloneCommand(url, ref, active, dir);
  const git = spawnSync('git', gitArgs, { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (git.status !== 0) {
    rmSync(dir, { recursive: true, force: true }); // our own fresh temp dir only
    const stderr = redactSecrets(git.stderr ?? '', active).trim();
    throw Object.assign(new Error(`git clone failed for ${name}${ref ? `@${ref}` : ''}${stderr ? `: ${stderr}` : ''}`), { status: 400 });
  }
  // HEAD sha at clone time: the baseline the periodic remote check compares against.
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  if (head.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cannot read cloned HEAD for ${name}`);
  }
  const importedSha = head.stdout.trim();
  return { dir, temp: true, source: { kind: 'repo', spec, name, ref, importedSha } };
}

// resolvedIn: an already-resolved { dir, temp, source } to import directly (the editor's
// clone), so a write never clones twice. Absent: resolveSource resolves spec as usual.
function importSource(state, spec, kind, token, db, resolvedIn = null) {
  const resolved = resolvedIn ?? resolveSource(spec, kind, token);
  try {
    const inventory = scanInventory(resolved.dir, resolved.temp ? null : dirname(resolved.dir));
    const previous = state.inventory;
    const changes = previous ? computeChanges(previous, inventory) : null;
    const next = { source: { ...resolved.source, importedAt: new Date().toISOString() }, inventory, previous, changes };
    // One transaction keeps the previous snapshot intact if any source read fails.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM files');
      const insert = db.prepare('INSERT INTO files (path, content) VALUES (?, ?)');
      const walk = (dir, sub = '') => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (['.git', 'node_modules', '__pycache__'].includes(entry.name)) continue;
          const rel = sub ? `${sub}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink() || /[\\:\0]/.test(rel)) throw Object.assign(new Error(`unsafe snapshot path: ${rel}`), { status: 400 });
          const file = join(dir, entry.name);
          assertSourceInside(resolved.dir, file);
          if (entry.isDirectory()) walk(file, rel);
          else if (entry.isFile()) insert.run(rel, readFileSync(file));
          else throw Object.assign(new Error(`snapshot path is not a regular file: ${rel}`), { status: 400 });
        }
      };
      walk(resolved.dir);
      db.prepare('INSERT OR REPLACE INTO state (id, value) VALUES (1, ?)').run(JSON.stringify(next));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return next;
  } finally {
    if (resolved.temp) rmSync(resolved.dir, { recursive: true, force: true });
  }
}

// Existing installers read a directory. It contains only the stored database bytes.
function snapshotData(db) {
  const dir = mkdtempSync(join(tmpdir(), 'alate-snapshot-'));
  try {
    for (const { path, content } of db.prepare('SELECT path, content FROM files').iterate()) {
      if (/[\\:\0]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`unsafe snapshot path: ${path}`);
      const dest = join(dir, path);
      checkDestination(dir, dest);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    return { dir, temp: true };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// ---- File editor: verify a base hash, write or delete in a source tree, commit and push. ----

const sha256 = b => createHash('sha256').update(b).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Editor paths are relative '/'-separated snapshot paths. Reject everything the snapshot
// itself rejects (backslash, colon, NUL) plus traversal and any .git segment.
function safeRelPath(path) {
  const shown = typeof path === 'string' ? path.slice(0, 100) : '';
  if (typeof path !== 'string' || path === '' || /[\\:\0]/.test(path) || path.startsWith('/')) fail(400, `unsafe file path: ${shown}`);
  if (path.split('/').some(s => !s || s === '.' || s === '..' || /^\.git$/i.test(s))) fail(400, `unsafe file path: ${shown}`);
  return path;
}

// One stored snapshot file for the editor: null when absent. binary when the bytes are not
// valid UTF-8 or hold NUL, so content is then null; hash covers the stored bytes.
function readStoredFile(db, rel) {
  safeRelPath(rel);
  const row = db.prepare('SELECT content FROM files WHERE path = ?').get(rel);
  if (!row) return null;
  const bytes = Buffer.from(row.content);
  let text = null;
  try { text = bytes.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* invalid UTF-8 */ }
  return { path: rel, bytes: bytes.length, binary: text === null, content: text, hash: sha256(bytes) };
}

function listStoredFiles(db) {
  return db.prepare('SELECT path, LENGTH(content) AS bytes FROM files ORDER BY path').all();
}

// Commit message: default per action; a caller message is one line of at most 500 characters.
function editMessage(raw, rel, adding, del) {
  const fallback = `alate: ${del ? 'delete' : adding ? 'add' : 'edit'} ${rel}`;
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') fail(400, 'invalid message');
  const line = raw.replaceAll(/\r\n?|\n/g, ' ').trim() || fallback;
  if (line.length > 500) fail(400, 'message must be 500 characters or fewer');
  return line;
}

// Verify base against the tree's file bytes, then write or delete there. bytes null = delete.
// base null = create, the file must not exist; otherwise the sha256 hex the editor loaded.
function applyToTree(dir, rel, base, bytes) {
  const file = join(dir, ...rel.split('/'));
  const current = existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
  if (bytes === null) {
    if (current === null) fail(404, `${rel} not found`);
    if (sha256(current) !== base) fail(409, `${rel} changed since it was loaded; reload it and retry`);
    try { assertSourceInside(dir, file); checkDestination(dir, file); } catch (err) { fail(400, err.message); }
    rmSync(file, { force: true });
    // git tracks no folders: drop the ones the delete emptied, so the inventory loses the skill dir too.
    for (let d = dirname(file); d !== dir && d.startsWith(dir) && readdirSync(d).length === 0; d = dirname(d)) rmSync(d, { recursive: true });
  } else {
    if (base === null) { if (current !== null) fail(409, `${rel} changed since it was loaded; reload it and retry`); }
    else if (current === null || sha256(current) !== base) fail(409, `${rel} changed since it was loaded; reload it and retry`);
    try { checkDestination(dir, file); } catch (err) { fail(400, err.message); }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

// git in dir; env carries auth through per-process config, never argv or URL.
function runGit(dir, args, env = process.env) {
  return spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });
}

// -c identity only when the tree has none: a commit must always be possible.
function identArgs(dir, env) {
  const id = runGit(dir, ['config', 'user.email'], env);
  return id.status !== 0 || !id.stdout.trim() ? ['-c', 'user.name=alate', '-c', 'user.email=alate@localhost'] : [];
}

// Stage the one path, commit, return the new sha. A failure is a client-safe 400.
function commitEdit(dir, rel, message, env, token) {
  const add = runGit(dir, ['add', '-A', '--', rel], env);
  if (add.status !== 0) fail(400, `git add failed: ${redactSecrets(add.stderr.trim(), token)}`);
  const commit = runGit(dir, [...identArgs(dir, env), 'commit', '-m', message], env);
  if (commit.status !== 0) fail(400, `git commit failed: ${redactSecrets(commit.stderr.trim(), token)}`);
  const head = runGit(dir, ['rev-parse', 'HEAD'], env);
  if (head.status !== 0) fail(400, `cannot read the new commit for ${rel}`);
  return head.stdout.trim();
}

// Repo source: fresh clone, verify against the clone, commit, push HEAD:<branch>, then import
// the snapshot from that same clone so importedSha is the new commit. Temp dir always cleaned.
function editRepoSource(state, db, src, op, token) {
  const resolved = cloneRepo(src.spec, src.name, src.ref, token);
  try {
    applyToTree(resolved.dir, op.rel, op.base, op.bytes);
    const env = gitAuthEnv(remoteUrl(src.name), token);
    const commit = commitEdit(resolved.dir, op.rel, op.message, env, token);
    const branch = src.ref || runGit(resolved.dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env).stdout.trim();
    const push = runGit(resolved.dir, ['push', 'origin', `HEAD:${branch}`], env);
    if (push.status !== 0) fail(502, `git push failed: ${redactSecrets(push.stderr.trim(), token)}`);
    resolved.source.importedSha = commit;
    const next = importSource(state, src.spec, src.kind, token, db, resolved);
    return { commit, pushed: true, warning: undefined, state: next };
  } finally {
    if (existsSync(resolved.dir)) rmSync(resolved.dir, { recursive: true, force: true }); // importSource already removed it on success
  }
}

// Path source: verify against disk, write, then commit and push in the user's own work tree
// (its hooks and credential helpers run untouched, never --no-verify). The disk stays the
// truth: a failed commit or push still re-imports the snapshot before the error is rethrown.
function editPathSource(state, db, src, op, token) {
  const dir = src.name;
  if (!existsSync(dir)) fail(400, `no local data repo at ${src.spec}`);
  applyToTree(dir, op.rel, op.base, op.bytes);
  let commit = '', pushed = false, warning, failure = null;
  if (runGit(dir, ['rev-parse', '--is-inside-work-tree']).status === 0) {
    try {
      commit = commitEdit(dir, op.rel, op.message, process.env, token);
      if (runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).status !== 0) {
        warning = 'no upstream configured; the commit stayed local';
      } else {
        const push = runGit(dir, ['push']);
        if (push.status !== 0) failure = Object.assign(new Error(`git push failed: ${redactSecrets(push.stderr.trim(), token)}`), { status: 502 });
        else pushed = true;
      }
    } catch (err) { failure = err; }
  }
  const next = importSource(state, src.spec, src.kind, token, db);
  if (failure) throw failure;
  return { commit, pushed, warning, state: next };
}

// One editor operation end to end. edit: { path, base, content?, message?, delete }.
// Throws Error with a client-safe .status and a token-free message.
function applyFileEdit(state, db, edit, token) {
  const rel = safeRelPath(edit.path);
  if (!state.source) fail(400, 'no data source configured');
  if (edit.delete && edit.content !== undefined) fail(400, 'delete takes no content');
  if (!edit.delete && typeof edit.content !== 'string') fail(400, 'content must be a string');
  if (edit.base !== null && typeof edit.base !== 'string') fail(400, 'base must be the loaded hash or null');
  const op = {
    rel,
    base: edit.base,
    bytes: edit.delete ? null : Buffer.from(edit.content, 'utf8'),
    message: editMessage(edit.message, rel, !edit.delete && edit.base === null, edit.delete),
  };
  return state.source.kind === 'repo'
    ? editRepoSource(state, db, state.source, op, token)
    : editPathSource(state, db, state.source, op, token);
}

// First sha of `git ls-remote` for a dashboard repo source; '' when the check fails (client-safe).
function remoteHead(name, ref, token) {
  const url = remoteUrl(name);
  const git = spawnSync('git', ['ls-remote', url, ref || 'HEAD'], {
    env: gitAuthEnv(url, token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN),
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  return git.status === 0 && git.stdout ? git.stdout.split('\n')[0].trim().split(/\s+/)[0] : '';
}

export { scanInventory, importSource, loadState, remoteHead, snapshotData, readStoredFile, listStoredFiles, applyFileEdit };
