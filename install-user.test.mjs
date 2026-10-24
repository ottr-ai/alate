// Self-check for install-user.mjs: node install-user.test.mjs
// Hermetic: the data repo (with user/ snapshot) and a copy of the tool script live in a temp dir.
// Offline by design: every invocation uses --skip-plugins.
// The examples/data install workflow also skips plugins; neither proves Bun installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, forTarget, keepTemp } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-install-'));
const scriptDir = join(tmp, 'tool'); // copy of the script + lib, so the default ../agent-data fallback misses
const data = join(tmp, 'data');
const home = join(tmp, 'home');
mkdirSync(join(scriptDir, 'lib'), { recursive: true });
copyFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), join(scriptDir, 'install-user.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(scriptDir, 'lib', 'data.mjs'));
const put = (rel, text) => { mkdirSync(join(data, 'user', rel, '..'), { recursive: true }); writeFileSync(join(data, 'user', rel), text); };
const run = (extra, h = home, env) => spawnSync(process.execPath, [join(scriptDir, 'install-user.mjs'), '--home', h, ...extra], {
  encoding: 'utf8',
  // Default env puts the stub skillspector first on PATH (the scan gate); an explicit env runs
  // without it. Windows cannot exec an extensionless stub through spawnSync, so there the suite
  // needs a real skillspector on PATH: the gate fails closed without one, by design.
  env: env ?? (scanned ? { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}` } : undefined),
});
// The stub logs its argv and exits with a script-set code: 0 clean, 1 findings.
const stubDir = join(tmp, 'stub');
const callsLog = join(stubDir, 'calls.log');
const scanned = process.platform !== 'win32';
const writeStub = exit => {
  writeFileSync(join(stubDir, 'skillspector'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsLog}'\nexit ${exit}\n`);
  chmodSync(join(stubDir, 'skillspector'), 0o755);
};
if (scanned) {
  mkdirSync(stubDir, { recursive: true });
  writeStub(0);
}
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
    r = run(['--data', data, '--skip-plugins'], home, { ...process.env });
    assert.equal(r.status, 1, 'a missing scanner refuses the run');
    assert.match(r.stderr, /skillspector not found/);
    assert.match(r.stderr, /SkillSpector@v2\.13\.0/);
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/EVIL.md')));

    // A clean snapshot installs as before, and the blocked state carried no damage.
    writeStub(0);
    rmSync(join(data, 'user/omp/agent/skills/mine/EVIL.md'));
    put('omp/agent/skills/mine/RENAME.md', '# mine, v6\n');
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 installed/);
    assert.equal(got('.omp/agent/skills/mine/RENAME.md'), '# mine, v6\n');
  } else {
    console.log('win32: the scanner-stub checks need a real skillspector on PATH; gate assertions skipped');
  }

  // The server image must carry the scanner the gate refuses to run without; the two pins
  // must not drift (an unpinned image made every containerized provision fail).
  const source = readFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), 'utf8');
  const ref = source.match(/const SKILLSPECTOR_REF = '(v[\d.]+)';/)?.[1];
  assert.ok(ref, 'install-user.mjs pins SKILLSPECTOR_REF');
  assert.ok(
    readFileSync(fileURLToPath(new URL('./Dockerfile', import.meta.url)), 'utf8').includes(`ARG SKILLSPECTOR_REF=${ref}`),
    `Dockerfile must carry the pinned build install-user.mjs requires (${ref})`,
  );

  console.log('install-user.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
