#!/usr/bin/env node
// Per-file test selection for Stryker's command runner: both mutation configs run this
// script as their command (node scripts/mutant-run.mjs <testFile>...). Plain node only.
//
// Dry run (no active mutant): the full chain runs once, unchanged, so Stryker's
// timeout budget keeps the net time of the chain it replaced.
//
// Mutant run: Stryker passes the active mutant id in __STRYKER_ACTIVE_MUTANT__, and the
// instrumented mutate files carry stryMutAct_<hash>("<id>") switches. This script scans
// the chain's import closure (plus the spawn edges in SPAWN_EDGES) for that stamp to
// find the mutated file, then runs the chain in two stages:
//   stage 1: the chain files that reach the mutated file;
//   stage 2: the remaining chain files, so every stage-1 survivor still faces the
//     whole chain.
// Stage 1 and stage 2 together are the chain, so the exit code — the command runner's
// only verdict input — fails iff a full chain run would fail. A wrong or stale map
// entry only shifts work between stages; it never changes a verdict. An id with no
// stamp skips stage 1 and runs the whole chain: slower, never wrong.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests reach these files by spawning them as child processes, or through a spawned
// file's own imports, so a static import scan cannot see the edge. Values are filtered
// to the chain being run.
const SPAWN_EDGES = {
  'sync.mjs': ['sync.test.mjs', 'clone.test.mjs'],
  'install-user.mjs': ['install-user.test.mjs', 'sync-user.test.mjs'],
  'sync-user.mjs': ['sync-user.test.mjs'],
  'sync-projects.mjs': ['sync-projects.test.mjs'],
  'server.ts': ['server.test.mjs'],
  'web/dashboard.mjs': ['server.test.mjs'],
};

const TEST_RE = /\.test\.[cm]?[jt]s$/;
const SOURCE_RE = /\.(?:m|c)?[jt]s$/;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"\n]+)['"]/g;

// resolveSpec: root-relative path of a relative import from fromFile, or null.
const resolveSpec = (root, fromFile, spec) => {
  const base = normalize(join(root, dirname(fromFile), spec));
  const candidates = [base, `${base}.mjs`, `${base}.ts`, join(base, 'index.mjs'), join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (SOURCE_RE.test(candidate) && existsSync(candidate)) {
      return candidate.slice(root.length + 1).split('\\').join('/');
    }
  }
  return null;
};

// reachMap: for every chain file, the source files its static import closure contains.
// Returns Map<source, chainFile[]> with chain files in chain order.
export const reachMap = (chain, root = process.cwd()) => {
  const map = new Map();
  for (const testFile of chain) {
    const seen = new Set([testFile]);
    const queue = [testFile];
    while (queue.length > 0) {
      const file = queue.shift();
      const code = readFileSync(join(root, file), 'utf8');
      for (const match of code.matchAll(IMPORT_RE)) {
        const resolved = resolveSpec(root, file, match[1]);
        if (resolved === null || seen.has(resolved) || TEST_RE.test(resolved)) continue;
        seen.add(resolved);
        queue.push(resolved);
        const list = map.get(resolved) ?? [];
        if (!list.includes(testFile)) list.push(testFile);
        map.set(resolved, list);
      }
    }
  }
  return map;
};

// findMutatedFile: the scan set is every mapped source plus the spawn-edge keys; a
// mutant id is unique across the run, so exactly the mutated file carries its stamp.
// The id comes from the environment (untrusted input): digits only, or no stage 1.
export const findMutatedFile = (id, sources, root = process.cwd()) => {
  if (!/^\d+$/.test(id)) return '';
  const stamp = new RegExp(`stryMutAct_[0-9a-f]+\\(['"]${id}['"]\\)`);
  for (const source of sources) {
    try {
      if (stamp.test(readFileSync(join(root, source), 'utf8'))) return source;
    } catch {
      // Absent in this checkout: not the mutated file.
    }
  }
  return '';
};

// stageSplit: chain order preserved, stages disjoint, stage 1 union stage 2 = chain.
export const stageSplit = (chain, stage1) => ({
  first: chain.filter(file => stage1.has(file)),
  rest: chain.filter(file => !stage1.has(file)),
});

const runFiles = files => {
  for (const file of files) {
    const run = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
};

export const main = () => {
  const chain = process.argv.slice(2);
  if (chain.length === 0) {
    console.error('usage: node scripts/mutant-run.mjs <testFile>...');
    process.exit(1);
  }
  const mutant = process.env.__STRYKER_ACTIVE_MUTANT__;
  if (!mutant) {
    runFiles(chain);
    return;
  }
  const map = reachMap(chain);
  const sources = [...new Set([...map.keys(), ...Object.keys(SPAWN_EDGES)])];
  const mutated = findMutatedFile(mutant, sources);
  const hits = new Set(map.get(mutated) ?? []);
  for (const file of SPAWN_EDGES[mutated] ?? []) {
    if (chain.includes(file)) hits.add(file);
  }
  const { first, rest } = stageSplit(chain, hits);
  if (first.length === 0 || first.length === chain.length) {
    runFiles(chain); // Unknown file, or every file reaches it: one pass.
    return;
  }
  console.error(`[mutant-run] mutant ${mutant} (${mutated || 'unknown file'}): stage 1 runs ${first.length} of ${chain.length} test files`);
  runFiles(first);
  runFiles(rest);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
