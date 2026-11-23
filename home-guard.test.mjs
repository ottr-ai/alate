// Guard against writes into the real home's watched dirs during the test chain.
// Three modes: (none) self-check with fake homes; `record [snap]` snapshots the real home;
// `check [snap]` re-walks and fails with one diff line per finding.
// The platform's own runtime state (the omp databases and hour logs, .omp/cache,
// .omp/run, the session stores under .omp — context-mode, custom-session-files,
// snapcompact — the cache and session stores of the browser profiles under
// .omp/browser-profiles, the live worker's .omp/plugins/cache downloads and
// .omp/plugins/node_modules dependencies (other plugins/ paths stay checked),
// .omp/memories, the memory backend store .omp/agent/memories, .omp/oauth, .omp/install-id,
// .omp/marketplaces.json, .omp/natives, the .omp/autoqa.db database with its -wal and
// -journal files, the alate rules install record .omp/agent/rules/.alate-installed.json,
// the bookkeeping files under .alate (in-use.json, in-use.owners.json,
// skillspector-pass.json), and the
// live worker's layer runtime (each layer's .omp tree under .alate/layers — the same
// ignore set as .omp, plus its puppeteer browser-tooling install; the layer's own
// manifest files stay checked))
// is excluded: a live worker writes it during any chain run, and none of it is a
// test write.
// Exists because a Stryker mutant once dropped install-user.mjs's --home handling, so the
// script fell back to os.homedir() and deleted files of the shared Ottr worker home.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCHED = ['.alate', '.agents', '.omp'];
// Platform runtime state churns while a live worker runs the chain; those writes are not
// test writes, so the guard ignores them. Inside the chrome-devtools browser profiles
// under .omp/browser-profiles that is only the cache trees (Cache, Code Cache, and the
// GPU shader caches GPUCache, GPUPersistentCache, GrShaderCache, ShaderCache, GraphiteDawnCache,
// DawnGraphiteCache, DawnWebGPUCache) and the Cookies and History session stores with
// their -wal and -journal files: a live browser rewrites those mid-chain. A live worker
// also rewrites its plugin download cache (.omp/plugins/cache). The platform seed
// rewrites .omp/plugins/node_modules dependency shims (ALAT-195); other plugins/ paths
// stay checked. The worker also rewrites its memories (.omp/memories and the memory
// backend store .omp/agent/memories), its oauth state, its native grammar files
// (.omp/natives), the install-id and marketplaces.json bookkeeping files, and its
// autoqa.db runtime database with its -wal and -journal files. A sibling session's
// provisioning run (sync.mjs) rewrites the alate rules install record
// agent/rules/.alate-installed.json mid-chain (ALAT-169 merge turn); the rule files beside
// it stay checked, so a sync install into the home still fails on the rules themselves.
// Everything else in the watched dirs — skills, rules, agent context, installed.json,
// layers, current, the rest of a browser profile — is checked for presence and mtime.
// Under .alate/layers only each layer's .omp runtime tree is live state (see layerOmpLive
// below); the layer's manifest files and token-reminders.json stay checked.
// The flat .omp runtime predicate, reused for the layer layout below.
const OMP_LIVE = rel => rel === 'logs' || rel.startsWith('logs/') || rel === 'cache' || rel.startsWith('cache/')
  || rel === 'run' || rel.startsWith('run/')
  || rel === 'context-mode' || rel.startsWith('context-mode/')
  || rel === 'agent/custom-session-files' || rel.startsWith('agent/custom-session-files/')
  || rel === 'snapcompact-savings.jsonl'
  || rel === 'agent/blobs' || rel.startsWith('agent/blobs/')
  || rel === 'agent/memories' || rel.startsWith('agent/memories/')
  || (/^browser-profiles\//.test(rel)
    && (/\/(?:Cache|Code Cache|GPUCache|GPUPersistentCache|GrShaderCache|ShaderCache|GraphiteDawnCache|DawnGraphiteCache|DawnWebGPUCache)(?:\/|$)/.test(rel)
      || /\/(?:Cookies|History)(?:-wal|-journal)?$/.test(rel)))
  || rel === 'plugins/cache' || rel.startsWith('plugins/cache/')
  || rel === 'plugins/node_modules' || rel.startsWith('plugins/node_modules/')
  || rel === 'memories' || rel.startsWith('memories/')
  || rel === 'oauth' || rel.startsWith('oauth/')
  || rel === 'install-id'
  || rel === 'marketplaces.json'
  || rel === 'natives' || rel.startsWith('natives/')
  || /^autoqa\.db(?:-wal|-journal)?$/.test(rel)
  || rel === 'agent/rules/.alate-installed.json'
  || /^agent\/[A-Za-z0-9-]+\.db(?:\.|-|$)/.test(rel);
// A live worker's layer .omp lives at .alate/layers/<id>/.omp and holds the same runtime
// state as the flat .omp; its browser tooling also installs puppeteer there when a browser
// session runs mid-chain. Same ignore set as .omp, plus puppeteer. Everything else under
// .alate/layers — the layer's manifest files and token-reminders.json — stays checked.
const layerOmpLive = rel => {
  const m = /^layers\/[^/]+\/\.omp\/(.+)$/.exec(rel);
  return m !== null && (OMP_LIVE(m[1]) || m[1] === 'puppeteer' || m[1].startsWith('puppeteer/'));
};
const LIVE = {
  '.alate': rel => rel === 'in-use.json' || rel === 'in-use.owners.json' || rel === 'skillspector-pass.json' || layerOmpLive(rel),
  '.agents': () => false,
  '.omp': OMP_LIVE,
};
const resolveSnap = (argv) => argv[3] ?? process.env.ALATE_HOME_GUARD_SNAPSHOT ?? join(tmpdir(), 'alate-home-guard-snapshot.json');

// Walk one watched dir into mtime: every checked file and subdirectory, keyed relative
// with forward slashes, value lstat mtimeMs; every checked directory also lands in dirs.
// Never follow symlinks; a symlinked root records nothing, no walk. A missing dir
// records as absent.
const walkWatched = (root, mtime, dirs, isLive) => {
  if (!existsSync(root)) return;
  const st = lstatSync(root);
  if (st.isSymbolicLink()) return;
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const relKey = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      const s = lstatSync(full);
      if (!isLive(relKey)) {
        mtime[relKey] = s.mtimeMs;
        if (s.isDirectory()) dirs[relKey] = true;
      }
      if (s.isDirectory()) walk(full, relKey);
    }
  };
  walk(root, '');
};

const snapshot = () => {
  const mtime = {};
  const dirs = {};
  for (const dir of WATCHED) walkWatched(join(homedir(), dir), mtime, dirs, LIVE[dir] ?? (() => false));
  return { mtime, dirs };
};

const saveSnap = (path, data) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(data));
  renameSync(`${path}.tmp`, path);
};

const run = (mode, home, snap) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, snap], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home },
});

// Compare against the snapshot; returns an array of diff lines.
// A file mtime diff always reports. A directory's mtime also moves when a live-ignored
// child is created or removed inside it — the memory backend creating
// .omp/agent/memories mid-chain, or live workers creating and removing the SQLite -wal
// and -shm files of agent.db, history.db and models.db (ALAT-133), moves the agent mtime
// without touching any checked path. A real change to a checked child reports that
// child on its own, so a directory that stayed a directory and has no direct-child diff
// of its own is ignored-child churn and its mtime diff is dropped; a type flip (dir to
// file or back) still reports.
const diff = (snapPathArg) => {
  if (!existsSync(snapPathArg)) return [`snapshot missing: ${snapPathArg}`];
  const snap = JSON.parse(readFileSync(snapPathArg, 'utf8'));
  const now = snapshot();
  const removed = [];
  const added = [];
  const mtimed = [];
  for (const key of Object.keys(snap.mtime)) if (!(key in now.mtime)) removed.push(key);
  for (const key of Object.keys(now.mtime)) {
    if (!(key in snap.mtime)) added.push(key);
    else if (snap.mtime[key] !== now.mtime[key] || (key in snap.dirs) !== (key in now.dirs)) mtimed.push(key);
  }
  const changed = new Set([...removed, ...added, ...mtimed]);
  const hasDirectChildDiff = (key) => {
    const prefix = `${key}/`;
    for (const other of changed) {
      if (other.startsWith(prefix) && !other.slice(prefix.length).includes('/')) return true;
    }
    return false;
  };
  const lines = [];
  for (const key of removed) lines.push(`removed entry: ${key}`);
  for (const key of added) lines.push(`added entry: ${key}`);
  for (const key of mtimed) {
    if (!(key in now.dirs) || !(key in snap.dirs) || hasDirectChildDiff(key)) lines.push(`mtime changed: ${key}`);
  }
  return lines;
};

const record = (snapPathArg) => {
  saveSnap(snapPathArg, snapshot());
  return 0;
};

const check = (snapPathArg) => {
  const lines = diff(snapPathArg);
  for (const line of lines) console.error(`home-guard: ${line}`);
  return lines.length ? 1 : 0;
};

// Self-check: the whole chain runs inside its own temp fixture with a fake home.
const selfCheck = () => {
  const tmp = mkdtempSync(join(tmpdir(), 'alate-home-guard-'));
  const fake = join(tmp, 'home');
  for (const rel of ['.alate/state.json', '.alate/in-use.json', '.alate/in-use.owners.json', '.alate/skillspector-pass.json',
    '.omp/browser-profiles/chrome-x/Default/Preferences',
    '.omp/browser-profiles/chrome-x/Default/Cache/Cache_Data/sqldb',
    '.omp/browser-profiles/chrome-x/Default/Code Cache/js',
    '.omp/browser-profiles/chrome-x/Default/GPUCache/data_1',
    '.omp/browser-profiles/chrome-x/GrShaderCache/data_1',
    '.omp/browser-profiles/chrome-x/GPUPersistentCache/store',
    '.omp/browser-profiles/chrome-x/Default/Cookies',
    '.omp/browser-profiles/chrome-x/Default/Cookies-wal',
    '.omp/browser-profiles/chrome-x/Default/History',
    '.omp/browser-profiles/chrome-x/Default/History-journal',
    '.agents/skills/x/SKILL.md', '.omp/agent/rules/r.md', '.omp/agent/agent.db', '.omp/agent/agent.db-wal',
    '.omp/agent/skill-descriptions.db-shm', '.omp/agent/skill-descriptions.db-wal',
    '.omp/logs/omp.231.log', '.omp/context-mode/sessions/s.db-shm', '.omp/agent/custom-session-files/a',
    '.omp/snapcompact-savings.jsonl', 'unwatched.txt', '.omp/autoqa.db', '.omp/autoqa.db-wal',
    '.omp/autoqa.db-journal',
    '.omp/plugins/cache/marketplaces/idx.json', '.omp/plugins/installed/p/manifest.json',
    '.omp/plugins/node_modules/.bin/plugin-tool',
    '.omp/memories/m.md', '.omp/oauth/tokens.json', '.omp/install-id',
    '.omp/marketplaces.json', '.omp/natives/grammars/en.wasm',
    '.alate/layers/w1/.omp/puppeteer/package.json', '.alate/layers/w1/.omp/install-id',
    '.alate/layers/w1/.omp/agent/rules/r.md',
    '.alate/layers/w1/config.yml', '.alate/layers/token-reminders.json']) {
    mkdirSync(join(fake, rel, '..'), { recursive: true });
    writeFileSync(join(fake, rel), rel);
  }
  // The blob cache dir pre-exists on any machine that has run omp once; its entries churn.
  // So does the live worker's own state: the plugin download cache, memories (flat and
  // the .omp/agent/memories backend store, which the churn block below creates
  // mid-chain, as the memory backend does), oauth, natives, install-id and
  // marketplaces.json.
  mkdirSync(join(fake, '.omp/agent/blobs'), { recursive: true });
  mkdirSync(join(fake, '.alate/layers/w1/.omp/cache'), { recursive: true });
  const snap = join(tmp, 'snap.json');
  try {
    assert.equal(run('record', fake, snap).status, 0, 'record passes');
    assert.equal(run('check', fake, snap).status, 0, 'check passes unchanged');
    // A change only outside the watched dirs passes.
    writeFileSync(join(fake, 'unwatched.txt'), 'changed');
    assert.equal(run('check', fake, snap).status, 0, 'unwatched change passes');
    // Platform runtime files may churn mid-chain; the guard ignores them.
    utimesSync(join(fake, '.omp/agent/agent.db-wal'), new Date(), new Date(Date.now() + 9000));
    utimesSync(join(fake, '.omp/agent/skill-descriptions.db-shm'), new Date(), new Date(Date.now() + 9000));
    writeFileSync(join(fake, '.omp/agent/skill-descriptions.db-wal'), 'more\n');
    // The live worker's autoqa runtime database churns too (ALAT-140 chain run 1).
    utimesSync(join(fake, '.omp/autoqa.db'), new Date(), new Date(Date.now() + 9000));
    writeFileSync(join(fake, '.omp/autoqa.db-wal'), 'more\n');
    writeFileSync(join(fake, '.omp/autoqa.db-journal'), 'more\n');
    writeFileSync(join(fake, '.omp/logs/omp.231.log'), 'more\n');
    writeFileSync(join(fake, '.alate/skillspector-pass.json'), '{}\n');
    // A live browser writes only cache and session stores: the ignored class.
    writeFileSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Cache/Cache_Data/sqldb-wal'), 'wal\n');
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Cache/Cache_Data/sqldb'), new Date(), new Date(Date.now() + 9000));
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Code Cache/js'), new Date(), new Date(Date.now() + 9000));
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/Default/GPUCache/data_1'), new Date(), new Date(Date.now() + 9000));
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/GrShaderCache/data_1'), new Date(), new Date(Date.now() + 9000));
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/GPUPersistentCache/store'), new Date(), new Date(Date.now() + 9000));
    writeFileSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Cookies-wal'), 'wal\n');
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/Default/History-journal'), new Date(), new Date(Date.now() + 9000));
    writeFileSync(join(fake, '.omp/context-mode/sessions/s.db-shm'), 'more\n');
    writeFileSync(join(fake, '.omp/snapcompact-savings.jsonl'), 'more\n');
    writeFileSync(join(fake, '.omp/agent/blobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), 'blob\n');
    writeFileSync(join(fake, '.omp/agent/blobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png'), 'blob\n');
    writeFileSync(join(fake, '.omp/plugins/cache/marketplaces/idx.json'), '{}\n');
    utimesSync(join(fake, '.omp/plugins/cache/marketplaces'), new Date(), new Date(Date.now() + 9000));
    writeFileSync(join(fake, '.omp/memories/m.md'), 'more\n');
    writeFileSync(join(fake, '.omp/oauth/tokens.json'), '{}\n');
    writeFileSync(join(fake, '.omp/install-id'), 'id-2\n');
    writeFileSync(join(fake, '.omp/marketplaces.json'), '[]\n');
    writeFileSync(join(fake, '.omp/natives/grammars/en.wasm'), 'wasm\n');
    // The memory backend writes below .omp/agent/memories and below each layer's
    // .omp/agent/memories. The flat .omp store did not exist at record time, so its
    // creation also moves the agent dir's mtime; with no checked child changed that
    // parent-mtime diff must be dropped.
    mkdirSync(join(fake, '.omp/agent/memories/mnemopi'), { recursive: true });
    writeFileSync(join(fake, '.omp/agent/memories/mnemopi/m.md'), 'memory\n');
    writeFileSync(join(fake, '.omp/agent/memories/mnemopi/m2.md'), 'memory\n');
    mkdirSync(join(fake, '.alate/layers/w1/.omp/agent/memories/mnemopi'), { recursive: true });
    writeFileSync(join(fake, '.alate/layers/w1/.omp/agent/memories/mnemopi/m.md'), 'memory\n');
    // The live worker's layer runtime churns the same way inside .alate/layers/<id>/.omp,
    // and its browser tooling rewrites puppeteer there mid-chain.
    writeFileSync(join(fake, '.alate/layers/w1/.omp/puppeteer/package.json'), '{"puppeteer":true}\n');
    writeFileSync(join(fake, '.alate/layers/w1/.omp/install-id'), 'id-2\n');
    writeFileSync(join(fake, '.alate/layers/w1/.omp/cache/idx'), '{}\n');
    assert.equal(run('check', fake, snap).status, 0, 'live runtime churn passes');
    // ALAT-195: a platform seed rewrites plugin dependency shims mid-chain.
    utimesSync(join(fake, '.omp/plugins/node_modules/.bin/plugin-tool'), new Date(), new Date(Date.now() + 9000));
    assert.equal(run('check', fake, snap).status, 0, 'plugin dependency shim mtime churn passes');
    // A sibling outside node_modules and cache still fails this clean bracket.
    utimesSync(join(fake, '.omp/plugins/installed/p/manifest.json'), new Date(), new Date(Date.now() + 9000));
    const pluginChange = run('check', fake, snap);
    assert.equal(pluginChange.status, 1, 'plugin entry outside node_modules and cache fails');
    assert.match(pluginChange.stderr, /^home-guard: mtime changed: plugins\/installed\/p\/manifest\.json$/m);
    assert.equal(run('record', fake, snap).status, 0, 'record after plugin sibling change passes');
    // A write to a checked child of agent still fails: the new file reports itself as an
    // added entry, and with that direct-child diff the agent dir mtime diff stays too.
    writeFileSync(join(fake, '.omp/agent/rules/x.md'), 'x');
    assert.notEqual(run('check', fake, snap).status, 0, 'checked agent child write fails');
    // Non-runtime layer content stays checked.
    utimesSync(join(fake, '.alate/layers/w1/config.yml'), new Date(), new Date(Date.now() + 9000));
    utimesSync(join(fake, '.alate/layers/token-reminders.json'), new Date(), new Date(Date.now() + 9000));
    assert.notEqual(run('check', fake, snap).status, 0, 'watched layer manifest write fails');
    // Adding a file under a watched dir fails.
    writeFileSync(join(fake, '.alate', 'extra.txt'), 'x');
    assert.equal(run('check', fake, snap).status !== 0, true, 'added entry fails');
    rmSync(join(fake, '.alate', 'extra.txt'));
    // Removing one fails.
    rmSync(join(fake, '.agents/skills/x/SKILL.md'));
    assert.notEqual(run('check', fake, snap).status, 0, 'removed entry fails');
    writeFileSync(join(fake, '.agents/skills/x/SKILL.md'), 'x');
    // Changing a file's mtime fails.
    const mtime = statSync(join(fake, '.agents/skills/x/SKILL.md')).mtime;
    utimesSync(join(fake, '.agents/skills/x/SKILL.md'), mtime, new Date(mtime.getTime() + 5000));
    assert.notEqual(run('check', fake, snap).status, 0, 'mtime change fails');
    // A write into a watched browser-profile file fails: only the profile's cache
    // and session stores are live state.
    writeFileSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Preferences'), '{}\n');
    assert.notEqual(run('check', fake, snap).status, 0, 'watched browser-profile write fails');
    // A missing snapshot file fails with a clear message.
    const missing = run('check', fake, join(tmp, 'no-such-snap.json'));
    assert.notEqual(missing.status, 0, 'missing snapshot fails');
    assert.match(missing.stderr, /snapshot missing/);
    // The recorded snapshot contains the watched entries and no unwatched one.
    const recorded = JSON.parse(readFileSync(snap, 'utf8'));
    assert.deepEqual(Object.keys(recorded.mtime).sort(), ['agent', 'agent/rules', 'agent/rules/r.md',
      'browser-profiles', 'browser-profiles/chrome-x', 'browser-profiles/chrome-x/Default',
      'browser-profiles/chrome-x/Default/Preferences',
      'layers', 'layers/token-reminders.json', 'layers/w1', 'layers/w1/.omp',
      'layers/w1/.omp/agent', 'layers/w1/.omp/agent/rules', 'layers/w1/.omp/agent/rules/r.md',
      'layers/w1/config.yml',
      'plugins', 'plugins/installed', 'plugins/installed/p', 'plugins/installed/p/manifest.json',
      'skills', 'skills/x', 'skills/x/SKILL.md', 'state.json']);
    assert.ok(!('agent/agent.db' in recorded.mtime) && !('logs' in recorded.mtime) && !('in-use.json' in recorded.mtime)
      && !('in-use.owners.json' in recorded.mtime)
      && !('context-mode' in recorded.mtime) && !('snapcompact-savings.jsonl' in recorded.mtime)
      && !('plugins/cache' in recorded.mtime) && !('memories' in recorded.mtime) && !('oauth' in recorded.mtime)
      && !('install-id' in recorded.mtime) && !('marketplaces.json' in recorded.mtime) && !('natives' in recorded.mtime)
      && !('browser-profiles/chrome-x/Default/Cache' in recorded.mtime)
      && !('browser-profiles/chrome-x/Default/GPUCache' in recorded.mtime)
      && !('browser-profiles/chrome-x/GrShaderCache' in recorded.mtime)
      && !('browser-profiles/chrome-x/GPUPersistentCache' in recorded.mtime)
      && !('browser-profiles/chrome-x/Default/Cookies' in recorded.mtime)
      && !('browser-profiles/chrome-x/Default/History-journal' in recorded.mtime)
      && !('layers/w1/.omp/puppeteer' in recorded.mtime) && !('layers/w1/.omp/cache' in recorded.mtime)
      && !('layers/w1/.omp/install-id' in recorded.mtime),
      'live runtime entries stay out of the snapshot');
    assert.deepEqual(Object.keys(recorded.dirs).sort(), ['agent', 'agent/rules',
      'browser-profiles', 'browser-profiles/chrome-x', 'browser-profiles/chrome-x/Default',
      'layers', 'layers/w1', 'layers/w1/.omp',
      'layers/w1/.omp/agent', 'layers/w1/.omp/agent/rules',
      'plugins', 'plugins/installed', 'plugins/installed/p',
      'skills', 'skills/x']);
    // ALAT-133 shape: live workers create and remove the SQLite -wal and -shm files of
    // agent.db, history.db and models.db directly in .omp/agent. No ignored file stays,
    // but the agent dir mtime moves; no checked child changed, so the check passes.
    assert.equal(run('record', fake, snap).status, 0, 're-record passes');
    const agentDir = join(fake, '.omp/agent');
    for (const db of ['agent.db', 'history.db', 'models.db']) {
      for (const ext of ['-wal', '-shm']) {
        writeFileSync(join(agentDir, db + ext), 'wal\n');
        rmSync(join(agentDir, db + ext));
      }
    }
    // Pin the moved dir mtime: a coarse file-system timestamp can hide the churn.
    utimesSync(agentDir, new Date(), new Date(Date.now() + 9000));
    assert.equal(run('check', fake, snap).status, 0, 'ignored-name churn in a watched dir passes');
    // The same churn with a non-ignored name in that dir fails: the file reports as an
    // added entry, and its direct-child diff keeps the agent dir mtime diff.
    writeFileSync(join(agentDir, 'agent.txt'), 'x\n');
    utimesSync(agentDir, new Date(), new Date(Date.now() + 18000));
    const realChange = run('check', fake, snap);
    assert.notEqual(realChange.status, 0, 'non-ignored file in a watched dir fails');
    assert.match(realChange.stderr, /^home-guard: added entry: agent\/agent\.txt$/m);
    assert.match(realChange.stderr, /^home-guard: mtime changed: agent$/m);
    // ALAT-169 merge turn: a sibling session's sync.mjs run rewrote the alate rules
    // install record in the real home mid-chain. The record alone churns: the check passes.
    const rulesDir = join(agentDir, 'rules');
    writeFileSync(join(rulesDir, '.alate-installed.json'), '{}\n');
    assert.equal(run('record', fake, snap).status, 0, 'record with the rules install record passes');
    writeFileSync(join(rulesDir, '.alate-installed.json'), '{"rules":[]}\n');
    utimesSync(join(rulesDir, '.alate-installed.json'), new Date(), new Date(Date.now() + 9000));
    assert.equal(run('check', fake, snap).status, 0, 'rules install record write passes');
    // A rule file beside the record stays watched: a sync install into this home still fails.
    writeFileSync(join(rulesDir, 'r.md'), 'changed\n');
    utimesSync(join(rulesDir, 'r.md'), new Date(), new Date(Date.now() + 9000));
    const ruleChange = run('check', fake, snap);
    assert.notEqual(ruleChange.status, 0, 'watched rule file write fails');
    assert.match(ruleChange.stderr, /^home-guard: mtime changed: agent\/rules\/r\.md$/m);
    console.log('home-guard ok');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return 0;
};

const mode = process.argv[2];
process.exit(mode === 'record' ? record(resolveSnap(process.argv))
  : mode === 'check' ? check(resolveSnap(process.argv))
  : mode === undefined ? selfCheck()
  : (console.error(`home-guard: unknown mode: ${mode}`), 2));
