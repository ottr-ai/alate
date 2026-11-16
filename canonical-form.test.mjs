// Canonical-form acceptance tests (specs/canonical-form.md): node canonical-form.test.mjs
// Red today by design. Each section runs even when an earlier one fails; the file exits 1
// while any check is red. Hermetic: temp homes, temp data dirs, a stub scanner on PATH,
// ALATE_DATA pointing nowhere, no network, no plugins (--skip-plugins). The tree cleans
// itself up unless ALATE_KEEP_TEMP is set (same pattern as install-user.test.mjs).
// Skips itself on Windows: the scanner stub is a POSIX shell script and section C needs
// git index modes and POSIX paths.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_ROOTS, forTarget, toStoredForm } from './lib/data.mjs';

if (process.platform === 'win32') {
  console.log('canonical-form.test.mjs: skipped (needs a POSIX stub scanner, git index modes, POSIX paths)');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'alate-canonical-form-'));

// Hermetic tool dir: copies of the real scripts, the shipped tree they read, and the
// scan-gate stub (verbatim from install-bundles.test.mjs).
const scriptDir = join(tmp, 'tool');
mkdirSync(join(scriptDir, 'lib'), { recursive: true });
for (const rel of ['install-user.mjs', 'sync-user.mjs', 'lib/data.mjs', 'lib/bundles.mjs', 'lib/shipped.mjs'])
  copyFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), join(scriptDir, rel));
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
copyFileSync(fileURLToPath(new URL('./shipped/skillspector-reviews.json', import.meta.url)), join(scriptDir, 'shipped', 'skillspector-reviews.json'));

const stubDir = join(tmp, 'stub');
const callsLog = join(stubDir, 'calls.log');
const scanReport = JSON.stringify({ issues: [], suppressed: [], suppressed_count: 0 });
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'skillspector'), [
  '#!/bin/sh',
  `[ "$1" = scan ] && printf '%s\\n' "$*" >> '${callsLog}'`,
  `if [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi`,
  `printf '%s\\n' '${scanReport}'`,
  'exit 0',
  '',
].join('\n'));
chmodSync(join(stubDir, 'skillspector'), 0o755);

const captureEnv = home => ({ ...process.env, HOME: home, USERPROFILE: home });
const installEnv = home => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ALATE_DATA: join(tmp, 'no-aldata'),
  PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
  SKILLSPECTOR_VENV: join(tmp, 'no-venv'),
  SKILLSPECTOR_BIN: '',
});

/** @param {string} script @param {string[]} args @param {NodeJS.ProcessEnv} env */
const run = (script, args, env) => spawnSync(process.execPath, [join(scriptDir, script), ...args], { encoding: 'utf8', env });

/** @param {string} dir @param {string} rel @param {string | Buffer} bytes */
const put = (dir, rel, bytes) => {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const crlf = text => Buffer.from(text.replaceAll('\n', '\r\n'), 'utf8');
// Text bytes for assertions. The zero-deps gate reads a Buffer.from call whose argument
// is a quoted literal as a module specifier, so the tests route every literal through
// this helper (the same rule lib/canonical.test.mjs documents).
const bytes = text => Buffer.from(text, 'utf8');

/** First 0x0D byte index, or -1. @param {Buffer} bytes */
const firstCR = bytes => bytes.indexOf(0x0d);
const oct = m => `0o${m.toString(8)}`;

/** rel (slash form) -> sha256 hex, over every file below root. @param {string} root */
const treeHashes = root => {
  const out = {};
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return out;
};

const failures = [];
/** Runs one check, records its failure message, and lets the next check run. @param {string} label @param {() => void} fn */
const attempt = (label, fn) => {
  try {
    fn();
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
};
const outOf = r => `${(r.stdout ?? '').trim().slice(-400)}\n--- stderr ---\n${(r.stderr ?? '').trim().slice(-400)}`;

// The Windows-form fixture: CRLF text, a CRLF batch file, binary bytes, and a
// Windows home path inside mcp.json.
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);
const SKILL_MD = '---\nname: demo\ndescription: Test skill.\n---\n\nBody line.\n';
const RUN_CMD = '@echo off\nrem demo batch\necho hello\n';
const winMcpDoc = { mcpServers: { demo: { command: 'node', args: ['C:\\Users\\x\\.omp\\plugins\\demo\\bin.js'] } } };
const UPSTREAMS = JSON.stringify({
  items: [{ name: 'demo', kind: 'skill', origin: 'https://github.com/example/demo', check: { type: 'github-path', repo: 'example/demo', path: 'skills/demo' }, paths: ['user/omp/agent/skills/demo'] }],
});
const storedMcpArg = '/root/.omp/plugins/demo/bin.js';

async function sectionA() {
  try {
    const winHome = join(tmp, 'home-win');
    const data = join(tmp, 'data-a');
    const linuxHome = join(tmp, 'home-linux');
    mkdirSync(winHome, { recursive: true });
    mkdirSync(data, { recursive: true });
    mkdirSync(linuxHome, { recursive: true });
    put(winHome, '.omp/agent/skills/demo/SKILL.md', crlf(SKILL_MD));
    put(winHome, '.omp/agent/skills/demo/scripts/run.cmd', crlf(RUN_CMD));
    put(winHome, '.omp/agent/skills/demo/assets/logo.bin', LOGO);
    put(winHome, '.omp/agent/mcp.json', JSON.stringify(winMcpDoc));

    // 2. Capture the Windows-form home into a fresh data repo.
    const r1 = run('sync-user.mjs', ['--home', winHome, '--data', data, '--first'], captureEnv(winHome));
    attempt('A.2 capture --first exits 0', () => assert.equal(r1.status, 0, `capture refused the fixture home\n${outOf(r1)}`));

    // 3. The repo must hold canonical bytes. [RED today: CRLF stored raw]
    const storedSkill = readFileSync(join(data, 'user/omp/agent/skills/demo/SKILL.md'));
    const storedCmd = readFileSync(join(data, 'user/omp/agent/skills/demo/scripts/run.cmd'));
    const storedLogo = readFileSync(join(data, 'user/omp/agent/skills/demo/assets/logo.bin'));
    const storedMcp = readFileSync(join(data, 'user/omp/agent/mcp.json'));
    attempt('A.3 SKILL.md stored with LF only', () => {
      const at = firstCR(storedSkill);
      assert.equal(at, -1, `CRLF stored raw in the repo: user/omp/agent/skills/demo/SKILL.md holds a 0x0D byte at offset ${at}; the canonical form stores LF text`);
    });
    attempt('A.3 run.cmd stored with LF only', () => {
      const at = firstCR(storedCmd);
      assert.equal(at, -1, `CRLF stored raw in the repo: user/omp/agent/skills/demo/scripts/run.cmd holds a 0x0D byte at offset ${at}; the canonical form stores *.cmd as LF in the index and renders CRLF at install`);
    });
    attempt('A.3 logo.bin stored byte-identical', () => {
      assert.ok(storedLogo.equals(LOGO), `binary bytes changed in the repo: stored ${storedLogo.toString('hex')} != fixture ${LOGO.toString('hex')}`);
    });
    attempt('A.3 mcp.json stored under /root', () => {
      const doc = JSON.parse(storedMcp.toString('utf8'));
      assert.equal(doc.mcpServers.demo.args[0], storedMcpArg, `mcp.json args[0] is ${JSON.stringify(doc.mcpServers.demo.args[0])}, expected ${storedMcpArg}`);
      assert.ok(!storedMcp.toString('utf8').includes('C:'), 'mcp.json still holds a Windows path in stored form');
    });
    const before = treeHashes(join(data, 'user'));

    // 5. Install into a fresh Linux-form home behind the stub scanner.
    const r2 = run('install-user.mjs', ['--home', linuxHome, '--data', data, '--skip-plugins'], installEnv(linuxHome));
    attempt('A.5 install exits 0', () => assert.equal(r2.status, 0, `install refused the canonical data repo\n${outOf(r2)}`));

    // 6. The installed files must hold the target form. [RED today: CRLF installed as captured]
    // mcp.json: the /root prefix is the home placeholder, so the install re-roots it at
    // the target home on every platform (specs/canonical-form.md); an install into a
    // /root worker home is an identity. Section B covers the win32 direction.
    const instSkill = readFileSync(join(linuxHome, '.omp/agent/skills/demo/SKILL.md'));
    const instCmd = readFileSync(join(linuxHome, '.omp/agent/skills/demo/scripts/run.cmd'));
    const instLogo = readFileSync(join(linuxHome, '.omp/agent/skills/demo/assets/logo.bin'));
    const instMcp = readFileSync(join(linuxHome, '.omp/agent/mcp.json'));
    attempt('A.6 SKILL.md installed with LF only', () => {
      const at = firstCR(instSkill);
      assert.equal(at, -1, `CRLF installed on Linux: .omp/agent/skills/demo/SKILL.md holds a 0x0D byte at offset ${at}; install must render canonical repo bytes to LF text`);
    });
    attempt('A.6 run.cmd installed with CRLF', () => {
      assert.ok(instCmd.includes(bytes('\r\n')), `.omp/agent/skills/demo/scripts/run.cmd holds no CRLF line end (hex head ${instCmd.subarray(0, 12).toString('hex')}); install must render *.cmd as CRLF on every target`);
    });
    attempt('A.6 mcp.json re-roots the placeholder at the Linux home', () => {
      const doc = JSON.parse(instMcp.toString('utf8'));
      // The /root prefix is the home placeholder: forTarget re-roots it at the target
      // home on every platform (specs/canonical-form.md), so a non-/root Linux home
      // gets its own path and a /root worker install stays an identity.
      const expected = `${linuxHome}/.omp/plugins/demo/bin.js`;
      assert.equal(doc.mcpServers.demo.args[0], expected, `mcp.json installed with args[0] ${JSON.stringify(doc.mcpServers.demo.args[0])}, expected the placeholder re-rooted at ${expected}`);
      assert.ok(!instMcp.toString('utf8').includes('C:'), 'installed mcp.json holds a Windows path');
    });
    attempt('A.6 logo.bin installed byte-identical', () => {
      assert.ok(instLogo.equals(LOGO), `binary bytes changed at install: installed ${instLogo.toString('hex')} != fixture ${LOGO.toString('hex')}`);
    });

    // 7. Re-capture the Linux home: nothing to write, so the repo tree stays byte-identical.
    const r3 = run('sync-user.mjs', ['--home', linuxHome, '--data', data], captureEnv(linuxHome));
    attempt('A.7 re-capture exits 0', () => assert.equal(r3.status, 0, `re-capture of the provisioned home refused; capture must normalize to the canonical form before it fingerprints, so provisioned bytes count as unchanged\n${outOf(r3)}`));
    attempt('A.7 data tree byte-identical after re-capture', () => {
      assert.deepEqual(treeHashes(join(data, 'user')), before, 'the re-capture wrote different bytes into the data repo');
    });
  } catch (err) {
    failures.push(`A (fixture error): ${err.message}`);
  }
}

async function sectionB() {
  // Guarded: the export does not exist yet, and the failure is part of today's red.
  let renderForTarget = null;
  let loadProblem = null;
  try {
    ({ renderForTarget } = await import('./lib/data.mjs'));
  } catch (err) {
    loadProblem = err;
  }
  if (typeof renderForTarget !== 'function') {
    failures.push(`B: skip (red): renderForTarget not implemented yet${loadProblem ? ` (import failed: ${loadProblem.message})` : ''}`);
    return;
  }
  // The export exists; the task fixes its return shape only as "bytes", so accept a
  // Buffer or a { bytes } result either way.
  const asBytes = out => (Buffer.isBuffer(out) ? out : out.bytes);
  try {
    const lf = bytes('line one\nline two\n');
    attempt('B SKILL.md renders LF untouched', () => {
      const out = asBytes(renderForTarget('a/SKILL.md', lf));
      assert.equal(firstCR(out), -1, `renderForTarget('a/SKILL.md', LF bytes) introduced a 0x0D byte`);
      assert.ok(out.equals(lf), `renderForTarget('a/SKILL.md', LF bytes) changed the bytes: ${out.toString('hex')} != ${lf.toString('hex')}`);
    });
    attempt('B run.cmd renders CRLF', () => {
      const out = asBytes(renderForTarget('a/run.cmd', bytes('@echo off\n')));
      assert.ok(out.includes(bytes('\r\n')), `renderForTarget('a/run.cmd', LF bytes) produced no CRLF (hex ${out.toString('hex')}); *.cmd must render CRLF`);
    });
    attempt('B logo.bin renders untouched', () => {
      const out = asBytes(renderForTarget('a/logo.bin', LOGO));
      assert.ok(out.equals(LOGO), `renderForTarget('a/logo.bin', binary) changed the bytes: ${out.toString('hex')} != ${LOGO.toString('hex')}`);
    });
    attempt('B render is idempotent', () => {
      const once = asBytes(renderForTarget('a/run.cmd', bytes('a\nb\n')));
      const twice = asBytes(renderForTarget('a/run.cmd', once));
      assert.ok(once.equals(twice), `renderForTarget is not idempotent: ${once.toString('hex')} != ${twice.toString('hex')}`);
    });
    attempt('B toStoredForm and forTarget stay inverse (win32)', () => {
      const machine = Buffer.from(JSON.stringify(winMcpDoc));
      const stored = toStoredForm('omp/agent/mcp.json', machine, { roots: CAPTURE_ROOTS }).bytes;
      const rendered = asBytes(forTarget('omp/agent/mcp.json', stored, { home: 'C:\\Users\\x', platform: 'win32', roots: CAPTURE_ROOTS }));
      const doc = JSON.parse(rendered.toString('utf8'));
      assert.equal(doc.mcpServers.demo.args[0], 'C:\\Users\\x\\.omp\\plugins\\demo\\bin.js', `win32 render produced args[0] ${JSON.stringify(doc.mcpServers.demo.args[0])}`);
      const back = toStoredForm('omp/agent/mcp.json', rendered, { roots: CAPTURE_ROOTS }).bytes;
      assert.ok(back.equals(stored), `the win32 round trip is not byte-stable: stored ${stored.toString('utf8')} != returned ${back.toString('utf8')}`);
    });
  } catch (err) {
    failures.push(`B (fixture error): ${err.message}`);
  }
}

function sectionC() {
  try {
    const data = join(tmp, 'data-c');
    const home = join(tmp, 'home-c');
    mkdirSync(data, { recursive: true });
    mkdirSync(home, { recursive: true });
    put(data, 'user/omp/agent/skills/demo/SKILL.md', SKILL_MD);
    put(data, 'user/omp/agent/skills/demo/scripts/run.sh', '#!/bin/sh\necho hi\n');
    put(data, 'upstreams.json', UPSTREAMS);
    const git = (args, extra = {}) => spawnSync('git', args, { encoding: 'utf8', cwd: data, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: data }, ...extra });
    const gitOk = (label, args) => {
      const r = git(args);
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
      return r;
    };
    gitOk('init', ['init', '-b', 'main']);
    gitOk('identity', ['config', 'user.email', 'test@example.com']);
    gitOk('identity', ['config', 'user.name', 'Canonical Test']);
    gitOk('add', ['add', '-A']);
    gitOk('commit', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    // Exec lives in the git index, never on the bind-mounted filesystem.
    gitOk('chmod', ['update-index', '--chmod=+x', 'user/omp/agent/skills/demo/SKILL.md']);
    // Bind-mount noise: the filesystem says 0777, the index still says 100644.
    chmodSync(join(data, 'user/omp/agent/skills/demo/scripts/run.sh'), 0o777);

    const r = run('install-user.mjs', ['--home', home, '--data', data, '--skip-plugins'], installEnv(home));
    attempt('C install exits 0', () => assert.equal(r.status, 0, `install refused the git data repo\n${outOf(r)}`));

    const instExec = statSync(join(home, '.omp/agent/skills/demo/SKILL.md')).mode & 0o777;
    attempt('C index-exec file installs 0755', () => {
      assert.equal(instExec, 0o755, `index-executable file installed ${oct(instExec)}; install must take modes from the git index (100755) and write 0755, [RED today: installs 0644]`);
    });
    const instPlain = statSync(join(home, '.omp/agent/skills/demo/scripts/run.sh')).mode & 0o777;
    attempt('C 0777-source file installs 0644', () => {
      assert.equal(instPlain, 0o644, `filesystem-0777 source installed ${oct(instPlain)}; install must never take the exec bit from the filesystem, bind-mount noise included (pins the invariant, [GREEN today])`);
    });
  } catch (err) {
    failures.push(`C (fixture error): ${err.message}`);
  }
}

function sectionD() {
  try {
    // ALAT-186: a clean checkout of a canonical data repo holds CRLF *.cmd bytes over
    // LF index blobs (the .gitattributes smudge), and a baseline-shipping skill ships
    // one. The CRLF source guard must not refuse git's own checkout rendering; it must
    // still refuse a CRLF working copy of a non-suffix file over an LF blob.
    const data = join(tmp, 'data-d');
    const home = join(tmp, 'home-d');
    mkdirSync(data, { recursive: true });
    mkdirSync(home, { recursive: true });
    put(data, '.gitattributes', [
      '# One canonical form (specs/canonical-form.md): text is LF everywhere;',
      '# *.cmd/*.bat check out CRLF on every OS.',
      '* text=auto eol=lf',
      '*.cmd text eol=crlf',
      '*.bat text eol=crlf',
      '',
    ].join('\n'));
    put(data, 'upstreams.json', JSON.stringify({
      items: [{ name: 'smudgy', kind: 'skill', origin: 'https://github.com/example/smudgy', check: { type: 'github-path', repo: 'example/smudgy', path: 'skills/smudgy' }, paths: ['user/omp/agent/skills/smudgy'] }],
    }));
    const smudgyMd = SKILL_MD.replace('name: demo', 'name: smudgy');
    put(data, 'user/omp/agent/skills/smudgy/SKILL.md', smudgyMd);
    put(data, 'user/omp/agent/skills/smudgy/.skillspector-baseline.yaml', 'findings: []\n');
    put(data, 'user/omp/agent/skills/smudgy/scripts/run.cmd', RUN_CMD);
    const git = args => {
      const r = spawnSync('git', args, { encoding: 'utf8', cwd: data, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: data } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
      return r;
    };
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Canonical Test']);
    git(['add', '-A']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    // The canonical smudge: the index blob holds LF, the working tree holds CRLF, and
    // git status stays clean — the checkout state the guard refused before the fix.
    // The add only refreshes git's stat cache for the rewritten file (its clean filter
    // returns the committed LF blob), which is what a real checkout's refresh does.
    writeFileSync(join(data, 'user/omp/agent/skills/smudgy/scripts/run.cmd'), crlf(RUN_CMD));
    git(['add', 'user/omp/agent/skills/smudgy/scripts/run.cmd']);
    const status = git(['status', '--porcelain']);
    attempt('D fixture is a clean checkout', () => {
      assert.equal(status.stdout, '', `the smudged fixture is not a clean checkout: ${JSON.stringify(status.stdout)}`);
    });

    const r = run('install-user.mjs', ['--home', home, '--data', data, '--skip-plugins'], installEnv(home));
    attempt('D install exits 0', () => assert.equal(r.status, 0, `install refused the canonical checkout's CRLF .cmd bytes\n${outOf(r)}`));
    attempt('D run.cmd installed with CRLF', () => {
      const inst = readFileSync(join(home, '.omp/agent/skills/smudgy/scripts/run.cmd'));
      assert.ok(inst.includes(Buffer.from('\r\n')), `the installed run.cmd holds no CRLF (hex head ${inst.subarray(0, 12).toString('hex')}); install must render *.cmd as CRLF on every target`);
    });
    // The boundary holds: a CRLF working copy of a non-suffix file over an LF blob is a
    // real conversion and still refuses — named, while the smudged .cmd stays out.
    put(data, 'user/omp/agent/skills/smudgy/notes.txt', 'body\r\n');
    const r2 = run('install-user.mjs', ['--home', home, '--data', data, '--skip-plugins'], installEnv(home));
    attempt('D non-suffix CRLF copy still refuses', () => {
      assert.equal(r2.status, 1, `a CRLF notes.txt over an LF blob installed\n${outOf(r2)}`);
      assert.ok(r2.stderr.includes('user/omp/agent/skills/smudgy/notes.txt'), `the refusal names the converted file: ${r2.stderr}`);
      assert.ok(!r2.stderr.includes('run.cmd'), `the smudged .cmd must not appear in the refusal: ${r2.stderr}`);
    });
    put(data, 'user/omp/agent/skills/smudgy/notes.txt', 'body\n');
    const r3 = run('install-user.mjs', ['--home', home, '--data', data, '--skip-plugins'], installEnv(home));
    attempt('D restored checkout installs', () => assert.equal(r3.status, 0, `install refused the restored checkout\n${outOf(r3)}`));
  } catch (err) {
    failures.push(`D (fixture error): ${err.message}`);
  }
}

try {
  await sectionA();
  await sectionB();
  sectionC();
  sectionD();
} finally {
  console.log('\n=== canonical-form.test.mjs (specs/canonical-form.md) ===');
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length
    ? `${failures.length} check(s) red — canonical form not implemented yet (expected today)`
    : 'all canonical-form acceptance checks passed');
  if (!process.env.ALATE_KEEP_TEMP) rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
