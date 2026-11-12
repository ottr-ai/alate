// Guard against writes into the real home's watched dirs during the test chain.
// Three modes: (none) self-check with fake homes; `record [snap]` snapshots the real home;
// `check [snap]` re-walks and fails with one diff line per finding.
// The platform's own runtime state (the omp databases and hour logs, .omp/cache,
// .omp/run, the session stores under .omp — context-mode, custom-session-files,
// snapcompact — the agent blob cache .omp/agent/blobs, the chrome-devtools browser
// profiles .omp/browser-profiles, the live worker's .omp/plugins/cache downloads
// (anything else under plugins/ stays checked), .omp/memories, .omp/oauth,
// .omp/install-id, .omp/marketplaces.json, .omp/natives, and the two bookkeeping
// files under .alate) is excluded: a live worker writes it during any chain run,
// and none of it is a test write.
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
// test writes, so the guard ignores them. That includes the chrome-devtools browser profiles
// under .omp/browser-profiles: a live browser session rewrites caches and session stores
// mid-chain. A live worker also rewrites its plugin download cache (.omp/plugins/cache;
// anything else under plugins/ stays checked), its memories, its oauth state, its native
// grammar files (.omp/natives), and the install-id and marketplaces.json bookkeeping
// files. Everything else in the watched dirs — skills, rules, agent context,
// installed.json, layers, current — is checked for presence and mtime.
const LIVE = {
  '.alate': rel => rel === 'in-use.json' || rel === 'skillspector-pass.json',
  '.agents': () => false,
  '.omp': rel => rel === 'logs' || rel.startsWith('logs/') || rel === 'cache' || rel.startsWith('cache/')
    || rel === 'run' || rel.startsWith('run/')
    || rel === 'context-mode' || rel.startsWith('context-mode/')
    || rel === 'agent/custom-session-files' || rel.startsWith('agent/custom-session-files/')
    || rel === 'snapcompact-savings.jsonl'
    || rel === 'agent/blobs' || rel.startsWith('agent/blobs/')
    || rel === 'browser-profiles' || rel.startsWith('browser-profiles/')
    || rel === 'plugins/cache' || rel.startsWith('plugins/cache/')
    || rel === 'memories' || rel.startsWith('memories/')
    || rel === 'oauth' || rel.startsWith('oauth/')
    || rel === 'install-id'
    || rel === 'marketplaces.json'
    || rel === 'natives' || rel.startsWith('natives/')
    || /^agent\/[A-Za-z0-9-]+\.db(?:\.|-|$)/.test(rel),
};
const resolveSnap = (argv) => argv[3] ?? process.env.ALATE_HOME_GUARD_SNAPSHOT ?? join(tmpdir(), 'alate-home-guard-snapshot.json');

// Walk one watched dir into out: every file and subdirectory, keyed relative with forward
// slashes, value lstat mtimeMs. Never follow symlinks; a symlinked root records nothing,
// no walk. A missing dir records as absent.
const walkWatched = (root, out, isLive) => {
  if (!existsSync(root)) return;
  const st = lstatSync(root);
  if (st.isSymbolicLink()) return;
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const relKey = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      const s = lstatSync(full);
      if (!isLive(relKey)) out[relKey] = s.mtimeMs;
      if (s.isDirectory()) walk(full, relKey);
    }
  };
  walk(root, '');
};

const snapshot = () => {
  const out = {};
  for (const dir of WATCHED) walkWatched(join(homedir(), dir), out, LIVE[dir] ?? (() => false));
  return out;
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
const diff = (snapPathArg) => {
  if (!existsSync(snapPathArg)) return [`snapshot missing: ${snapPathArg}`];
  const snap = JSON.parse(readFileSync(snapPathArg, 'utf8'));
  const now = snapshot();
  const lines = [];
  for (const key of Object.keys(snap)) if (!(key in now)) lines.push(`removed entry: ${key}`);
  for (const key of Object.keys(now)) {
    if (!(key in snap)) lines.push(`added entry: ${key}`);
    else if (snap[key] !== now[key]) lines.push(`mtime changed: ${key}`);
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
  for (const rel of ['.alate/state.json', '.alate/in-use.json', '.alate/skillspector-pass.json',
    '.omp/browser-profiles/chrome-x/Default/Preferences',
    '.agents/skills/x/SKILL.md', '.omp/agent/rules/r.md', '.omp/agent/agent.db', '.omp/agent/agent.db-wal',
    '.omp/agent/skill-descriptions.db-shm', '.omp/agent/skill-descriptions.db-wal',
    '.omp/logs/omp.231.log', '.omp/context-mode/sessions/s.db-shm', '.omp/agent/custom-session-files/a',
    '.omp/snapcompact-savings.jsonl', 'unwatched.txt',
    '.omp/plugins/cache/marketplaces/idx.json', '.omp/plugins/installed/p/manifest.json',
    '.omp/memories/m.md', '.omp/oauth/tokens.json', '.omp/install-id',
    '.omp/marketplaces.json', '.omp/natives/grammars/en.wasm']) {
    mkdirSync(join(fake, rel, '..'), { recursive: true });
    writeFileSync(join(fake, rel), rel);
  }
  // The blob cache dir pre-exists on any machine that has run omp once; its entries churn.
  // So does the live worker's own state: the plugin download cache, memories, oauth,
  // natives, install-id and marketplaces.json.
  mkdirSync(join(fake, '.omp/agent/blobs'), { recursive: true });
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
    writeFileSync(join(fake, '.omp/logs/omp.231.log'), 'more\n');
    writeFileSync(join(fake, '.alate/skillspector-pass.json'), '{}\n');
    writeFileSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Preferences'), '{}\n');
    utimesSync(join(fake, '.omp/browser-profiles/chrome-x/Default/Preferences'), new Date(), new Date(Date.now() + 9000));
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
    assert.equal(run('check', fake, snap).status, 0, 'live runtime churn passes');
    // Anything under plugins/ outside cache/ stays checked.
    utimesSync(join(fake, '.omp/plugins/installed/p/manifest.json'), new Date(), new Date(Date.now() + 9000));
    assert.notEqual(run('check', fake, snap).status, 0, 'plugins entry outside cache fails');
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
    // A missing snapshot file fails with a clear message.
    const missing = run('check', fake, join(tmp, 'no-such-snap.json'));
    assert.notEqual(missing.status, 0, 'missing snapshot fails');
    assert.match(missing.stderr, /snapshot missing/);
    // The recorded snapshot contains the watched entries and no unwatched one.
    const recorded = JSON.parse(readFileSync(snap, 'utf8'));
    assert.deepEqual(Object.keys(recorded).sort(), ['agent', 'agent/rules', 'agent/rules/r.md',
      'plugins', 'plugins/installed', 'plugins/installed/p', 'plugins/installed/p/manifest.json',
      'skills', 'skills/x', 'skills/x/SKILL.md', 'state.json']);
    assert.ok(!('agent/agent.db' in recorded) && !('logs' in recorded) && !('in-use.json' in recorded)
      && !('context-mode' in recorded) && !('snapcompact-savings.jsonl' in recorded)
      && !('plugins/cache' in recorded) && !('memories' in recorded) && !('oauth' in recorded)
      && !('install-id' in recorded) && !('marketplaces.json' in recorded) && !('natives' in recorded),
      'live runtime entries stay out of the snapshot');
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
