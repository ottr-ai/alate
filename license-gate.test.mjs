// Self-check for the fail-closed license gate: drives the real CLI over temp fixtures and
// property-checks the violations helper. node license-gate.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepTemp, forAll } from './lib/data.mjs';
import { violations } from './license-gate.mjs';

const toolRoot = dirname(fileURLToPath(import.meta.url));

const runCli = fixture =>
  spawnSync(process.execPath, [join(toolRoot, 'license-gate.mjs'), '--lock', fixture], { encoding: 'utf8' });

const refused = (r, what) => assert(r.status !== null && r.status !== 0,
  `${what}: expected nonzero exit, got 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

const ok = (r, what) => assert.strictEqual(r.status, 0, `${what} failed: ${r.stderr}`);

// Package-lock fixture with license fields only; entries map keyed the lockfileVersion 3 way.
const writeLock = (dir, name, entries) => {
  const packages = {};
  for (const [key, rest] of entries) packages[key] = rest;
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ lockfileVersion: 3, packages }));
  return p;
};

let tmp;
try {
  // (1) The repo's own lockfile passes.
  ok(runCli(join(toolRoot, 'package-lock.json')), 'repo lockfile');

  tmp = mkdtempSync(join(tmpdir(), 'alate-license-'));

  // (2) A synthetic all-allowed lock passes.
  const clean = writeLock(tmp, 'clean.json', [
    ['', { name: 'root', version: '1.0.0', license: 'MIT' }],
    ['node_modules/isaacs', { version: '2.0.0', license: 'ISC' }],
  ]);
  const good = runCli(clean);
  ok(good, 'all-allowed lock');
  assert.match(good.stdout, /2 packages/, `summary line missing: ${good.stdout}`);

  // (3) A disallowed license fails and names the package.
  const disallowed = writeLock(tmp, 'disallowed.json', [
    ['', { name: 'root', version: '1.0.0', license: 'MIT' }],
    ['node_modules/left-pad', { version: '1.0.0', license: 'WTFPL' }],
  ]);
  const bad = runCli(disallowed);
  refused(bad, 'disallowed license');
  assert(bad.stderr.includes('left-pad@1.0.0'), `output must name the package: ${bad.stderr}`);

  // (4) A missing license field fails.
  const missing = writeLock(tmp, 'missing.json', [
    ['', { name: 'root', version: '1.0.0', license: 'MIT' }],
    ['node_modules/shy', { version: '1.0.0' }],
  ]);
  const noLicense = runCli(missing);
  refused(noLicense, 'missing license field');
  assert(noLicense.stderr.includes('shy@1.0.0'), `output must name the package: ${noLicense.stderr}`);

  // (5) Compound expressions: OR of allowed ids passes, a disallowed operand fails,
  // an unknown token inside an otherwise-allowed OR fails too.
  ok(runCli(writeLock(tmp, 'or.json', [['', { name: 'r', version: '1', license: 'MIT OR Apache-2.0' }]])), 'MIT OR Apache-2.0');
  const andOr = runCli(writeLock(tmp, 'andor.json', [['', { name: 'r', version: '1', license: 'MIT AND (GPL-3.0 OR ISC)' }]]));
  refused(andOr, 'GPL operand');
  assert(andOr.stderr.includes('GPL-3.0'), `must name GPL-3.0: ${andOr.stderr}`);
  const unknownToken = runCli(writeLock(tmp, 'unknown.json', [['', { name: 'r', version: '1', license: 'MIT OR Bogus-License-9.9' }]]));
  refused(unknownToken, 'unknown token in OR');

  // (6) WITH-exceptions are identifiers like any other: not on the allowlist, refused.
  const withEx = runCli(writeLock(tmp, 'with.json', [['', { name: 'r', version: '1', license: 'MIT WITH Font-exception-0.1' }]]));
  refused(withEx, 'WITH exception clause');
  ok(runCli(writeLock(tmp, 'pair.json', [['', { name: 'r', version: '1', license: 'MIT OR ISC' }]])), 'plain allowed pair');

  // (7) Malformed JSON and a lock without a packages map fail loudly, naming the file.
  const corrupt = join(tmp, 'corrupt.json');
  writeFileSync(corrupt, '{not json');
  const malformed = runCli(corrupt);
  refused(malformed, 'malformed JSON');
  assert(malformed.stderr.includes(corrupt), `must name the file: ${malformed.stderr}`);
  const shapelessPath = join(tmp, 'shapeless2.json');
  writeFileSync(shapelessPath, JSON.stringify({ lockfileVersion: 1 }));
  const noMap = runCli(shapelessPath);
  refused(noMap, 'lock without packages map');
  assert(noMap.stderr.includes(shapelessPath), `must name the file: ${noMap.stderr}`);

  // (8) --lock at a nonexistent path fails loudly.
  const absent = runCli(join(tmp, 'no-such-lock.json'));
  refused(absent, 'nonexistent lock path');
  assert(absent.stderr.includes('no-such-lock.json'), `must name the file: ${absent.stderr}`);

  // Property (a): violations() agrees with a simple reference implementation.
  const OK_IDS = ['MIT', 'ISC', 'Apache-2.0', '0BSD'];
  const BAD_IDS = ['GPL-3.0', 'AGPL-3.0', 'WTFPL'];
  const ALL_IDS = [...OK_IDS, ...BAD_IDS];
  const tag = license => typeof license === 'string' ? (license.trim() ? license : '(empty license)') : license === undefined ? '(no license field)' : String(license);
  const refViolations = entries => entries.flatMap(({ name, version, license }) => {
    if (typeof license !== 'string' || !license.trim())
      return [`${name}@${version}: ${tag(license)}`];
    const bad = license.replace(/[()]/g, ' ').split(/\s+/)
      .filter(t => t && !/^(?:AND|OR|WITH)$/.test(t) && !OK_IDS.includes(t));
    return bad.length ? [`${name}@${version}: ${tag(license)}`] : [];
  }).sort();

  const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];
  const gen = (rand, size) => {
    const entries = [];
    for (let i = 0; i < size; i++) {
      const kind = rand();
      const license = kind < 0.6
        ? pick(rand, ALL_IDS)
        : kind < 0.8
          ? `${pick(rand, ALL_IDS)} ${pick(rand, ['AND', 'OR'])} ${pick(rand, ALL_IDS)}`
          : kind < 0.9
            ? `${pick(rand, OK_IDS)} AND (${pick(rand, ALL_IDS)} OR ${pick(rand, OK_IDS)})`
            : `${pick(rand, OK_IDS)} WITH ${pick(rand, ['Font-exception-0.1', 'LLVM-exception'])}`;
      const lic = rand() < 0.9 ? license : pick(rand, [null, 42, undefined]);
      entries.push({ name: `pkg${i}`, version: `${i}.0.0`, license: lic });
    }
    return entries;
  };
  forAll(gen, entries => assert.deepEqual(violations(entries), refViolations(entries)));

  // Property (b): allowlisted-only licenses pass; a bare unknown token names its package.
  forAll(
    (rand, size) => Array.from({ length: size }, (_, i) => ({ name: `ok${i}`, version: '1.0.0', license: `${pick(rand, OK_IDS)} OR ${pick(rand, OK_IDS)}` })),
    entries => assert.deepEqual(violations(entries), []));
  forAll(
    (rand, size) => Array.from({ length: size }, (_, i) => {
      const guilty = rand() < 0.5;
      return guilty
        ? { name: `bad${i}`, version: '1.0.0', license: pick(rand, BAD_IDS) }
        : { name: `fine${i}`, version: '1.0.0', license: pick(rand, OK_IDS) };
    }),
    entries => {
      const found = violations(entries);
      for (const e of entries.filter(e => BAD_IDS.includes(e.license)))
        assert(found.some(v => v.startsWith(`${e.name}@`)), `missing violation for ${e.name}: ${found}`);
    });

  console.log('license-gate ok');
} finally {
  if (tmp && !keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
