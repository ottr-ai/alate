// Self-check for sync.mjs: node sync.test.mjs
// Hermetic: the data repo, the rules target and a copy of the tool script all live in a temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// The child's HOME is a scratch dir distinct from every target: a dropped positional or
// default (a Stryker mutant) writes into the sandbox, never the machine home, and the
// target assertions fail. ALATE_DATA points at a missing path, so a host that exports one
// cannot turn the missing-data refusals into surprise installs.
const childHome = join(tmp, 'child-home');
mkdirSync(childHome);
const childEnv = { ...process.env, HOME: childHome, USERPROFILE: childHome, ALATE_DATA: join(tmp, 'no-aldata') };
delete childEnv.PI_CODING_AGENT_DIR; // sync.mjs prefers it over HOME; an inherited value could be a real agent dir
const run = (t, extra = []) => spawnSync(process.execPath, [join(scriptDir, 'sync.mjs'), ...(t ? [t] : []), ...extra], { encoding: 'utf8', env: childEnv });

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
  assert.equal(r.stderr, '', 'a per-item failure is not a refusal: stderr stays empty');
  assert.equal(installed(target, 'a.md'), rule.replace('Body', 'New body'), 'a clean rule installs beside the failures');
  assert.ok(!existsSync(join(target, 'b.md')), 'a rejected rule never lands');
  assert.ok(!existsSync(join(target, 'c.md')));
  assert.ok(r.stdout.includes([
    'Failed items:',
    '  AGENTS.md — rejected: hidden character U+202E at AGENTS.md:1:5',
    '  b.md — rejected: hidden character U+200B at b.md:6:5',
    '  c.md — rejected: needs frontmatter with a description at c.md',
  ].join('\n')), r.stdout);
  assert.ok(!existsSync(join(target, 'AGENTS.md')), 'AGENTS.md is not installed by sync, problem or not');

  rmSync(join(data, 'b.md'));
  rmSync(join(data, 'c.md'));
  put('AGENTS.md', agents);
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 unchanged/m, 'a.md already installed beside the failures');
  assert.equal(installed(target, 'a.md'), rule.replace('Body', 'New body'));

  // Rules alate installs are recorded; a rule the data repo drops is deleted when its copy
  // still holds the recorded content, and a rule without a record is only reported.
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(join(target, '.alate-installed.json'), 'utf8'));
  assert.equal(record['a.md'], fingerprint('a.md', Buffer.from(rule.replace('Body', 'New body'))));
  assert.ok(!('mine.md' in record), 'a rule alate did not install is not recorded');

  // A rule that turns bad after it was installed: the record-matching copy of the now
  // rejected rule is deleted; a machine-changed copy stays, loses its record, and the
  // run exits 1 either way.
  put('a.md', 'bad\u200Brule\n');
  r = run(target, ['--data', data]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('deleted  a.md'), r.stdout);
  assert.ok(!existsSync(join(target, 'a.md')), 'the stale record-matching copy is deleted');
  assert.ok(r.stdout.includes('  a.md — rejected: hidden character U+200B at a.md:1:4'), r.stdout);

  put('a.md', rule.replace('Body', 'New body'));
  r = run(target, ['--data', data]); // reinstall so the manifest records a.md again
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(target, 'a.md'), 'machine edit\n');
  put('a.md', 'bad\u200Brule\n');
  r = run(target, ['--data', data]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(`changed here, kept: ${join(target, 'a.md')}`), r.stdout);
  assert.ok(!r.stdout.includes('deleted  '), 'a machine-changed copy is never deleted');
  assert.equal(installed(target, 'a.md'), 'machine edit\n');
  const recordBad = JSON.parse(readFileSync(join(target, '.alate-installed.json'), 'utf8'));
  assert.ok(!('a.md' in recordBad), 'the record of the rejected rule is dropped');

  // Restore a clean rule set for the later scenarios.
  put('a.md', rule.replace('Body', 'New body'));
  r = run(target, ['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated  a\.md/);

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

  // Uncovered: drop the covers. The uncovered items fail alone (acceptance c): a covered
  // rule still installs, the uncovered rule stays out, and the failures move from the
  // stderr refusal block to the stdout Failed items block.
  rmSync(join(data2, 'user/agents/skills/locked'), { recursive: true });
  rmSync(join(data2, 'user/agents/.skill-lock.json'));
  mkdirSync(join(data2, 'user/agents/skills/orphan'), { recursive: true });
  put2('user/agents/skills/orphan/SKILL.md', '# orphan\n');
  put2('covered.md', rule);
  put2('upstreams.json', JSON.stringify({ _doc: 'x', own: [], items: [
    { name: 'cov', kind: 'rule-set', origin: 'https://github.com/x/y', paths: ['covered.md'] },
  ] }));
  put2('user/omp/agent/mcp.json', JSON.stringify({ mcpServers: {
    foo: { command: 'npx', args: ['foo-mcp2@1.0.0'] },
    bar: { command: 'cmd', args: ['/c', 'npx', '-y', 'foo-mcp2@1.0.0'] },
  } }));
  const fresh = join(tmp, 'rules4');
  r = run(fresh, ['--data', data2]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '', 'uncovered origins are per-item failures, not a refusal');
  assert.equal(installed(fresh, 'covered.md'), rule, 'one uncovered origin does not stop the other items');
  assert.ok(!existsSync(join(fresh, 'a.md')), 'an uncovered rule never lands');
  assert.ok(r.stdout.includes([
    'Failed items:',
    '  a.md — no origin',
    '  user/agents/skills/orphan — no origin',
    '  user/omp/agent/managed-skills/m1 — no origin',
    '  user/omp/agent/mcp.json "bar" — no origin',
    '  user/omp/agent/mcp.json "foo" — no origin',
  ].join('\n')), r.stdout);

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

  // --- origin gate exactness: reset data2 to a minimal shape per scenario ---
  const reset2 = () => {
    rmSync(data2, { recursive: true, force: true });
    mkdirSync(data2, { recursive: true });
    put2('AGENTS.md', agents);
  };
  const freshTarget = name => { const t = join(tmp, name); mkdirSync(t, { recursive: true }); return t; };

  // Full-coverage install: every kind, every check type, a valid pin, and own globs
  // exercising each glob feature (**, *, ?, regex metacharacters); the gate stays silent.
  reset2();
  put2('a+b.md', rule);
  put2('preXpost.md', rule);
  put2('xXy.md', rule);
  put2('aXb.md', rule);
  put2('upstreams.json', JSON.stringify({ own: ['a+b.md', 'pre**post.md', 'x?y.md', 'a*b.md'], items: [
    { name: 'i1', kind: 'image-pin', origin: 'https://github.com/o/n', check: { type: 'npm', package: 'p' } },
    { name: 'i2', kind: 'mcp', origin: 'https://github.com/o/n', check: { type: 'github-release' } },
    { name: 'i3', kind: 'rule-set', origin: 'https://github.com/o/n', check: { type: 'github-path' } },
    { name: 'i4', kind: 'skill', origin: 'https://github.com/o/n', check: { type: 'node-dist' }, pin: { repo: 'r', file: 'f', key: 'k' } },
    { name: 'i5', kind: 'plugin', origin: 'https://github.com/aa/b', check: { type: 'chrome-for-testing' } },
    { name: 'i6', kind: 'skill', origin: 'https://github.com/o/ab' },
  ]}));
  r = run(freshTarget('rules6'), ['--data', data2]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');

  // Every item problem message in one exact list: a null item (label falls back to "#0",
  // kind/origin (missing) suffixes), unknown kind and check type, non-GitHub origin, bad pin.
  reset2();
  put2('u1.md', rule); // uncovered: pins the "no recorded origin" hint after the item problems
  put2('upstreams.json', JSON.stringify({ items: [
    null,
    { name: 'n1' },
    { name: 'n2', kind: 'weird', origin: 'ftp://x/', check: {}, pin: 5 },
    { kind: 'skill', origin: 'https://github.com/o/n/' },
    { name: 'n4', kind: 'skill', origin: 'https://github.com/o/n', check: null },
    { name: 'p1', kind: 'skill', origin: 'https://github.com/o/n', pin: { repo: 1, file: 2, key: 3 } },
  ]}));
  r = run(freshTarget('rules7'), ['--data', data2]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, [
    'Nothing installed. Fix:',
    '  upstreams.json: item "#0": unknown kind (missing)',
    '  upstreams.json: item "#0": origin is not a GitHub repo URL',
    '  upstreams.json: item "n1": unknown kind (missing)',
    '  upstreams.json: item "n1": origin is not a GitHub repo URL',
    '  upstreams.json: item "n2": unknown kind weird',
    '  upstreams.json: item "n2": origin is not a GitHub repo URL',
    '  upstreams.json: item "n2": unknown check type (missing)',
    '  upstreams.json: item "n2": pin needs repo, file and key',
    '  upstreams.json: item "n4": unknown check type (missing)',
    '  upstreams.json: item "p1": pin needs repo, file and key',
  ].join('\n') + '\n');
  assert.equal(r.stdout, '', 'a fatal gate refuses the run before any item is installed');
  assert.ok(!existsSync(join(tmp, 'rules7', 'u1.md')), 'the uncovered rule never lands');

  // Origin-URL regex edges (trailing path, leading junk, whitespace in owner), item paths
  // covering a rule, and a corrupt user/agents/mcp.json surfacing as a parse problem.
  reset2();
  put2('c1.md', rule);
  put2('c2.md', rule);
  mkdirSync(join(data2, 'user/omp/agent'), { recursive: true });
  put2('user/omp/agent/mcp.json', '{');
  put2('upstreams.json', JSON.stringify({ own: [], items: [
    { name: 'q', kind: 'skill', origin: 'https://github.com/o/n', paths: ['c1.md', 'zz.md'] },
    { name: 'r1', kind: 'skill', origin: 'https://github.com/o/n/extra' },
    { name: 'r2', kind: 'skill', origin: 'try https://github.com/o/n' },
    { name: 'r3', kind: 'skill', origin: 'https://github.com/o n/x' },
  ]}));
  r = run(freshTarget('rules8'), ['--data', data2]);
  assert.equal(r.status, 1);
  const gateLines = r.stderr.split('\n');
  assert.equal(gateLines[0], 'Nothing installed. Fix:');
  assert.deepEqual(gateLines.slice(1, 4), [
    '  upstreams.json: item "r1": origin is not a GitHub repo URL',
    '  upstreams.json: item "r2": origin is not a GitHub repo URL',
    '  upstreams.json: item "r3": origin is not a GitHub repo URL',
  ], r.stderr);
  assert.match(gateLines[4], /^  user\/omp\/agent\/mcp\.json: /);
  const mcpMsg = (() => { try { JSON.parse('{'); } catch (e) { return e.message; } })();
  assert.equal(gateLines[4], `  user/omp/agent/mcp.json: ${mcpMsg}`);
  assert.deepEqual(gateLines.slice(5), [''], r.stderr);
  assert.equal(r.stdout, '', 'a fatal gate refuses the run before any item is installed');

  // No items and no own entries: the fallbacks are empty and the only rule is uncovered —
  // a per-item failure now, not a refusal.
  reset2();
  put2('z.md', rule);
  put2('upstreams.json', '{}');
  r = run(freshTarget('rules9'), ['--data', data2]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.ok(!existsSync(join(tmp, 'rules9', 'z.md')), 'the uncovered rule never lands');
  assert.ok(r.stdout.includes('Failed items:\n  z.md — no origin'), r.stdout);

  // Glob patterns are fully anchored: a name that merely contains or extends a pattern is
  // still uncovered and named exactly.
  reset2();
  put2('qa+b.md', rule);
  put2('xa+b.md', rule);
  put2('a+b.md2.md', rule);
  put2('upstreams.json', JSON.stringify({ own: ['a+b.md'], items: [] }));
  r = run(freshTarget('rules10'), ['--data', data2]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.includes([
    'Failed items:',
    '  a+b.md2.md — no origin',
    '  qa+b.md — no origin',
    '  xa+b.md — no origin',
  ].join('\n')), r.stdout);

  // --- machine-readable results file (ALATE_PROVISION_RESULTS) ---
  const resultsPath = join(tmp, 'results.json');
  const runRes = (t, extra = []) => spawnSync(process.execPath, [join(scriptDir, 'sync.mjs'), ...(t ? [t] : []), ...extra],
    { encoding: 'utf8', env: { ...childEnv, ALATE_PROVISION_RESULTS: resultsPath } });

  // One good + one uncovered rule: the run is not fatal, the good rule installs, the
  // uncovered one is reported no-origin in the file.
  reset2();
  put2('g1.md', rule);
  put2('g2.md', rule);
  put2('upstreams.json', JSON.stringify({ own: ['g1.md'], items: [] }));
  rmSync(resultsPath, { force: true });
  r = runRes(freshTarget('results-ok'), ['--data', data2]);
  assert.equal(r.status, 1);
  const okResults = JSON.parse(readFileSync(resultsPath, 'utf8'));
  assert.equal(okResults.fatal, false);
  assert.equal(okResults.error, null);
  assert.deepEqual(okResults.items, [
    { item: 'g1.md', status: 'installed', rule: null, at: null },
    { item: 'g2.md', status: 'no-origin', rule: null, at: null },
  ]);

  // A refused run (upstreams.json not JSON) writes fatal: true with the error message.
  rmSync(resultsPath, { force: true });
  put2('upstreams.json', '{ not json');
  r = runRes(freshTarget('results-fatal'), ['--data', data2]);
  assert.equal(r.status, 1);
  const fatalResults = JSON.parse(readFileSync(resultsPath, 'utf8'));
  assert.equal(fatalResults.fatal, true);
  assert.match(fatalResults.error, /upstreams\.json: /);
  assert.deepEqual(fatalResults.items, []);

  // Pinned Python MCP servers (uvx / pipx run) and own-glob coverage for self-written servers.
  const pypiItem = pkg => ({ name: 'atl', kind: 'mcp', origin: 'https://github.com/x/y', check: { type: 'pypi', package: pkg } });
  const mcpReset = servers => {
    reset2();
    put2('r.md', rule);
    mkdirSync(join(data2, 'user/omp/agent'), { recursive: true });
    put2('user/omp/agent/mcp.json', JSON.stringify({ mcpServers: servers }));
  };
  const gateRun = (up, tname) => {
    put2('upstreams.json', JSON.stringify(up));
    return run(freshTarget(tname), ['--data', data2]);
  };

  // 1. Pinned uvx + pypi item: covered, installs cleanly.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian==0.24.1'] } });
  r = gateRun({ own: ['r.md'], items: [pypiItem('mcp-atlassian')] }, 'rules-py1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');

  // 2. Unpinned uvx: the specific unpinned message, not the generic hint.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian'] } });
  r = gateRun({ own: ['r.md'], items: [pypiItem('mcp-atlassian')] }, 'rules-py2');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /uvx package "mcp-atlassian" is not pinned to a version — pin it in mcp\.json args as "mcp-atlassian==<version>" and add an upstreams\.json item with check \{"type":"pypi","package":"mcp-atlassian"\}/);

  // 3. pipx run: pinned passes, unpinned gets the pipx run message.
  mcpReset({ sx: { command: 'pipx', args: ['run', 'mcp-server-x==1.2.3'] } });
  r = gateRun({ own: ['r.md'], items: [{ name: 'atl', kind: 'mcp', origin: 'https://github.com/x/y', check: { type: 'pypi', package: 'mcp-server-x' } }] }, 'rules-py3');
  assert.equal(r.status, 0, r.stderr);
  mcpReset({ sx: { command: 'pipx', args: ['run', 'mcp-server-x'] } });
  r = gateRun({ own: ['r.md'], items: [pypiItem('mcp-server-x')] }, 'rules-py4');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /pipx run package "mcp-server-x" is not pinned to a version/);

  // 4. Own glob covers a self-written server under the child's HOME; a non-matching own list leaves it uncovered.
  mcpReset({ mine: { command: join(childHome, 'servers', 'my-mcp.py'), args: [] } });
  r = gateRun({ own: ['r.md', '**/servers/*.py'], items: [] }, 'rules-py5');
  assert.equal(r.status, 0, r.stderr);
  r = gateRun({ own: ['/home/u/other/**', 'r.md'], items: [] }, 'rules-py6');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /  user\/omp\/agent\/mcp\.json "mine" — no origin/);

  // 5. Pinned spec but no pypi item: generic uncovered line with the standard hint.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian==0.24.1'] } });
  r = gateRun({ own: ['r.md'], items: [] }, 'rules-py7');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /  user\/omp\/agent\/mcp\.json "atl" — no origin/);

  // 6. Type discrimination: an npm item with the same package never covers a Python server.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian==0.24.1'] } });
  r = gateRun({ own: ['r.md'], items: [{ name: 'atl', kind: 'mcp', origin: 'https://github.com/x/y', check: { type: 'npm', package: 'mcp-atlassian' } }] }, 'rules-py8');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /  user\/omp\/agent\/mcp\.json "atl" — no origin/);

  // 7. A pypi item without a usable package string does not cover.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian==0.24.1'] } });
  r = gateRun({ own: ['r.md'], items: [{ name: 'atl', kind: 'mcp', origin: 'https://github.com/x/y', check: { type: 'pypi' } }] }, 'rules-py9');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /  user\/omp\/agent\/mcp\.json "atl" — no origin/);

  // 8. An empty version is not a concrete pin: the unpinned refusal fires despite the `==`.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian=='] } });
  r = gateRun({ own: ['r.md'], items: [pypiItem('mcp-atlassian')] }, 'rules-py10');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^    uvx package "mcp-atlassian" is not pinned to a version — pin it in mcp\.json args as "mcp-atlassian==<version>" and add an upstreams\.json item with check \{"type":"pypi","package":"mcp-atlassian"\}$/m);

  // 9. A PEP 440 wildcard is not a concrete pin: the unpinned refusal fires.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian==1.*'] } });
  r = gateRun({ own: ['r.md'], items: [pypiItem('mcp-atlassian')] }, 'rules-py11');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^    uvx package "mcp-atlassian" is not pinned to a version — pin it in mcp\.json args as "mcp-atlassian==<version>" and add an upstreams\.json item with check \{"type":"pypi","package":"mcp-atlassian"\}$/m);

  // 10. A concrete prerelease pin is still a pin.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian==1.0rc1'] } });
  r = gateRun({ own: ['r.md'], items: [pypiItem('mcp-atlassian')] }, 'rules-py12');
  assert.equal(r.status, 0, r.stderr);

  // 11. Own-glob coverage needs the command inside the child's HOME; the glob alone is not enough.
  mcpReset({ mine: { command: join(childHome, 'servers', 'mine.py'), args: [] } });
  r = gateRun({ own: ['r.md', '**/servers/*.py'], items: [] }, 'rules-py13');
  assert.equal(r.status, 0, r.stderr);

  // 12. Outside the HOME the matching glob alone must not cover: generic uncovered line.
  mcpReset({ vend: { command: '/opt/vendor/servers/x.py', args: [] } });
  r = gateRun({ own: ['r.md', '**/servers/*.py'], items: [] }, 'rules-py14');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /  user\/omp\/agent\/mcp\.json "vend" — no origin/);

  // 13. A bare runner name never satisfies an own glob; the pin rule still applies.
  mcpReset({ atl: { command: 'uvx', args: ['mcp-atlassian'] } });
  r = gateRun({ own: ['r.md', 'uvx'], items: [pypiItem('mcp-atlassian')] }, 'rules-py15');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /uvx package "mcp-atlassian" is not pinned to a version/);

  // --- --compare: the labels and the deleted count come from an existing rules dir (the
  // live layer's rules dir in a layer install), never from the fresh target; the compare
  // dir stays read-only, the fresh target still receives every rule byte. ---
  reset2();
  put2('r.md', rule);
  const liveDir = freshTarget('compare-live');
  r = run(liveDir, ['--data', data2]);
  assert.equal(r.status, 0, r.stderr);
  const freshCmp = freshTarget('compare-fresh');
  rmSync(resultsPath, { force: true });
  r = runRes(freshCmp, ['--data', data2, '--compare', liveDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 updated, 0 added, 1 unchanged, 0 deleted in /, 'an unchanged rule is labeled against the compare dir');
  assert.deepEqual(JSON.parse(readFileSync(resultsPath, 'utf8')).items, [
    { item: 'r.md', status: 'unchanged', rule: null, at: null },
  ]);
  assert.equal(installed(freshCmp, 'r.md'), rule, 'the fresh target still receives the rule bytes');
  assert.equal(installed(liveDir, 'r.md'), rule, 'the compare dir keeps its bytes');

  // One changed rule and one new rule: exactly one updated and one added label.
  writeFileSync(join(data2, 'r.md'), rule.replace('Body', 'New body'));
  put2('n.md', rule);
  rmSync(resultsPath, { force: true });
  const freshCmp2 = freshTarget('compare-fresh2');
  r = runRes(freshCmp2, ['--data', data2, '--compare', liveDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated  r\.md/);
  assert.match(r.stdout, /added  n\.md/);
  assert.match(r.stdout, /1 updated, 1 added, 0 unchanged, 0 deleted in /);
  assert.deepEqual(JSON.parse(readFileSync(resultsPath, 'utf8')).items.map(i => [i.item, i.status]), [
    ['n.md', 'added'],
    ['r.md', 'updated'],
  ]);
  assert.equal(installed(freshCmp2, 'r.md'), rule.replace('Body', 'New body'), 'the fresh target holds the new bytes');
  assert.equal(installed(liveDir, 'r.md'), rule, 'the compare dir keeps its bytes');

  // One removed rule counts as deleted; the compare dir is never unlinked.
  rmSync(join(data2, 'r.md'));
  rmSync(join(data2, 'n.md'));
  rmSync(resultsPath, { force: true });
  const freshCmp3 = freshTarget('compare-fresh3');
  r = runRes(freshCmp3, ['--data', data2, '--compare', liveDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deleted  r\.md/);
  assert.match(r.stdout, /0 updated, 0 added, 0 unchanged, 1 deleted in /);
  assert.ok(existsSync(join(liveDir, 'r.md')), 'the compare dir keeps its dropped copy');
  assert.ok(!existsSync(join(freshCmp3, 'r.md')), 'the fresh target leaves the dropped rule out');

  // A recorded rule that changed in the compare dir and is dropped counts as deleted too,
  // with its own note: the new layer leaves it out either way.
  writeFileSync(join(liveDir, 'r.md'), rule.replace('Body', 'Machine edit'));
  rmSync(resultsPath, { force: true });
  const freshCmp4 = freshTarget('compare-fresh4');
  r = runRes(freshCmp4, ['--data', data2, '--compare', liveDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /changed here, left out: .+compare-live.{1,3}r\.md/);
  assert.match(r.stdout, /0 updated, 0 added, 0 unchanged, 1 deleted in /, 'the changed dropped rule counts as deleted');
  assert.ok(existsSync(join(liveDir, 'r.md')), 'the compare dir keeps its copy');

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
