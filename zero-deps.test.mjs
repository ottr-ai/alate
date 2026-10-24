// Declared-dependency gate: only the root manifest/lockfile, no other manifests, no undeclared bare imports. node zero-deps.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepTemp } from './lib/data.mjs';

// test-fixture strings must never contain import-shaped text (see sync-user.test.mjs), so
// the fixture splits the keyword below and specifiers stay out of this file source.
const EVIL_IMPORT = 'import x ' + 'fro' + "m 'left-pad';";

// Matches the from / import / require keywords followed by a quoted specifier.
const SPEC = /\b(?:from|import|require)\b\s*\(?\s*(['"])([^'"\n]+)\1/g;

const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'deno.lock']);
const CODE = /\.[cm]?[jt]s$/;

// Package root name of a specifier: '@scope/name' or 'name' before the first '/'.
const pkgRoot = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const scan = root => {
  const bad = [];
  // Root manifest is required, legal, and the source of declared deps.
  let declared;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    declared = new Set(Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {})));
  } catch {
    bad.push(join(root, 'package.json'));
    declared = new Set();
  }
  const legal = spec => spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || declared.has(pkgRoot(spec));
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name === 'package.json' && p !== join(root, 'package.json')) bad.push(p);
      else if (name !== 'package.json' && MANIFESTS.has(name) && p !== join(root, 'package-lock.json')) bad.push(p);
      else if (p !== join(root, 'package-lock.json') && CODE.test(name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(SPEC)) {
          const spec = m[2];
          if (!legal(spec)) bad.push(`${p}: ${spec}`);
        }
      }
    }
  };
  walk(root);
  return bad;
};

let tmp;
try {
  const empty = mkdtempSync(join(tmpdir(), 'alate-zero-deps-empty-'));
  // "Empty" fixture still needs a root manifest: a missing one is itself a violation.
  writeFileSync(join(empty, 'package.json'), '{}');
  assert.deepEqual(scan(empty).length, 0);
  rmSync(empty, { recursive: true, force: true });

  tmp = mkdtempSync(join(tmpdir(), 'alate-zero-deps-'));
  writeFileSync(join(tmp, 'package.json'), '{}'); // empty manifest: no declared deps
  mkdirSync(join(tmp, 'sub'), { recursive: true });
  writeFileSync(join(tmp, 'sub', 'package.json'), '{}');
  writeFileSync(join(tmp, 'sub', 'evil.mjs'), EVIL_IMPORT);
  assert.deepEqual(scan(tmp).length, 2, `expected sub-manifest + bare import, got: ${scan(tmp).join('; ')}`);

  // A root manifest makes declared bare imports legal; undeclared ones stay violations.
  const declaredRoot = mkdtempSync(join(tmpdir(), 'alate-zero-deps-decl-'));
  writeFileSync(join(declaredRoot, 'package.json'), JSON.stringify({ dependencies: { fastify: '^5.6.1' } }));
  writeFileSync(join(declaredRoot, 'a.ts'), 'import x ' + "fro" + "m 'left-pad';");
  writeFileSync(join(declaredRoot, 'b.ts'), 'import x ' + "fro" + "m 'fastify/x';");
  assert.deepEqual(scan(declaredRoot).length, 1, `expected only left-pad violation, got: ${scan(declaredRoot).join('; ')}`);
  rmSync(declaredRoot, { recursive: true, force: true });

  const repo = fileURLToPath(new URL('./', import.meta.url));
  const violations = scan(repo);
  assert.deepEqual(violations, [], `undeclared dependencies found:\n${violations.join('\n')}`);
  console.log('zero-deps ok');
} finally {
  if (tmp && !keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
