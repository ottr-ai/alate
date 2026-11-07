// Self-check for scripts/mutant-run.mjs: node scripts/mutant-run.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepTemp } from '../lib/data.mjs';
import { findMutatedFile, reachMap, stageSplit } from './mutant-run.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-mutant-run-'));

// Fixture test files carry relative import specifiers only, so the zero-deps gate
// stays green when it scans this file.
try {
  mkdirSync(join(tmp, 'lib'), { recursive: true });
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'server.test.mjs'), "import { x } from './lib/data.mjs';\nimport { y } from './web/diff.mjs';\n");
  writeFileSync(join(tmp, 'sync.test.mjs'), "import { z } from './lib/data.mjs';\n");
  writeFileSync(join(tmp, 'install-user.test.mjs'), "import { a } from './lib/data.mjs';\nimport { b } from './install-user.fixtures.mjs';\n");
  writeFileSync(join(tmp, 'lib', 'data.mjs'), "import { spawnSync } from 'node:child_process';\n");
  writeFileSync(join(tmp, 'web', 'diff.mjs'), "import { join } from 'node:path';\n");
  writeFileSync(join(tmp, 'install-user.fixtures.mjs'), 'export const FIXTURE = "x";\n');
  writeFileSync(join(tmp, 'mutant.mjs'), 'const gate = stryMutAct_9fa48("42") ? "a" : "b";\n');

  // Static import closure: chain order preserved, test files never become sources.
  const map = reachMap(['server.test.mjs', 'sync.test.mjs', 'install-user.test.mjs'], tmp);
  assert.deepEqual(map.get('lib/data.mjs'), ['server.test.mjs', 'sync.test.mjs', 'install-user.test.mjs']);
  assert.deepEqual(map.get('web/diff.mjs'), ['server.test.mjs']);
  assert.deepEqual(map.get('install-user.fixtures.mjs'), ['install-user.test.mjs']);
  assert.equal(map.has('server.test.mjs'), false);

  // Stage split: chain order, disjoint, union is the chain.
  const split = stageSplit(['a.test.mjs', 'b.test.mjs', 'c.test.mjs'], new Set(['b.test.mjs']));
  assert.deepEqual(split, { first: ['b.test.mjs'], rest: ['a.test.mjs', 'c.test.mjs'] });
  const whole = stageSplit(['a.test.mjs', 'b.test.mjs'], new Set());
  assert.deepEqual(whole, { first: [], rest: ['a.test.mjs', 'b.test.mjs'] });

  // Mutant stamp: found in exactly the stamped file; unknown and non-numeric ids miss.
  const sources = ['lib/data.mjs', 'mutant.mjs'];
  assert.equal(findMutatedFile('42', sources, tmp), 'mutant.mjs');
  assert.equal(findMutatedFile('43', sources, tmp), '');
  assert.equal(findMutatedFile('42|x', sources, tmp), '');
  assert.equal(findMutatedFile('', sources, tmp), '');
  assert.equal(findMutatedFile('42', ['missing.mjs'], tmp), '');

  // Command runner, dry run: every invocation runs its chain inside a private temp
  // dir (TMPDIR/TEMP/TMP), removes it at exit — also when a chain file fails — and
  // never reuses one across invocations, so concurrent Stryker workers sharing the
  // OS tmpdir cannot put a sibling's dir inside a leak assertion's window.
  const mutrun = fileURLToPath(new URL('./mutant-run.mjs', import.meta.url));
  const runChain = files => spawnSync(process.execPath, [mutrun, ...files], { cwd: tmp, encoding: 'utf8' });
  writeFileSync(join(tmp, 'probe-a.test.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "writeFileSync('probe-a.out', JSON.stringify({",
    '  dir: process.env.TMPDIR,',
    '  same: process.env.TMP === process.env.TMPDIR && process.env.TEMP === process.env.TMPDIR,',
    '  alive: existsSync(process.env.TMPDIR),',
    '}));',
  ].join('\n'));
  let r = runChain(['probe-a.test.mjs']);
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(join(tmp, 'probe-a.out'), 'utf8'));
  assert.ok(basename(seen.dir).startsWith('alate-mutrun-'), 'the chain runs in a private alate-mutrun- temp dir');
  assert.equal(seen.same, true, 'TMPDIR, TEMP and TMP all name the private dir');
  assert.equal(seen.alive, true, 'the private dir exists while the chain runs');
  assert.ok(!existsSync(seen.dir), 'mutant-run removes its private dir at exit');
  writeFileSync(join(tmp, 'probe-b.test.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('probe-b.out', process.env.TMPDIR);\n");
  r = runChain(['probe-b.test.mjs']);
  assert.equal(r.status, 0, r.stderr);
  const again = readFileSync(join(tmp, 'probe-b.out'), 'utf8');
  assert.ok(!existsSync(again), 'the second invocation removes its private dir too');
  assert.notEqual(again, seen.dir, 'no private dir is reused across invocations');
  writeFileSync(join(tmp, 'probe-fail.test.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('probe-fail.out', process.env.TMPDIR);\nprocess.exit(1);\n");
  writeFileSync(join(tmp, 'probe-never.test.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('probe-never.out', 'ran');\n");
  r = runChain(['probe-fail.test.mjs', 'probe-never.test.mjs']);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(readFileSync(join(tmp, 'probe-fail.out'), 'utf8')), 'a failing chain still removes its private dir');
  assert.ok(!existsSync(join(tmp, 'probe-never.out')), 'a failing first file stops the chain');

  console.log('mutant-run.test.mjs passed');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { /* ran as main above */ }
