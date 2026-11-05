// Self-check for scripts/mutant-run.mjs: node scripts/mutant-run.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  console.log('mutant-run.test.mjs passed');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { /* ran as main above */ }
