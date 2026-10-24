// Self-check for sync.mjs: node sync.test.mjs
// Hermetic: the data repo, the rules target and a copy of the tool script all live in a temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, keepTemp } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-sync-'));
const scriptDir = join(tmp, 'tool'); // copy of the script + lib, so the default ../agent-data fallback misses
const data = join(tmp, 'data');
const target = join(tmp, 'rules');
mkdirSync(join(scriptDir, 'lib'), { recursive: true });
mkdirSync(data);
copyFileSync(fileURLToPath(new URL('./sync.mjs', import.meta.url)), join(scriptDir, 'sync.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(scriptDir, 'lib', 'data.mjs'));
const rule = '---\ndescription: test rule\nalwaysApply: true\n---\n\nBody — dashes → arrows stay allowed\n';
const agents = '# data repo instructions, not a rule\n';
const put = (name, text) => writeFileSync(join(data, name), text);
const rmLink = p => { try { rmSync(p); } catch { spawnSync('cmd', ['/c', 'rmdir', p]); } }; // bun can't rmSync junctions
const installed = (t, name) => readFileSync(join(t, name), 'utf8');
const run = (t, extra = []) => spawnSync(process.execPath, [join(scriptDir, 'sync.mjs'), ...(t ? [t] : []), ...extra], { encoding: 'utf8' });

try {
  // Missing data dir: no --data, fallback ../agent-data beside scriptDir does not exist.
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No data dir|--data|--repo/);

  put('a.md', rule);
  put('AGENTS.md', agents);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'mine.md'), rule);

  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added\s+a\.md/);
  assert.equal(installed(target, 'a.md'), rule);
  assert.ok(!existsSync(join(target, 'AGENTS.md')), 'AGENTS.md is not a rule');
  assert.match(r.stdout, /left in place: mine\.md/);
  assert.ok(existsSync(join(target, 'mine.md')), 'never deletes');

  r = run(target, ['--data', data]);
  assert.match(r.stdout, /^1 unchanged/m);

  // --repo <existing local path> clones and installs the same bytes (git clone needs a real repo).
  const commit = spawnSync('git', ['-C', data, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { encoding: 'utf8' });
  if (commit.status !== 0) {
    spawnSync('git', ['-C', data, 'init', '-q']);
    spawnSync('git', ['-C', data, 'add', '-A']);
    spawnSync('git', ['-C', data, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);
  }
  const cloneTarget = join(tmp, 'rules2');
  r = run(cloneTarget, ['--repo', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added\s+a\.md/);
  assert.equal(installed(cloneTarget, 'a.md').replaceAll('\r\n', '\n'), rule, 'clone output matches modulo autocrlf');
  assert.ok(!existsSync(join(cloneTarget, 'AGENTS.md')));

  put('a.md', rule.replace('Body', 'New body'));
  put('b.md', rule.replace('Body', 'Zero\u200Bwidth') + 'Tag\u{E0041}smuggling\nEsc\x1B[31m\nVar\u{E0101}sel\n');
  put('c.md', 'no frontmatter\n');
  put('AGENTS.md', 'Bidi\u202Eoverride\n');
  r = run(target, ['--data', data]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /b\.md:6:5: hidden character U\+200B/);
  assert.match(r.stderr, /b\.md:7:4: hidden character U\+E0041/);
  assert.match(r.stderr, /b\.md:8:4: hidden character U\+001B/);
  assert.match(r.stderr, /b\.md:9:4: hidden character U\+E0101/);
  assert.match(r.stderr, /c\.md: needs frontmatter/);
  assert.match(r.stderr, /AGENTS\.md:1:5: hidden character U\+202E/);
  assert.equal(installed(target, 'a.md'), rule, 'a failed check installs nothing');
  assert.ok(!existsSync(join(target, 'b.md')));

  rmSync(join(data, 'b.md'));
  rmSync(join(data, 'c.md'));
  put('AGENTS.md', agents);
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated\s+a\.md/);
  assert.equal(installed(target, 'a.md'), rule.replace('Body', 'New body'));

  // Rules alate installs are recorded; a rule the data repo drops is deleted when its copy
  // still holds the recorded content, and a rule without a record is only reported.
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(join(target, '.alate-installed.json'), 'utf8'));
  assert.equal(record['a.md'], fingerprint('a.md', Buffer.from(rule.replace('Body', 'New body'))));
  assert.ok(!('mine.md' in record), 'a rule alate did not install is not recorded');

  rmSync(join(data, 'a.md'));
  put('g.md', rule);
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added  g\.md/);
  assert.match(r.stdout, /deleted  a\.md/);
  assert.match(r.stdout, /left in place: mine\.md/, 'an unrecorded rule is still only reported');
  assert.ok(!existsSync(join(target, 'a.md')));
  assert.equal(installed(target, 'g.md'), rule);
  const record2 = JSON.parse(readFileSync(join(target, '.alate-installed.json'), 'utf8'));
  assert.ok(record2['g.md'], 'the rename is recorded under its new name');
  assert.ok(!('a.md' in record2));

  // A dropped rule that changed here stays, loses its record, and is reported.
  writeFileSync(join(target, 'g.md'), 'hand edit\n');
  rmSync(join(data, 'g.md'));
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('changed here, kept: '));
  assert.ok(r.stdout.includes(join(target, 'g.md')), r.stdout);
  assert.ok(!r.stdout.includes('deleted  '), 'a changed rule is never deleted');
  assert.equal(installed(target, 'g.md'), 'hand edit\n');
  const listed = r.stdout.match(/left in place: (.*)/)[1].split(', ').sort();
  assert.deepEqual(listed, ['g.md', 'mine.md']);

  // An unreadable record proves nothing: dropped rules are only reported.
  writeFileSync(join(target, '.alate-installed.json'), '{');
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Ignoring unreadable/);
  assert.equal(installed(target, 'g.md'), 'hand edit\n', 'nothing is deleted without a record');

  // Restore a.md so the win32 junction case below still finds it installed.
  put('a.md', rule.replace('Body', 'New body'));
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added  a\.md/);

  // --- origin gate: second fixture dir with its own target ---
  const data2 = join(tmp, 'data2');
  const put2 = (name, text) => writeFileSync(join(data2, name), text);
  mkdirSync(join(data2, 'user/agents/skills/orphan'), { recursive: true });
  put2('user/agents/skills/orphan/SKILL.md', '# orphan\n');
  mkdirSync(join(data2, 'user/omp/agent/managed-skills/m1'), { recursive: true });
  put2('user/omp/agent/managed-skills/m1/x.md', '# m1\n');
  put2('a.md', rule);
  put2('user/omp/agent/mcp.json', JSON.stringify({ mcpServers: { foo: { command: 'npx', args: ['foo-mcp@1.0.0'] } } }));

  // Gate off: no upstreams.json, unchecked items are fine.
  r = run(join(tmp, 'rules3'), ['--data', data2]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(installed(join(tmp, 'rules3'), 'a.md'), rule);

  // Full coverage: every checked item has a recorded origin, installs.
  rmSync(join(data2, 'user/agents/skills/orphan'), { recursive: true });
  put2('upstreams.json', JSON.stringify({
    _doc: 'where public items come from',
    own: ['user/omp/agent/managed-skills/*'],
    items: [
      { name: 'a rule', kind: 'rule-set', origin: 'https://github.com/x/y', paths: ['a.md'] },
      { name: 'locked', kind: 'skill', origin: 'https://github.com/x/z' },
      { name: 'foo', kind: 'mcp', origin: 'https://github.com/x/w', check: { type: 'npm', package: 'foo-mcp' } },
    ],
  }));
  put2('user/agents/.skill-lock.json', JSON.stringify({ version: 1, skills: { locked: {} } }));
  mkdirSync(join(data2, 'user/agents/skills/locked'), { recursive: true });
  put2('user/agents/skills/locked/SKILL.md', '# locked\n');
  r = run(join(tmp, 'rules3'), ['--data', data2]);
  assert.equal(r.status, 0, r.stderr);

  // Windows captures wrap npx in cmd /c; the gate reads through the wrapper (unwrapCmd).
  put2('user/omp/agent/mcp.json', JSON.stringify({ mcpServers: { foo: { type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'foo-mcp@1.2.3'] } } }));
  r = run(join(tmp, 'rules3'), ['--data', data2]);
  assert.equal(r.status, 0, r.stderr);
  put2('user/omp/agent/mcp.json', JSON.stringify({ mcpServers: { foo: { command: 'cmd.exe', args: ['/d', '/c', 'npx', 'foo-mcp'] } } }));
  r = run(join(tmp, 'rules3'), ['--data', data2]);
  assert.equal(r.status, 0, r.stderr);

  // Uncovered: drop the covers, gate fails with the exact hint and installs nothing.
  rmSync(join(data2, 'user/agents/skills/locked'), { recursive: true });
  rmSync(join(data2, 'user/agents/.skill-lock.json'));
  mkdirSync(join(data2, 'user/agents/skills/orphan'), { recursive: true });
  put2('user/agents/skills/orphan/SKILL.md', '# orphan\n');
  put2('upstreams.json', JSON.stringify({ _doc: 'x', own: [], items: [] }));
  put2('user/omp/agent/mcp.json', JSON.stringify({ mcpServers: {
    foo: { command: 'npx', args: ['foo-mcp2@1.0.0'] },
    bar: { command: 'cmd', args: ['/c', 'npx', '-y', 'foo-mcp2@1.0.0'] },
  } }));
  const fresh = join(tmp, 'rules4');
  r = run(fresh, ['--data', data2]);
  assert.equal(r.status, 1);
  const hint = 'no recorded origin — add an item to upstreams.json or an own entry';
  assert.match(r.stderr, new RegExp(`a\\.md: ${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stderr, /user\/agents\/skills\/orphan: no recorded origin/);
  assert.match(r.stderr, /user\/omp\/agent\/managed-skills\/m1: no recorded origin/);
  assert.match(r.stderr, /user\/omp\/agent\/mcp\.json "foo": no recorded origin/);
  assert.match(r.stderr, /user\/omp\/agent\/mcp\.json "bar": no recorded origin/);
  assert.ok(!existsSync(join(fresh, 'a.md')), 'an uncovered path installs nothing');

  // Validation: parse errors and all item problems in one run.
  put2('upstreams.json', '{ not json');
  r = run(join(tmp, 'rules5'), ['--data', data2]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /upstreams\.json: /);
  put2('upstreams.json', JSON.stringify({ items: [
    { name: 'bad kind', kind: 'widget', origin: 'https://github.com/x/y' },
    { name: 'bad check', kind: 'skill', origin: 'https://github.com/x/y', check: { type: 'cvs' } },
    { name: 'bad origin', kind: 'skill', origin: 'https://gitlab.com/x/y' },
    { name: 'bad pin', kind: 'image-pin', origin: 'https://github.com/x/y', pin: { repo: 'r', file: 'f' } },
  ]}));
  r = run(join(tmp, 'rules5'), ['--data', data2]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /item "bad kind": unknown kind/);
  assert.match(r.stderr, /item "bad check": unknown check type/);
  assert.match(r.stderr, /item "bad origin": origin is not a GitHub repo URL/);
  assert.match(r.stderr, /item "bad pin": pin needs repo, file and key/);

  if (process.platform === 'win32') {
    const link = join(tmp, 'rules-link');
    symlinkSync(data, link, 'junction');
    r = run(link, ['--data', data]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /resolves to the data dir/);
    assert.equal(installed(target, 'a.md'), rule.replace('Body', 'New body'), 'junction target untouched');
    rmLink(link);
  }
  console.log('sync.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
