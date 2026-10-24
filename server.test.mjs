// Self-check for server.ts: node server.test.mjs
// Hermetic: a fixture origin repo, config file and HOME all live in a temp dir; the server runs on an ephemeral port.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { forAll, keepTemp } from './lib/data.mjs';

import { diffLines } from './web/diff.mjs';
import { cmpVer } from './lib/updates.mjs';

// Proof-mark diff: change, pure addition, pure deletion, and no change.
assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [{ start: 1, count: 1, old: ['b'] }]);
assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [{ start: 1, count: 1, old: [] }]);
assert.deepEqual(diffLines(['a', 'b', 'c', 'd'], ['a', 'd']), [{ start: 1, count: 0, old: ['b', 'c'] }]);
assert.deepEqual(diffLines(['x', 'a', 'y', 'b'], ['a', 'z', 'b', 'w']), [
  { start: 0, count: 0, old: ['x'] }, { start: 1, count: 1, old: ['y'] }, { start: 3, count: 1, old: [] }]);
assert.deepEqual(diffLines(['a'], ['a']), []);

const repoRoot = dirname(fileURLToPath(import.meta.url)); // this test sits at the repo root
const tmp = mkdtempSync(join(tmpdir(), 'alate-server-'));
const tmpHome = join(tmp, 'home');
const origin = join(tmp, 'origin');
const emptyDir = join(tmp, 'empty');
const data = join(tmp, 'data');
const stateFile = join(tmp, 'state.db');
const persisted = () => {
  const db = new DatabaseSync(stateFile, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT value FROM state WHERE id = 1').get().value); }
  finally { db.close(); }
};
mkdirSync(tmpHome, { recursive: true });
const serverTmp = join(tmp, 'server-tmp');
mkdirSync(serverTmp);
const provisionGate = join(serverTmp, 'provision-gate');
mkdirSync(join(origin, 'user', 'omp', 'agent'), { recursive: true });
mkdirSync(join(origin, 'user', 'omp', 'plugins'), { recursive: true });
mkdirSync(join(origin, 'projects'), { recursive: true });
mkdirSync(emptyDir, { recursive: true });
writeFileSync(join(emptyDir, 'bad.md'), 'no frontmatter\n'); // undescribed rule: sync.mjs refuses, exit 1
writeFileSync(join(origin, 'demo-rule.md'), '---\ndescription: demo rule\n---\n\nBody\n');
writeFileSync(join(origin, 'AGENTS.md'), '# data repo instructions\n');
writeFileSync(join(origin, 'user', 'omp', 'agent', 'config.yml'), 'model: test\n');
writeFileSync(join(origin, 'user', 'omp', 'plugins', 'package.json'), JSON.stringify({ dependencies: {} }));
writeFileSync(join(origin, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: {} }));
const git = (args, opts = {}) => spawnSync('git', args, { ...opts, env: { ...process.env, GIT_CONFIG_GLOBAL: 'nul', GIT_CONFIG_SYSTEM: 'nul' } });
assert.equal(git(['init', origin]).status, 0);
assert.equal(git(['-C', origin, 'add', '-A']).status, 0);
assert.equal(git(['-C', origin, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init']).status, 0);

// Dashboard fixture: a data repo with rules, user layer and projects (from web/server.test.mjs).
mkdirSync(join(data, 'user', 'omp', 'agent', 'skills', 'demo'), { recursive: true });
mkdirSync(join(data, 'projects', 'alpha'), { recursive: true });
writeFileSync(join(data, 'demo-rule.md'), '---\ndescription: demo rule\n---\n\nBody\n');
writeFileSync(join(data, 'AGENTS.md'), '# data repo instructions\n');
writeFileSync(join(data, 'user', 'omp', 'agent', 'config.yml'), 'model: test\n');
mkdirSync(join(data, 'user', 'omp', 'plugins'), { recursive: true });
writeFileSync(join(data, 'user', 'omp', 'plugins', 'package.json'), JSON.stringify({ dependencies: { '@scope/demo': '^1.0.0' } }));
writeFileSync(join(data, 'user', 'omp', 'agent', 'skills', 'demo', 'SKILL.md'), '---\ndescription: demo skill\n---\n');
writeFileSync(join(data, 'projects', 'projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { alpha: ['extra'], ghost: [], '../../outside': [] } }));
writeFileSync(join(data, 'projects', 'alpha', 'snapshot.md'), 'snapshot\n');
// user-layer coverage: config files, lock files, managed/agents skills, extensions, non-frontmatter rule
writeFileSync(join(data, 'user', 'omp', 'agent', 'mcp.json'), '{}');
writeFileSync(join(data, 'user', 'omp', 'agent', 'optimizer.json'), '{}');
writeFileSync(join(data, 'user', 'omp', 'marketplaces.json'), '{}');
writeFileSync(join(data, 'user', 'omp', 'plugins', 'bun.lock'), '');
writeFileSync(join(data, 'user', 'omp', 'plugins', 'omp-plugins.lock.json'), JSON.stringify({ plugins: { 'lock-plug': { version: '1.0.0', enabled: true } }, settings: {} })); // real shape: names live under "plugins"
writeFileSync(join(data, 'user', 'omp', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'inst-plug': {} } })); // real shape: names live under "plugins"
mkdirSync(join(data, 'user', '.agents'), { recursive: true });
writeFileSync(join(data, 'user', '.agents', '.skill-lock.json'), '{}');
mkdirSync(join(data, 'user', 'omp', 'agent', 'managed-skills', 'mskill'), { recursive: true });
writeFileSync(join(data, 'user', 'omp', 'agent', 'managed-skills', 'mskill', 'SKILL.md'), '---\ndescription: mskill skill\n---\n');
mkdirSync(join(data, 'user', '.agents', 'skills', 'askill'), { recursive: true });
writeFileSync(join(data, 'user', '.agents', 'skills', 'askill', 'SKILL.md'), '---\ndescription: askill skill\n---\n');
mkdirSync(join(data, 'user', 'omp', 'agent', 'extensions', 'ext-a'), { recursive: true });
writeFileSync(join(data, 'not-front.md'), 'leading text\n---\ndescription: sneaky\n---\n'); // frontmatter marker not at byte 0: description stays ''

// GitHub fixture: the dashboard data fixture served as a local "remote" via ALATE_TEST_GH_BASE.
const ghData = join(tmp, 'gh', 'demo', 'data');
cpSync(data, ghData, { recursive: true });
assert.equal(git(['init', ghData]).status, 0);
assert.equal(git(['-C', ghData, 'add', '-A']).status, 0);
assert.equal(git(['-C', ghData, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init']).status, 0);
const ghSha = () => git(['-C', ghData, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const sha1 = ghSha();

const serverEnv = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TMPDIR: serverTmp, TEMP: serverTmp, TMP: serverTmp, ALATE_KEEP_TEMP: '', ALATE_TEST_PROVISION_GATE: provisionGate, ALATE_TEST_GH_BASE: pathToFileURL(join(tmp, 'gh')).href, GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_GLOBAL: 'nul', GIT_CONFIG_SYSTEM: 'nul' };
// sync.mjs prefers PI_CODING_AGENT_DIR over HOME: an inherited value would install fixture rules into a real agent dir.
delete serverEnv.PI_CODING_AGENT_DIR;
let child = spawn(process.execPath, [join(repoRoot, 'server.ts'), '--port', '0', '--config', join(tmp, 'server-config.json'), '--interval', '1', '--db', stateFile], { cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'inherit'] });

const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() < end, 'waitFor timed out');
    await new Promise(r => setTimeout(r, 100));
  }
};

try {
  let base, apiKey, listenLine = '';
  await new Promise((res, rej) => {
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      const k = /alate API key: (\S+)\n/.exec(buf);
      const l = /alate server on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(buf);
      if (k) apiKey = k[1];
      if (l) listenLine = l[1];
      if (k && l) res();
    });
    child.on('exit', code => rej(new Error(`server exited early (${code})`)));
    setTimeout(() => rej(new Error(`no startup lines; got: ${buf}`)), 10_000).unref();
  });
  base = listenLine;

  const get = async (path, auth = true) => fetch(new URL(path, base), auth ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
  const post = async (path, body, headers = {}) => fetch(new URL(path, base), { method: 'POST', headers, body });
  const postJson = async (path, body, auth = true) => post(path, JSON.stringify(body), { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${apiKey}` } : {}) });
  const config = join(tmp, 'server-config.json');

  // 0. No source configured yet: provision refuses before anything runs.
  let r = await postJson('/provision', {}, true);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'no data source configured');

  // 1. Config round-trip: token is persisted to the file but never serialized back in any response.
  r = await postJson('/config', { repo: origin, token: 'alate-test-token-9f2c' }, true);
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.tokenSet, true);
  assert.ok(!JSON.stringify(body).includes('alate-test-token-9f2c'), 'no token in POST /config response');
  r = await get('/config');
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.repo, origin, 'GET /config reports the repo source');
  assert.ok(!JSON.stringify(body).includes('alate-test-token-9f2c'), 'no token in GET /config');
  r = await get('/health');
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.apiKeySet, true);
  assert.ok(!JSON.stringify(body).includes('alate-test-token-9f2c'), 'no token in /health');
  const onDisk = readFileSync(config, 'utf8');
  assert.ok(onDisk.includes('alate-test-token-9f2c'), 'token persisted in config file');
  if (process.platform !== 'win32') assert.equal(statSync(config).mode & 0o777, 0o600, 'config file mode 0600');

  // 2. Bearer auth required on POST /provision and POST /config.
  r = await postJson('/provision', {}, false);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'unauthorized');
  r = await postJson('/config', { path: emptyDir }, false);
  assert.equal(r.status, 401);
  r = await post('/provision', '{}', { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' });
  assert.equal(r.status, 401);
  // /config validation: all 400s happen before any state change, so the repo source stays intact.
  r = await postJson('/config', {}, true);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'exactly one of repo or path required');
  r = await postJson('/config', { repo: 'bad name!' }, true);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid repo');
  r = await postJson('/config', { path: join(tmp, 'definitely-missing-dir') }, true);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid path');
  for (const invalid of [{ repo: origin, path: emptyDir }, { repo: 42 }, { path: 42 }, { repo: origin, token: 42 }]) {
    assert.equal((await postJson('/config', invalid, true)).status, 400);
    assert.equal(persisted().source.spec, origin, 'invalid config preserves the stored snapshot');
  }
  r = await post('/provision', '{}', { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
  assert.notEqual(r.status, 401);

  // 2b. POST /api/key issues a fresh key: returned once, persisted, old bearer rejected after.
  const oldKey = apiKey;
  r = await post('/api/key', undefined, { Authorization: `Bearer ${apiKey}` });
  assert.equal(r.status, 200);
  apiKey = (await r.json()).key;
  assert.equal(typeof apiKey, 'string');
  assert.ok(apiKey.length >= 32 && apiKey !== oldKey, 'new key differs from the boot key');
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).apiKey, apiKey, 'rotated key persisted to config file');
  r = await post('/config', JSON.stringify({ repo: origin }), { Authorization: `Bearer ${oldKey}`, 'Content-Type': 'application/json' });
  assert.equal(r.status, 401, 'old key rejected after rotation');
  r = await postJson('/config', { repo: origin }, true);
  assert.equal(r.status, 200, 'new key accepted');

  // 2c. The dashboard trusts a loopback bind: data routes answer without a key there.
  // A non-loopback bind needs the key on every dashboard route (section 79). The
  // provisioning API (/config, /provision, /api/updates) needs the key on every bind.
  r = await fetch(new URL('/api/state', base));
  assert.equal(r.status, 200, 'the dashboard trusts a loopback bind');
  r = await post('/provision', undefined);
  assert.equal(r.status, 401, 'provisioning needs the key on loopback too');
  r = await fetch(new URL('/api/updates', base));
  assert.equal(r.status, 401, 'the updates read needs the key on loopback too');
  for (const open of ['/', '/app.js', '/style.css', '/theme.js', '/health']) {
    assert.equal((await fetch(new URL(open, base))).status, 200, `${open} stays open`);
  }

  // 5. Update loop: poll lastChecked, then provision refreshes shas, then a new origin commit flips behind.
  await waitFor(async () => {
    body = await (await get('/health')).json();
    return body.update.lastChecked !== null;
  }, 10_000);
  assert.equal(body.update.enabled, true);
  assert.equal(body.update.behind, false);
  r = await postJson('/provision', {}, true);
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.results.map(x => x.code), [0, 0]);
  assert.ok(body.results[0].output.includes(join(tmpHome, '.omp', 'agent', 'rules')), 'success reports the installation destination');
  assert.equal(readFileSync(join(tmpHome, '.omp', 'agent', 'rules', 'demo-rule.md'), 'utf8').replaceAll('\r\n', '\n'), '---\ndescription: demo rule\n---\n\nBody\n');
  const snapshot = new DatabaseSync(stateFile, { readOnly: true });
  try {
    assert.equal(Buffer.from(snapshot.prepare('SELECT content FROM files WHERE path = ?').get('demo-rule.md').content).toString().replaceAll('\r\n', '\n'), '---\ndescription: demo rule\n---\n\nBody\n');
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '.git/%'").get().n, 0);
  } finally { snapshot.close(); }
  assert.equal((await postJson('/config', { repo: origin }, true)).status, 200, 're-import preserves the provisioned baseline');
  assert.equal((await (await get('/config')).json()).tokenSet, true, 'a source refresh preserves the stored credential');
  git(['-C', origin, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'second']);
  await waitFor(async () => {
    body = await (await get('/health')).json();
    return body.update.behind === true;
  }, 10_000);

  // 3. Reject overlapping requests even when the client pauses before it sends them.
  writeFileSync(provisionGate, '');
  const first = postJson('/provision', {}, true);
  try {
    await waitFor(async () => (await (await get('/health')).json()).running, 10_000);
    await new Promise(r => setTimeout(r, 600));
    r = await postJson('/provision', {}, true);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'provision already running');
    assert.equal((await postJson('/config', { path: emptyDir }, true)).status, 409);
    assert.equal((await postJson('/api/import', { source: data })).status, 409);
  } finally { rmSync(provisionGate, { force: true }); }
  await first;
  r = await postJson('/provision', {}, true);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);

  r = await postJson('/config', { repo: 'https://github.com/demo/data' }, true);
  assert.equal(r.status, 200);
  assert.equal(persisted().source.importedSha, sha1, '/config stores the selected GitHub commit');
  assert.equal((await (await get('/health')).json()).update.behind, false, 'a different repo has no provisioned baseline');
  assert.equal((await postJson('/config', { repo: origin }, true)).status, 200);

  // A stored snapshot provisions without the remote. A failed refresh preserves it.
  const offline = join(tmp, 'origin-offline');
  renameSync(origin, offline);
  try {
    r = await postJson('/config', { repo: origin }, true);
    assert.equal(r.status, 400);
    assert.equal((await (await get('/config')).json()).repo, origin);
    r = await postJson('/provision', {}, true);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  } finally { renameSync(offline, origin); }

  const invalidSnapshot = join(tmp, 'invalid-snapshot');
  mkdirSync(invalidSnapshot);
  writeFileSync(join(invalidSnapshot, 'new-rule.md'), '---\ndescription: new rule\n---\nNew\n');
  symlinkSync(data, join(invalidSnapshot, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  r = await postJson('/api/import', { source: invalidSnapshot });
  assert.equal(r.status, 400);
  assert.equal(persisted().source.spec, origin, 'unsafe import preserves the selected snapshot');
  r = await postJson('/config', { path: invalidSnapshot }, true);
  assert.equal(r.status, 400);
  assert.equal(typeof (await r.json()).error, 'string');
  assert.equal(persisted().source.spec, origin, 'rejected configuration preserves the selected snapshot');
  const stored = new DatabaseSync(stateFile);
  try {
    assert.equal(stored.prepare('SELECT path FROM files WHERE path = ?').get('new-rule.md'), undefined, 'failed import rolls back file writes');
    for (const path of ['../escape.txt', 'C:\\escape.txt', '/escape.txt', 'nested\\escape.txt', 'nested:escape.txt', 'nested/./escape.txt', 'nested//escape.txt', 'nested/../escape.txt', 'nul\0.txt']) {
      stored.prepare('INSERT INTO files (path, content) VALUES (?, ?)').run(path, new TextEncoder().encode('unsafe'));
      try {
        r = await postJson('/provision', {}, true);
        assert.equal(r.status, 500, 'stored traversal cannot provision outside the temporary snapshot');
      } finally { stored.prepare('DELETE FROM files WHERE path = ?').run(path); }
    }
  } finally { stored.close(); }

  // 4. Script failure surfaces a non-zero code with the full result shape.
  r = await postJson('/config', { path: emptyDir }, true);
  assert.equal(r.status, 200);
  // source switch to a path disables the update loop
  body = await (await get('/health')).json();
  assert.equal(body.update.enabled, false);
  // a path source has no update loop to re-save config, so only POST /config can persist it
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).path, emptyDir, 'path source persisted to config file');
  r = await postJson('/provision', {}, true);
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.results[0].script, 'sync.mjs');
  assert.notEqual(body.results[0].code, 0);
  for (const item of body.results) {
    assert.equal(typeof item.script, 'string');
    assert.equal(typeof item.code, 'number');
    assert.equal(typeof item.output, 'string');
    assert.equal(typeof item.truncated, 'boolean');
  }
  // 4b. Mixed failure: one script fails while the others pass, ok stays false (every, not some).
  const mixedDir = join(tmp, 'mixed');
  mkdirSync(join(mixedDir, 'user', 'omp', 'agent'), { recursive: true });
  mkdirSync(join(mixedDir, 'projects'), { recursive: true });
  writeFileSync(join(mixedDir, 'bad.md'), 'no frontmatter\n'); // sync.mjs refuses, exit 1
  writeFileSync(join(mixedDir, 'user', 'omp', 'agent', 'config.yml'), 'model: test\n'); // same bytes origin already installed: install-user passes
  writeFileSync(join(mixedDir, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: {} })); // sync-projects passes
  r = await postJson('/config', { path: mixedDir }, true);
  assert.equal(r.status, 200);
  r = await postJson('/provision', {}, true);
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.results.map(x => x.code), [1, 0]);
  assert.equal(body.ok, false); // one failing script fails the provision
  assert.ok(body.results[0].output.includes('bad.md'), 'failure reports the rule that needs a fix');

  // restore the repo source for later cases; a provision refreshes the update state
  await postJson('/config', { repo: origin }, true);
  r = await postJson('/provision', {}, true);
  assert.equal(r.status, 200);
  await waitFor(async () => {
    body = await (await get('/health')).json();
    return body.update.lastChecked !== null && body.update.behind === false;
  }, 10_000);
  assert.ok(JSON.parse(readFileSync(config, 'utf8')).update.provisionedSha, 'provisioned sha persisted to config file');

  // Dashboard imports select the same stored snapshot used by provisioning.
  const postImport = payload => post('/api/im' + 'port', payload, { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` });
  assert.equal((await postImport(JSON.stringify({ source: data }))).status, 200);

  r = await get('/api/state');
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.source.kind, 'path');
  assert.ok(body.inventory.rules.some(x => x.name === 'demo-rule.md' && x.description === 'demo rule'));
  assert.ok(body.inventory.user.skills.some(s => s.name === 'demo'));
  assert.ok(body.inventory.user.skills.some(s => s.name === 'mskill' && s.origin === 'managed-skills'));
  assert.ok(body.inventory.user.skills.some(s => s.name === 'askill' && s.origin === 'agents-skills'));
  for (const p of ['omp/agent/config.yml', 'omp/agent/mcp.json', 'omp/agent/optimizer.json', 'omp/marketplaces.json']) {
    assert.ok(body.inventory.user.configFiles.some(f => f.path === p && f.bytes > 0), `config row ${p}`);
  }
  assert.deepEqual(body.inventory.user.others.map(o => o.path), [
    '.agents/.skill-lock.json',
    'omp/plugins/bun.lock',
    'omp/plugins/installed_plugins.json',
    'omp/plugins/omp-plugins.lock.json',
    'omp/plugins/package.json',
  ]);
  assert.ok(body.inventory.user.plugins.some(p => p.name === 'lock-plug' && p.origin === 'omp-plugins.lock.json'));
  assert.ok(body.inventory.user.plugins.some(p => p.name === 'inst-plug' && p.origin === 'installed_plugins.json'));
  assert.ok(!body.inventory.user.plugins.some(p => ['version', 'plugins', 'settings'].includes(p.name)), 'wrapper keys are not plugin names');
  assert.ok(body.inventory.user.extensions.includes('ext-a'));
  assert.equal(body.inventory.rules.find(x => x.name === 'not-front.md')?.description, '');
  assert.equal(body.inventory.counts.userFiles, 12);
  assert.equal(body.inventory.projects.named[0].name, 'alpha');
  assert.equal(body.inventory.projects.named[0].files, 1);
  // F1: traversal project name rejected, nothing written outside the fixture;
  // 'ghost' has no snapshot dir and still imports with files: 0, no warning
  assert.equal(body.inventory.projects.named.length, 2);
  const ghost = body.inventory.projects.named.find(p => p.name === 'ghost');
  assert.ok(ghost && ghost.files === 0);
  assert.ok(!body.inventory.warnings.some(w => w.includes('ghost')));
  assert.ok(body.inventory.warnings.some(w => w.includes('../../outside')));
  assert.ok(!existsSync(join(tmp, 'outside')), 'no traversal write outside the fixture');
  // F2: plugin/lock files counted under user/ get their own rows
  assert.ok(body.inventory.user.others.some(o => o.path === 'omp/plugins/package.json' && o.bytes > 0));
  assert.ok(body.inventory.counts.userFiles >= body.inventory.user.others.length);
  assert.ok(!JSON.stringify(body).includes('model: test'), 'no file contents in responses');

  r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-security-policy'), /manifest-src 'self'/);
  assert.match(await r.text(), /rel="manifest" href="\/manifest\.webmanifest"/);
  r = await get('/style.css');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /font-src 'self'/);
  for (const font of ['/fonts/source-serif-4.woff2', '/fonts/jetbrains-mono.woff2']) {
    r = await get(font);
    assert.equal(r.status, 200, font);
    assert.equal(r.headers.get('content-type'), 'font/woff2');
  }
  // PWA: manifest, service worker, and icons are public static assets.
  r = await get('/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/manifest+json');
  const pwa = await r.json();
  assert.equal(pwa.name, 'alate');
  assert.equal(pwa.display, 'standalone');
  assert.equal(pwa.start_url, '/');
  assert.ok(pwa.icons.some((i) => i.sizes === '192x192' && i.src === '/icons/icon-192.png'), 'a 192 icon is listed');
  assert.ok(pwa.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'a maskable icon is listed');
  r = await get('/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(await r.text(), /alate-shell-v1/);
  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']) {
    r = await get(icon);
    assert.equal(r.status, 200, icon);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const head = Buffer.from(await r.arrayBuffer()).subarray(0, 4);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47], `${icon} is a PNG`);
  }
  r = await get('/diff.mjs');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  r = await get('/nope');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not found');
  r = await get('/%2e%2e/etc/passwd');
  assert.equal(r.status, 404);

  r = await postImport(JSON.stringify({ source: data }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.state.inventory.rules.some(x => x.name === 'demo-rule.md'));

  r = await postImport(JSON.stringify({ source: './definitely-missing-xyz' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no data repo at/);

  r = await postImport('not json');
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid JSON body');

  // route bodyLimit is 64 KiB: a ~100 KB import body is rejected
  r = await postImport(JSON.stringify({ source: 'x'.repeat(100_000) }));
  assert.equal(r.status, 413);

  r = await postImport(JSON.stringify({ source: data }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.notEqual(body.state.changes, null);
  assert.deepEqual(body.state.changes.rules, { added: [], removed: [], updated: [] });

  // F3: explicit kind is honored
  r = await postImport(JSON.stringify({ source: data, kind: 'path' }));
  assert.equal(r.status, 200);
  r = await postImport(JSON.stringify({ source: data, kind: 'repo' })); // local dir, kind repo refuses
  assert.equal(r.status, 400);
  r = await postImport(JSON.stringify({ source: '../not-there', kind: 'path' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no local data repo at/);
  r = await postImport(JSON.stringify({ source: data, kind: 'bogus' }));
  assert.equal(r.status, 400);

  // S2: contextFiles of the wrong shape is ignored with a warning
  const data2 = join(tmp, 'data2');
  mkdirSync(join(data2, 'projects'), { recursive: true });
  writeFileSync(join(data2, 'projects', 'projects.json'), JSON.stringify({ contextFiles: 'AGENTS.md', projects: {} }));
  r = await postImport(JSON.stringify({ source: data2 }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.state.inventory.projects.contextFiles, []);
  assert.ok(body.state.inventory.warnings.some(w => w.includes('contextFiles must be an array of strings')));

  // S7: editing a rule's description reports it as updated
  r = await postImport(JSON.stringify({ source: data })); // baseline with the old description
  assert.equal(r.status, 200);
  writeFileSync(join(data, 'demo-rule.md'), '---\ndescription: changed rule\n---\n\nBody\n');
  r = await postImport(JSON.stringify({ source: data }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.state.changes.rules.updated, ['demo-rule.md']);
  assert.deepEqual(body.state.changes.rules.added, []);

  // U1-adjacent hermetic cases + (a) repo without a user/ dir
  const data3 = join(tmp, 'data3');
  mkdirSync(join(data3, 'projects', 'solo'), { recursive: true });
  writeFileSync(join(data3, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: { solo: [] } }));
  r = await postImport(JSON.stringify({ source: data3 }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.state.inventory.counts.userFiles, 0);
  assert.ok(!body.state.inventory.warnings.some(w => w.includes('user/')), 'no false user/ escape warning');

  // (b) projects of the wrong shape is ignored with a warning
  const data4 = join(tmp, 'data4');
  mkdirSync(join(data4, 'projects'), { recursive: true });
  writeFileSync(join(data4, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: 'nope' }));
  r = await postImport(JSON.stringify({ source: data4 }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.state.inventory.projects.named, []);
  assert.ok(body.state.inventory.warnings.some(w => w.includes('projects must be an object')));

  // (c) non-array extras skips that project, others stay listed
  const data5 = join(tmp, 'data5');
  mkdirSync(join(data5, 'projects'), { recursive: true });
  writeFileSync(join(data5, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: { good: [], bad: 'x' } }));
  r = await postImport(JSON.stringify({ source: data5 }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.state.inventory.projects.named.map(p => p.name), ['good']);
  assert.ok(body.state.inventory.warnings.some(w => w.includes('"bad"') && w.includes('must be an array of strings')));

  // (d) invalid owner segment with multiple @s is rejected without any network use
  r = await postImport(JSON.stringify({ source: '@bad name@x@y', kind: 'repo' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no data repo at/);

  // (a) manifest without projects -> warning, named [], contextFiles still listed
  const data6 = join(tmp, 'data6');
  mkdirSync(join(data6, 'projects'), { recursive: true });
  writeFileSync(join(data6, 'projects', 'projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'] }));
  r = await postImport(JSON.stringify({ source: data6 }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.state.inventory.projects.named, []);
  assert.deepEqual(body.state.inventory.projects.contextFiles, ['AGENTS.md']);
  assert.ok(body.state.inventory.warnings.some(w => w.includes('projects must be an object')));

  // (b) adding a context file shows up as a '@context/'-prefixed addition
  const data7 = join(tmp, 'data7');
  mkdirSync(join(data7, 'projects'), { recursive: true });
  writeFileSync(join(data7, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: { alpha: [] } }));
  r = await postImport(JSON.stringify({ source: data7 }));
  assert.equal(r.status, 200);
  writeFileSync(join(data7, 'projects', 'projects.json'), JSON.stringify({ contextFiles: ['new.md'], projects: { alpha: [] } }));
  r = await postImport(JSON.stringify({ source: data7 }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.ok(body.state.changes.projects.added.includes('@context/new.md'));

  // (c) adding a skill marks Skills, not User layer (record-based user changes)
  r = await postImport(JSON.stringify({ source: data })); // baseline with the current skills
  assert.equal(r.status, 200);
  mkdirSync(join(data, 'user', 'omp', 'agent', 'skills', 'extra'), { recursive: true });
  writeFileSync(join(data, 'user', 'omp', 'agent', 'skills', 'extra', 'SKILL.md'), '---\ndescription: extra skill\n---\n');
  r = await postImport(JSON.stringify({ source: data }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.state.changes.skills.added, ['extra']);
  assert.deepEqual(body.state.changes.user, { added: [], removed: [], updated: [] });

  // Drift detection: snapshot vs live comparison. liveRoot is dirname(data8) = tmp, so live alpha = tmp/alpha.
  // status 'unknown' (repo/temp import) is not reachable hermetically: that path needs a git clone.
  const data8 = join(tmp, 'data8');
  mkdirSync(join(data8, 'projects', 'alpha', 'notes'), { recursive: true });
  writeFileSync(join(data8, 'projects', 'projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { alpha: ['notes/ideas.md'] } }));
  writeFileSync(join(data8, 'projects', 'alpha', 'AGENTS.md'), 'snapshot agents\n');
  writeFileSync(join(data8, 'projects', 'alpha', 'extra.md'), 'snapshot extra\n');
  mkdirSync(join(tmp, 'alpha', 'notes'), { recursive: true });
  writeFileSync(join(tmp, 'alpha', 'AGENTS.md'), 'live agents\n');
  writeFileSync(join(tmp, 'alpha', 'notes', 'ideas.md'), 'live idea\n');
  r = await postImport(JSON.stringify({ source: data8 }));
  assert.equal(r.status, 200);
  body = await r.json();
  const drift = body.state.inventory.projects.named.find(p => p.name === 'alpha');
  assert.equal(drift.name, 'alpha');
  assert.equal(drift.live, 'checked');
  assert.equal(drift.files, 2);
  const byPath = Object.fromEntries(drift.entries.map(e => [e.path, e]));
  assert.deepEqual(drift.entries.map(e => e.path), ['AGENTS.md', 'extra.md', 'notes/ideas.md']); // sorted
  assert.equal(byPath['AGENTS.md'].status, 'changed');
  assert.equal(byPath['AGENTS.md'].bytes, Buffer.byteLength('snapshot agents\n'));
  assert.equal(byPath['extra.md'].status, 'missing');
  assert.equal(byPath['notes/ideas.md'].status, 'uncaptured');
  assert.equal(byPath['notes/ideas.md'].bytes, Buffer.byteLength('live idea\n'));

  writeFileSync(join(tmp, 'alpha', 'AGENTS.md'), 'snapshot agents\n');
  r = await postImport(JSON.stringify({ source: data8 }));
  assert.equal(Object.fromEntries((await r.json()).state.inventory.projects.named.find(p => p.name === 'alpha').entries.map(e => [e.path, e]))['AGENTS.md'].status, 'sync');
  writeFileSync(join(tmp, 'alpha', 'AGENTS.md'), 'snapshot agents\r\n'); // CRLF-normalized comparison
  r = await postImport(JSON.stringify({ source: data8 }));
  assert.equal(Object.fromEntries((await r.json()).state.inventory.projects.named.find(p => p.name === 'alpha').entries.map(e => [e.path, e]))['AGENTS.md'].status, 'sync');

  rmSync(join(tmp, 'alpha'), { recursive: true, force: true }); // this test's own fixture under tmp
  r = await postImport(JSON.stringify({ source: data8 }));
  body = await r.json();
  const gone = body.state.inventory.projects.named.find(p => p.name === 'alpha');
  assert.equal(gone.live, 'gone');
  assert.ok(gone.entries.every(e => e.status === 'missing'));

  // extras traversal: an unsafe manifest path is rejected, its content never served
  const manifest8 = join(data8, 'projects', 'projects.json');
  const manifest8Original = readFileSync(manifest8, 'utf8');
  writeFileSync(manifest8, JSON.stringify({ contextFiles: [], projects: { alpha: ['../escape.txt'] } }));
  writeFileSync(join(tmp, 'escape.txt'), 'secret\n');
  mkdirSync(join(tmp, 'alpha'), { recursive: true }); // live dir back so the uncaptured pass runs
  r = await postImport(JSON.stringify({ source: data8 }));
  assert.equal(r.status, 200);
  const escapeBody = await r.json();
  assert.ok(!JSON.stringify(escapeBody).includes('secret'), 'no escaped file contents in responses');
  assert.ok(escapeBody.state.inventory.warnings.some(w => w.includes('rejected unsafe snapshot path "../escape.txt"')));
  writeFileSync(manifest8, manifest8Original);

  // POST /api/import persists the state file: re-import the fixture and check the persisted rules
  r = await postImport(JSON.stringify({ source: data }));
  assert.equal(r.status, 200);
  assert.ok(persisted().inventory.rules.some(x => x.name === 'demo-rule.md'), 'POST /api/import persisted state');

  // 7b. Dashboard settings + GitHub remote check. Earlier /config tests set a provision token; clear it
  // so the dashboard settings start from the documented defaults.
  r = await postJson('/api/settings', { token: '' });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body, { tokenSet: false, autoUpdate: false });
  r = await get('/api/settings');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { tokenSet: false, autoUpdate: false });

  // Settings write: token is stored on disk (0600) but never echoed back in any response.
  const ghToken = 'alate-gh-token-3f9a';
  r = await postJson('/api/settings', { token: ghToken });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { tokenSet: true, autoUpdate: false });
  assert.ok(!(JSON.stringify(await (await get('/api/settings')).json())).includes(ghToken), 'GET /api/settings never echoes the token');
  assert.ok(!JSON.stringify(await (await get('/api/state')).json()).includes(ghToken), 'GET /api/state never echoes the token');
  assert.ok(readFileSync(config, 'utf8').includes(ghToken), 'token persisted to server-config.json');
  r = await postJson('/api/settings', { token: 42 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid token');
  r = await postJson('/api/settings', { autoUpdate: 'yes' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid autoUpdate');

  // Repo import via the GitHub fixture: captures the cloned HEAD as importedSha.
  r = await postImport(JSON.stringify({ source: 'https://github.com/demo/data', kind: 'repo' }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.state.source.kind, 'repo');
  assert.equal(body.state.source.importedSha, sha1);
  assert.equal((await (await get('/config')).json()).repo, 'https://github.com/demo/data');
  await waitFor(async () => {
    const s = await (await get('/api/state')).json();
    return s.update != null && s.update.checkedAt !== null;
  }, 10_000);
  const state3 = await (await get('/api/state')).json();
  assert.equal(state3.update.available, false);
  assert.equal(state3.update.remoteSha, sha1);
  assert.equal(persisted().source.importedSha, sha1, 'importedSha persisted');
  r = await postJson('/provision', {}, true);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, false, 'a repo with invalid rules cannot provision');

  // A new commit on the remote flips update.available within one --interval tick.
  git(['-C', ghData, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'second']);
  const sha2 = ghSha();
  await waitFor(async () => {
    const s = await (await get('/api/state')).json();
    return s.update?.available === true && s.update.remoteSha === sha2;
  }, 10_000);
  assert.equal((await (await get('/health')).json()).update.behind, false, 'a failed provision does not establish a baseline');

  // Auto-update opt-in: the next tick after a remote commit re-imports from the new HEAD.
  r = await postJson('/api/settings', { autoUpdate: true });
  assert.equal(r.status, 200);
  git(['-C', ghData, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'third']);
  const sha3 = ghSha();
  await waitFor(async () => {
    const s = await (await get('/api/state')).json();
    return s.source.importedSha === sha3 && s.update.available === false;
  }, 10_000);

  // Failed repo import: client-safe 400, and git output is redacted of the stored token.
  r = await postImport(JSON.stringify({ source: 'demo/missing', kind: 'repo' }));
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(await r.json()).includes(ghToken), 'clone failure never echoes the stored token');
  assert.equal(persisted().source.importedSha, sha3, 'failed clone preserves the previous snapshot');

  // Path import: the update block is cleared (no remote to check).
  r = await postImport(JSON.stringify({ source: data }));
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.state.update, null);

  // SQLite remains authoritative when the source is offline and the JSON config is stale.
  await new Promise(resolve => { child.once('close', resolve); child.kill(); });
  renameSync(data, join(tmp, 'data-offline'));
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), repo: origin, path: null }));
  child = spawn(process.execPath, [join(repoRoot, 'server.ts'), '--port', '0', '--config', config, '--db', stateFile], { cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      const line = /alate server on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(buf);
      if (line) resolve(line[1]);
    });
    child.once('exit', code => reject(new Error(`cached server exited early (${code})`)));
    setTimeout(() => reject(new Error('cached server did not start')), 10_000).unref();
  });
  assert.equal((await (await get('/api/state')).json()).source.spec, data);
  assert.deepEqual(await (await get('/config')).json(), { repo: null, path: data, tokenSet: true });
  assert.deepEqual(readdirSync(serverTmp).filter(name => /^alate-(?:dashboard|snapshot)-/.test(name)), [], 'imports and provisions remove temporary repository bytes');

  // 78. Upstream update checker: fake GitHub and npm (no real network), contract
  // endpoints, G21 age gate, skill head-only rule, Dockerfile pin parsing, auth, pending.
  const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString();
  const plusDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString();
  // Fixed instants shared by the fake and the assertions (fresh calls would drift by ms).
  const T = {
    rel30: daysAgo(30), rel2: daysAgo(2), rc1: daysAgo(1), npm90: daysAgo(90), npm20: daysAgo(20),
    npm1: daysAgo(1), ctx60: daysAgo(60), ctx10: daysAgo(10), ctx3: daysAgo(3), node10: daysAgo(10),
    node4: daysAgo(4), node1: daysAgo(1), node30: daysAgo(30), node40: daysAgo(40),
    stale10: daysAgo(10), fresh2: daysAgo(2), cur10: daysAgo(10), cav9: daysAgo(9), seen8: daysAgo(8),
  };
  const SHA = {
    staleHead: 'head0000000000000000000000000000000000000000', freshHead: 'head1111111111111111111111111111111111111111',
    curHead: 'head2222222222222222222222222222222222222222', gitPlugHead: 'deadbeef9999999999999999999999999999999999',
    staleLock: 'tree1111111111111111111111111111111111111111', staleTree: 'tree2222222222222222222222222222222222222222',
    curTree: 'tree3333333333333333333333333333333333333333', freshTree: 'tree4444444444444444444444444444444444444444',
    freshLock: 'tree5555555555555555555555555555555555555555', gapHead: 'gapfeed000000000000000000000000000000000000',
    goneHead: 'head3333333333333333333333333333333333333333', goneLock: 'tree6666666666666666666666666666666666666666',
  };
  const b64 = s => Buffer.from(s).toString('base64');
  let relFails = false;
  const authSeen = [];
  const fakeUp = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const reply = (code, body2) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body2)); };
    const prefix = url.pathname.split('/')[1];
    authSeen.push({ prefix, authorization: req.headers.authorization ?? null });
    if (prefix === 'gh') {
      if (url.pathname === '/gh/repos/fake/rel/releases') {
        if (relFails) return reply(500, { message: 'boom' });
        return reply(200, [
          { tag_name: 'v2.0.0-rel', draft: false, prerelease: false, published_at: T.rel30, html_url: 'https://github.com/fake/rel/releases/v2.0.0' },
          { tag_name: 'v1.9.0-rel', draft: false, prerelease: false, published_at: T.rel2, html_url: 'https://github.com/fake/rel/releases/v1.9.0' },
          { tag_name: 'v3.0.0-rc1', draft: false, prerelease: true, published_at: T.rc1, html_url: 'https://github.com/fake/rel/releases/v3.0.0-rc1' },
          { tag_name: 'v4.0.0-rel', draft: true, prerelease: false, published_at: T.rc1, html_url: 'https://github.com/fake/rel/releases/v4.0.0' },
        ]);
      }
      if (url.pathname === '/gh/repos/demo/private/contents/Dockerfile.worker')
        return reply(200, { content: b64('FROM ghcr.io/fake/image:9.9.9\nARG DEMO_IMAGE=ghcr.io/fake/image:1.2.2-debian\n'), encoding: 'base64' });
      if (url.pathname === '/gh/repos/fake/skills/commits') {
        const p = url.searchParams.get('path');
        const head = p === 'skills/x/stale-skill' ? SHA.staleHead : p === 'skills/x/fresh-skill' ? SHA.freshHead : p === 'skills/x/gone-skill' ? SHA.goneHead : SHA.curHead;
        const when = p === 'skills/x/stale-skill' ? T.stale10 : p === 'skills/x/fresh-skill' ? T.fresh2 : p === 'skills/x/gone-skill' ? T.fresh2 : T.cur10;
        return reply(200, [{ sha: head, commit: { committer: { date: when } }, html_url: `https://github.com/fake/skills/commit/${head}` }]);
      }
      // No stable releases for the skills repo: the rows keep the SHA behavior.
      if (url.pathname === '/gh/repos/fake/skills/releases') return reply(200, []);
      if (url.pathname === '/gh/repos/fake/skills/git/trees/HEAD')
        return reply(200, { tree: [
          { path: 'skills/x/stale-skill', type: 'tree', sha: SHA.staleTree },
          { path: 'skills/x/current-skill', type: 'tree', sha: SHA.curTree },
          { path: 'skills/x/fresh-skill', type: 'tree', sha: SHA.freshTree },
        ] });
      if (url.pathname === '/gh/repos/JuliusBrussee/caveman/commits')
        return reply(200, [{ sha: SHA.gitPlugHead, commit: { committer: { date: T.cav9 } }, html_url: `https://github.com/JuliusBrussee/caveman/commit/${SHA.gitPlugHead}` }]);
      if (url.pathname === '/gh/repos/fake/gap/commits')
        return reply(200, [{ sha: SHA.gapHead, commit: { committer: { date: T.node40 } }, html_url: `https://github.com/fake/gap/commit/${SHA.gapHead}` }]);
      return reply(404, { message: 'no such gh fixture' });
    }
    if (url.pathname === '/npm/fake-demo-pkg')
      return reply(200, { time: { created: T.npm90, modified: T.npm1, '2.3.3': T.npm90, '3.0.0': T.npm20, '3.1.0-beta': T.npm20, '2.9.0': T.npm1 }, versions: {} });
    if (url.pathname === '/npm/context-mode')
      return reply(200, { time: { '1.0.9': T.ctx60, '1.1.0': T.ctx10, '2.0.0-alpha': T.ctx3 }, versions: {} });
    if (url.pathname === '/npm/@xynogen/pix-optimizer')
      return reply(200, { time: { '1.2.0': T.ctx60, '1.3.0': T.ctx10 }, versions: {} });
    if (url.pathname === '/npm/@xynogen/pix-skills')
      return reply(200, { time: { '0.8.5': T.npm20 }, versions: {} });
    if (url.pathname === '/npm/chrome-devtools-mcp')
      return reply(200, { time: { '1.10.1': T.npm90, '1.11.0': T.npm20 }, versions: {} });
    if (url.pathname === '/dist/index.json')
      return reply(200, [
        { version: 'v22.20.0', date: T.node10 }, { version: 'v22.19.0-rc.1', date: T.node4 },
        { version: 'v22.9.0', date: T.node1 }, { version: 'v23.0.0', date: T.node30 }, { version: 'v21.9.0', date: T.node40 },
      ]);
    if (url.pathname === '/cft/last-known-good-versions.json')
      return reply(200, { channels: { Stable: { channel: 'Stable', version: '154.0.8037.92' } } });
    reply(404, { message: 'no such fixture' });
  });
  await new Promise(resolve => fakeUp.listen(0, '127.0.0.1', resolve));
  const upBase = `http://127.0.0.1:${fakeUp.address().port}`;
  try {
    // The checker fixture: a data repo with upstreams.json, a skill lock and a bun.lock,
    // served as a git remote through the same file:// GH fixture the imports use.
    const upRepo = join(tmp, 'gh', 'demo', 'updates');
    mkdirSync(join(upRepo, 'user', 'agents'), { recursive: true });
    mkdirSync(join(upRepo, 'user', 'omp', 'plugins'), { recursive: true });
    writeFileSync(join(upRepo, 'rel-rule.md'), '---\ndescription: rel rule\n---\nbody\n');
    writeFileSync(join(upRepo, 'Dockerfile'), 'ARG OTHER_KEY=1\nFROM --platform=linux/amd64 fake/base:1.0.0 AS build\nFROM ghcr.io/fake/other:2.3.3-alpine\n');
    writeFileSync(join(upRepo, 'upstreams.json'), JSON.stringify({ _doc: 'x', own: [], items: [
      { name: 'rel-demo', kind: 'rule-set', origin: 'https://github.com/fake/rel', check: { type: 'github-release', tagPrefix: 'v', tagSuffix: '-rel' }, version: '1.5.0', paths: ['rel-rule.md'] },
      { name: 'pin-demo', kind: 'image-pin', origin: 'https://github.com/fake/image', pin: { repo: 'demo/private', file: 'Dockerfile.worker', key: 'DEMO_IMAGE' } },
      { name: 'from-demo', kind: 'image-pin', origin: 'https://github.com/fake/other', pin: { repo: 'demo/updates', file: 'Dockerfile', key: 'ghcr.io/fake/other' }, check: { type: 'npm', package: 'fake-demo-pkg' } },
      { name: 'mcp-demo', kind: 'mcp', origin: 'https://github.com/fake/mcp', check: { type: 'npm', package: 'chrome-devtools-mcp' }, pin: { repo: 'demo/updates', file: 'user/omp/agent/mcp.json', key: 'chrome-devtools-mcp@' } },
      { name: 'miss-demo', kind: 'image-pin', origin: 'https://github.com/fake/miss', pin: { repo: 'demo/updates', file: 'Dockerfile', key: 'MISSING_PIN' } },
      { name: 'gap-demo', kind: 'skill', origin: 'https://github.com/fake/gap', check: { type: 'github-path', branch: 'main' } },
      { name: 'node-demo', kind: 'mcp', origin: 'https://github.com/fake/node-mcp', version: '22.1.0', check: { type: 'node-dist', major: 22 } },
      { name: 'cft-demo', kind: 'image-pin', origin: 'https://github.com/fake/chrome', version: '150.0.0.0', check: { type: 'chrome-for-testing', channel: 'Stable' } },
      { name: 'managed-demo', kind: 'rule-set', origin: 'https://github.com/fake/managed', version: '0.0.1', managedBy: 'alate sync', paths: [] },
      { name: 'stale-skill', kind: 'skill', origin: 'https://github.com/fake/skills' },
    ] }));
    writeFileSync(join(upRepo, 'user', 'agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: {
      'stale-skill': { sourceUrl: 'https://github.com/fake/skills.git', skillPath: 'skills/x/stale-skill/SKILL.md', skillFolderHash: SHA.staleLock },
      'current-skill': { sourceUrl: 'https://github.com/fake/skills.git', skillPath: 'skills/x/current-skill/SKILL.md', skillFolderHash: SHA.curTree },
      'fresh-skill': { sourceUrl: 'https://github.com/fake/skills.git', skillPath: 'skills/x/fresh-skill/SKILL.md', skillFolderHash: SHA.freshLock },
      'gone-skill': { sourceUrl: 'https://github.com/fake/skills.git', skillPath: 'skills/x/gone-skill/SKILL.md', skillFolderHash: SHA.goneLock },
    } }));
    // Real bun.lock is JSONC: comments and trailing commas.
    writeFileSync(join(upRepo, 'user', 'omp', 'plugins', 'bun.lock'), `{
  // bun lock fixture: comments and trailing commas are legal JSONC
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "omp-plugins", "dependencies": {
    "context-mode": "^1.0.5",
    "caveman-installer": "github:JuliusBrussee/caveman",
    "@xynogen/pix-optimizer": "npm:@xynogen/pix-optimizer",
    "@xynogen/pix-skills": "npm:@xynogen/pix-skills@^0.8",
    "gitpin": "git+https://github.com/fake/gitpin.git",
  } } },
  "packages": {
    "context-mode": ["context-mode@1.0.9", "", {}],
    "caveman-installer": ["caveman-installer@github:JuliusBrussee/caveman#cafebabe", "", {}],
    "@xynogen/pix-optimizer": ["@xynogen/pix-optimizer@1.2.0", "", {}],
    "@xynogen/pix-skills": ["@xynogen/pix-skills@0.8.5", "", {}],
    "gitpin": ["gitpin@git+https://github.com/fake/gitpin.git#beefcafe", "", {}],
  },
}
`);
    writeFileSync(join(upRepo, 'user', 'omp', 'plugins', 'package.json'), JSON.stringify({ dependencies: { 'context-mode': '^1.0.5', 'caveman-installer': 'github:JuliusBrussee/caveman', '@xynogen/pix-optimizer': 'npm:@xynogen/pix-optimizer', '@xynogen/pix-skills': 'npm:@xynogen/pix-skills@^0.8' } }));
    // The real mcp.json shape: the pinned version rides an npx args token.
    mkdirSync(join(upRepo, 'user', 'omp', 'agent'), { recursive: true });
    writeFileSync(join(upRepo, 'user', 'omp', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { 'chrome-devtools-mcp': { command: 'cmd', args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@1.10.1', '--no-usage-statistics'] } } }));
    assert.equal(git(['init', upRepo]).status, 0);
    assert.equal(git(['-C', upRepo, 'add', '-A']).status, 0);
    assert.equal(git(['-C', upRepo, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'updates fixture']).status, 0);

    // A dedicated server: fresh db and config, one-second checker ticks, upstream bases at the fake.
    await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    const tmpBin = join(tmp, 'bin');
    mkdirSync(tmpBin, { recursive: true });
    writeFileSync(join(tmpBin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // offline stand-in so provisioning never installs real plugins
    if (process.platform === 'win32' && spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0) {
      // Windows cannot resolve the extension-less shim: a real bun on PATH would install
      // plugins for real. Compile a no-op bun.exe from bun itself (offline) to keep the stand-in.
      writeFileSync(join(tmpBin, 'exit0.js'), 'process.exit(0)\n');
      const compiled = spawnSync('bun', ['build', '--compile', join(tmpBin, 'exit0.js'), '--outfile', join(tmpBin, 'bun.exe')], { encoding: 'utf8' });
      assert.equal(compiled.status, 0, `bun.exe stand-in compile failed: ${compiled.stderr}`);
    }
    const upConfig = join(tmp, 'server-config-updates.json');
    const upDb = join(tmp, 'state-updates.db');
    child = spawn(process.execPath, [join(repoRoot, 'server.ts'), '--port', '0', '--config', upConfig, '--db', upDb, '--update-interval', '1'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...serverEnv, PATH: `${tmpBin}${delimiter}${serverEnv.PATH ?? ''}`,
        ALATE_TEST_GITHUB_API_BASE: `${upBase}/gh`, ALATE_TEST_NPM_BASE: `${upBase}/npm`,
        ALATE_TEST_NODE_DIST_BASE: `${upBase}/dist`, ALATE_TEST_CFT_BASE: `${upBase}/cft`,
      },
    });
    let apiKeyUp = '';
    base = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', chunk => {
        buf += chunk;
        const k = /alate API key: (\S+)\n/.exec(buf);
        const l = /alate server on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(buf);
        if (k) apiKeyUp = k[1];
        if (k && l) resolve(l[1]);
      });
      child.once('exit', code => reject(new Error(`updates server exited early (${code})`)));
      setTimeout(() => reject(new Error(`updates server did not start; got: ${buf}`)), 10_000).unref();
    });
    apiKey = apiKeyUp; // the shared get/postJson helpers follow the active instance
    const authed = path => fetch(new URL(path, base), { headers: { Authorization: `Bearer ${apiKey}` } });

    // Contract: /api/updates is Bearer-only, empty before any snapshot, /health pending false.
    assert.equal((await get('/api/updates', false)).status, 401, 'updates need the bearer key');
    assert.equal((await fetch(new URL('/api/updates', base), { headers: { Authorization: 'Bearer wrong-key' } })).status, 401);
    assert.equal((await post('/api/updates', '')).status, 405, 'known route refuses other methods');
    assert.deepEqual(await (await authed('/api/updates')).json(), { checkedAt: null, updates: [] });
    let health = await (await get('/health')).json();
    assert.equal(health.pending, false, 'nothing imported, nothing pending');

    // Store the GitHub key, import the checker fixture as a repo source, wait for all rows.
    assert.equal((await postJson('/api/settings', { token: 'updates-gh-token-3f9' })).status, 200);
    r = await postImport(JSON.stringify({ source: 'https://github.com/demo/updates.git', kind: 'repo' }));
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    await waitFor(async () => (await (await authed('/api/updates')).json()).updates.length === 17, 20_000);
    const rows = Object.fromEntries((await (await authed('/api/updates')).json()).updates.map(u => [u.name, u]));

    // github-release: tag prefix/suffix stripped, drafts and prereleases skipped, age gate on published_at.
    const rel = rows['rel-demo'];
    assert.equal(rel.current, '1.5.0');
    assert.equal(rel.latest, '2.0.0', 'drafts and prereleases never become latest');
    assert.equal(rel.target, '2.0.0', 'the fresh v1.9.0 does not qualify yet');
    assert.equal(rel.publishedAt, T.rel30, JSON.stringify(rel));
    assert.equal(rel.qualifiesAt, plusDays(T.rel30, 7));
    assert.equal(rel.notesUrl, 'https://github.com/fake/rel/releases/v2.0.0');
    assert.equal(rel.id, 'rel-demo@2.0.0');
    assert.equal(rel.repo, null);
    assert.deepEqual(rel.pin, null);
    assert.equal(rel.error ?? null, null);

    // A pin in another repo is read through the contents API: ARG wins over FROM, suffix stripped.
    const pin = rows['pin-demo'];
    assert.equal(pin.current, '1.2.2');
    assert.equal(pin.repo, 'demo/private');
    assert.deepEqual(pin.pin, { file: 'Dockerfile.worker', key: 'DEMO_IMAGE' });
    assert.equal(pin.latest, null);
    assert.equal(pin.target, null);
    assert.equal(pin.id, 'pin-demo@latest');

    // A data-repo pin read from the snapshot: the key names the image, so the decoy first
    // FROM stays out; the npm check runs on check.package (stable only).
    const from = rows['from-demo'];
    assert.equal(from.current, '2.3.3', 'FROM tag with the -alpine suffix stripped');
    assert.equal(from.repo, 'demo/updates', 'data-repo pins report the configured data repo');
    assert.equal(from.latest, '3.0.0', '3.1.0-beta is not stable');
    assert.equal(from.target, '3.0.0', '2.9.0 is too fresh to qualify');
    assert.equal(from.publishedAt, T.npm20);

    // A pin key that matches nothing in the file is an error row, never a false update.
    const miss = rows['miss-demo'];
    assert.match(miss.error ?? '', /pin MISSING_PIN not found in Dockerfile/);
    assert.equal(miss.current, null);
    assert.equal(miss.latest, null);
    assert.equal(miss.target, null);

    // An `@`-prefix key reads the version from a `<package>@<version>` token (mcp.json args).
    const mcp = rows['mcp-demo'];
    assert.equal(mcp.current, '1.10.1', 'the pinned version, not a false update');
    assert.equal(mcp.latest, '1.11.0');
    assert.equal(mcp.target, '1.11.0');
    assert.deepEqual(mcp.pin, { file: 'user/omp/agent/mcp.json', key: 'chrome-devtools-mcp@' });

    // No pin and no lock entry: the check still runs with an unknown current.
    const gap = rows['gap-demo'];
    assert.equal(gap.current, null);
    assert.equal(gap.latest, SHA.gapHead);
    assert.equal(gap.target, SHA.gapHead, 'a week-old head qualifies without a pin');

    // node-dist within the configured major only.
    const node = rows['node-demo'];
    assert.equal(node.current, '22.1.0');
    assert.equal(node.latest, '22.20.0', 'other majors and rc builds stay out');
    assert.equal(node.target, '22.20.0');
    assert.equal(node.publishedAt, T.node10);

    // chrome-for-testing has no publish time: the first-seen moment gates the target.
    const cft = rows['cft-demo'];
    assert.equal(cft.latest, '154.0.8037.92');
    assert.equal(cft.target, null, 'first seen moments ago, not qualified yet');
    assert.ok(Math.abs(Date.parse(cft.publishedAt) - Date.now()) < 60_000);
    assert.equal(cft.qualifiesAt, plusDays(cft.publishedAt, 7));

    // managedBy rows are recorded, never targeted.
    const managed = rows['managed-demo'];
    assert.equal(managed.managedBy, 'alate sync');
    assert.equal(managed.target, null);
    assert.equal(managed.latest, null);

    // Skills: tree-hash compare decides outdated, the head commit qualifies only when a week old.
    const stale = rows['stale-skill'];
    assert.equal(stale.current, SHA.staleLock);
    assert.equal(stale.latest, SHA.staleHead);
    assert.equal(stale.target, SHA.staleHead, 'a week-old head qualifies');
    assert.equal(stale.repo, 'demo/updates');
    assert.deepEqual(stale.pin, { file: 'user/agents/.skill-lock.json', key: 'stale-skill' });
    assert.equal(stale.origin, 'https://github.com/fake/skills', 'origin merges from the upstreams item');
    assert.equal(stale.publishedAt, T.stale10);
    const fresh = rows['fresh-skill'];
    assert.equal(fresh.latest, SHA.freshHead);
    assert.equal(fresh.target, null, 'the skills CLI clones a branch, so a fresh head never qualifies');
    assert.equal(fresh.current, SHA.freshLock, 'a mismatched tree keeps the tree sha');
    assert.notEqual(fresh.current, fresh.latest, 'a stale tree never reads as current');
    const cur = rows['current-skill'];
    assert.equal(cur.target, null, 'a lock hash equal to the head tree is up to date');
    assert.equal(cur.latest, SHA.curHead);
    assert.equal(cur.current, SHA.curHead, 'current equals latest when the installed tree equals the head tree');
    // A skill deleted upstream is a notification row, never an update: no age gate on the news.
    const gone = rows['gone-skill'];
    assert.equal(gone.removed, true);
    assert.equal(gone.target, null);
    assert.equal(gone.current, SHA.goneLock);
    assert.equal(gone.latest, SHA.goneHead);
    assert.equal(gone.error ?? null, null);
    assert.equal(gone.id, `gone-skill@${SHA.goneHead}`);

    // Plugins from bun.lock: npm packages get the registry check, git ones the repo-root check.
    const ctx = rows['context-mode'];
    assert.deepEqual(ctx.pin, { file: 'user/omp/plugins/bun.lock', key: 'context-mode' });
    assert.equal(ctx.current, '1.0.9');
    assert.equal(ctx.latest, '1.1.0', '2.0.0-alpha is not stable');
    assert.equal(ctx.target, '1.1.0');
    const cav = rows['caveman-installer'];
    assert.equal(cav.current, 'cafebabe', 'the locked short commit');
    assert.equal(cav.latest, SHA.gitPlugHead);
    assert.equal(cav.target, SHA.gitPlugHead, 'a week-old head commit qualifies');
    assert.equal(cav.origin, 'https://github.com/JuliusBrussee/caveman');
    assert.equal(cav.id, `caveman-installer@${SHA.gitPlugHead}`);

    // npm: specs are npm checks on the named package, locked version as current.
    const pix = rows['@xynogen/pix-optimizer'];
    assert.equal(pix.current, '1.2.0');
    assert.equal(pix.latest, '1.3.0');
    assert.equal(pix.target, '1.3.0');
    assert.deepEqual(pix.pin, { file: 'user/omp/plugins/bun.lock', key: '@xynogen/pix-optimizer' });
    const pix2 = rows['@xynogen/pix-skills'];
    assert.equal(pix2.current, '0.8.5', 'the range in npm:<package>@<range> is ignored');
    assert.equal(pix2.latest, '0.8.5');
    assert.equal(pix2.target, null);

    // The dashboard payload carries the same rows on /api/state.
    const state = await (await get('/api/state')).json();
    assert.equal(state.updates.updates.length, 17);
    assert.equal(typeof state.updates.checkedAt, 'string');

    // The stored GitHub key goes to GitHub endpoints only, never to npm, node or cft.
    const ghAuth = authSeen.filter(a => a.prefix === 'gh' && a.authorization);
    assert.ok(ghAuth.length > 0, 'the checker authenticated against GitHub');
    assert.ok(ghAuth.every(a => a.authorization === 'Bearer updates-gh-token-3f9'));
    assert.deepEqual(authSeen.filter(a => a.prefix !== 'gh' && a.authorization), [], 'the GitHub key never travels to npm, node or cft');

    // Backdate the first-seen record: the cft version now clears the age gate.
    {
      const seen = new DatabaseSync(upDb);
      seen.prepare("UPDATE update_seen SET seenAt = ? WHERE key LIKE 'item:cft-demo|%'").run(T.seen8);
      seen.close();
    }
    r = await postImport(JSON.stringify({ source: 'https://github.com/demo/updates.git' }));
    assert.equal(r.status, 200);
    await waitFor(async () => (await (await authed('/api/updates')).json()).updates.find(u => u.name === 'cft-demo')?.target === '154.0.8037.92', 20_000);
    const cft2 = (await (await authed('/api/updates')).json()).updates.find(u => u.name === 'cft-demo');
    assert.equal(cft2.publishedAt, T.seen8);
    assert.equal(cft2.qualifiesAt, plusDays(T.seen8, 7));

    // A failed check keeps the last result and records the error for the dashboard.
    relFails = true;
    r = await postImport(JSON.stringify({ source: 'https://github.com/demo/updates.git' }));
    assert.equal(r.status, 200);
    await waitFor(async () => {
      const u = (await (await authed('/api/updates')).json()).updates.find(x => x.name === 'rel-demo');
      return u && /HTTP 500/.test(u.error ?? '');
    }, 20_000);
    const rel2 = (await (await authed('/api/updates')).json()).updates.find(u => u.name === 'rel-demo');
    assert.equal(rel2.latest, '2.0.0', 'a failed check keeps the last result');
    assert.equal(rel2.target, '2.0.0');
    assert.ok(rel2.checkedAt > rel.checkedAt, 'the carried row reports the fresh checkedAt');
    relFails = false;

    // pending: an imported snapshot that never provisioned is pending until provision records its HEAD.
    health = await (await get('/health')).json();
    assert.equal(health.pending, true, 'imported but never provisioned');
    assert.equal(health.update.behind, false);
    r = await postJson('/provision', {}, true);
    assert.equal(r.status, 200);
    const prov = await r.json();
    assert.equal(prov.ok, true, JSON.stringify(prov.results?.map(x => [x.script, x.code, x.output.slice(-400)])));
    health = await (await get('/health')).json();
    assert.equal(health.pending, false, 'provisioning records the stored snapshot commit');
    assert.equal(health.update.behind, false);
  } finally {
    await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    await new Promise(resolve => fakeUp.close(resolve));
  }

  // 8. File editor API: snapshot reads; edits that commit and push; conflicts; path safety.
  // A dedicated server instance keeps this section off the earlier state file.
  const editSeed = join(tmp, 'edit-seed');
  const editDir = join(tmp, 'edit-dir');
  const editBare = join(tmp, 'gh', 'demo', 'editdata.git');
  mkdirSync(editSeed, { recursive: true });
  writeFileSync(join(editSeed, 'notes.md'), 'seed notes\n');
  writeFileSync(join(editSeed, 'keep.md'), 'keep\n');
  writeFileSync(join(editSeed, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62])); // NUL byte: binary
  writeFileSync(join(editSeed, 'bad.dat'), Buffer.from([0x61, 0xff, 0x62])); // invalid UTF-8: binary
  assert.equal(git(['init', '-q', '-b', 'main', editSeed]).status, 0);
  git(['-C', editSeed, 'config', 'user.name', 't']);
  git(['-C', editSeed, 'config', 'user.email', 't@t']);
  assert.equal(git(['-C', editSeed, 'add', '-A']).status, 0);
  assert.equal(git(['-C', editSeed, 'commit', '-qm', 'seed']).status, 0);
  assert.equal(git(['init', '-q', '--bare', '-b', 'main', editBare]).status, 0);
  assert.equal(git(['-C', editSeed, 'push', '-q', editBare, 'main']).status, 0);
  assert.equal(git(['clone', '-q', editBare, editDir]).status, 0);
  git(['-C', editDir, 'config', 'user.name', 't']);
  git(['-C', editDir, 'config', 'user.email', 't@t']);
  // A second repo whose main branch carries tag v1: pushing HEAD:v1 can never fast-forward.
  const tagRepo = join(tmp, 'gh', 'demo', 'tagged');
  mkdirSync(tagRepo, { recursive: true });
  writeFileSync(join(tagRepo, 'keep.md'), 'tag seed\n');
  assert.equal(git(['init', '-q', '-b', 'main', tagRepo]).status, 0);
  git(['-C', tagRepo, 'config', 'user.name', 't']);
  git(['-C', tagRepo, 'config', 'user.email', 't@t']);
  assert.equal(git(['-C', tagRepo, 'add', '-A']).status, 0);
  assert.equal(git(['-C', tagRepo, 'commit', '-qm', 'tag seed']).status, 0);
  assert.equal(git(['-C', tagRepo, 'tag', 'v1']).status, 0);
  const remoteText = path => git(['--git-dir', editBare, 'show', `main:${path}`], { encoding: 'utf8' }).stdout.replaceAll('\r\n', '\n');
  const inRemote = path => git(['--git-dir', editBare, 'cat-file', '-e', `main:${path}`]).status === 0;
  const commitSubject = () => git(['--git-dir', editBare, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).stdout.trim();

  child = spawn(process.execPath, [join(repoRoot, 'server.ts'), '--port', '0', '--config', join(tmp, 'server-config-edit.json'), '--db', join(tmp, 'state-edit.db')], { cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      const k = /alate API key: (\S+)\n/.exec(buf);
      const l = /alate server on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(buf);
      if (k) apiKey = k[1];
      if (k && l) resolve(l[1]);
    });
    child.once('exit', code => reject(new Error(`editor server exited early (${code})`)));
    setTimeout(() => reject(new Error(`editor server did not start; got: ${buf}`)), 10_000).unref();
  });
  const putJson = async b => fetch(new URL('/api/file', base), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(b) });
  const delJson = async b => fetch(new URL('/api/file', base), { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(b) });
  const persistedEdit = () => {
    const db = new DatabaseSync(join(tmp, 'state-edit.db'), { readOnly: true });
    try { return JSON.parse(db.prepare('SELECT value FROM state WHERE id = 1').get().value); }
    finally { db.close(); }
  };
  const editToken = 'alate-edit-token-7d21';
  assert.equal((await postJson('/api/settings', { token: editToken })).status, 200);

  // No source configured: edits refuse before any tree or clone is touched.
  r = await putJson({ path: 'x.md', content: 'x', base: null });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'no data source configured');
  assert.deepEqual(await (await get('/api/files')).json(), { files: [] });

  // Path source that is a git work tree pushing to a bare remote.
  r = await postImport(JSON.stringify({ source: editDir }));
  assert.equal(r.status, 200, JSON.stringify(await r.json()));

  // Reads: full listing sorted by path, one text file with its hash, binary files, 404, unsafe paths.
  r = await get('/api/files');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { files: [
    { path: 'bad.dat', bytes: 3 }, { path: 'bin.dat', bytes: 3 }, { path: 'keep.md', bytes: 5 }, { path: 'notes.md', bytes: 11 },
  ] });
  let file = await (await get('/api/file?path=notes.md')).json();
  assert.equal(file.binary, false);
  assert.equal(file.content, 'seed notes\n');
  assert.equal(file.bytes, 11);
  assert.equal(file.hash, createHash('sha256').update(file.content, 'utf8').digest('hex'), 'hash covers the stored bytes');
  file = await (await get('/api/file?path=bin.dat')).json();
  assert.deepEqual([file.binary, file.content, file.bytes], [true, null, 3]);
  file = await (await get('/api/file?path=bad.dat')).json();
  assert.deepEqual([file.binary, file.content], [true, null], 'invalid UTF-8 is binary too');
  assert.equal((await get('/api/file?path=missing.md')).status, 404);
  for (const bad of ['../escape.md', 'a\\b.md', '.git/config', '.GIT/config', 'a/./b.md', 'a//b.md', 'a/../b.md', '/notes.md', 'C:/notes.md', 'colon:name.md', 'nul\0.md', '.', '']) {
    assert.equal((await get(`/api/file?path=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  assert.ok(((await (await get('/api/file?path=.')).json()).error).includes('unsafe file path'), 'validation errors name the problem');
  assert.equal((await putJson({ path: 42, content: 'x', base: null })).status, 400, 'non-string path refuses');

  // Create with a custom message: the commit lands on disk and in the bare remote.
  r = await putJson({ path: 'docs/new.md', content: 'created\n', base: null, message: 'test: create new.md' });
  body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.match(body.commit, /^[0-9a-f]{40}$/);
  assert.equal(body.pushed, true);
  assert.equal(body.state.source.kind, 'path');
  assert.ok(body.state.updates, 'state matches GET /api/state');
  assert.equal(readFileSync(join(editDir, 'docs', 'new.md'), 'utf8'), 'created\n');
  assert.equal(remoteText('docs/new.md'), 'created\n', 'commit landed in the bare remote');
  assert.equal(commitSubject(), 'test: create new.md');
  file = await (await get('/api/file?path=docs/new.md')).json();
  assert.equal(file.content, 'created\n', 'snapshot re-imported after the edit');

  // A dot-suffixed name or dotted directory is not a .git segment; the tree's own identity commits.
  r = await putJson({ path: 'plugin.git', content: 'gitless\n', base: null });
  assert.equal(r.status, 200, JSON.stringify(await r.json()));
  r = await putJson({ path: '.github/workflow.md', content: 'wf\n', base: null });
  assert.equal(r.status, 200);
  assert.equal(git(['--git-dir', editBare, 'log', '-1', '--format=%ce'], { encoding: 'utf8' }).stdout.trim(), 't@t', 'the tree commits with its own identity');

  // The default create message says "add".
  r = await putJson({ path: 'docs/add.md', content: 'added\n', base: null });
  assert.equal(r.status, 200);
  assert.equal(commitSubject(), 'alate: add docs/add.md');

  // Exactly 500 characters is a legal message; the refusal names the limit.
  let addHash = (await (await get('/api/file?path=docs/add.md')).json()).hash;
  r = await putJson({ path: 'docs/add.md', content: 'edge\n', base: addHash, message: 'y'.repeat(500) });
  assert.equal(r.status, 200);
  r = await putJson({ path: 'docs/add.md', content: 'edge2\n', base: (await (await get('/api/file?path=docs/add.md')).json()).hash, message: 'z'.repeat(501) });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.includes('500 characters'));

  // Update with the loaded hash and the default message.
  r = await putJson({ path: 'docs/new.md', content: 'edited\n', base: file.hash });
  assert.equal(r.status, 200);
  assert.equal(commitSubject(), 'alate: edit docs/new.md');
  assert.equal(remoteText('docs/new.md'), 'edited\n');

  // An edit that changes nothing cannot commit: the failure names the git step.
  file = await (await get('/api/file?path=docs/new.md')).json();
  r = await putJson({ path: 'docs/new.md', content: 'edited\n', base: file.hash });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.includes('git commit failed'));

  // Updating a file the tree does not have is a conflict, not a crash.
  r = await putJson({ path: 'ghost.md', content: 'x\n', base: 'a'.repeat(64) });
  assert.equal(r.status, 409);
  assert.ok((await r.json()).error.includes('changed'));

  // Conflicts: a stale or null base writes nothing and commits nothing.
  file = await (await get('/api/file?path=docs/new.md')).json();
  const staleBase = file.hash;
  r = await putJson({ path: 'docs/new.md', content: 'clobber\n', base: 'f'.repeat(64) });
  assert.equal(r.status, 409);
  assert.ok((await r.json()).error.includes('changed'), 'conflict wording says "changed"');
  assert.equal(remoteText('docs/new.md'), 'edited\n', 'stale base wrote nothing');
  r = await putJson({ path: 'docs/new.md', content: 'clobber\n', base: null });
  assert.equal(r.status, 409);
  assert.ok((await r.json()).error.includes('changed'), 'create-on-existing says changed');
  r = await delJson({ path: 'docs/new.md', base: 'f'.repeat(64) });
  assert.equal(r.status, 409);
  assert.ok((await r.json()).error.includes('changed'), 'stale delete says changed');
  r = await delJson({ path: 'docs/new.md', base: null });
  assert.equal(r.status, 409, 'delete needs a loaded hash');
  assert.ok(existsSync(join(editDir, 'docs', 'new.md')), 'stale delete kept the file');
  assert.equal(commitSubject(), 'alate: edit docs/new.md', 'no new commit on conflict');

  // A path that exists as a directory refuses on both write and delete.
  r = await putJson({ path: 'docs', content: 'x', base: null });
  assert.equal(r.status, 400);
  r = await delJson({ path: 'docs', base: null });
  assert.equal(r.status, 404);

  // Delete with the loaded hash; a second delete finds nothing.
  r = await delJson({ path: 'docs/new.md', base: staleBase });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.pushed, true);
  assert.match(body.commit, /^[0-9a-f]{40}$/);
  assert.ok(!existsSync(join(editDir, 'docs', 'new.md')));
  assert.equal(inRemote('docs/new.md'), false, 'deletion reached the remote');
  assert.equal(commitSubject(), 'alate: delete docs/new.md');
  r = await delJson({ path: 'docs/new.md', base: staleBase });
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error.includes('not found'));
  // A delete that empties folders removes them, so a deleted skill's dir leaves the inventory.
  r = await putJson({ path: 'deep/a/b.md', content: 'b\n', base: null });
  assert.equal(r.status, 200);
  r = await delJson({ path: 'deep/a/b.md', base: createHash('sha256').update('b\n').digest('hex') });
  assert.equal(r.status, 200);
  assert.ok(!existsSync(join(editDir, 'deep')), 'emptied folders are gone');
  assert.ok(existsSync(editDir), 'the repo root stays');

  // Linked destinations refuse: a hardlinked twin, and a junction ancestor escaping the tree.
  const twin = join(editDir, 'twin.md');
  linkSync(join(editDir, 'keep.md'), twin);
  const twinHash = createHash('sha256').update(readFileSync(twin)).digest('hex');
  r = await delJson({ path: 'twin.md', base: twinHash });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.includes('hard links'));
  assert.ok(existsSync(twin), 'the linked twin survived');
  rmSync(twin, { force: true }); // one link removed: keep.md is writable again below
  const linkTarget = join(tmp, 'link-target');
  mkdirSync(linkTarget, { recursive: true });
  writeFileSync(join(linkTarget, 'x.md'), 'linked x\n');
  symlinkSync(linkTarget, join(editDir, 'linkdir'), 'junction');
  const xHash = createHash('sha256').update('linked x\n').digest('hex');
  r = await delJson({ path: 'linkdir/x.md', base: xHash });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.includes('outside'), 'an escaping delete names the escape');
  assert.ok(existsSync(join(linkTarget, 'x.md')), 'the junction target survived');
  rmSync(join(editDir, 'linkdir'), { recursive: true, force: true }); // the snapshot walk refuses links: drop it before the next import

  // Unsafe write paths are refused before any filesystem or git touch.
  for (const bad of ['../escape.md', 'a\\b.md', '.git/config', 'a/../b.md', '/abs.md', 'C:/abs.md', 'colon:name.md', '']) {
    assert.equal((await putJson({ path: bad, content: 'x', base: null })).status, 400, bad);
  }
  assert.ok(!existsSync(join(tmp, 'escape.md')));
  r = await putJson({ path: 'x.md', content: 'x' });
  assert.equal(r.status, 400, 'base required');
  assert.equal((await r.json()).error, 'base must be the loaded hash or null');
  r = await putJson({ path: 'x.md', content: 42, base: null });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'content must be a string');
  r = await putJson({ path: 'x.md', content: 'x', base: 7 });
  assert.equal(r.status, 400);
  r = await putJson({ path: 'x.md', content: 'x', base: null, message: 9 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid message');
  r = await putJson({ path: 'x.md', content: 'x', base: null, message: 'y'.repeat(501) });
  assert.equal(r.status, 400);
  r = await delJson({ path: 'x.md', content: 'x', base: null });
  assert.equal(r.status, 400, 'delete takes no content');
  assert.equal((await r.json()).error, 'delete takes no content');

  // A path the tree's .gitignore ignores stages nothing: the add step names the failure.
  writeFileSync(join(editDir, '.gitignore'), 'ignored.md\n');
  writeFileSync(join(editDir, 'ignored.md'), 'x\n');
  const ignoredHash = createHash('sha256').update('x\n').digest('hex');
  r = await putJson({ path: 'ignored.md', content: 'y\n', base: ignoredHash });
  const ignoredErr = await r.json();
  assert.equal(r.status, 400, JSON.stringify(ignoredErr));
  assert.ok(ignoredErr.error.includes('git add failed'), ignoredErr.error);
  r = await post('/api/file', '{}', { 'Content-Type': 'application/json' });
  assert.equal(r.status, 405, 'known route refuses other methods');
  // Oversize body: reject on the declared Content-Length alone. Sending real megabytes races
  // the server's 413-and-close against the client's write (ECONNRESET), so only the header travels.
  const oversizeStatus = await new Promise((resolve, reject) => {
    const req = request(new URL('/api/file', base), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(oversizeStatus, 413, 'route body limit holds');
  // 1.5MB is under this route's 2MB limit but over the global 1MB: the route limit wins.
  const midStatus = await new Promise((resolve, reject) => {
    const req = request(new URL('/api/file', base), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': String(1.5 * 1024 * 1024) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('[' + 'x'.repeat(1.5 * 1024 * 1024 - 2) + ']');
  });
  assert.equal(midStatus, 400, 'the route accepts 1.5MB and rejects the malformed body');

  // Message newlines collapse to one line.
  let keepHash = (await (await get('/api/file?path=keep.md')).json()).hash;
  r = await putJson({ path: 'keep.md', content: 'multi line\n', base: keepHash, message: 'one\r\ntwo\nthree' });
  assert.equal(r.status, 200, await r.text());
  assert.equal(commitSubject(), 'one two three');

  // No upstream: the commit stays local, pushed false with a warning.
  assert.equal(git(['-C', editDir, 'remote', 'remove', 'origin']).status, 0);
  keepHash = (await (await get('/api/file?path=keep.md')).json()).hash;
  r = await putJson({ path: 'keep.md', content: 'local only\n', base: keepHash });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.pushed, false);
  assert.match(body.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof body.warning, 'string');
  assert.equal(readFileSync(join(editDir, 'keep.md'), 'utf8'), 'local only\n');
  assert.equal(commitSubject(), 'one two three', 'nothing was pushed');

  // Push failure: the upstream moved ahead, so the push is a non-fast-forward -> 502.
  assert.equal(git(['-C', editDir, 'remote', 'add', 'origin', editBare]).status, 0);
  assert.equal(git(['-C', editDir, 'fetch', '-q', 'origin']).status, 0);
  assert.equal(git(['-C', editDir, 'branch', '-u', 'origin/main', 'main']).status, 0);
  const racer = join(tmp, 'racer');
  assert.equal(git(['clone', '-q', editBare, racer]).status, 0);
  writeFileSync(join(racer, 'notes.md'), 'raced\n');
  git(['-C', racer, 'config', 'user.name', 't']);
  git(['-C', racer, 'config', 'user.email', 't@t']);
  assert.equal(git(['-C', racer, 'commit', '-qam', 'race']).status, 0);
  assert.equal(git(['-C', racer, 'push', '-q', 'origin', 'main']).status, 0);
  rmSync(racer, { recursive: true, force: true });
  const localHash = (await (await get('/api/file?path=keep.md')).json()).hash;
  r = await putJson({ path: 'keep.md', content: 'conflict\n', base: localHash });
  assert.equal(r.status, 502);
  const pushErr = (await r.json()).error;
  assert.ok(pushErr.includes('git push failed'), pushErr);
  assert.ok(!pushErr.includes(editToken), 'push failure never echoes the stored token');
  assert.equal(readFileSync(join(editDir, 'keep.md'), 'utf8'), 'conflict\n', 'disk stays the truth after a failed push');
  file = await (await get('/api/file?path=keep.md')).json();
  assert.equal(file.content, 'conflict\n', 'snapshot re-imported even when the push failed');

  // Repo source through the fake GitHub base: fresh clone, edit, push, re-import from that clone.
  r = await postImport(JSON.stringify({ source: 'https://github.com/demo/editdata.git', kind: 'repo' }));
  assert.equal(r.status, 200, JSON.stringify(await r.json()));
  file = await (await get('/api/file?path=notes.md')).json();
  assert.equal(file.content, 'raced\n');
  r = await putJson({ path: 'repo-file.md', content: 'repo edit\n', base: null, message: 'test: repo edit' });
  body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.pushed, true);
  assert.match(body.commit, /^[0-9a-f]{40}$/);
  assert.equal(body.state.source.importedSha, body.commit, 'state carries the new commit');
  assert.ok(body.state.update && body.state.update.available === false && body.state.update.remoteSha === body.commit, 'a repo edit refreshes the update block');
  assert.equal(git(['--git-dir', editBare, 'log', '-1', '--format=%ce'], { encoding: 'utf8' }).stdout.trim(), 'alate@localhost', 'a fresh clone commits as alate');
  assert.equal(remoteText('repo-file.md'), 'repo edit\n', 'edit pushed to the bare remote');
  file = await (await get('/api/file?path=repo-file.md')).json();
  assert.equal(file.content, 'repo edit\n');

  // Shaping: a space-named path is a legal file; message null falls back to the default;
  // the caller's message is flattened to one trimmed line in the commit subject.
  r = await putJson({ path: 'Stryker was here!', content: 'sentinel\n', base: null });
  assert.equal(r.status, 200, 'a space-named file is a legal path: ' + JSON.stringify(await r.json()).slice(0, 200));
  r = await putJson({ path: 'my rule.md', content: 'spaced one\n', base: null });
  assert.equal(r.status, 200);
  assert.equal(commitSubject(), 'alate: add my rule.md');
  r = await putJson({ path: 'my rule.md', content: 'spaced two\n', base: (await (await get('/api/file?path=my%20rule.md')).json()).hash, message: '  Stryker was\rhere!\r\nmore  ' });
  assert.equal(r.status, 200);
  assert.equal(commitSubject(), 'Stryker was here! more', 'CR/LF flatten to spaces and the line is trimmed');
  r = await putJson({ path: 'my rule.md', content: 'spaced three\n', base: (await (await get('/api/file?path=my%20rule.md')).json()).hash, message: 'Stryker was here!' });
  assert.equal(r.status, 200);
  assert.equal(commitSubject(), 'Stryker was here!', 'a caller message is used verbatim');
  r = await putJson({ path: 'my rule.md', content: 'spaced four\n', base: (await (await get('/api/file?path=my%20rule.md')).json()).hash, message: null });
  assert.equal(r.status, 200, 'a null message falls back to the default, not a 400');
  assert.equal(commitSubject(), 'alate: edit my rule.md');

  // Delete pruning: emptied folders leave the tree, sibling files stay.
  await putJson({ path: 'keep/inner.md', content: 'inner\n', base: null });
  await putJson({ path: 'keep/side.md', content: 'side\n', base: null });
  r = await delJson({ path: 'keep/inner.md', base: (await (await get('/api/file?path=keep/inner.md')).json()).hash });
  assert.equal(r.status, 200);
  body = await (await get('/api/files')).json();
  assert.deepEqual(body.files.map(f => f.path).filter(p => p.startsWith('keep/')), ['keep/side.md'], 'the emptied parent folder is gone, the sibling file stays');

  // Repo-source push failure: a tag ref cannot move -> 502, token-free.
  r = await postImport(JSON.stringify({ source: 'https://github.com/demo/tagged@v1', kind: 'repo' }));
  assert.equal(r.status, 200, JSON.stringify(await r.json()));
  file = await (await get('/api/file?path=keep.md')).json();
  r = await putJson({ path: 'keep.md', content: 'tag block\n', base: file.hash });
  assert.equal(r.status, 502);
  const tagErr = (await r.json()).error;
  assert.ok(tagErr.includes('git push failed'), tagErr);
  assert.ok(!tagErr.includes(editToken), 'repo push failure never echoes the stored token');

  // A provision in flight blocks edits; the busy wording never says "changed".
  writeFileSync(provisionGate, '');
  const firstProvision = postJson('/provision', {}, true);
  try {
    await waitFor(async () => (await (await get('/health')).json()).running, 10_000);
    const busy = await putJson({ path: 'keep.md', content: 'x', base: null });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, 'provision already running');
    assert.equal((await delJson({ path: 'keep.md', base: null })).status, 409);
  } finally { rmSync(provisionGate, { force: true }); }
  await firstProvision;

  // A path source outside any work tree: no commit, no push, no warning, update block null.
  const plainDir = join(tmp, 'plain-edit');
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(join(plainDir, 'seed.md'), 'plain seed\n');
  r = await postImport(JSON.stringify({ source: plainDir }));
  assert.equal(r.status, 200);
  r = await putJson({ path: 'seed.md', content: 'plain edit\n', base: (await (await get('/api/file?path=seed.md')).json()).hash });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.commit, '');
  assert.equal(body.pushed, false);
  assert.ok(!('warning' in body));
  assert.equal(body.state.update, null, 'a path source has no update block');
  assert.equal(readFileSync(join(plainDir, 'seed.md'), 'utf8'), 'plain edit\n');
  assert.ok('update' in persistedEdit(), 'the edit persisted its state row');

  // A data dir that vanished after the import refuses cleanly.
  renameSync(plainDir, join(tmp, 'plain-edit-gone'));
  r = await putJson({ path: 'seed.md', content: 'late\n', base: (await (await get('/api/file?path=seed.md')).json()).hash });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.includes('no local data repo at'));

  // The import fixed the source: deleting a path source's last file keeps the root on disk.
  const lastDir = join(tmp, 'last-file');
  mkdirSync(lastDir);
  writeFileSync(join(lastDir, 'only.md'), 'only\n');
  r = await postImport(JSON.stringify({ source: lastDir }));
  assert.equal(r.status, 200);
  r = await delJson({ path: 'only.md', base: (await (await get('/api/file?path=only.md')).json()).hash });
  assert.equal(r.status, 200);
  assert.ok(existsSync(lastDir), 'the source root survives deleting its last file');
  r = await get('/api/file?path=only.md');
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error.includes('no stored file at only.md'), 'the 404 names the file');

  assert.deepEqual(readdirSync(serverTmp).filter(name => /^alate-(?:dashboard|snapshot)-/.test(name)), [], 'the editor removed its temp clones');

  console.log('server ok');

  // Kill the editor server before the LAN section reuses `child`, or it leaks the event loop open.
  await new Promise(resolve => { child.once('close', resolve); child.kill(); });

  // 79. Non-loopback guard: with --host 0.0.0.0 every dashboard route that reads or
  // changes state needs the key (Bearer token or login cookie); loopback stays key-free
  // (every earlier section ran unauthenticated on the default loopback bind).
  {
    const lanConfig = join(tmp, 'server-config-lan.json');
    const lanDb = join(tmp, 'state-lan.db');
    child = spawn(process.execPath, [join(repoRoot, 'server.ts'), '--port', '0', '--host', '0.0.0.0', '--config', lanConfig, '--db', lanDb], { cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      let lanKey = '';
      const lanBase = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', chunk => {
          buf += chunk;
          const k = /alate API key: (\S+)\n/.exec(buf);
          const l = /alate server on (http:\/\/[\d.]+:\d+)\n/.exec(buf);
          if (k) lanKey = k[1];
          if (k && l) resolve(l[1]);
        });
        child.once('exit', code => reject(new Error(`lan server exited early (${code})`)));
        setTimeout(() => reject(new Error(`lan server did not start; got: ${buf}`)), 10_000).unref();
      });
      const lanGet = (path, headers = {}) => fetch(new URL(path, lanBase), { headers });
      const lanPost = (path, body, headers = {}) => fetch(new URL(path, lanBase), { method: 'POST', headers, body });
      const lanPut = (body, headers = {}) => fetch(new URL('/api/file', lanBase), { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const lanDel = (body, headers = {}) => fetch(new URL('/api/file', lanBase), { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      // ponytail: not '/api/import' inline — the bare-specifier scan reads import + quote as an import statement
      const importPath = '/api/' + 'import';
      const lanOrigin = `http://${new URL(lanBase).host}`;

      let r2 = await lanGet('/api/state');
      assert.equal(r2.status, 401, 'state needs auth off loopback');
      r2 = await lanGet('/api/settings');
      assert.equal(r2.status, 401, 'settings read needs auth off loopback');
      r2 = await lanGet('/api/files');
      assert.equal(r2.status, 401, 'the file index needs auth off loopback');
      r2 = await lanGet('/api/file?path=seed.md');
      assert.equal(r2.status, 401, 'a file read needs auth off loopback');
      r2 = await lanPut({ path: 'seed.md', content: 'x', base: null });
      assert.equal(r2.status, 401, 'a file write needs auth off loopback');
      r2 = await lanDel({ path: 'seed.md', base: null });
      assert.equal(r2.status, 401, 'a file deletion needs auth off loopback');
      r2 = await lanPost(importPath, JSON.stringify({ source: origin }), { 'Content-Type': 'application/json' });
      assert.equal(r2.status, 401, 'import needs auth off loopback');
      r2 = await lanPost('/api/settings', JSON.stringify({ autoUpdate: true }), { 'Content-Type': 'application/json' });
      assert.equal(r2.status, 401, 'settings write needs auth off loopback');
      r2 = await lanPost('/api/key', undefined);
      assert.equal(r2.status, 401, 'key rotation needs auth off loopback');
      r2 = await lanGet('/app.js');
      assert.equal(r2.status, 200, 'the login page assets stay public');
      r2 = await lanGet('/theme.js');
      assert.equal(r2.status, 200, 'the theme bootstrap stays public');
      r2 = await lanGet('/sw.js');
      assert.equal(r2.status, 200, 'install assets stay public');
      r2 = await lanGet('/manifest.webmanifest');
      assert.equal(r2.status, 200, 'install assets stay public');

      // Login: the wrong key is refused, the right key sets an HttpOnly SameSite=Strict
      // cookie and the key itself never travels back in a body or the cookie.
      r2 = await lanPost('/api/login', JSON.stringify({ key: 'wrong-key' }), { 'Content-Type': 'application/json' });
      assert.equal(r2.status, 401);
      r2 = await lanPost('/api/login', JSON.stringify({ key: 42 }), { 'Content-Type': 'application/json' });
      assert.equal(r2.status, 401, 'a non-string key is refused');
      r2 = await lanPost('/api/login', JSON.stringify({ key: lanKey }), { 'Content-Type': 'application/json' });
      assert.equal(r2.status, 200);
      const loginBody = await r2.json();
      assert.deepEqual(loginBody, { ok: true });
      assert.ok(!JSON.stringify(loginBody).includes(lanKey), 'login never sends the key back');
      const setCookie = r2.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /alate_session=[a-f0-9]{64}/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Path=\//);
      assert.ok(setCookie.includes('Max-Age=2592000'), 'thirty-day session');
      const cookie = setCookie.split(';')[0];

      r2 = await lanGet('/api/state', { cookie });
      assert.equal(r2.status, 200, 'the session cookie reads state');
      r2 = await lanGet('/api/settings', { cookie });
      assert.equal(r2.status, 200, 'the session cookie reads settings');
      r2 = await fetch(new URL('/api/state', lanBase), { method: 'HEAD', headers: { cookie } });
      assert.equal(r2.status, 200, 'HEAD rides the GET guard');
      // CSRF: a cookie write must carry a same-origin Origin header.
      r2 = await lanPost('/api/settings', JSON.stringify({ autoUpdate: true }), { 'Content-Type': 'application/json', cookie });
      assert.equal(r2.status, 401, 'a cookie write without Origin is refused');
      r2 = await lanPost('/api/settings', JSON.stringify({ autoUpdate: true }), { 'Content-Type': 'application/json', cookie, origin: 'https://evil.example' });
      assert.equal(r2.status, 401, 'a cross-site cookie write is refused');
      r2 = await lanPost('/api/settings', JSON.stringify({ autoUpdate: true }), { 'Content-Type': 'application/json', cookie, origin: lanOrigin });
      assert.equal(r2.status, 200, 'a same-origin cookie write passes');
      // Header shapes the guard must not accept: junk before the scheme, a malformed
      // Origin, a second cookie before the session, and HEAD without Origin.
      r2 = await lanGet('/api/state', { authorization: `junk Bearer ${lanKey}` });
      assert.equal(r2.status, 401, 'a padded bearer header is refused');
      r2 = await lanPost('/api/settings', JSON.stringify({ autoUpdate: true }), { 'Content-Type': 'application/json', cookie, origin: 'not a url' });
      assert.equal(r2.status, 401, 'a malformed Origin is refused');
      r2 = await lanGet('/api/state', { cookie: `other=1; ${cookie}` });
      assert.equal(r2.status, 200, 'the session is found behind another cookie');
      r2 = await lanPost('/api/settings', JSON.stringify({ autoUpdate: true }), { 'Content-Type': 'application/json', cookie: `other=1; ${cookie}`, origin: lanOrigin });
      assert.equal(r2.status, 200, 'a cookie write behind another cookie passes');
      // Bearer works for scripts on the network bind.
      r2 = await lanGet('/api/state', { authorization: `Bearer ${lanKey}` });
      assert.equal(r2.status, 200);
      r2 = await lanPost(importPath, JSON.stringify({ source: origin }), { 'Content-Type': 'application/json', authorization: `Bearer ${lanKey}` });
      assert.equal(r2.status, 200, JSON.stringify(await r2.json()));
      // Rotating the key ends the cookie session, because the token derives from the key.
      r2 = await lanPost('/api/key', undefined, { authorization: `Bearer ${lanKey}` });
      assert.equal(r2.status, 200);
      lanKey = (await r2.json()).key;
      r2 = await lanGet('/api/state', { cookie });
      assert.equal(r2.status, 401, 'the old cookie dies with the key');
      r2 = await lanGet('/api/state', { authorization: `Bearer ${lanKey}` });
      assert.equal(r2.status, 200, 'the new key works');
      r2 = await lanGet('/api/files', { authorization: `Bearer ${lanKey}` });
      assert.equal(r2.status, 200, 'the key opens the file index off loopback');
    } finally {
      await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    }
  }

  // Property checks (fuzz tier via forAll in lib/data.mjs): cmpVer (lib/updates.mjs, a
  // Stryker-mutated file) is a total order and agrees with a simple reference.
  // Gate: 200 runs, fixed seed 42; PROP_RUNS=<n> re-seeds randomly for the review deep tier.
  {
    const sign = d => Math.sign(d);
    // Reference: strip one leading v/V, compare dot segments by numeric prefix (missing or
    // junk segment counts as 0). Pinned pairs document the shapes callers rely on.
    const refCmp = (a, b) => {
      const seg = v => String(v).replace(/^[vV]/, '').split('.').map(s => { const m = /^\d+/.exec(s); return m ? Number(m[0]) : 0; });
      const A = seg(a), B = seg(b);
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const d = (A[i] ?? 0) - (B[i] ?? 0);
        if (d !== 0) return Math.sign(d);
      }
      return 0;
    };
    for (const [a, b, expected] of [['v1.2', '1.2.0', 0], ['1.10.0', '1.9.9', 1], ['1.2.3', '1.2.10', -1], ['1.0.0-rc.1', '1.0.0', 1], ['junk', '0.0.0', 0]])
      assert.equal(sign(cmpVer(a, b)), expected, `cmpVer(${a}, ${b})`);
    const ver = rand => `${rand() < 0.3 ? 'v' : ''}${1 + Math.floor(rand() * 9)}${rand() < 0.6 ? `.${Math.floor(rand() * 20)}` : ''}${rand() < 0.4 ? `.${Math.floor(rand() * 20)}` : ''}${rand() < 0.15 ? '-rc.1' : ''}`;
    forAll(rand => [ver(rand), ver(rand)], ([a, b]) => {
      assert.equal(sign(cmpVer(a, b)), refCmp(a, b), `agrees with the reference: ${a} vs ${b}`);
      assert.ok(sign(cmpVer(a, b)) === -sign(cmpVer(b, a)), `antisymmetric: ${a} vs ${b}`); // === identifies 0 and -0
    });
    forAll(rand => [ver(rand), ver(rand), ver(rand)], ([a, b, c]) => {
      if (sign(cmpVer(a, b)) <= 0 && sign(cmpVer(b, c)) <= 0)
        assert.ok(sign(cmpVer(a, c)) <= 0, `transitive: ${a} <= ${b} <= ${c}`);
    });
  }
// Mutation survivors covered by this section: lib/updates.mjs ====
{
  const { initUpdates, cmpVer, checkUpdates, loadUpdates } = await import('./lib/updates.mjs');
  const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString();
  const plusDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString();
  const old30 = daysAgo(30), fresh2 = daysAgo(2);
  const b64 = s => Buffer.from(s).toString('base64');

  // A local fake for the four upstream API bases; each test installs its own handler.
  let handler = null;
  const hits = [];
  const fakeUp = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push({ p: url.pathname, q: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null });
    const r = handler ? handler(url) : null;
    res.writeHead(r ? r[0] : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r ? r[1] : { message: 'no fixture' }));
  });
  await new Promise(resolve => fakeUp.listen(0, '127.0.0.1', resolve));
  const upBase = `http://127.0.0.1:${fakeUp.address().port}`;
  const envKeys = ['ALATE_TEST_GITHUB_API_BASE', 'ALATE_TEST_NPM_BASE', 'ALATE_TEST_NODE_DIST_BASE', 'ALATE_TEST_CFT_BASE'];
  const savedEnv = envKeys.map(k => process.env[k]);
  envKeys.forEach((k, i) => { process.env[k] = `${upBase}/${['gh', 'npm', 'dist', 'cft'][i]}`; });

  const mkDb = files => {
    const db = new DatabaseSync(':memory:');
    initUpdates(db);
    db.exec('CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT)');
    const ins = db.prepare('INSERT INTO files (path, content) VALUES (?, ?)');
    for (const [p, c] of Object.entries(files ?? {})) ins.run(p, typeof c === 'string' ? c : JSON.stringify(c));
    return db;
  };
  const item = (name, extra = {}) => ({ name, kind: 't', origin: `https://github.com/fake/${name}`, ...extra });
  const UP = items => JSON.stringify({ items });
  const rows = db => Object.fromEntries(loadUpdates(db).updates.map(u => [u.name, u]));
  const rawRows = db => db.prepare('SELECT value FROM updates').all().map(r => JSON.parse(r.value));
  const run = async (files, opts = {}) => {
    const db = mkDb(files);
    await checkUpdates(db, { dataRepo: 'demo/data', token: 'tok-xyz', ...opts });
    return db;
  };

  try {
    // cmpVer pinned edges beyond the property tier: extra segments, junk, prefixes, case.
    for (const [a, b, s] of [['1.2.3.4', '1.2.3', 1], ['1.2.3', '1.2.3.0', 0], ['V2.0', '1.9', 1], ['1a', '1', 0], ['a', '1', -1], ['1.0.x', '1.0.0', 0], ['1.02', '1.2', 0], ['', '0', 0], ['v', '0', 0], ['10.0', '9.0', 1], ['a1', '1', -1], ['1v2', '1.2', -1], ['1.2', '1v2', 1]])
      assert.equal(Math.sign(cmpVer(a, b)), s, `cmpVer(${a}, ${b})`);

    // initUpdates is idempotent and both tables work.
    {
      const db = new DatabaseSync(':memory:');
      initUpdates(db); initUpdates(db);
      db.prepare('INSERT INTO update_seen (key, seenAt) VALUES (?, ?)').run('k', old30);
      db.prepare('INSERT INTO updates (id, value) VALUES (?, ?)').run('i', '{}');
      db.close();
    }

    // Empty and whitespace-only snapshot files mean "no entries", never fatal.
    assert.equal(Object.keys(rows(await run({ 'upstreams.json': '' }))).length, 0);
    assert.equal(Object.keys(rows(await run({ 'upstreams.json': ' \n\t ', 'user/agents/.skill-lock.json': ' \n\t ' }))).length, 0);

    // github-release: sort order, pick, age gate, publishedAt/notesUrl from the qualifying pick.
    {
      handler = url => url.pathname === '/gh/repos/fake/r1/releases' ? [200, [
        { tag_name: 'v1.4.0-rel', draft: false, prerelease: false, published_at: old30, html_url: 'u14' },
        { tag_name: 'v3.0.0-rel', draft: false, prerelease: false, published_at: fresh2, html_url: 'u30' },
        { tag_name: 'v2.0.0-rel', draft: false, prerelease: false, published_at: old30, html_url: 'u20' },
        { tag_name: 'v0.9.0-rel', draft: false, prerelease: false, published_at: old30, html_url: 'u09' },
      ]] : null;
      const db = await run({ 'upstreams.json': UP([item('r1', { version: '1.0.0', check: { type: 'github-release', tagPrefix: 'v', tagSuffix: '-rel' } })]) });
      const r = rows(db);
      assert.deepEqual([r.r1.latest, r.r1.target, r.r1.publishedAt, r.r1.notesUrl, r.r1.qualifiesAt, r.r1.id],
        ['3.0.0', '2.0.0', old30, 'u20', plusDays(old30, 7), 'r1@2.0.0'], JSON.stringify(r.r1));
      assert.deepEqual([r.r1.repo, r.r1.pin, r.r1.current, r.r1.error ?? null], [null, null, '1.0.0', null], 'an unpinned item reports a null repo');
      const res = await checkUpdates(db, { dataRepo: 'demo/data', token: 'tok-xyz' });
      assert.deepEqual([res.count, typeof res.checkedAt], [1, 'string'], 'checkUpdates reports count and checkedAt');
    }

    // github-release: draft/prerelease/tagless/hyphen skip; no target at an equal current.
    {
      handler = url => url.pathname === '/gh/repos/fake/r2/releases' ? [200, [
        { tag_name: 'v2.0.0-rel', draft: false, prerelease: false, published_at: old30, html_url: 'e20' },
        { draft: false, prerelease: false, published_at: old30 },
        { tag_name: 'v9.0.0-rel', draft: true, prerelease: false, published_at: old30 },
        { tag_name: 'v9.0.0-rel', draft: false, prerelease: true, published_at: old30 },
        { tag_name: 'v1.0-rc-rel', draft: false, prerelease: false, published_at: old30 },
      ]] : null;
      const r = rows(await run({ 'upstreams.json': UP([item('r2', { version: '2.0.0', check: { type: 'github-release', tagPrefix: 'v', tagSuffix: '-rel' } })]) }));
      assert.deepEqual([r.r2.latest, r.r2.target, r.r2.publishedAt, r.r2.id], ['2.0.0', null, old30, 'r2@2.0.0'], JSON.stringify(r.r2));
    }

    // github-release: pick, filtering and pinned error strings.
    {
      handler = url => {
        if (url.pathname === '/gh/repos/fake/r3/releases') return [200, [{ tag_name: 'v2.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'z' }]];
        if (url.pathname === '/gh/repos/fake/r4/releases') return [500, { message: 'boom' }];
        if (url.pathname === '/gh/repos/fake/r9/releases') return [200, [{ draft: false, prerelease: false, published_at: old30 }]];
        if (url.pathname === '/gh/repos/fake/r10/releases') return [200, [{ tag_name: 'undefinedX', draft: false, prerelease: false, published_at: old30 }]];
        if (url.pathname === '/gh/repos/fake/r11/releases') return [200, [{ tag_name: 'Xundefined', draft: false, prerelease: false, published_at: old30 }]];
        if (url.pathname === '/gh/repos/fake/r12/releases') return [200, [
          { tag_name: 'v1.5.0-rc-rel', draft: false, prerelease: false, published_at: old30 },
          { tag_name: 'v1.4.0-rel', draft: false, prerelease: false, published_at: old30 },
        ]];
        if (url.pathname === '/gh/repos/fake/r13/releases') return [200, [{ tag_name: 'v-rel', draft: false, prerelease: false, published_at: old30 }]];
        if (url.pathname === '/gh/repos/fake/r14/releases') return [200, [{ tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'z14' }]];
        return null;
      };
      const r = rows(await run({ 'upstreams.json': UP([
        item('r3', { check: { type: 'github-release' } }),
        item('r4', { check: { type: 'github-release' } }),
        item('r5', { origin: null, check: { type: 'github-release' } }),
        item('r6', { origin: 'https://gitlab.com/o/r', check: { type: 'github-release' } }),
        item('r7', { origin: 'https://evil.com/https://github.com/a/b', check: { type: 'github-release' } }),
        item('r9', { check: { type: 'github-release' } }),
        item('r10', { check: { type: 'github-release' } }),
        item('r11', { check: { type: 'github-release' } }),
        item('r12', { version: '1.0.0', check: { type: 'github-release', tagPrefix: 'v', tagSuffix: '-rel' } }),
        item('r13', { check: { type: 'github-release', tagPrefix: 'v', tagSuffix: '-rel' } }),
        item('r14', { version: '9.9.9', check: { type: 'github-release' } }),
      ]) }));
      assert.deepEqual([r.r3.latest, r.r3.target, r.r3.current, r.r3.publishedAt], ['v2.0.0', 'v2.0.0', null, old30], 'a null current still targets the newest old release');
      assert.match(r.r4.error, /^GET http:\/\/127\.0\.0\.1:\d+\/gh\/repos\/fake\/r4\/releases\?per_page=100 failed: HTTP 500$/);
      assert.equal(r.r5.error, 'cannot parse repo from origin (none)');
      assert.equal(r.r6.error, 'cannot parse repo from origin https://gitlab.com/o/r');
      assert.equal(r.r7.error, 'cannot parse repo from origin https://evil.com/https://github.com/a/b');
      assert.deepEqual([r.r9.latest, r.r9.target, r.r9.error ?? null], [null, null, null], 'a tagless release never becomes latest');
      assert.deepEqual([r.r10.latest, r.r11.latest], ['undefinedX', 'Xundefined'], 'prefix/suffix stripping stays anchored to its own check');
      assert.deepEqual([r.r12.latest, r.r12.target], ['1.4.0', '1.4.0'], 'a hyphen version never qualifies');
      assert.deepEqual([r.r13.latest, r.r13.target, r.r13.publishedAt, r.r13.notesUrl, r.r13.error ?? null], [null, null, null, null, null], 'a tag that strips to nothing leaves the row empty');
      assert.deepEqual([r.r14.latest, r.r14.target], ['v1.0.0', null], 'a current above every release never targets');
      assert.ok(!JSON.stringify(r).includes('tok-xyz'), 'the token never reaches a row');
      const ghHits = hits.filter(h => h.p.startsWith('/gh/'));
      assert.ok(ghHits.length >= 2 && ghHits.every(h => h.auth === 'Bearer tok-xyz'), 'the token rides GitHub calls only');
    }

    // github-path: prefix-tolerant same-sha, query string shape, error rows, missing fields.
    {
      handler = url => {
        if (url.pathname === '/gh/repos/o/p/commits') return [200, [{ sha: 'abc1234567890', commit: { committer: { date: old30 } }, html_url: 'pu' }]];
        if (url.pathname === '/gh/repos/o/p4/commits') return [200, [{ sha: 'def4567890', commit: { committer: { date: fresh2 } }, html_url: 'pu4' }]];
        if (url.pathname === '/gh/repos/o/p9/commits') return [200, [{ sha: 'def4567890', commit: { committer: { date: fresh2 } }, html_url: 'pu9' }]];
        if (url.pathname === '/gh/repos/o/empty/commits') return [200, []];
        if (url.pathname === '/gh/repos/o/nosha/commits') return [200, [{ commit: { committer: { date: old30 } } }]];
        if (url.pathname === '/gh/repos/o/nocommit/commits') return [200, [{ sha: 'x7', commit: {} }]];
        if (url.pathname === '/gh/repos/o/nocommit2/commits') return [200, [{ sha: 'x8', html_url: 'u8' }]];
        return null;
      };
      hits.length = 0;
      const r = rows(await run({ 'upstreams.json': UP([
        item('p1', { origin: 'https://github.com/o/p', check: { type: 'github-path' } }),
        item('p2', { origin: 'https://github.com/o/p', version: 'abc1234', check: { type: 'github-path' } }),
        item('p3', { origin: 'https://github.com/o/p', version: 'zzz', check: { type: 'github-path' } }),
        item('p8', { origin: 'https://github.com/o/p4', check: { type: 'github-path' } }),
        item('p9', { origin: 'https://github.com/o/p9', version: 'def4567890', check: { type: 'github-path', path: 'sub/dir', branch: 'main' } }),
        item('p10', { origin: 'https://github.com/o/p', version: '567890', check: { type: 'github-path' } }),
        item('p5', { origin: 'https://github.com/o/empty', check: { type: 'github-path' } }),
        item('p6', { origin: 'https://github.com/o/nosha', check: { type: 'github-path' } }),
        item('p7', { origin: 'https://github.com/o/nocommit', check: { type: 'github-path' } }),
        item('p11', { origin: 'https://gitlab.com/g', check: { type: 'github-path' } }),
        item('p12', { origin: null, check: { type: 'github-path' } }),
        item('p13', { origin: 'https://github.com/o/nocommit2', check: { type: 'github-path' } }),
      ]) }));
      assert.deepEqual([r.p1.latest, r.p1.target, r.p1.publishedAt, r.p1.notesUrl], ['abc1234567890', 'abc1234567890', old30, 'pu']);
      assert.deepEqual([r.p2.target, r.p2.current], [null, 'abc1234'], 'prefix-tolerant current never targets');
      assert.equal(r.p3.target, 'abc1234567890');
      assert.deepEqual([r.p8.latest, r.p8.target, r.p8.current ?? null], ['def4567890', null, null], 'an unknown current still gates on head age');
      assert.equal(r.p9.target, null);
      assert.deepEqual(hits.find(h => h.p === '/gh/repos/o/p9/commits').q, { per_page: '1', path: 'sub/dir', sha: 'main' });
      assert.deepEqual(hits.find(h => h.p === '/gh/repos/o/p/commits').q, { per_page: '1' });
      assert.equal(r.p10.target, 'abc1234567890', 'a suffix current is not the same commit');
      assert.equal(r.p5.error, 'no commit found on o/empty');
      assert.equal(r.p6.error, 'no commit found on o/nosha');
      assert.deepEqual([r.p7.latest, r.p7.publishedAt, r.p7.error ?? null], ['x7', null, null], 'a head without committer data stays error-free');
      assert.equal(r.p11.error, 'cannot parse repo from origin https://gitlab.com/g');
      assert.equal(r.p12.error, 'cannot parse repo from origin (none)');
      assert.deepEqual([r.p13.latest, r.p13.publishedAt, r.p13.error ?? null], ['x8', null, null], 'a head without a commit object keeps publishedAt null');
    }

    // npm: created/modified exclusion, prerelease exclusion, pick, package fallback, empty doc.
    {
      handler = url => {
        if (url.pathname === '/npm/n1') return [200, { time: { created: old30, modified: old30, '0.1': old30 } }];
        if (url.pathname === '/npm/n2') return [200, { time: { '1.0-a': old30, created: old30, modified: old30 } }];
        if (url.pathname === '/npm/n4') return [200, { time: { '2.0.0': fresh2, '1.5.0': old30 } }];
        if (url.pathname === '/npm/n5') return [200, { time: { '2.0.0': old30 } }];
        return null;
      };
      const r = rows(await run({ 'upstreams.json': UP([
        item('n1', { check: { type: 'npm', package: 'n1' }, version: '0.0.1' }),
        item('n2', { check: { type: 'npm', package: 'n2' } }),
        item('n4', { check: { type: 'npm' }, version: '1.5.0' }),
        item('n5', { check: { type: 'npm', package: 'n5' } }),
      ]) }));
      assert.deepEqual([r.n1.latest, r.n1.target, r.n1.publishedAt, r.n1.notesUrl, r.n1.qualifiesAt], ['0.1', '0.1', old30, 'https://www.npmjs.com/package/n1', plusDays(old30, 7)]);
      assert.deepEqual([r.n2.latest, r.n2.target, r.n2.publishedAt], [null, null, null]);
      assert.deepEqual([r.n4.latest, r.n4.target, r.n4.publishedAt], ['2.0.0', null, fresh2]);
      assert.deepEqual([r.n5.current, r.n5.target], [null, '2.0.0']);
      assert.ok(hits.filter(h => h.p.startsWith('/npm/')).every(h => h.auth === null), 'the GitHub token never rides npm');
    }

    // node-dist: major filter, rc exclusion, equal and above current, empty result, exact notesUrl.
    {
      handler = url => url.pathname === '/dist/index.json' ? [200, [
        { version: 'v22.5.0', date: fresh2 }, { version: 'v22.20.0', date: old30 }, { version: 'v22.19.0-rc.1', date: old30 },
        { version: 'v23.1.0', date: old30 }, { version: 'v21.0.0', date: old30 },
      ]] : null;
      const r = rows(await run({ 'upstreams.json': UP([
        item('node1', { version: '22.1.0', check: { type: 'node-dist', major: 22 } }),
        item('node2', { version: '22.20.0', check: { type: 'node-dist', major: 22 } }),
        item('node3', { version: '1.0.0', check: { type: 'node-dist', major: 99 } }),
        item('node4', { version: '22.30.0', check: { type: 'node-dist', major: 22 } }),
      ]) }));
      assert.deepEqual([r.node1.latest, r.node1.target, r.node1.publishedAt, r.node1.notesUrl], ['22.20.0', '22.20.0', old30, `${upBase}/dist/`]);
      assert.deepEqual([r.node2.target, r.node2.latest, r.node2.publishedAt], [null, '22.20.0', old30]);
      assert.deepEqual([r.node3.latest, r.node3.target, r.node3.publishedAt, r.node3.error ?? null], [null, null, null, null]);
      assert.deepEqual([r.node4.latest, r.node4.target], ['22.20.0', null], 'a current above every build never targets');
      assert.ok(hits.filter(h => h.p.startsWith('/dist/')).every(h => h.auth === null));
    }

    // chrome-for-testing: first-seen gate, backdated seen rows, same/older current, missing channel/doc.
    {
      handler = url => url.pathname === '/cft/last-known-good-versions.json' ? [200, { channels: { Stable: { version: '155.0.0.1' } } }] : null;
      const db = await run({ 'upstreams.json': UP([
        item('c1', { version: '150.0.0.0', check: { type: 'chrome-for-testing', channel: 'Stable' } }),
        item('c2', { version: '155.0.0.1', check: { type: 'chrome-for-testing', channel: 'Stable' } }),
        item('c3', { version: '156.0', check: { type: 'chrome-for-testing', channel: 'Stable' } }),
        item('c4', { check: { type: 'chrome-for-testing', channel: 'Nightly' } }),
      ]) });
      const first = rows(db);
      assert.deepEqual([first.c1.latest, first.c1.target], ['155.0.0.1', null], 'first seen is never qualified');
      assert.ok(Math.abs(Date.parse(first.c1.publishedAt) - Date.now()) < 60_000);
      assert.equal(first.c1.qualifiesAt, plusDays(first.c1.publishedAt, 7));
      assert.equal(first.c1.notesUrl, `${upBase}/cft/last-known-good-versions.json`);
      assert.deepEqual([first.c2.target, first.c3.target], [null, null]);
      assert.equal(first.c4.error, 'channel Nightly not found');
      const back = daysAgo(9);
      db.prepare("UPDATE update_seen SET seenAt = ? WHERE key IN ('item:c1|155.0.0.1', 'item:c2|155.0.0.1', 'item:c3|155.0.0.1')").run(back);
      await checkUpdates(db, { dataRepo: 'demo/data', token: 'tok-xyz' });
      const second = rows(db);
      assert.deepEqual([second.c1.target, second.c1.publishedAt], ['155.0.0.1', back], 'an old first-seen row qualifies; INSERT OR IGNORE keeps it');
      assert.equal(second.c2.target, null, 'an equal version never targets, even when old');
      assert.equal(second.c3.target, null, 'an older upstream never targets');
      assert.ok(hits.filter(h => h.p.startsWith('/cft/')).every(h => h.auth === null));
      // A doc without channels reports the pinned error, never a crash.
      handler = () => [200, {}];
      const r5 = rows(await run({ 'upstreams.json': UP([item('c5', { check: { type: 'chrome-for-testing', channel: 'Stable' } })]) }));
      assert.equal(r5.c5.error, 'channel Stable not found');
    }

    // runCheck dispatch: unknown types, static rows without a check.
    {
      handler = () => null;
      const r = rows(await run({ 'upstreams.json': UP([
        item('x1', { check: { type: 'wat' } }),
        item('x2', { check: {} }),
        item('x3', { version: '1.0.0' }),
      ]) }));
      assert.equal(r.x1.error, 'unknown check type wat');
      assert.equal(r.x2.error, 'unknown check type undefined');
      assert.deepEqual([r.x3.current, r.x3.latest, r.x3.target, r.x3.publishedAt, r.x3.notesUrl, r.x3.error ?? null], ['1.0.0', null, null, null, null, null]);
    }

    // pinCurrent: ARG (spaces/tab), FROM with flags and second line, @-keys, mid-string v, remote pins.
    {
      handler = url => {
        if (url.pathname === '/gh/repos/remote/o/contents/pin.txt') return [200, { content: b64('ARG PK=v3.0.0\n'), encoding: 'base64' }];
        if (url.pathname === '/gh/repos/remote/o/contents/null.txt') return [200, { content: null, encoding: 'base64' }];
        return null;
      };
      hits.length = 0;
      const dockerfile = 'ARG OTHER=1\n  ARG\tIMG=ghcr.io/i/a:v1.2.2-debian\nARG V2=av1.0-x\nFROM --platform=linux/amd64 fake/base:1.0.0 AS build\nFROM c.io/d:4.5.6\n';
      const r = rows(await run({
        'upstreams.json': UP([
          item('pA', { pin: { file: 'Dockerfile', key: 'IMG' } }),
          item('pB', { pin: { file: 'Dockerfile', key: 'c.io/d' } }),
          item('pC', { pin: { file: 'Dockerfile', key: 'fake/base' } }),
          item('pK', { pin: { file: 'Dockerfile', key: 'V2' } }),
          item('pD', { pin: { file: 'mcp.json', key: 'k@' } }),
          item('pE', { pin: { file: 'mcp.json', key: 'q@' } }),
          item('pF', { pin: { file: 'mcp.json', key: 'zz@' } }),
          item('pG', { pin: { repo: 'remote/o', file: 'pin.txt', key: 'PK' } }),
          item('pH', { pin: { repo: 'demo/data', file: 'Dockerfile', key: 'IMG' } }),
          item('pI', { version: '9.9', pin: { file: 'absent.bin', key: 'k' } }),
          item('pJ', { pin: { repo: 'remote/o', file: 'null.txt', key: 'PK' } }),
          item('pL', { pin: { file: 'Dockerfile', key: 'IMG' } }),
        ]),
        Dockerfile: dockerfile,
        'mcp.json': '{"args":["k@1.2.3","q@2.0.0"]}',
      }));
      assert.deepEqual([r.pA.current, r.pB.current, r.pC.current, r.pK.current], ['1.2.2', '4.5.6', '1.0.0', 'av1.0'], JSON.stringify([r.pA.current, r.pB.current, r.pC.current, r.pK.current]));
      assert.deepEqual([r.pD.current, r.pE.current], ['1.2.3', '2.0.0']);
      assert.equal(r.pF.error, 'pin zz@ not found in mcp.json');
      assert.deepEqual([r.pG.current, r.pG.repo], ['3.0.0', 'remote/o']);
      assert.deepEqual([r.pH.current, r.pH.repo], ['1.2.2', 'demo/data'], 'a data-repo pin reads the snapshot, not HTTP');
      assert.equal(r.pI.current, '9.9', 'a version wins over the pin file');
      assert.equal(r.pJ.error, 'pin PK not found in null.txt');
      assert.deepEqual([r.pL.current, r.pL.repo], ['1.2.2', 'demo/data'], 'a repo-less pin defaults to the data repo');
      const contentHits = hits.filter(h => h.p.includes('/contents/'));
      assert.equal(contentHits.length, 2);
      assert.ok(contentHits.every(h => h.auth === 'Bearer tok-xyz'));
    }

    // parseJsonc: comments, escapes, trailing commas, malformed and unclosed inputs.
    {
      handler = url => {
        if (url.pathname === '/npm/pkga') return [200, { time: { '1.2.3': old30 } }];
        if (url.pathname === '/npm/pkgb') return [200, { time: { '2.5.0': old30 } }];
        if (url.pathname === '/npm/@s/p') return [200, { time: { '2.5.0': old30 } }];
        if (url.pathname === '/npm/pkgc') return [200, { time: { '5.0.0': old30 } }];
        return null;
      };
      const lock1 = `{
  /* b0 / b0 *//* bb */ "workspaces": { "": { "dependencies": {
  // pure line comment one
  // pure line comment two
    "pkga": "^1.0.0",
    "pkgb": "npm:@s/p@^2",
  } } },
  "packages": {
    "pkga": ["pkga@1.2.3", "", {},],
    "pkgb": ["pkgb@2.5.0\\"", "", {}],
  },
}
`;
      const r = rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': lock1 }));
      assert.deepEqual([r.pkga.current, r.pkga.latest, r.pkga.target], ['1.2.3', '1.2.3', null]);
      assert.deepEqual([r.pkgb.current, r.pkgb.latest], ['2.5.0"', '2.5.0'], 'the escaped quote survives the stripper');
      // A whitespace-only lock means no entries; malformed and unclosed shapes throw or stay clean.
      assert.equal(Object.keys(rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': ' \n\t ' }))).length, 0);
      assert.equal(Object.keys(rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '{"workspaces": {}, "packages": {"z": ["z@1.0"]}}' }))).length, 0, 'a workspace-less lock has no plugin rows');
      await assert.rejects(run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '{oops' }));
      await assert.rejects(run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '1 / junk' }), undefined, 'a bare slash outside a comment never parses');
      await assert.rejects(run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '{"workspaces": { "": { "dependencies": { "pkgc": "^5.0.0" } } }, "packages": { "pkgc": ["pkgc@5.0.0", "", {}] } } **' }), undefined, 'a bare star pair outside a comment is fatal');
      await assert.rejects(run({ 'upstreams.json': '{' }));
      await assert.rejects(run({ 'user/agents/.skill-lock.json': '{' }));
      assert.equal(Object.keys(rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '{"workspaces": { "": { "dependencies": { "pkgc": "^5.0.0" } } }, "packages": { "pkgc": ["pkgc@5.0.0", "", {}] } }\n/* unclosed to EOF' }))).length, 1, 'a comment unclosed at EOF still parses');
      assert.equal(Object.keys(rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '{"workspaces": { "": { "dependencies": { "pkgc": "^5.0.0" } } }, "packages": { "pkgc": ["pkgc@5.0.0", "", {}] } }\n// final comment no newline' }))).length, 1, 'a line comment to EOF still parses');
      assert.equal(Object.keys(rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': '{"packages": { "z": ["z@1.0"] } }' }))).length, 0, 'a lock without workspaces has no plugin rows');
      const lockEsc = `{
  "note": "x\\"",
  // comment between the escape and the deps
  "workspaces": { "": { "dependencies": { "pkgd": "^7.0.0" } } },
  "packages": { "pkgd": ["pkgd@7.0.0", "", {}] }
}`;
      assert.equal(Object.keys(rows(await run({ 'upstreams.json': UP([]), 'user/omp/plugins/bun.lock': lockEsc }))).length, 1, 'an escaped quote keeps the stripper in sync');
    }

    // Skills: tree-hash compare, branch plumbing, gone folders, origin from sourceUrl, taken set.
    {
      handler = url => {
        if (url.pathname === '/gh/repos/o/s/commits') {
          const p = url.searchParams.get('path');
          return [200, [{ sha: p === 'skills/s1' ? 'H1' : 'H2', commit: { committer: { date: old30 } }, html_url: 'su' }]];
        }
        if (url.pathname === '/gh/repos/o/s/git/trees/HEAD') return [200, { tree: [{ path: 'skills/s1', type: 'tree', sha: 't1' }, { path: 'skills/s2', type: 'blob', sha: 'BLOB' }, { path: 'skills/s2', type: 'tree', sha: 't2' }] }];
        if (url.pathname === '/gh/repos/o/s3/commits') return [200, [{ sha: 'H3', commit: { committer: { date: old30 } }, html_url: 's3u' }]];
        if (url.pathname === '/gh/repos/o/s3/git/trees/HEAD') return [200, { tree: [{ path: 'other/x', type: 'tree', sha: 'q' }] }];
        if (url.pathname === '/gh/repos/o/s5/commits') return [200, [{ sha: 'H5', commit: { committer: { date: old30 } }, html_url: 's5u' }]];
        if (url.pathname === '/gh/repos/o/s5/git/trees/dev') return [200, { tree: [{ path: 'skills/s5', type: 'tree', sha: 't5' }] }];
        if (url.pathname === '/gh/repos/o/s5/git/trees/r6') return [200, { tree: [{ path: 'skills/s6', type: 'tree', sha: 't6' }] }];
        // No stable releases anywhere here: every row below keeps the SHA behavior.
        if (url.pathname === '/gh/repos/o/s/releases' || url.pathname === '/gh/repos/o/s3/releases' || url.pathname === '/gh/repos/o/s5/releases') return [200, []];
        return null;
      };
      hits.length = 0;
      const db = await run({
        'upstreams.json': UP([item('s2')]),
        'user/agents/.skill-lock.json': JSON.stringify({ skills: {
          s1: { sourceUrl: 'https://github.com/o/s.git', skillPath: 'skills/s1/SKILL.md', skillFolderHash: 'h1' },
          s2: { sourceUrl: 'https://github.com/o/s.git', skillPath: 'skills/s2/SKILL.md', skillFolderHash: 't2' },
          s3: { sourceUrl: 'https://github.com/o/s3', skillPath: 'skills/s3/SKILL.md', skillFolderHash: 'h3' },
          s4: { sourceUrl: 'https://x/y', skillPath: 'skills/s4/SKILL.md', skillFolderHash: 'h4' },
          s5: { sourceUrl: 'https://github.com/o/s5', skillPath: 'skills/s5/SKILL.md', skillFolderHash: 'h5', branch: 'dev' },
          s6: { sourceUrl: 'https://github.com/o/s5', skillPath: 'skills/s6/SKILL.md', skillFolderHash: 'h6', ref: 'r6' },
        } }),
      });
      const r = rows(db);
      assert.deepEqual([r.s1.latest, r.s1.target, r.s1.current, r.s1.origin, r.s1.repo, r.s1.kind, r.s1.pin],
        ['H1', 'H1', 'h1', 'https://github.com/o/s.git', 'demo/data', 'skill', { file: 'user/agents/.skill-lock.json', key: 's1' }], JSON.stringify(r.s1));
      assert.deepEqual([r.s2.target, r.s2.current], [null, 'H2'], 'an installed tree equal to head reads as current; blobs never match');
      assert.deepEqual([r.s3.latest, r.s3.target, r.s3.current, r.s3.removed, r.s3.error ?? null], ['H3', null, 'h3', true, null]);
      assert.equal(r.s4.error, 'cannot parse repo from sourceUrl https://x/y');
      assert.deepEqual([r.s5.latest, r.s5.target], ['H5', 'H5']);
      assert.deepEqual(hits.find(h => h.p === '/gh/repos/o/s5/commits').q, { per_page: '1', path: 'skills/s5', sha: 'dev' });
      assert.ok(hits.some(h => h.p === '/gh/repos/o/s5/git/trees/dev'));
      // A lock `ref` rides the commit and tree queries of the no-release path like `branch` does.
      assert.deepEqual([r.s6.latest, r.s6.target, r.s6.current, r.s6.error ?? null], ['H5', 'H5', 'h6', null], JSON.stringify(r.s6));
      assert.deepEqual(hits.find(h => h.p === '/gh/repos/o/s5/commits' && h.q.sha === 'r6').q.path, 'skills/s6');
      assert.ok(hits.some(h => h.p === '/gh/repos/o/s5/git/trees/r6'));
      // The releases probe is memoized per repo: s1/s2 and s5/s6 fetch it once each.
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/s/releases').length, 1);
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/s5/releases').length, 1);
      assert.equal(rawRows(db).find(v => v.name === 's1')._row, 'skill:s1');
      assert.equal(rawRows(db).filter(v => v._row === 'item:s2').length, 0, 'a lock row takes the name from the items loop');
    }

    // Skills in release mode: rows report release tags, not SHAs; the installed folder is
    // matched to a tag by tree hash; the age gate applies to published_at.
    {
      const tree = sha => [200, { tree: [{ path: 'skills/k', type: 'tree', sha }] }];
      handler = url => {
        if (url.pathname === '/gh/repos/o/rel/releases') return [200, [
          { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'u100' },
          { tag_name: 'v2.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'u200' },
          { tag_name: 'v3.0.0', draft: false, prerelease: false, published_at: fresh2, html_url: 'u300' },
        ]];
        if (url.pathname === '/gh/repos/o/rel/git/trees/v1.0.0') return tree('T1');
        if (url.pathname === '/gh/repos/o/rel/git/trees/v2.0.0') return tree('T2');
        if (url.pathname === '/gh/repos/o/rel/git/trees/v3.0.0') return tree('T3');
        if (url.pathname === '/gh/repos/o/dr/releases') return [200, [
          { tag_name: 'v9.0.0', draft: true, prerelease: false, published_at: old30, html_url: 'u9' },
          { tag_name: 'v8.0.0', draft: false, prerelease: true, published_at: old30, html_url: 'u8' },
          { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'u1' },
        ]];
        if (url.pathname === '/gh/repos/o/dr/git/trees/v1.0.0') return tree('TD');
        if (url.pathname === '/gh/repos/o/gone/releases') return [200, [
          { tag_name: 'v2.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'g2' },
          { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'g1' },
        ]];
        if (url.pathname === '/gh/repos/o/gone/git/trees/v2.0.0') return [200, { tree: [{ path: 'elsewhere', type: 'tree', sha: 'X' }] }];
        if (url.pathname === '/gh/repos/o/gone/git/trees/v1.0.0') return tree('TG');
        // File diffs between tags: files inside and outside the skill folder.
        const cmp = files => [200, { files }];
        if (url.pathname === '/gh/repos/o/rel/compare/v1.0.0...v2.0.0') return cmp([
          { filename: 'skills/k/CHANGED.md' },
          { filename: 'skills/k/sub/new.md' },
          { filename: 'elsewhere/other.md' },
        ]);
        if (url.pathname === '/gh/repos/o/rel/compare/v2.0.0...v3.0.0') return cmp([{ filename: 'skills/k/NEW.md' }]);
        return null;
      };
      hits.length = 0;
      const at = (repo, hash, extra = {}) =>
        ({ sourceUrl: `https://github.com/o/${repo}`, skillPath: 'skills/k/SKILL.md', skillFolderHash: hash, ...extra });
      const db = await run({
        'upstreams.json': UP([]),
        'user/agents/.skill-lock.json': JSON.stringify({ skills: {
          a: at('rel', 'T1'), // installed folder = older week-old tag
          b: at('rel', 'T3'), // installed folder = newest tag
          c: at('rel', 'T2'), // installed folder = newest week-old tag
          d: at('dr', 'TD'), // only one stable release; drafts and prereleases never count
          e: at('gone', 'TG'), // folder missing at the newest release
          f: at('rel', 'nope', { ref: 'v1.0.0' }), // no tag matches the folder; the ref pins
        } }),
      });
      const r = rows(db);
      // Older week-old tag matches the install: current is that tag, the newer week-old tag targets.
      assert.deepEqual([r.a.current, r.a.latest, r.a.target, r.a.publishedAt, r.a.notesUrl, r.a.error ?? null],
        ['v1.0.0', 'v3.0.0', 'v2.0.0', old30, 'u200', null], JSON.stringify(r.a));
      // The folder at the newest tag is installed: current === latest (Ottr drops the row), no target.
      assert.deepEqual([r.b.current, r.b.latest, r.b.target, r.b.publishedAt, r.b.notesUrl],
        ['v3.0.0', 'v3.0.0', null, fresh2, 'u300'], JSON.stringify(r.b));
      // The young newest release never targets; the newest week-old tag reads as current.
      assert.deepEqual([r.c.current, r.c.latest, r.c.target, r.c.publishedAt],
        ['v2.0.0', 'v3.0.0', null, fresh2], JSON.stringify(r.c));
      // Drafts and prereleases are invisible: the single stable release is latest and current.
      assert.deepEqual([r.d.current, r.d.latest, r.d.target, r.d.removed ?? null], ['v1.0.0', 'v1.0.0', null, null]);
      // Folder gone at the newest release: notification row with the latest release's metadata.
      assert.deepEqual([r.e.current, r.e.latest, r.e.target, r.e.removed, r.e.publishedAt, r.e.notesUrl, r.e.error ?? null],
        ['TG', 'v2.0.0', null, true, old30, 'g2', null], JSON.stringify(r.e));
      // The removed row stops at the newest release: the older tag's tree is never fetched.
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/gone/git/trees/v1.0.0').length, 0);
      // No tag matches the installed folder: a lock ref equal to a release tag pins current.
      assert.deepEqual([r.f.current, r.f.latest, r.f.target], ['v1.0.0', 'v3.0.0', 'v2.0.0'], JSON.stringify(r.f));
      // One releases fetch per repo and one tree fetch per (repo, tag) across all six rows.
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/rel/releases').length, 1);
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/rel/git/trees/v2.0.0').length, 1);
      // Diffs: only files inside the skill dir, each with the per-file sha256 GitHub anchor.
      const anchor = (b, h, f) =>
        `https://github.com/o/rel/compare/${b}...${h}#diff-${createHash('sha256').update(f).digest('hex')}`;
      assert.deepEqual(r.a.diffs, [
        { file: 'skills/k/CHANGED.md', url: anchor('v1.0.0', 'v2.0.0', 'skills/k/CHANGED.md') },
        { file: 'skills/k/sub/new.md', url: anchor('v1.0.0', 'v2.0.0', 'skills/k/sub/new.md') },
      ], JSON.stringify(r.a.diffs));
      // current === latest serves no diffs.
      assert.ok(!('diffs' in r.b));
      // A young latest with an older current still diffs current against the picked latest tag.
      assert.deepEqual(r.c.diffs,
        [{ file: 'skills/k/NEW.md', url: anchor('v2.0.0', 'v3.0.0', 'skills/k/NEW.md') }], JSON.stringify(r.c.diffs));
      // current === latest on the single-stable-release row: no diffs.
      assert.ok(!('diffs' in r.d));
      // The served record (the stored updates row) carries the same diffs list.
      assert.deepEqual(rawRows(db).find(v => v.name === 'a').diffs, r.a.diffs);
      // The compare fetch is memoized per (repo, base, head): rows a and f share one fetch.
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/rel/compare/v1.0.0...v2.0.0').length, 1);
    }

    // Release streams: one repo publishes several release lines (`skill-v4.7.0`, `cli-v4.7.0`,
    // `engine-v0.1.16`). The row tracks one stream, picked by the upstreams tagPrefix, the lock
    // ref, the `skill` prefix, the empty prefix or the single stream; versions compare parsed,
    // row values keep the raw tag text.
    {
      const tree = sha => [200, { tree: [{ path: 'skills/k', type: 'tree', sha }] }];
      handler = url => {
        if (url.pathname === '/gh/repos/o/ms/releases') return [200, [
          { tag_name: 'skill-v4.7.0', draft: false, prerelease: false, published_at: old30, html_url: 'us47' },
          { tag_name: 'cli-v4.7.0', draft: false, prerelease: false, published_at: old30, html_url: 'uc47' },
          { tag_name: 'skill-v4.6.0', draft: false, prerelease: false, published_at: old30, html_url: 'us46' },
          { tag_name: 'cli-v4.6.0', draft: false, prerelease: false, published_at: old30, html_url: 'uc46' },
          { tag_name: 'skill-v3.9.1', draft: false, prerelease: false, published_at: old30, html_url: 'us39' },
          { tag_name: 'engine-v0.1.16', draft: false, prerelease: false, published_at: old30, html_url: 'ue0' },
        ]];
        for (const [tag, sha] of [['skill-v4.7.0', 'S47'], ['skill-v4.6.0', 'S46'], ['skill-v3.9.1', 'S39'], ['cli-v4.7.0', 'C47'], ['cli-v4.6.0', 'C46'], ['engine-v0.1.16', 'E0']])
          if (url.pathname === `/gh/repos/o/ms/git/trees/${tag}`) return tree(sha);
        for (const [b, h] of [['skill-v4.6.0', 'skill-v4.7.0'], ['cli-v4.6.0', 'cli-v4.7.0']])
          if (url.pathname === `/gh/repos/o/ms/compare/${b}...${h}`) return [200, { files: [{ filename: 'skills/k/F.md' }] }];
        // An unprefixed ref (`v1.0.0`) must keep the empty-prefix stream, even next to a skill- stream.
        if (url.pathname === '/gh/repos/o/unp/releases') return [200, [
          { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'uv1' },
          { tag_name: 'v2.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'uv2' },
          { tag_name: 'skill-v9.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'us9' },
        ]];
        for (const [tag, sha] of [['v1.0.0', 'U1'], ['v2.0.0', 'U2'], ['skill-v9.0.0', 'U9']])
          if (url.pathname === `/gh/repos/o/unp/git/trees/${tag}`) return tree(sha);
        if (url.pathname === '/gh/repos/o/unp/compare/v1.0.0...v2.0.0') return [200, { files: [] }];
        // A HEAD install matching no tag: the young v2.0.0 has the folder, the week-old v1.0.0 lacks it.
        if (url.pathname === '/gh/repos/o/nof/releases') return [200, [
          { tag_name: 'v2.0.0', draft: false, prerelease: false, published_at: fresh2, html_url: 'un2' },
          { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: old30, html_url: 'un1' },
        ]];
        if (url.pathname === '/gh/repos/o/nof/git/trees/v2.0.0') return tree('N2');
        if (url.pathname === '/gh/repos/o/nof/git/trees/v1.0.0') return [200, { tree: [{ path: 'other', type: 'tree', sha: 'X' }] }];
        if (url.pathname === '/gh/repos/o/ord/compare/skill-v4.9.0...skill-v4.10.0') return [200, { files: [{ filename: 'skills/k/F.md' }] }];
        // Ordering: 4.10.0 sorts above 4.9.0 only by parsed version.
        if (url.pathname === '/gh/repos/o/ord/releases') return [200, [
          { tag_name: 'skill-v4.9.0', draft: false, prerelease: false, published_at: old30, html_url: 'u49' },
          { tag_name: 'skill-v4.10.0', draft: false, prerelease: false, published_at: old30, html_url: 'u410' },
        ]];
        if (url.pathname === '/gh/repos/o/ord/git/trees/skill-v4.9.0') return tree('O49');
        if (url.pathname === '/gh/repos/o/ord/git/trees/skill-v4.10.0') return tree('O410');
        // Two unrelated streams: no skill prefix and no empty prefix, so the repo has no
        // usable stream and the rows fall back to the SHA behavior.
        if (url.pathname === '/gh/repos/o/fall/releases') return [200, [
          { tag_name: 'cli-v1', draft: false, prerelease: false, published_at: old30, html_url: 'uc1' },
          { tag_name: 'engine-v2', draft: false, prerelease: false, published_at: old30, html_url: 'ue2' },
        ]];
        if (url.pathname === '/gh/repos/o/fall/commits') return [200, [{ sha: 'HF', commit: { committer: { date: old30 } }, html_url: 'fu' }]];
        if (url.pathname === '/gh/repos/o/fall/git/trees/HEAD') return [200, { tree: [{ path: 'skills/k', type: 'tree', sha: 'TF' }] }];
        return null;
      };
      hits.length = 0;
      const at = (repo, hash, extra = {}) =>
        ({ sourceUrl: `https://github.com/o/${repo}`, skillPath: 'skills/k/SKILL.md', skillFolderHash: hash, ...extra });
      const db = await run({
        'upstreams.json': UP([item('msa', { kind: 'skill', check: { tagPrefix: 'engine-' } })]),
        'user/agents/.skill-lock.json': JSON.stringify({ skills: {
          ms: at('ms', 'S46'), // the skill- stream wins; the installed folder is the older week-old tag
          msb: at('ms', 'nope', { ref: 'cli-v4.6.0' }), // the ref names a stable tag: the cli- stream, ref pins current
          msa: at('ms', 'nope2'), // the upstreams tagPrefix knob pins the engine- stream
          ord: at('ord', 'O49'), // parsed-version ordering: 4.10.0 above 4.9.0
          fall: at('fall', 'hF'), // no usable stream: SHA head/path behavior
          unp: at('unp', 'nope3', { ref: 'v1.0.0' }), // unprefixed ref: the '' stream, not skill-
          nof: at('nof', 'headHash'), // HEAD install; the only week-old release lacks the folder
        } }),
      });
      const r = rows(db);
      // The skill- stream is picked from the multi-stream repo; cli-/engine- tags never surface.
      assert.deepEqual([r.ms.current, r.ms.latest, r.ms.target, r.ms.publishedAt, r.ms.notesUrl, r.ms.error ?? null],
        ['skill-v4.6.0', 'skill-v4.7.0', 'skill-v4.7.0', old30, 'us47', null], JSON.stringify(r.ms));
      // Rule b: the lock ref picks the cli- stream and pins current; the target needs the parsed
      // versions (the raw tag strings compare equal).
      assert.deepEqual([r.msb.current, r.msb.latest, r.msb.target],
        ['cli-v4.6.0', 'cli-v4.7.0', 'cli-v4.7.0'], JSON.stringify(r.msb));
      // Rule a: the upstreams tagPrefix knob overrides the skill guess.
      assert.deepEqual([r.msa.current, r.msa.latest, r.msa.target],
        ['nope2', 'engine-v0.1.16', 'engine-v0.1.16'], JSON.stringify(r.msa));
      // Parsed-version ordering: 4.10.0 sorts above 4.9.0.
      assert.deepEqual([r.ord.current, r.ord.latest, r.ord.target],
        ['skill-v4.9.0', 'skill-v4.10.0', 'skill-v4.10.0'], JSON.stringify(r.ord));
      // Rule f: no usable stream, the row keeps the SHA head/path behavior.
      assert.deepEqual([r.fall.current, r.fall.latest, r.fall.target, r.fall.error ?? null],
        ['hF', 'HF', 'HF', null], JSON.stringify(r.fall));
      // The release list is still memoized per repo across the three ms rows.
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/ms/releases').length, 1);
      // Rule b with an unprefixed ref: the empty-prefix stream wins over the skill- stream.
      assert.deepEqual([r.unp.current, r.unp.latest, r.unp.target, r.unp.notesUrl],
        ['v1.0.0', 'v2.0.0', 'v2.0.0', 'uv2'], JSON.stringify(r.unp));
      // A release without the skill folder is never the target, even when it is the only week-old one.
      // The row picks the young release that has the folder: latest v2.0.0 with its notes and
      // publish time (target stays null until the 7-day rule passes; Ottr offers Propose now).
      assert.deepEqual(
        [r.nof.current, r.nof.latest, r.nof.target, r.nof.notesUrl, r.nof.publishedAt, r.nof.removed ?? null],
        ['headHash', 'v2.0.0', null, 'un2', fresh2, null], JSON.stringify(r.nof));
      // The compare fetch is memoized per (repo, base, head) across ms and msb.
      assert.equal(hits.filter(h => h.p === '/gh/repos/o/ms/compare/skill-v4.6.0...skill-v4.7.0').length, 1);
      // A current that is a folder hash (row msa, no tag matched) gets no diffs.
      assert.ok(!('diffs' in r.msa));
    }

    // Plugin rows: git specs, npm aliases, semver specs, skipped shapes, missing locks.
    {
      handler = url => {
        if (url.pathname === '/npm/@s/alias') return [200, { time: { '3.0.0': old30 } }];
        if (url.pathname === '/npm/@ab@/c') return [200, { time: {} }];
        if (url.pathname === '/npm/plug2') return [200, { time: { '4.0.0': old30 } }];
        if (url.pathname === '/npm/plain') return [200, { time: { '5.0.1': old30 } }];
        if (url.pathname === '/npm/a') return [200, { time: { '1.0.0': old30 } }];
        if (url.pathname === '/npm/@a@b/c') return [200, { time: {} }];
        if (url.pathname === '/gh/repos/JuliusB/plugx/commits') return [200, [{ sha: 'PX9', commit: { committer: { date: old30 } }, html_url: 'xu' }]];
        return null;
      };
      hits.length = 0;
      const bun = `{
  "workspaces": { "": { "dependencies": {
    "plug1": "github:JuliusB/plugx",
    "plug3": "github:JuliusB/plugx",
    "g1": "npm:@s/alias",
    "ab": "npm:@ab@/c",
    "al": "npm:a@b/c@1.0.0",
    "al2": "npm:@a@b/c",
    "plug2": "^4.0.0",
    "plain": "^5.0.0",
    "mix": "gitlab:github:o/r",
    "mix2": "look:1",
    "mx": "look.1",
    "my2": "^2.0.0",
    "gitpin": "git+https://github.com/fake/gitpin.git",
    "nolock": "^1.0.0",
  } } },
  "packages": {
    "plug1": ["plug1@github:JuliusB/plugx#cafe123", "", {}],
    "plug3": ["plug3@github:JuliusB/plugx", "", {}],
    "g1": ["g1@1.2.3", "", {}],
    "ab": ["ab@1.0.0", "", {}],
    "al": ["al@1.0.0", "", {}],
    "al2": ["al2@2.0.0", "", {}],
    "plug2": ["plug2@4.0.0", "", {}],
    "plain": ["5.0.1", "", {}],
    "mix": ["mix@github:o/r#sha1", "", {}],
    "mix2": ["mix2@5.0.0", "", {}],
    "mx": ["mx@1.0.9", "", {}],
    "my2": ["my2@abc1.0", "", {}],
  },
}`;
      const db = await run({ 'upstreams.json': UP([{ name: 'plug2', kind: 't' }]), 'user/omp/plugins/bun.lock': bun });
      const r = rows(db);
      assert.deepEqual([r.plug1.current, r.plug1.latest, r.plug1.target, r.plug1.origin], ['cafe123', 'PX9', 'PX9', 'https://github.com/JuliusB/plugx']);
      assert.deepEqual(hits.find(h => h.p === '/gh/repos/JuliusB/plugx/commits').q, { per_page: '1' });
      assert.deepEqual([r.g1.current, r.g1.latest, r.g1.target, r.g1.kind, r.g1.pin], ['1.2.3', '3.0.0', '3.0.0', 'plugin', { file: 'user/omp/plugins/bun.lock', key: 'g1' }], 'npm: aliases check the aliased package');
      assert.equal(r.al.current, '1.0.0', 'an npm: body with a slash before @ checks the package before the slash');
      assert.ok(hits.some(h => h.p === '/npm/@a@b/c'), 'a scoped token without a slash version stays whole');
      assert.ok(hits.some(h => h.p === '/npm/@ab@/c'), 'an @-body checks the whole token when no @ follows the slash');
      assert.deepEqual([r.plug2.current, r.plug2.latest], ['4.0.0', '4.0.0']);
      assert.equal(r.plain.current, '5.0.1', 'a locked value without the name@ prefix is taken verbatim');
      for (const gone of ['plug3', 'mix', 'mix2', 'mx', 'my2', 'gitpin', 'nolock'])
        assert.equal(r[gone], undefined, `${gone} is skipped`);
      assert.equal(rawRows(db).find(v => v.name === 'plug1')._row, 'plugin:plug1');
      assert.equal(rawRows(db).filter(v => v._row === 'item:plug2').length, 0, 'a plugin row takes the name from the items loop');
    }

    // checkUpdates: failed checks carry the previous row forward; prev rows come from stored JSON.
    {
      handler = url => url.pathname === '/npm/n1' ? [200, { time: { '0.1': old30 } }] : null;
      const db = mkDb({ 'upstreams.json': UP([item('n1', { version: '0.0.1', check: { type: 'npm', package: 'n1' } }), item('px', { check: { type: 'npm', package: 'px-missing' } })]) });
      db.prepare('INSERT INTO updates (id, value) VALUES (?, ?)').run('j1', 'null');
      db.prepare('INSERT INTO updates (id, value) VALUES (?, ?)').run('j2', JSON.stringify({ name: 'legacy', current: '0.9' }));
      await checkUpdates(db, { dataRepo: 'demo/data', token: 'tok-xyz' });
      assert.equal(rows(db).n1.latest, '0.1');
      handler = () => null; // the registry goes dark
      await checkUpdates(db, { dataRepo: 'demo/data', token: 'tok-xyz' });
      const after = rows(db).n1;
      assert.equal(after.error, `GET ${upBase}/npm/n1 failed: HTTP 404`);
      assert.deepEqual([after.latest, after.target, after.current], ['0.1', '0.1', '0.0.1'], 'the failed check keeps the last result');
      assert.equal(rawRows(db).find(v => v.name === 'n1')._row, 'item:n1');
      // A stored prev row written by hand is picked up through the _row key.
      db.prepare('INSERT INTO updates (id, value) VALUES (?, ?)').run('px@7.7.7',
        JSON.stringify({ name: 'px', _row: 'item:px', current: '1.0.0', latest: '7.7.7', target: '7.7.7', id: 'px@7.7.7', checkedAt: '2020-01-01T00:00:00.000Z' }));
      await checkUpdates(db, { dataRepo: 'demo/data', token: 'tok-xyz' });
      const px = rows(db).px;
      assert.deepEqual([px.latest, px.target, px.current], ['7.7.7', '7.7.7', '1.0.0'], 'the carried row keeps its values');
      assert.match(px.error, /failed: HTTP 404$/);
      assert.ok(px.checkedAt > '2020-01-01T00:00:00.000Z');
      assert.ok(!rawRows(db).some(v => v.name === 'px2'), 'each run replaces the stored rows');
    }

    // managedBy rows never target; checkUpdates defaults; the transaction rollback keeps nothing.
    {
      handler = url => url.pathname === '/npm/m1' ? [200, { time: { '0.1': old30 } }] : null;
      const r = rows(await run({ 'upstreams.json': UP([item('m1', { version: '0.0.1', check: { type: 'npm', package: 'm1' }, managedBy: 'alate sync' })]) }));
      assert.deepEqual([r.m1.latest, r.m1.target], ['0.1', null], 'managed rows are recorded, never targeted');
      const dbd = mkDb({ 'upstreams.json': UP([]) });
      assert.deepEqual(await checkUpdates(dbd), { checkedAt: null, count: 0 }, 'default opts run clean over an empty snapshot');
      dbd.close();
      const dbx = new DatabaseSync(':memory:');
      dbx.exec('CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT)');
      dbx.prepare('INSERT INTO files (path, content) VALUES (?, ?)').run('upstreams.json', UP([item('y')]));
      dbx.exec('CREATE TABLE updates (id TEXT, value TEXT, extra TEXT NOT NULL)');
      dbx.prepare('INSERT INTO updates (id, value, extra) VALUES (?, ?, ?)').run('sentinel', '{"name":"sentinel"}', 'x');
      await assert.rejects(checkUpdates(dbx, {}), /NOT NULL/, 'a failed insert rolls the batch back and rethrows');
      assert.equal(dbx.prepare('SELECT COUNT(*) AS n FROM updates').get().n, 1, 'the failed batch left the stored rows untouched');
      dbx.close();
    }

    // loadUpdates: sort by name then id, junk rows skipped, _row stripped, checkedAt max.
    {
      const db = new DatabaseSync(':memory:');
      initUpdates(db);
      const ins = db.prepare('INSERT INTO updates (id, value) VALUES (?, ?)');
      ins.run('A@2', JSON.stringify({ name: 'A', id: 'A@2', checkedAt: '2026-01-02T00:00:00.000Z' }));
      ins.run('A@1', JSON.stringify({ name: 'A', id: 'A@1', checkedAt: '2026-01-03T00:00:00.000Z' }));
      ins.run('B@1', JSON.stringify({ name: 'B', id: 'B@1', checkedAt: '2026-01-01T00:00:00.000Z', _row: 'x' }));
      ins.run('B@0', JSON.stringify({ name: 'B', id: 'B@0', checkedAt: '2026-01-05T00:00:00.000Z' }));
      ins.run('C@1', JSON.stringify({ name: 'C', id: 'C@1', checkedAt: '2026-01-04T00:00:00.000Z' }));
      ins.run('bad', '{oops');
      ins.run('z@1', JSON.stringify({ id: 'z@1' }));
      const doc = loadUpdates(db);
      assert.deepEqual(doc.updates.map(u => u.id), ['z@1', 'A@1', 'A@2', 'B@0', 'B@1', 'C@1'], JSON.stringify(doc.updates.map(u => u.id)));
      assert.equal(doc.checkedAt, '2026-01-05T00:00:00.000Z');
      assert.ok(!('_row' in doc.updates.find(u => u.id === 'B@1')));
      assert.deepEqual(loadUpdates(mkDb({})), { checkedAt: null, updates: [] });
      db.close();
    }
  } finally {
    envKeys.forEach((k, i) => { if (savedEnv[i] === undefined) delete process.env[k]; else process.env[k] = savedEnv[i]; });
    fakeUp.closeAllConnections();
    await new Promise(resolve => fakeUp.close(resolve));
  }
}

  // Mutation survivors covered by this section: web/dashboard.mjs ====
  {
    // Direct unit tests over the exported dashboard module. Env is set before the
    // cache-busted import so module-level GH_BASE points at the local fixture remote.
    process.env.ALATE_TEST_GH_BASE = pathToFileURL(join(tmp, 'gh10')).href;
    process.env.GIT_CONFIG_GLOBAL = 'nul';
    process.env.GIT_CONFIG_SYSTEM = 'nul';
    const dash = await import('./web/dashboard.mjs?alat10');
    const w10 = join(tmp, 'alat10');
    const gh10 = join(tmp, 'gh10');
    const dig = (p, c = '') => { mkdirSync(dirname(join(w10, p)), { recursive: true }); writeFileSync(join(w10, p), c); };
    const ddir = p => mkdirSync(join(w10, p), { recursive: true });
    const fm = d => `---\ndescription: ${d}\n---\n`;
    const git10 = (args, opts = {}) => git(args, { ...opts, cwd: w10, encoding: 'utf8' });
    const scan10 = d => dash.scanInventory(join(w10, d));
    const err10 = fn => { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); };

    // -- scanInventory: empty repo returns the full default shape.
    ddir('e10');
    assert.deepEqual(scan10('e10'), {
      rules: [], user: { configFiles: [], others: [], skills: [], extensions: [], plugins: [] },
      projects: { contextFiles: [], named: [] },
      counts: { rules: 0, skills: 0, plugins: 0, extensions: 0, projects: 0, userFiles: 0 }, warnings: [],
    });

    // -- projects/ dir without projects.json warns; the default contextFiles survives.
    ddir('mp10/projects');
    const mp = scan10('mp10');
    assert.deepEqual([mp.projects.contextFiles, mp.warnings],
      [[], ['projects/projects.json: missing or unparseable; showing what exists']]);

    // -- main inventory fixture: rules, user layer, plugins, projects, counts.
    dig('main10/demo-rule.md', fm('demo rule'));
    dig('main10/extra.mdc', fm('mdc rule'));
    dig('main10/plain.md', 'no frontmatter\n');
    dig('main10/readme.md', 'lowercase readme is a rule\n');
    dig('main10/AGENTS.md', '# excluded\n');
    dig('main10/README.md', '# excluded\n');
    dig('main10/UP.MD', '# wrong case\n');
    dig('main10/notes.mdc.bak', '# not a rule\n');
    ddir('main10/sub.md'); // a directory named *.md is not a rule
    dig('main10/user/omp/agent/config.yml', 'model: x\n'); // 9 bytes
    dig('main10/user/omp/agent/mcp.json', '{}');
    dig('main10/user/omp/agent/optimizer.json', '{}');
    dig('main10/user/omp/marketplaces.json', '{}');
    dig('main10/user/omp/plugins/package.json', JSON.stringify({ dependencies: { '@scope/demo': '^1.0.0', dup: '^1.0.0' } }));
    dig('main10/user/omp/plugins/omp-plugins.lock.json', JSON.stringify({ plugins: { lockp: {}, dup: {}, lockinst: {} } }));
    dig('main10/user/omp/plugins/installed_plugins.json', JSON.stringify({ plugins: { instp: {}, dup: {}, lockinst: {} } }));
    dig('main10/user/omp/plugins/bun.lock', '');
    dig('main10/user/.agents/.skill-lock.json', '{}');
    symlinkSync(join(tmp, 'home'), join(w10, 'main10/user/link.txt')); // symlinks are never counted
    dig('main10/user/omp/agent/skills/demo/SKILL.md', fm('demo skill'));
    dig('main10/user/omp/agent/skills/file.txt', 'a file, not a skill dir\n');
    dig('main10/user/omp/agent/managed-skills/msk/SKILL.md', fm('msk skill'));
    ddir('main10/user/.agents/skills/ask'); // no SKILL.md: description stays ''
    ddir('main10/user/omp/agent/extensions/ext-a');
    ddir('main10/user/omp/agent/extensions/ext-b');
    dig('main10/user/omp/agent/extensions/zfile.txt', 'listed too\n');
    dig('main10/projects/alpha/s2.md', 'two\n');
    dig('main10/projects/alpha/s1.md', 'one\n');
    dig('main10/projects/alpha/sub/inner.md', 'inner\n'); // nested snapshot file
    symlinkSync(join(tmp, 'home'), join(w10, 'main10/projects/alpha/lnk')); // symlinks are never listed
    writeFileSync(join(w10, 'main10/projects/projects.json'), JSON.stringify({
      contextFiles: ['ctx.md'],
      projects: { alpha: ['z9.md', 'a0.md'], '.': [], '..': [], '': [], 'bad/name': [], badextras: 'nope', numextras: [1] },
    }));
    const inv = scan10('main10');
    assert.deepEqual(inv, {
      rules: [
        { name: 'demo-rule.md', description: 'demo rule' },
        { name: 'extra.mdc', description: 'mdc rule' },
        { name: 'plain.md', description: '' },
        { name: 'readme.md', description: '' },
      ],
      user: {
        configFiles: [
          { path: 'omp/agent/config.yml', bytes: 9 }, { path: 'omp/agent/mcp.json', bytes: 2 },
          { path: 'omp/agent/optimizer.json', bytes: 2 }, { path: 'omp/marketplaces.json', bytes: 2 },
        ],
        others: [
          { path: '.agents/.skill-lock.json', bytes: 2 }, { path: 'omp/plugins/bun.lock', bytes: 0 },
          { path: 'omp/plugins/installed_plugins.json', bytes: 47 }, { path: 'omp/plugins/omp-plugins.lock.json', bytes: 47 },
          { path: 'omp/plugins/package.json', bytes: 56 },
        ],
        skills: [
          { name: 'demo', origin: 'skills', description: 'demo skill' },
          { name: 'msk', origin: 'managed-skills', description: 'msk skill' },
          { name: 'ask', origin: 'agents-skills', description: '' },
        ],
        extensions: ['ext-a', 'ext-b', 'zfile.txt'],
        plugins: [
          { name: '@scope/demo', version: '^1.0.0', origin: 'package.json' },
          { name: 'dup', version: '^1.0.0', origin: 'package.json' },
          { name: 'lockp', origin: 'omp-plugins.lock.json' },
          { name: 'lockinst', origin: 'omp-plugins.lock.json' },
          { name: 'instp', origin: 'installed_plugins.json' },
        ],
      },
      projects: {
        contextFiles: ['ctx.md'],
        named: [{
          name: 'alpha', extras: 2, files: 3, live: 'off',
          entries: [
            { path: 's1.md', bytes: 4, status: 'unknown' },
            { path: 's2.md', bytes: 4, status: 'unknown' },
            { path: 'sub/inner.md', bytes: 6, status: 'unknown' },
          ],
        }],
      },
      counts: { rules: 4, skills: 3, plugins: 5, extensions: 3, projects: 1, userFiles: 13 },
      warnings: [
        'projects/projects.json: rejected unsafe project name "."',
        'projects/projects.json: rejected unsafe project name ".."',
        'projects/projects.json: rejected unsafe project name ""',
        'projects/projects.json: rejected unsafe project name "bad/name"',
        'projects/projects.json: extras for "badextras" must be an array of strings; project skipped',
        'projects/projects.json: extras for "numextras" must be an array of strings; project skipped',
      ],
    });

    // -- live drift: sync/changed/missing/uncaptured, unsafe snapshot paths, live escapes.
    dig('live10/data/projects/alpha/s1.md', 'one\n');
    dig('live10/data/projects/alpha/s2.md', 'two\n');
    dig('live10/data/projects/alpha/s3.md', 'three\n');
    writeFileSync(join(w10, 'live10/data/projects/projects.json'), JSON.stringify({
      contextFiles: ['gone.md', 'ctx.md'],
      projects: {
        alpha: ['z9.md', 'a0.md', 'sub\\x.md', '../nope.md', 'link/x.md', 'r/./s.md', 'p//q.md'],
        esc: [], ghost: [],
      },
    }));
    ddir('live10/ws/alpha');
    writeFileSync(join(w10, 'live10/ws/alpha/s1.md'), 'one\n'); // identical: sync
    writeFileSync(join(w10, 'live10/ws/alpha/s2.md'), 'changed\n'); // differs: changed
    writeFileSync(join(w10, 'live10/ws/alpha/ctx.md'), 'ctx\n'); // uncaptured context file
    writeFileSync(join(w10, 'live10/ws/alpha/z9.md'), 'z\n');
    writeFileSync(join(w10, 'live10/ws/alpha/a0.md'), 'a\n');
    writeFileSync(join(w10, 'live10/ws/alpha/sub\\x.md'), 'sx\n'); // mutant bait: the un-normalized name
    writeFileSync(join(w10, 'live10/ws/alpha/subx.md'), 'bait\n');
    mkdirSync(join(w10, 'live10/out'), { recursive: true });
    writeFileSync(join(w10, 'live10/out/x.md'), 'x\n'); // the symlink escape carries a real file
    symlinkSync(join(w10, 'live10/out'), join(w10, 'live10/ws/alpha/link')); // escapes the live root
    symlinkSync(join(w10, 'live10/out'), join(w10, 'live10/ws/esc')); // live dir escapes
    const live = dash.scanInventory(join(w10, 'live10/data'), join(w10, 'live10/ws'));
    assert.deepEqual(live.projects.named, [
      {
        name: 'alpha', extras: 7, files: 3, live: 'checked',
        entries: [
          { path: 'a0.md', bytes: 2, status: 'uncaptured' },
          { path: 'ctx.md', bytes: 4, status: 'uncaptured' },
          { path: 's1.md', bytes: 4, status: 'sync' },
          { path: 's2.md', bytes: 4, status: 'changed' },
          { path: 's3.md', bytes: 6, status: 'missing' },
          { path: 'z9.md', bytes: 2, status: 'uncaptured' },
        ],
      },
      { name: 'esc', extras: 0, files: 0, live: 'off', entries: [] },
      { name: 'ghost', extras: 0, files: 0, live: 'gone', entries: [] },
    ]);
    assert.deepEqual(live.warnings, [
      'alpha: rejected unsafe snapshot path "../nope.md"',
      'alpha: rejected unsafe snapshot path "link/x.md"',
      'alpha: rejected unsafe snapshot path "r/./s.md"',
      'alpha: rejected unsafe snapshot path "p//q.md"',
      'esc: live project dir escapes the workspace; drift not checked',
    ]);

    // -- contextFiles must be all strings; projects must be a non-null object.
    ddir('bd10/data/projects/alpha');
    writeFileSync(join(w10, 'bd10/data/projects/alpha/b\\d.md'), 'bd\n'); // normalized rel breaks statSync
    writeFileSync(join(w10, 'bd10/data/projects/alpha/bd.md'), 'bd\n'); // the un-normalized name exists too
    ddir('bd10/ws');
    writeFileSync(join(w10, 'bd10/data/projects/projects.json'), JSON.stringify({ contextFiles: [], projects: { alpha: [] } }));
    assert.throws(() => dash.scanInventory(join(w10, 'bd10/data'), join(w10, 'bd10/ws')), /ENOENT/);
    ddir('lb10/data/projects');
    writeFileSync(join(w10, 'lb10/data/projects/projects.json'), JSON.stringify({ contextFiles: ['ok.md', 5], projects: null }));
    const lb = dash.scanInventory(join(w10, 'lb10/data'), join(w10, 'lb10/ws'));
    assert.deepEqual([lb.projects.contextFiles, lb.warnings], [
      [],
      ['projects/projects.json: contextFiles must be an array of strings; ignored',
        'projects/projects.json: projects must be an object; ignored'],
    ]);

    // -- unparseable plugin JSON warns and skips that source only.
    dig('uj10/user/omp/plugins/package.json', '{not json');
    dig('uj10/user/omp/plugins/omp-plugins.lock.json', JSON.stringify({ plugins: { lockp: {} } }));
    const uj = scan10('uj10');
    assert.deepEqual([uj.user.plugins, uj.warnings], [
      [{ name: 'lockp', origin: 'omp-plugins.lock.json' }],
      ['user/omp/plugins/package.json: unparseable JSON, skipped'],
    ]);

    // -- symlink escapes: caught warnings or throws, one per guarded call site.
    ddir('sxE/out');
    symlinkSync(join(w10, 'sxE/out'), join(w10, 'sxE/data-x'));
    ddir('sx-user/data'); symlinkSync(join(w10, 'sxE/out'), join(w10, 'sx-user/data/user'));
    const su = scan10('sx-user/data');
    assert.deepEqual([su.counts.userFiles, su.warnings], [0, ['user/: link escapes the data repo; count skipped']]);
    ddir('sx-omp/data'); dig('sx-omp/out/projects.json', '{}');
    symlinkSync(join(w10, 'sx-omp/out'), join(w10, 'sx-omp/data/projects'));
    assert.throws(() => scan10('sx-omp/data'), /Source .* is outside/); // readJson guard
    ddir('sx-agent/data/user/omp'); dig('sx-agent/out/config.yml', 'x\n');
    symlinkSync(join(w10, 'sx-agent/out'), join(w10, 'sx-agent/data/user/omp/agent'));
    assert.throws(() => scan10('sx-agent/data'), /Source .* is outside/); // configFiles guard
    ddir('sx-agents/data/user'); dig('sx-agents/out/.skill-lock.json', '{}');
    symlinkSync(join(w10, 'sx-agents/out'), join(w10, 'sx-agents/data/user/.agents'));
    assert.throws(() => scan10('sx-agents/data'), /Source .* is outside/); // others guard
    ddir('sx-skills/data/user/omp/agent'); ddir('sx-skills/out/sd');
    symlinkSync(join(w10, 'sx-skills/out'), join(w10, 'sx-skills/data/user/omp/agent/skills'));
    assert.throws(() => scan10('sx-skills/data'), /Source .* is outside/); // skill dirs guard
    ddir('sx-ext/data/user/omp/agent'); symlinkSync(join(w10, 'sxE/out'), join(w10, 'sx-ext/data/user/omp/agent/extensions'));
    const se = scan10('sx-ext/data');
    assert.deepEqual([se.user.extensions, se.warnings],
      [[], ['user/omp/agent/extensions: link escapes the data repo; skipped']]);

    // -- importSource: snapshot walk skips VCS dirs, stores nested paths, rolls nothing back.
    const mkDb10 = name => {
      const db = new DatabaseSync(join(tmp, name));
      db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL); CREATE TABLE files (path TEXT PRIMARY KEY, content BLOB NOT NULL)');
      return db;
    };
    dig('if10/top.md', 'top\n');
    dig('if10/sub/note.md', 'note\n');
    dig('if10/node_modules/x.js', 'x\n');
    dig('if10/__pycache__/y.pyc', 'p\n');
    ddir('if10/.git'); ddir('if10/.git/objects'); dig('if10/.git/HEAD', 'ref: refs/heads/main\n');
    const dbI = mkDb10('alat10-i.db');
    const st0 = dash.loadState(dbI);
    assert.deepEqual(st0, { source: null, inventory: null, previous: null, changes: null });
    const st1 = dash.importSource(st0, join(w10, 'if10'), undefined, null, dbI);
    assert.deepEqual([st1.source.kind, st1.source.ref, st1.source.importedSha], ['path', '', '']);
    assert.deepEqual(dash.listStoredFiles(dbI).map(r => ({ ...r })), [{ path: 'sub/note.md', bytes: 5 }, { path: 'top.md', bytes: 4 }]);
    assert.deepEqual(dash.loadState(dbI), st1);

    // -- colon paths and non-regular files are refused with a 400.
    dig('ifc/a:b.md', 'x\n');
    const dbC = mkDb10('alat10-c.db');
    let e = err10(() => dash.importSource(dash.loadState(dbC), join(w10, 'ifc'), undefined, null, dbC));
    assert.deepEqual([e.status, e.message], [400, 'unsafe snapshot path: a:b.md']);
    dig('iff/top.md', 'x\n');
    assert.equal(spawnSync('mkfifo', [join(w10, 'iff/pipe10')]).status, 0);
    const dbF = mkDb10('alat10-f.db');
    e = err10(() => dash.importSource(dash.loadState(dbF), join(w10, 'iff'), undefined, null, dbF));
    assert.deepEqual([e.status, e.message], [400, 'snapshot path is not a regular file: pipe10']);

    // -- resolveSource refusals are 400s with the documented messages.
    e = err10(() => dash.importSource(dash.loadState(dbI), join(w10, 'gone10'), 'path', null, dbI));
    assert.equal(e.status, 400);
    assert.match(e.message, /^no local data repo at /);
    for (const bad of ['./.x/y', '.x/y', 'C:/own/data']) {
      e = err10(() => dash.importSource(dash.loadState(dbI), bad, 'repo', null, dbI));
      assert.equal(e.status, 400, bad);
      assert.equal(e.message, `no data repo at ${bad}; pass a local path or owner/name[@ref]`, bad);
    }

    // -- computeChanges: rules/skills/plugins/extensions/user/projects deltas.
    const buildAB = () => {
      const a = join(w10, 'ifa');
      dig('ifa/keep.md', fm('keep'));
      dig('ifa/mod.md', fm('old ten'));
      dig('ifa/del.md', fm('del ten'));
      dig('ifa/user/omp/agent/config.yml', 'x\n');
      dig('ifa/user/omp/agent/skills/sk/SKILL.md', fm('sk desc'));
      ddir('ifa/user/omp/agent/extensions/ext-a');
      dig('ifa/user/omp/plugins/package.json', JSON.stringify({ dependencies: { p1: '1.0.0' } }));
      dig('ifa/projects/ctx.md', 'ctx\n');
      for (let i = 1; i <= 23; i++) dig(`ifa/projects/alpha/s${String(i).padStart(2, '0')}.md`, `${i}\n`);
      writeFileSync(join(a, 'projects/projects.json'), JSON.stringify({
        contextFiles: ['ctx.md'], projects: { alpha: ['e01'], beta: [], gamma: ['g1'], oldp: [] },
      }));
      // B: copy of A with every tracked change kind applied
      cpSync(a, join(w10, 'ifb'), { recursive: true });
      dig('ifb/add.md', fm('add ten'));
      dig('ifb/mod.md', fm('new ten'));
      rmSync(join(w10, 'ifb/del.md'));
      ddir('ifb/user/omp/agent/managed-skills');
      renameSync(join(w10, 'ifb/user/omp/agent/skills/sk'), join(w10, 'ifb/user/omp/agent/managed-skills/sk'));
      ddir('ifb/user/omp/agent/extensions/ext-b');
      writeFileSync(join(w10, 'ifb/user/omp/plugins/package.json'), JSON.stringify({ dependencies: { p1: '2.0.0' } }));
      for (let i = 4; i <= 23; i++) rmSync(join(w10, `ifb/projects/alpha/s${String(i).padStart(2, '0')}.md`));
      dig('ifb/projects/beta/f.md', 'f\n');
      writeFileSync(join(w10, 'ifb/projects/projects.json'), JSON.stringify({
        contextFiles: ['ctx.md'],
        projects: {
          alpha: ['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e09', 'e10', 'e11', 'e12'],
          beta: [], gamma: ['g1', 'g2'], newp: [],
        },
      }));
    };
    buildAB();
    const dbAB = mkDb10('alat10-ab.db');
    const ab0 = dash.loadState(dbAB);
    const ab1 = dash.importSource(ab0, join(w10, 'ifa'), undefined, null, dbAB);
    const ab2 = dash.importSource(ab1, join(w10, 'ifb'), undefined, null, dbAB);
    assert.deepEqual(ab2.changes, {
      rules: { added: ['add.md'], removed: ['del.md'], updated: ['mod.md'] },
      skills: { added: [], removed: [], updated: ['sk'] },
      plugins: { added: [], removed: [], updated: ['p1'] },
      extensions: { added: ['ext-b'], removed: [], updated: [] },
      user: { added: ['ext-b'], removed: [], updated: [] },
      projects: { added: ['newp'], removed: ['oldp'], updated: ['alpha', 'beta', 'gamma'] },
    });

    // -- computeChanges over a hand-crafted previous inventory with absent sections.
    const dbP = mkDb10('alat10-p.db');
    dbP.prepare('INSERT INTO state (id, value) VALUES (1, ?)').run(JSON.stringify({
      source: null, inventory: {}, previous: null, changes: null,
    }));
    const pc = dash.importSource(dash.loadState(dbP), join(w10, 'ifa'), undefined, null, dbP).changes;
    assert.deepEqual(pc, {
      rules: { added: ['del.md', 'keep.md', 'mod.md'], removed: [], updated: [] },
      skills: { added: ['sk'], removed: [], updated: [] },
      plugins: { added: ['p1'], removed: [], updated: [] },
      extensions: { added: ['ext-a'], removed: [], updated: [] },
      user: { added: ['omp/agent/config.yml', 'omp/plugins/package.json', 'ext-a'], removed: [], updated: [] },
      projects: { added: ['@context/ctx.md', 'alpha', 'beta', 'gamma', 'oldp'], removed: [], updated: [] },
    });

    // -- remoteHead: sha of the fixture remote, ref-aware, '' on failure.
    const ghOwn = join(gh10, 'own', 'data');
    mkdirSync(join(gh10, 'own'), { recursive: true });
    dig('ghwt/intro.md', 'intro\n');
    assert.equal(git10(['init', '-q', 'ghwt']).status, 0);
    assert.equal(git10(['-C', 'ghwt', 'symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
    assert.equal(git10(['-C', 'ghwt', 'add', '-A']).status, 0);
    assert.equal(git10(['-C', 'ghwt', '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qm', 'init']).status, 0);
    assert.equal(git10(['init', '-q', '--bare', ghOwn]).status, 0);
    assert.equal(git10(['-C', 'ghwt', 'push', '-q', ghOwn, 'main']).status, 0);
    assert.equal(git10(['--git-dir', ghOwn, 'symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
    const ownSha = git10(['--git-dir', ghOwn, 'rev-parse', 'HEAD']).stdout.trim();
    const dbR = mkDb10('alat10-r.db');
    const r1 = dash.importSource(dash.loadState(dbR), 'own/data@main', 'repo', null, dbR);
    assert.equal(r1.source.kind, 'repo');
    assert.deepEqual([r1.source.name, r1.source.ref, r1.source.importedSha], ['own/data', 'main', ownSha]);
    assert.deepEqual(dash.listStoredFiles(dbR).map(r => ({ ...r })), [{ path: 'intro.md', bytes: 6 }]);
    assert.equal(dash.remoteHead('own/data'), ownSha);
    assert.equal(dash.remoteHead('own/data', 'main'), ownSha);
    assert.equal(dash.remoteHead('absent/repo'), '');

    // -- repo-source edit: clone, write, commit, push, re-import; temp dirs never leak.
    const leak10 = async fn => {
      const before = new Set(readdirSync(tmpdir()).filter(n => /^alate-(dashboard|snapshot)-/.test(n)));
      const out = await fn();
      const fresh = readdirSync(tmpdir()).filter(n => /^alate-(dashboard|snapshot)-/.test(n) && !before.has(n));
      assert.deepEqual(fresh, [], 'dashboard temp dirs must not leak');
      return out;
    };
    await leak10(async () => {});
    const res1 = await leak10(() => dash.applyFileEdit(r1, dbR, { path: 'edit10.md', content: 'hi ten\n', base: null }));
    assert.equal(res1.pushed, true);
    assert.equal(res1.warning, undefined);
    assert.match(res1.commit, /^[0-9a-f]{40}$/);
    assert.equal(res1.state.source.importedSha, res1.commit);
    assert.equal(git10(['--git-dir', ghOwn, 'log', '-1', '--format=%s', 'main']).stdout.trim(), 'alate: add edit10.md');
    assert.deepEqual(dash.readStoredFile(dbR, 'edit10.md').content, 'hi ten\n');
    const editHash = dash.readStoredFile(dbR, 'edit10.md').hash;
    const res2 = await leak10(() => dash.applyFileEdit(res1.state, dbR, { path: 'edit10.md', content: 'up ten\n', base: editHash, message: '  Stryker ten  ' }));
    assert.equal(res2.pushed, true);
    assert.equal(git10(['--git-dir', ghOwn, 'log', '-1', '--format=%s', 'main']).stdout.replace(/\n$/, ''), 'Stryker ten', 'message is trimmed to one line');
    e = err10(() => dash.applyFileEdit(res2.state, dbR, { path: 'edit10.md', content: 'x\n', base: '0'.repeat(64) }));
    assert.equal(e.status, 409);
    e = err10(() => dash.applyFileEdit({ source: null }, dbR, { path: 'x.md', content: 'x', base: null }));
    assert.equal(e.status, 400);
    e = err10(() => dash.applyFileEdit(res2.state, dbR, { path: 'x.md', content: 'x', base: null, delete: true }));
    assert.equal(e.status, 400);

    // -- snapshotData: exact tree, temp prefix, unsafe stored paths refused.
    const snap = dash.snapshotData(dbI);
    assert.ok(/alate-snapshot-/.test(snap.dir));
    assert.deepEqual(readdirSync(snap.dir, { recursive: true }).sort(), ['sub', join('sub', 'note.md'), 'top.md']);
    assert.equal(readFileSync(join(snap.dir, 'top.md'), 'utf8'), 'top\n');
    rmSync(snap.dir, { recursive: true, force: true }); // our own returned temp dir
    const dbS = mkDb10('alat10-s.db');
    for (const bad of ['a\\b.md', 'a//b.md']) {
      dbS.exec('DELETE FROM files');
      dbS.prepare('INSERT INTO files (path, content) VALUES (?, ?)').run(bad, Buffer.from(`x`));
      e = err10(() => dash.snapshotData(dbS));
      assert.equal(e.message, `unsafe snapshot path: ${bad}`, bad);
    }
  }

  // Mutation survivors covered by this section: server.ts ====
  {
    const mut10Kill = p => new Promise(resolve => { p.once('close', resolve); p.kill(); });
    const mut10Spawn = (args, over = {}) => {
      const p = spawn(process.execPath, [join(repoRoot, 'server.ts'), ...args], { cwd: repoRoot, env: { ...serverEnv, ...over }, stdio: ['ignore', 'pipe', 'inherit'] });
      const up = new Promise((resolve, reject) => {
        let buf = '';
        p.stdout.on('data', chunk => {
          buf += chunk;
          const k = /alate API key: (\S+)\n/.exec(buf);
          const l = /alate server on (http:\/\/\S+)\n/.exec(buf);
          if (l) resolve({ base: l[1], key: k ? k[1] : '' });
        });
        p.once('exit', code => reject(new Error(`mut10 server exited early (${code}): ${buf.slice(-300)}`)));
        setTimeout(() => reject(new Error(`mut10 server did not start: ${buf.slice(-300)}`)), 30_000).unref();
      });
      return { p, up };
    };
    const mut10Json = (base, path, opts) => fetch(new URL(path, base), opts).then(async r => [r.status, await r.json(), r]);
    const mut10Post = (base, path, bodyObj, key) => mut10Json(base, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(bodyObj),
    });
    const mut10ReadRow = dbFile => {
      for (let attempt = 0; ; attempt++) {
        try {
          const db = new DatabaseSync(dbFile, { readOnly: true });
          try { return JSON.parse(db.prepare('SELECT value FROM state WHERE id = 1').get().value); }
          finally { db.close(); }
        } catch (err) {
          // A boot-time updateCheck can hold the write lock past the child's listen line.
          if (attempt >= 5 || !/LOCKED|BUSY/i.test(String(err.message))) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
    };

    // Server A: fresh instance, long interval so no dashboard tick races the asserts.
    {
      const cfgA = join(tmp, 'server-config-mutA.json');
      const dbA = join(tmp, 'state-mutA.db');
      const A = mut10Spawn(['--port', '0', '--config', cfgA, '--db', dbA, '--interval', '100000']);
      const { base, key } = await A.up;
      const getA = (path, withKey = false) => fetch(new URL(path, base), withKey ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
      // /health reports ok, an unset token, and the config defaults for the update block.
      let [st, body] = await mut10Json(base, '/health');
      assert.equal(st, 200);
      assert.equal(body.ok, true);
      assert.equal(body.tokenSet, false);
      assert.equal(body.update.lastChecked, null);
      // The generated boot key is persisted to the config file before anything else saves it.
      assert.ok(JSON.parse(readFileSync(cfgA, 'utf8')).apiKey, 'the boot-generated key is persisted');
      // Known routes refuse unregistered methods with the pinned body.
      for (const [method, path] of [['POST', '/health'], ['PUT', '/config'], ['GET', '/provision'], ['POST', '/api/files']]) {
        [st, body] = await mut10Json(base, path, { method });
        assert.equal(st, 405, `${method} ${path}`);
        assert.equal(body.error, 'method not allowed');
      }
      // 401 bodies on the bearer-only routes name the problem.
      [st, body] = await mut10Post(base, '/config', { path: emptyDir }, null);
      assert.equal(st, 401);
      assert.equal(body.error, 'unauthorized');
      [st, body] = await mut10Json(base, '/api/updates');
      assert.equal(st, 401);
      assert.equal(body.error, 'unauthorized');
      [st, body] = await mut10Post(base, '/api/login', { key: 'wrong-mut10' }, null);
      assert.equal(st, 401);
      assert.equal(body.error, 'unauthorized');
      // Login's 64 KiB body limit holds before any key comparison.
      const bigKey = 'x'.repeat(70_000);
      [st, body] = await mut10Post(base, '/api/login', { key: bigKey }, null);
      assert.equal(st, 413);
      // /config token type validation names its 400.
      [st, body] = await mut10Post(base, '/config', { repo: origin, token: 42 }, key);
      assert.equal(st, 400);
      assert.equal(body.error, 'invalid token');
      // /api/import request-shape 400s: empty source, non-string source, bogus kind.
      const mut10Import = payload => mut10Post(base, '/api/import', payload, null);
      [st, body] = await mut10Import({ source: '' });
      assert.equal(st, 400);
      assert.equal(body.error, 'source required');
      [st, body] = await mut10Import({ source: 42 });
      assert.equal(st, 400, 'a non-string source cannot reach selectSource');
      [st, body] = await mut10Import({ source: data, kind: 'bogus' });
      assert.equal(st, 400);
      assert.equal(body.error, 'kind must be "path" or "repo"');
      // Path import persists the update block (null) and the path source in the config file.
      [st, body] = await mut10Import({ source: mixedDir });
      assert.equal(st, 200, JSON.stringify(body));
      assert.ok('update' in mut10ReadRow(dbA), 'selectSource persists the state row with its update block');
      assert.equal(JSON.parse(readFileSync(cfgA, 'utf8')).path, mixedDir, 'selectSource persists the path source to the config file');
      // Provision output is the script's own bytes, never a prefixed buffer.
      [st, body] = await mut10Post(base, '/provision', {}, key);
      assert.equal(st, 200);
      assert.equal(body.ok, false);
      assert.ok(!body.results[0].output.startsWith('Stryker was here!'), 'provision output is not prefixed');
      // A stored traversal path fails the snapshot with a plain-error 500 body.
      {
        const raw = new DatabaseSync(dbA);
        try {
          raw.prepare('INSERT INTO files (path, content) VALUES (?, ?)').run('../mut10-escape.md', Buffer.from(`evil`));
          [st, body] = await mut10Post(base, '/provision', {}, key);
          assert.equal(st, 500);
          assert.match(body.error, /unsafe snapshot path/, 'the 500 body carries the thrown message, not a generic handler error');
        } finally { raw.prepare('DELETE FROM files WHERE path = ?').run('../mut10-escape.md'); raw.close(); }
      }
      // A repo import seeds the update block synchronously in selectSource (no tick needed).
      [st, body] = await mut10Import({ source: 'https://github.com/demo/data', kind: 'repo' });
      assert.equal(st, 200, JSON.stringify(body));
      [st, body] = await mut10Json(base, '/api/state');
      assert.notEqual(body.update, null);
      assert.equal(typeof body.update.checkedAt, 'string', 'selectSource seeds the update block synchronously');
      assert.equal(body.update.available, false);
      // The logo asset is served with its PNG type.
      let logo = await getA('/logo.png');
      assert.equal(logo.status, 200);
      assert.equal(logo.headers.get('content-type'), 'image/png');
      assert.deepEqual([...Buffer.from(await logo.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      // Capture cap: a large provision output is truncated to exactly CAP bytes.
      const bigDir = join(tmp, 'big-rules');
      mkdirSync(join(bigDir, 'projects'), { recursive: true });
      mkdirSync(join(bigDir, 'user', 'omp', 'agent'), { recursive: true });
      writeFileSync(join(bigDir, 'user', 'omp', 'agent', 'config.yml'), 'model: test\n');
      writeFileSync(join(bigDir, 'projects', 'projects.json'), JSON.stringify({ contextFiles: [], projects: {} }));
      for (let i = 0; i < 850; i++) writeFileSync(join(bigDir, `${'n'.repeat(240)}${i}.md`), '---\ndescription: big\n---\n\nBody\n');
      [st, body] = await mut10Import({ source: bigDir });
      assert.equal(st, 200, JSON.stringify(body).slice(0, 200));
      [st, body] = await mut10Post(base, '/provision', {}, key);
      assert.equal(st, 200, JSON.stringify(body).slice(0, 200));
      assert.equal(body.ok, true);
      assert.equal(body.results[0].truncated, true, 'a >200000-byte script output is flagged truncated');
      assert.equal(body.results[0].output.length, 200000, 'the captured output is cut to CAP bytes');
      await mut10Kill(A.p);
    }

    // Server A2: a pre-written key must survive boot, and a save must re-assert 0600.
    {
      const cfgA2 = join(tmp, 'server-config-mutA2.json');
      writeFileSync(cfgA2, JSON.stringify({ apiKey: 'mut10-known-key-a2' }), { mode: 0o666 });
      const A2 = mut10Spawn(['--port', '0', '--config', cfgA2, '--db', join(tmp, 'state-mutA2.db'), '--interval', '100000']);
      const { base } = await A2.up;
      // Health first: the source switch below would overwrite the load-time defaults.
      let [st, body] = await mut10Json(base, '/health');
      assert.equal(body.update.lastChecked, null, 'a config file without update gets the null-field default');
      [st, body] = await mut10Post(base, '/config', { path: emptyDir }, 'mut10-known-key-a2');
      assert.equal(st, 200, 'the boot keeps the configured API key');
      [st, body] = await mut10Json(base, '/api/settings');
      assert.equal(st, 200);
      assert.equal(body.autoUpdate, false, 'a config file without autoUpdate defaults to false');
      [st, body] = await mut10Post(base, '/api/settings', { token: '' }, null);
      assert.equal(st, 200);
      assert.equal(statSync(cfgA2).mode & 0o777, 0o600, 'saveConfig re-asserts 0600 on an existing file');
      assert.ok(readFileSync(cfgA2, 'utf8').endsWith('\n'), 'the config file ends with a newline');
      await mut10Kill(A2.p);
    }

    // Server A3: persisted autoUpdate and update fields survive a load untouched.
    {
      const cfgA3 = join(tmp, 'server-config-mutA3.json');
      writeFileSync(cfgA3, JSON.stringify({ apiKey: 'mut10-key-a3', autoUpdate: true, update: { lastChecked: '2026-01-01T00:00:00.000Z', remoteSha: '', provisionedSha: '' } }));
      const A3 = mut10Spawn(['--port', '0', '--config', cfgA3, '--db', join(tmp, 'state-mutA3.db'), '--interval', '100000']);
      const { base } = await A3.up;
      let [st, body] = await mut10Json(base, '/api/settings');
      assert.equal(body.autoUpdate, true, 'a configured autoUpdate survives the load');
      [st, body] = await mut10Json(base, '/health');
      assert.equal(body.update.lastChecked, '2026-01-01T00:00:00.000Z', 'a configured update.lastChecked survives the load');
      await mut10Kill(A3.p);
    }

    // Server A5: without --db the database lands next to the config file, mode 0600.
    {
      const cfgA5 = join(tmp, 'server-config-mutA5.json');
      const A5 = mut10Spawn(['--port', '0', '--config', cfgA5]);
      const { base } = await A5.up;
      const dbA5 = join(dirname(cfgA5), 'alate.db');
      assert.ok(existsSync(dbA5), 'the default database file is <config dir>/alate.db');
      if (process.platform !== 'win32') assert.equal(statSync(dbA5).mode & 0o777, 0o600, 'the database file is 0600');
      await mut10Kill(A5.p);
    }

    // Server A6 (no --config): dropped. The default config path is the repo root, which is
    // ONE SHARED directory across the concurrency-8 command-runner suites; a no-flag boot
    // writes server-config.json/alate.db there and the concurrent suites trample each
    // other's files (observed SQLITE_BUSY crashes), so the default is untestable here.

    // Servers B1/B2/B3: --repo boot selection, a restart with a moved remote, then an
    // offline restart with a persisted source.
    {
      const cfgB = join(tmp, 'server-config-mutB.json');
      const dbB = join(tmp, 'state-mutB.db');
      const B1 = mut10Spawn(['--port', '0', '--config', cfgB, '--db', dbB, '--repo', origin, '--interval', '100000']);
      const { base } = await B1.up;
      let [st, body] = await mut10Json(base, '/api/state');
      assert.equal(body.source.kind, 'repo', '--repo boots a repo source');
      assert.equal(body.source.spec, origin);
      assert.equal(body.update.available, false, 'an unchanged remote never reads as an update');
      [st, body] = await mut10Json(base, '/config');
      assert.equal(body.repo, origin, 'the repo source is stored as repo, not path');
      await mut10Kill(B1.p);
      // Move the remote ahead, then restart: the boot dash check must see the new commit.
      assert.equal(git(['-C', origin, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'mut10']).status, 0);
      const stale = JSON.parse(readFileSync(cfgB, 'utf8'));
      stale.path = 'WRONG'; // the boot must rewrite the config file from the stored source
      writeFileSync(cfgB, JSON.stringify(stale));
      const B2 = mut10Spawn(['--port', '0', '--config', cfgB, '--db', dbB, '--interval', '100000']);
      let base2 = (await B2.up).base;
      [st, body] = await mut10Json(base2, '/api/state');
      assert.equal(body.update.available, true, 'the boot dash check sees a moved remote');
      assert.equal(typeof body.update.checkedAt, 'string');
      [st, body] = await mut10Json(base2, '/config');
      assert.equal(body.repo, origin, 'the persisted repo source restores config.repo');
      assert.equal(body.path, null, 'the persisted repo source clears config.path');
      assert.equal(JSON.parse(readFileSync(cfgB, 'utf8')).path, null, 'the boot rewrites the config file from the stored source');
      await mut10Kill(B2.p);
      // Offline restart: an unreadable remote must leave baseline and update state intact.
      const X = mut10ReadRow(dbB).source.importedSha;
      {
        const raw = new DatabaseSync(dbB);
        const row = mut10ReadRow(dbB);
        row.update = null;
        raw.prepare('UPDATE state SET value = ? WHERE id = 1').run(JSON.stringify(row));
        raw.close();
      }
      const offline = JSON.parse(readFileSync(cfgB, 'utf8'));
      offline.update = { lastChecked: null, remoteSha: X, provisionedSha: X };
      writeFileSync(cfgB, JSON.stringify(offline));
      renameSync(origin, join(tmp, 'origin-mut10-offline'));
      try {
        const B3 = mut10Spawn(['--port', '0', '--config', cfgB, '--db', dbB, '--interval', '100000']);
        base2 = (await B3.up).base;
        [st, body] = await mut10Json(base2, '/health');
        assert.equal(body.update.behind, false, 'a failed remote check leaves the baseline untouched');
        assert.notEqual(JSON.parse(readFileSync(cfgB, 'utf8')).update.lastChecked, null, 'the boot dash check persists its lastChecked');
        [st, body] = await mut10Json(base2, '/api/state');
        assert.equal(body.update.available, false, 'an empty remote sha never reads as an update');
        assert.equal(typeof body.update.checkedAt, 'string');
        assert.notEqual(mut10ReadRow(dbB).update, null, 'the boot dash check persists the update block');
        await mut10Kill(B3.p);
      } finally { renameSync(join(tmp, 'origin-mut10-offline'), origin); }
    }

    // Server B4: a persisted path source restores config.path, and the config file rewrite
    // is observable because a path source's boot dash check exits before its own save.
    {
      const cfgB4 = join(tmp, 'server-config-mutB4.json');
      const dbB4 = join(tmp, 'state-mutB4.db');
      writeFileSync(cfgB4, JSON.stringify({ apiKey: 'mut10-key-b4', repo: 'WRONG', path: 'WRONG' }));
      {
        const raw = new DatabaseSync(dbB4);
        raw.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
        raw.prepare('INSERT OR REPLACE INTO state (id, value) VALUES (1, ?)').run(JSON.stringify({
          source: { kind: 'path', spec: mixedDir, name: mixedDir, ref: '', importedSha: '', importedAt: '2026-01-01T00:00:00.000Z' },
          inventory: null, previous: null, changes: null, update: null,
        }));
        raw.close();
      }
      const B4 = mut10Spawn(['--port', '0', '--config', cfgB4, '--db', dbB4, '--interval', '100000']);
      const { base } = await B4.up;
      let [st, body] = await mut10Json(base, '/config');
      assert.deepEqual(body, { repo: null, path: mixedDir, tokenSet: false }, 'a persisted path source restores config.path');
      assert.equal(JSON.parse(readFileSync(cfgB4, 'utf8')).path, mixedDir, 'the boot rewrites the config file from the stored path source');
      await mut10Kill(B4.p);
    }

    // Server C: the non-loopback guard's 401 body and a cookie glued to another cookie.
    {
      const cfgC = join(tmp, 'server-config-mutC.json');
      const C = mut10Spawn(['--port', '0', '--host', '0.0.0.0', '--config', cfgC, '--db', join(tmp, 'state-mutC.db')]);
      const { base, key } = await C.up;
      let [st, body] = await mut10Json(base, '/api/state');
      assert.deepEqual([st, body], [401, { error: 'unauthorized' }], 'the dashboard guard 401 body is pinned');
      const login = await fetch(new URL('/api/login', base), { method: 'POST', body: JSON.stringify({ key }), headers: { 'Content-Type': 'application/json' } });
      assert.equal(login.status, 200);
      const token = /alate_session=([a-f0-9]{64})/.exec(login.headers.get('set-cookie') ?? '')[1];
      [st, body] = await mut10Json(base, '/api/state', { headers: { cookie: `other=1;alate_session=${token}` } });
      assert.equal(st, 200, 'a session cookie glued to another cookie with no space is honored');
      await mut10Kill(C.p);
    }

    // Servers D/E: localhost and ::1 binds are loopback, so the dashboard stays key-free.
    {
      const D = mut10Spawn(['--port', '0', '--host', 'localhost', '--config', join(tmp, 'server-config-mutD.json'), '--db', join(tmp, 'state-mutD.db')]);
      let { base } = await D.up;
      let [st] = await mut10Json(base, '/api/state');
      assert.equal(st, 200, 'a localhost bind is a loopback bind');
      await mut10Kill(D.p);
      const E = mut10Spawn(['--port', '0', '--host', '::1', '--config', join(tmp, 'server-config-mutE.json'), '--db', join(tmp, 'state-mutE.db')]);
      ({ base } = await E.up);
      [st] = await mut10Json(base, '/api/state');
      assert.equal(st, 200, 'a ::1 bind is a loopback bind');
      await mut10Kill(E.p);
    }

    // Servers H1/H2: the --data flag and the config.path fallback both boot a path source.
    {
      const cfgH1 = join(tmp, 'server-config-mutH1.json');
      writeFileSync(cfgH1, JSON.stringify({ apiKey: 'mut10-key-h' }));
      const H1 = mut10Spawn(['--port', '0', '--config', cfgH1, '--db', join(tmp, 'state-mutH1.db'), '--data', mixedDir, '--interval', '100000']);
      let [st, body] = await mut10Json((await H1.up).base, '/api/state');
      assert.equal(body.source.kind, 'path', '--data boots the local dir as a path source');
      assert.equal(body.source.spec, mixedDir);
      await mut10Kill(H1.p);
      const cfgH2 = join(tmp, 'server-config-mutH2.json');
      writeFileSync(cfgH2, JSON.stringify({ apiKey: 'mut10-key-h', path: mixedDir }));
      const H2 = mut10Spawn(['--port', '0', '--config', cfgH2, '--db', join(tmp, 'state-mutH2.db'), '--interval', '100000']);
      [st, body] = await mut10Json((await H2.up).base, '/config');
      assert.deepEqual(body, { repo: null, path: mixedDir, tokenSet: false }, 'a persisted path source boots as a path, not a repo');
      await mut10Kill(H2.p);
    }

    // Fake-npm server G: the update checker's re-entrancy guard and the path-source dataRepo.
    {
      let npmHits = 0;
      let npmTime = { '1.0.0': new Date(Date.now() - 30 * 86_400_000).toISOString() };
      let releaseNpm = null;
      const fakeNpm = createServer((req, res) => {
        npmHits++;
        const reply = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ time: npmTime, versions: {} })); };
        if (npmHits === 1 && !releaseNpm) { releaseNpm = reply; return; } // held: check #1 stays in flight
        reply();
      });
      await new Promise(resolve => fakeNpm.listen(0, '127.0.0.1', resolve));
      const npmBase = `http://127.0.0.1:${fakeNpm.address().port}/npm`;
      try {
        const fdir = join(tmp, 'mut10-upstream');
        mkdirSync(fdir, { recursive: true });
        writeFileSync(join(fdir, 'Dockerfile'), 'FROM fake/img:1.0.0\n');
        writeFileSync(join(fdir, 'upstreams.json'), JSON.stringify({ own: [], items: [
          { name: 'mut10-pin', kind: 'image-pin', origin: 'https://github.com/fake/img', check: { type: 'npm', package: 'p1' }, pin: { file: 'Dockerfile', key: 'fake/img' } },
        ] }));
        const cfgG = join(tmp, 'server-config-mutG.json');
        const G = mut10Spawn(['--port', '0', '--config', cfgG, '--db', join(tmp, 'state-mutG.db'), '--interval', '100000', '--update-interval', '100000'], { ALATE_TEST_NPM_BASE: npmBase });
        const { base, key } = await G.up;
        const rowsG = async () => (await (await fetch(new URL('/api/updates', base), { headers: { Authorization: `Bearer ${key}` } })).json()).updates;
        // Check #1 is held open at the fake: a rapid second import must not start a second checker.
        let [st, body] = await mut10Post(base, '/api/import', { source: fdir }, null);
        assert.equal(st, 200, JSON.stringify(body).slice(0, 200));
        [st, body] = await mut10Post(base, '/api/import', { source: fdir }, null);
        assert.equal(st, 200);
        await new Promise(r => setTimeout(r, 2500));
        assert.equal(npmHits, 1, 'an overlapping update check is skipped by the re-entrancy guard');
        releaseNpm(); // let the first check finish and write its row
        await waitFor(async () => (await rowsG()).length === 1, 20_000);
        [st, body] = await mut10Json(base, '/api/updates', { headers: { Authorization: `Bearer ${key}` } });
        assert.equal(body.updates[0].repo, fdir, 'a path source reports its spec as the pin repo');
        // A new npm version is picked up by the next import's check.
        npmTime = { '1.0.0': new Date(Date.now() - 30 * 86_400_000).toISOString(), '2.0.0': new Date(Date.now() - 20 * 86_400_000).toISOString() };
        [st, body] = await mut10Post(base, '/api/import', { source: fdir }, null);
        assert.equal(st, 200);
        await waitFor(async () => (await rowsG()).find(u => u.name === 'mut10-pin')?.latest === '2.0.0', 20_000);
        await mut10Kill(G.p);
      } finally { await new Promise(resolve => fakeNpm.close(resolve)); }
    }
  }

} finally {
  child.kill();
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
