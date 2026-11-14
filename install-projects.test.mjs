// Self-check for install-projects.mjs: node install-projects.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.equal(state()['alpha/AGENTS.md'], fingerprint('alpha/AGENTS.md', Buffer.from('# alpha v2 board\n')));
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

  console.log('install-projects.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
