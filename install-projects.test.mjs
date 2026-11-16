// Self-check for install-projects.mjs: node install-projects.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, keepTemp } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-install-projects-'));
const script = fileURLToPath(new URL('./install-projects.mjs', import.meta.url));
const capture = fileURLToPath(new URL('./sync-projects.mjs', import.meta.url));
const data = join(tmp, 'data');
const ws = join(tmp, 'ws');
mkdirSync(join(data, 'projects'), { recursive: true });
mkdirSync(ws, { recursive: true });
const put = (base, rel, text) => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), text); };
const manifest = o => put(data, 'projects/projects.json', JSON.stringify(o, null, 2) + '\n');
const run = (args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...opts });
// The zero-deps gate flags a from-keyword directly followed by a quoted specifier, so the
// one Buffer conversion over a fixture string goes through this helper: the keyword never
// sits next to the quoted bytes.
const bytes = t => Buffer.from(t);
const withRoot = ['--data', data, '--root', ws];
const statePath = join(ws, '.alate', 'captured-projects.json');
const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const snapOf = (name, rel) => join(data, 'projects', name, ...rel.split('/'));
const machineOf = rel => join(ws, ...rel.split('/'));

try {
  // (a) A changed listed file is installed into the checkout; the second run is idempotent.
  put(ws, 'alpha/AGENTS.md', '# alpha rules v0\n');
  manifest({ contextFiles: ['AGENTS.md'], projects: { alpha: [] } });
  put(data, 'projects/alpha/AGENTS.md', '# alpha rules v1\n');
  let r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(machineOf('alpha/AGENTS.md'), 'utf8'), '# alpha rules v1\n');
  assert.match(r.stdout, /replaced projects\/alpha\/AGENTS\.md into .+alpha.AGENTS\.md \(no capture baseline exists; the machine copy differed from the snapshot\)/, r.stdout);
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 added, 0 updated, 1 unchanged across 1 projects from /, `not idempotent: ${r.stdout}`);

  // (k) The baseline record is the shared capture state: same file as sync-projects.mjs,
  // '<name>/<rel>' keys, values are CRLF-normalized fingerprints over the snapshot bytes.
  assert.equal(state()['alpha/AGENTS.md'], fingerprint('alpha/AGENTS.md', readFileSync(snapOf('alpha', 'AGENTS.md'))));

  // CRLF stability: a line-endings-only difference never churns, and the machine bytes stay.
  put(ws, 'alpha/AGENTS.md', '# alpha rules v1\r\n');
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 added, 0 updated, 1 unchanged/, `CRLF churned: ${r.stdout}`);
  assert.equal(readFileSync(machineOf('alpha/AGENTS.md'), 'utf8'), '# alpha rules v1\r\n');

  // (c) Machine edit WITH a baseline: the snapshot replaces it and says so, then a following
  // capture must not recapture the replaced bytes into the snapshot.
  put(ws, 'alpha/AGENTS.md', '# alpha v2 local\n');
  put(data, 'projects/alpha/AGENTS.md', '# alpha v2 board\n');
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /replaced projects\/alpha\/AGENTS\.md into .+ \(the machine copy changed since the last capture; its local changes were replaced\)/, r.stdout);
  assert.equal(readFileSync(machineOf('alpha/AGENTS.md'), 'utf8'), '# alpha v2 board\n');
  assert.equal(state()['alpha/AGENTS.md'], fingerprint('alpha/AGENTS.md', bytes('# alpha v2 board\n')));
  const snapBefore = readFileSync(snapOf('alpha', 'AGENTS.md'));
  const cap = spawnSync(process.execPath, [capture, '--root', ws, '--data', data], { encoding: 'utf8' });
  assert.equal(cap.status, 0, cap.stderr);
  assert.match(cap.stdout, /0 added, 0 updated, 1 unchanged/, `capture recaptured the install: ${cap.stdout}`);
  assert.ok(snapBefore.equals(readFileSync(snapOf('alpha', 'AGENTS.md'))), 'capture clobbered the snapshot');

  // A corrupt baseline record is named, every file counts as no-baseline, never rewritten.
  writeFileSync(statePath, 'not json');
  put(ws, 'alpha/AGENTS.md', '# alpha v3 local\n');
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is not a valid capture baseline/);
  assert.match(r.stdout, /replaced projects\/alpha\/AGENTS\.md into .+ \(no capture baseline exists/, r.stdout);
  assert.equal(readFileSync(statePath, 'utf8'), 'not json', 'a corrupt baseline file is left as-is');
  rmSync(statePath);

  // (d) Snapshot files missing from the checkout are created, nested parents included;
  // a name listed as context file and extra is installed once.
  manifest({ contextFiles: ['AGENTS.md', 'docs/guide.md'], projects: { beta: ['AGENTS.md', 'deep/nested/extra.md'] } });
  mkdirSync(join(ws, 'beta'), { recursive: true }); // a missing checkout is skipped whole (case f); creation is per file
  put(data, 'projects/beta/AGENTS.md', '# beta\n');
  put(data, 'projects/beta/docs/guide.md', '# guide\n');
  put(data, 'projects/beta/deep/nested/extra.md', '// extra\n');
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(machineOf('beta/AGENTS.md'), 'utf8'), '# beta\n');
  assert.equal(readFileSync(machineOf('beta/docs/guide.md'), 'utf8'), '# guide\n');
  assert.equal(readFileSync(machineOf('beta/deep/nested/extra.md'), 'utf8'), '// extra\n');
  assert.equal((r.stdout.match(/added projects\/beta\/AGENTS\.md/g) || []).length, 1, `deduped name installed twice: ${r.stdout}`);
  assert.match(r.stdout, /3 added, 0 updated, 0 unchanged across 1 projects/, r.stdout);

  // (e) A listed file with no snapshot copy is skipped with a note (contextFiles are
  // alternatives), exit 0.
  manifest({ contextFiles: ['AGENTS.md', 'ghost.md'], projects: { beta: [] } });
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('projects/beta/ghost.md is not in the snapshot; skipped'), r.stdout);
  assert.match(r.stdout, /0 added, 0 updated, 1 unchanged across 1 projects/, r.stdout);

  // (e2) Object project values (specs/bundles.md): extras install exactly like the array
  // form, and bundles is never read here (it drives install-user only; bundles/core does not exist).
  manifest({ contextFiles: ['AGENTS.md'], projects: { beta: { extras: ['deep/nested/extra.md'], bundles: ['core'] } } });
  put(data, 'projects/beta/deep/nested/extra.md', '// extra v2\n');
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refreshed projects\/beta\/deep\/nested\/extra\.md/, r.stdout);
  assert.equal(readFileSync(machineOf('beta/deep/nested/extra.md'), 'utf8'), '// extra v2\n', 'the object form installs extras like the array form');
  assert.match(r.stdout, /0 added, 1 updated, 1 unchanged across 1 projects/, r.stdout);

  // (f) No checkout dir: the whole project is skipped with a note, exit 0.
  manifest({ contextFiles: ['AGENTS.md'], projects: { beta: [], ghostproj: [] } });
  r = run(withRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`projects/ghostproj: no checkout at ${join(ws, 'ghostproj')}; skipped`), r.stdout);
  assert.match(r.stdout, /0 added, 0 updated, 1 unchanged across 1 projects/, r.stdout);

  // (g) An invalid manifest refuses the whole run: fatal results, nothing written.
  const resultsG = join(tmp, 'results-g.json');
  writeFileSync(join(data, 'projects/projects.json'), '{"contextFiles":"x","projects":{}}');
  r = run(withRoot, { env: { ...process.env, ALATE_PROVISION_RESULTS: resultsG } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /projects\.json: contextFiles must be an array of strings/);
  assert.equal(readFileSync(machineOf('beta/AGENTS.md'), 'utf8'), '# beta\n', 'a refusal wrote something');
  assert.deepEqual(JSON.parse(readFileSync(resultsG, 'utf8')), {
    fatal: true,
    error: 'projects.json: contextFiles must be an array of strings',
    items: [],
  });
  writeFileSync(join(data, 'projects/projects.json'), '{oops');
  r = run(withRoot);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0, 'an unparsable manifest must print the parse error');

  // (h) A destination symlink below the checkout root refuses; nothing is written through it.
  const wsH = join(tmp, 'wsH');
  mkdirSync(join(wsH, 'proj'), { recursive: true });
  manifest({ contextFiles: ['a.txt'], projects: { proj: [] } });
  put(data, 'projects/proj/a.txt', 'snap\n');
  symlinkSync(join(tmp, 'outside-h'), join(wsH, 'proj', 'a.txt')); // dangling link
  r = run(['--data', data, '--root', wsH]);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(tmp, 'outside-h')), 'a refusal wrote through the symlink');

  // (i) A project name with '..' refuses in the manifest validation.
  manifest({ contextFiles: [], projects: { '../outside': [] } });
  r = run(withRoot);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /projects\.json: project name: invalid segment in \.\.\/outside/);
  assert.ok(!existsSync(join(data, 'outside')), 'nothing escaped the projects dir');

  // (l) A laced .md snapshot is rejected per item: it never lands, a copy an earlier install
  // put in the checkout is removed, passing items still install, and the run exits 1.
  manifest({ contextFiles: ['AGENTS.md', 'clean.txt'], projects: { gamma: ['laced2.md'] } });
  mkdirSync(join(ws, 'gamma'), { recursive: true });
  put(data, 'projects/gamma/AGENTS.md', '# gamma \u202E rules\n');
  put(data, 'projects/gamma/clean.txt', 'clean\n');
  put(data, 'projects/gamma/laced2.md', '# laced \u202E two\n');
  put(ws, 'gamma/laced2.md', '# laced \u202E two\n'); // installed by an earlier run: ours to remove
  const resultsL = join(tmp, 'results-l.json');
  r = run(withRoot, { env: { ...process.env, ALATE_PROVISION_RESULTS: resultsL } });
  assert.equal(r.status, 1, `a laced md must fail the run: ${r.stdout}`);
  assert.ok(!existsSync(machineOf('gamma/AGENTS.md')), 'a rejected file must not install');
  assert.ok(!existsSync(machineOf('gamma/laced2.md')), 'a rejected copy installed before must be removed');
  assert.equal(readFileSync(machineOf('gamma/clean.txt'), 'utf8'), 'clean\n', 'a passing item still installs');
  assert.match(r.stdout, /removed projects\/gamma\/laced2\.md from .+ \(the snapshot copy installed here before is rejected now\)/, r.stdout);
  assert.match(r.stdout, /Failed items:/, r.stdout);
  assert.match(r.stdout, /projects\/gamma\/AGENTS\.md — rejected: .+ at .+/, r.stdout);
  const parsedL = JSON.parse(readFileSync(resultsL, 'utf8'));
  assert.equal(parsedL.fatal, false, 'a per-item rejection is not a whole-run refusal');
  const rej = parsedL.items.find(it => it.item === 'projects/gamma/AGENTS.md');
  assert.equal(rej.status, 'rejected');
  assert.ok(rej.rule && rej.at, 'the rejection names the rule and position');
  assert.ok(rej.report.length > 0, 'the rejection carries the problem lines');

  // A machine-changed laced copy is not ours to delete: it stays with a note, still rejected.
  put(ws, 'gamma/laced2.md', '# laced \u202E machine edition\n');
  r = run(withRoot);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(machineOf('gamma/laced2.md'), 'utf8'), '# laced \u202E machine edition\n');
  assert.match(r.stdout, /kept projects\/gamma\/laced2\.md at .+ \(the machine copy changed since the last capture; it is not ours to delete\)/, r.stdout);

  // An uppercase extension is Markdown too: a case-insensitive filesystem (Windows, macOS)
  // opens AGENTS.MD where omp reads AGENTS.md, so the hidden-character gate must not skip it.
  manifest({ contextFiles: ['AGENTS.MD'], projects: { delta: ['notes.Mdc'] } });
  mkdirSync(join(ws, 'delta'), { recursive: true });
  put(data, 'projects/delta/AGENTS.MD', '# delta \u202E rules\n');
  put(data, 'projects/delta/notes.Mdc', '# notes \u202E mdc\n');
  r = run(withRoot);
  assert.equal(r.status, 1, `a laced uppercase-extension md must fail the run: ${r.stdout}`);
  assert.ok(!existsSync(machineOf('delta/AGENTS.MD')), 'a rejected AGENTS.MD must not install');
  assert.ok(!existsSync(machineOf('delta/notes.Mdc')), 'a rejected notes.Mdc must not install');
  assert.match(r.stdout, /projects\/delta\/AGENTS\.MD — rejected: hidden character U\+202E at .+/, r.stdout);
  assert.match(r.stdout, /projects\/delta\/notes\.Mdc — rejected: hidden character U\+202E at .+/, r.stdout);

  // (j) No --root: the exact note on both streams, exit 0.
  r = run(['--data', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'install-projects: no --root; project files not provisioned\n');
  assert.equal(r.stderr, 'install-projects: no --root; project files not provisioned\n');

  // Results file: one item per installed or unchanged file, manifest order.
  manifest({ contextFiles: ['AGENTS.md', 'new.md'], projects: { beta: [] } });
  put(data, 'projects/beta/AGENTS.md', '# beta\n'); // unchanged
  put(data, 'projects/beta/new.md', 'new\n'); // added
  const results = join(tmp, 'results.json');
  r = run(withRoot, { env: { ...process.env, ALATE_PROVISION_RESULTS: results } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(results, 'utf8')), {
    fatal: false,
    error: null,
    items: [
      { item: 'projects/beta/AGENTS.md', status: 'unchanged', rule: null, at: null },
      { item: 'projects/beta/new.md', status: 'added', rule: null, at: null },
    ],
  });

  // Canonical form (specs/canonical-form.md): install renders the snapshot for the target —
  // LF text, CRLF .cmd — and takes file modes from the data repo's git index, never the
  // filesystem.
  {
    const dataC = join(tmp, 'data-canonical');
    const wsC = join(tmp, 'ws-canonical');
    mkdirSync(join(dataC, 'projects'), { recursive: true });
    mkdirSync(join(wsC, 'zeta'), { recursive: true });
    mkdirSync(join(wsC, 'eta'), { recursive: true });
    put(dataC, 'projects/projects.json', JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { zeta: [], eta: ['go.cmd'] } }, null, 2) + '\n');
    const runIn = (dataDir, wsDir) => spawnSync(process.execPath, [script, '--data', dataDir, '--root', wsDir], { encoding: 'utf8' });
    // A CRLF-committed snapshot installs LF text; a .cmd snapshot renders CRLF on every
    // target (cmd.exe wants CRLF batch files), and a CRLF-in-repo copy must not CRCRLF.
    put(dataC, 'projects/zeta/AGENTS.md', '# zeta\r\nrules\r\n');
    put(dataC, 'projects/eta/go.cmd', '@echo off\r\necho hi\r\n');
    let rC = runIn(dataC, wsC);
    assert.equal(rC.status, 0, rC.stderr);
    assert.equal(readFileSync(join(wsC, 'zeta', 'AGENTS.md'), 'utf8'), '# zeta\nrules\n', 'a CRLF snapshot installs LF text');
    const cmdBytes = readFileSync(join(wsC, 'eta', 'go.cmd'));
    assert.equal(cmdBytes.toString('utf8'), '@echo off\r\necho hi\r\n', 'a .cmd snapshot installs CRLF');
    assert.ok(!cmdBytes.includes('\r\r'), 'a CRLF .cmd snapshot never renders CRCRLF');
    // The rendered bytes are byte-stable: a re-install from the same snapshot is unchanged.
    rC = runIn(dataC, wsC);
    assert.equal(rC.status, 0, rC.stderr);
    assert.match(rC.stdout, /0 added, 0 updated, 2 unchanged/, `re-install churned: ${rC.stdout}`);

    const modeOf = p => statSync(p).mode & 0o777;
    const dataG = join(tmp, 'data-git');
    const wsG = join(tmp, 'ws-git');
    mkdirSync(join(dataG, 'projects', 'theta'), { recursive: true });
    mkdirSync(join(wsG, 'theta'), { recursive: true });
    put(dataG, 'projects/projects.json', JSON.stringify({ contextFiles: [], projects: { theta: ['run.sh', 'notes.txt'] } }, null, 2) + '\n');
    put(dataG, 'projects/theta/run.sh', '#!/bin/sh\necho hi\n');
    put(dataG, 'projects/theta/notes.txt', 'notes\n');
    const git = (...a) => spawnSync('git', a, { cwd: dataG, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0, 'git init is required for the index-mode case');
    assert.equal(git('add', '.').status, 0);
    assert.equal(git('update-index', '--chmod=+x', 'projects/theta/run.sh').status, 0, 'index chmod is required for the exec case');
    assert.equal(git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'snapshots').status, 0, 'git commit is required for the index-mode case');
    // Pin the umask so the exact-mode assertions are deterministic on any dev machine;
    // spawned children inherit it.
    const oldUmask = process.umask(0o022);
    try {
      const rG = runIn(dataG, wsG);
      assert.equal(rG.status, 0, rG.stderr);
      assert.equal(modeOf(join(wsG, 'theta', 'run.sh')), 0o755, 'an index-100755 snapshot installs 0755');
      assert.equal(modeOf(join(wsG, 'theta', 'notes.txt')), 0o644, 'an index-100644 snapshot installs 0644');

      // A data dir that is not a git checkout gives 0644 everywhere; a filesystem exec bit
      // on the source (bind-mount noise included) is never taken.
      const dataN = join(tmp, 'data-nogit');
      const wsN = join(tmp, 'ws-nogit');
      mkdirSync(join(dataN, 'projects', 'iota'), { recursive: true });
      mkdirSync(join(wsN, 'iota'), { recursive: true });
      put(dataN, 'projects/projects.json', JSON.stringify({ contextFiles: [], projects: { iota: ['run.sh'] } }, null, 2) + '\n');
      writeFileSync(join(dataN, 'projects', 'iota', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o777 });
      const rN = runIn(dataN, wsN);
      assert.equal(rN.status, 0, rN.stderr);
      assert.equal(modeOf(join(wsN, 'iota', 'run.sh')), 0o644, 'a non-git data dir installs 0644');

      // The mode holds on update, not only at creation (specs/canonical-form.md): a write
      // resets a filesystem 0777 on the dest, and an index-100755 snapshot re-applies its
      // mode to an existing file too. A changed snapshot forces the write ('unchanged'
      // entries never rewrite).
      put(dataG, 'projects/theta/notes.txt', 'notes v2\n');
      put(dataG, 'projects/theta/run.sh', '#!/bin/sh\necho hi v2\n');
      assert.equal(git('add', '.').status, 0);
      // git add stages the filesystem mode, so the index exec bit must be re-applied.
      assert.equal(git('update-index', '--chmod=+x', 'projects/theta/run.sh').status, 0, 'index chmod is required for the exec case');
      assert.equal(git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'snapshots v2').status, 0);
      chmodSync(join(wsG, 'theta', 'notes.txt'), 0o777);
      chmodSync(join(wsG, 'theta', 'run.sh'), 0o777);
      const rG2 = runIn(dataG, wsG);
      assert.equal(rG2.status, 0, rG2.stderr);
      assert.match(rG2.stdout, /2 updated/, `the changed snapshots refresh: ${rG2.stdout}`);
      assert.equal(modeOf(join(wsG, 'theta', 'run.sh')), 0o755, 'an updated file takes its index mode over a filesystem 0777');
      assert.equal(modeOf(join(wsG, 'theta', 'notes.txt')), 0o644, 'an updated non-exec file takes its index mode over a filesystem 0777');
      put(dataN, 'projects/iota/run.sh', '#!/bin/sh\necho hi v2\n');
      chmodSync(join(wsN, 'iota', 'run.sh'), 0o777);
      const rN2 = runIn(dataN, wsN);
      assert.equal(rN2.status, 0, rN2.stderr);
      assert.equal(modeOf(join(wsN, 'iota', 'run.sh')), 0o644, 'a refreshed file loses a filesystem 0777 even without a git index');
    } finally {
      process.umask(oldUmask);
    }
  }

  console.log('install-projects.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
