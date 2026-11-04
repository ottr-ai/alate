// Declared-dependency gate: only the root manifest/lockfile, no other manifests, no undeclared bare imports. node zero-deps.test.mjs
// The repo scan enumerates `git ls-files` output, so untracked local noise (a stray bun.lock,
// a .worktrees/ checkout) cannot fail the gate; staged or committed files always do.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forAll, keepTemp } from './lib/data.mjs';

// test-fixture strings must never contain import-shaped text (see sync-user.test.mjs), so
// the fixture splits the keyword below and specifiers stay out of this file source.
const EVIL_IMPORT = 'import x ' + 'fro' + "m 'left-pad';";

// Matches the from / import / require keywords followed by a quoted specifier.
const SPEC = /\b(?:from|import|require)\b\s*\(?\s*(['"])([^'"\n]+)\1/g;

const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'deno.lock']);
const CODE = /\.[cm]?[jt]s$/;

// Package root name of a specifier: '@scope/name' or 'name' before the first '/'.
const pkgRoot = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

// Violations for an explicit list of root-relative paths (forward slashes): only the
// files a caller hands in are visible, so the repo scan passes tracked paths only.
const violationsFor = (root, rels, declared) => {
  const bad = [];
  const legal = spec => spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || declared.has(pkgRoot(spec));
  for (const rel of rels) {
    const posix = rel.split('\\').join('/');
    const name = posix.slice(posix.lastIndexOf('/') + 1);
    const p = join(root, rel);
    if (name === 'package.json' && posix !== 'package.json') bad.push(p);
    else if (name !== 'package.json' && MANIFESTS.has(name) && posix !== 'package-lock.json') bad.push(p);
    else if (posix !== 'package-lock.json' && CODE.test(name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(SPEC)) {
        const spec = m[2];
        if (!legal(spec)) bad.push(`${p}: ${spec}`);
      }
    }
  }
  return bad.sort();
};

const scan = (root, rels) => {
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
  return bad.concat(violationsFor(root, rels ?? walkRels(root), declared));
};

// Filesystem enumeration for fixture roots ('.' and '..' names cannot occur from readdir).
const walkRels = (dir, base = '') => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = base ? `${base}/${name}` : name;
    if (statSync(join(dir, name)).isDirectory()) out.push(...walkRels(join(dir, name), rel));
    else out.push(rel);
  }
  return out;
};

// Repo enumeration: tracked paths only, NUL-separated so odd names survive.
const trackedPaths = root =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);

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

  // The repo scan sees tracked paths only: an untracked stray lockfile or scratch file
  // cannot fail the gate, while the same paths staged (or committed) do.
  const gitRepo = mkdtempSync(join(tmpdir(), 'alate-zero-deps-git-'));
  writeFileSync(join(gitRepo, 'package.json'), '{}');
  writeFileSync(join(gitRepo, 'ok.mjs'), 'import fs ' + "fro" + "m 'node:fs';\n");
  const git = (...args) => execFileSync('git', args, { cwd: gitRepo });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.com');
  git('config', 'user.name', 'zero-deps gate');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(join(gitRepo, 'bun.lock'), '{}'); // untracked stray lockfile
  writeFileSync(join(gitRepo, 'evil.mjs'), EVIL_IMPORT); // untracked stray code
  assert.deepEqual(scan(gitRepo, trackedPaths(gitRepo)), [], 'untracked files must stay invisible');
  git('add', 'bun.lock', 'evil.mjs'); // staged content is repo content
  assert.deepEqual(scan(gitRepo, trackedPaths(gitRepo)).length, 2,
    `expected staged lockfile + bare import, got: ${scan(gitRepo, trackedPaths(gitRepo)).join('; ')}`);
  rmSync(gitRepo, { recursive: true, force: true });

  // Property: whatever the path mix, the scan reports exactly the manifest-named files
  // outside the root manifest/lockfile pair, at any depth.
  forAll((rand, size) => {
    const NAMES = ['a.ts', 'b.mjs', 'pkg/package.json', 'deep/nest/yarn.lock', 'bun.lock', 'c.js', 'lock/package-lock.json'];
    const picked = new Set();
    for (let i = 0, n = 1 + Math.floor(rand() * (size + 2)); i < n; i++) picked.add(NAMES[Math.floor(rand() * NAMES.length)]);
    return [...picked];
  }, rels => {
    const rootF = mkdtempSync(join(tmpdir(), 'alate-zero-deps-prop-'));
    try {
      writeFileSync(join(rootF, 'package.json'), '{}');
      for (const rel of rels) {
        mkdirSync(dirname(join(rootF, rel)), { recursive: true });
        writeFileSync(join(rootF, rel), 'ok\n');
      }
      const expected = rels.filter(rel => {
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        return (name === 'package.json' && rel !== 'package.json')
          || (name !== 'package.json' && MANIFESTS.has(name) && rel !== 'package-lock.json');
      }).map(rel => join(rootF, rel)).sort();
      assert.deepEqual(scan(rootF), expected, `path mix: ${rels.join(', ')}`);
    } finally {
      rmSync(rootF, { recursive: true, force: true });
    }
  });

  const repo = fileURLToPath(new URL('./', import.meta.url));
  const found = scan(repo, trackedPaths(repo));
  assert.deepEqual(found, [], `undeclared dependencies found:\n${found.join('\n')}`);
  console.log('zero-deps ok');
} finally {
  if (tmp && !keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
