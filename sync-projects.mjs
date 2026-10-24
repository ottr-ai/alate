#!/usr/bin/env node
// Pulls per-project agent context snapshots from the workspace into <data>/projects/.
// Usage: node sync-projects.mjs [--root <workspaceDir>] [--data <dir>]   (root default: the dir containing the data repo)
// Direction is project -> data repo. Agents edit their own project files and never
// need to know about this repo; the snapshots here are refreshed copies, never hand-edited.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, resolveDataDir, checkDestination, assertSourceInside, safeRel } from './lib/data.mjs';

const args = parseArgs(process.argv.slice(2), ['--root', '--data', '--repo']);
const data = resolveDataDir(args, { allowClone: false });
// Projects live beside the data repo in the workspace, so its parent is the natural default root.
const root = resolve(args.values['--root'] ?? dirname(data.dir));

const bad = message => { throw new Error(`projects.json: ${message}`); };
const manifest = JSON.parse(readFileSync(join(data.dir, 'projects', 'projects.json'), 'utf8'));
if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) bad('manifest must be an object');
if (!Array.isArray(manifest.contextFiles) || manifest.contextFiles.some(f => typeof f !== 'string')) bad('contextFiles must be an array of strings');
const projects = manifest.projects;
if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) bad('projects must be an object');

const contextFiles = [...new Set(manifest.contextFiles.map(f => safeRel(f, 'projects.json: contextFiles')))];
const validated = Object.entries(projects).map(([name, extras]) => {
  const safe = safeRel(name, 'projects.json: project name');
  if (safe.includes('/')) bad(`project name ${name} must be one directory segment`);
  if (!Array.isArray(extras) || extras.some(f => typeof f !== 'string')) bad(`${safe}: extras must be an array of strings`);
  return [safe, [...new Set(extras.map(f => safeRel(f, `projects.json: project ${safe}`)))]];
});

// Snapshot walk: symlinks are never followed (cycles, escapes); relative result keeps '/'.
const snapFiles = dir => {
  const out = [];
  const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = join(d, e.name);
    if (e.isSymbolicLink()) throw new Error(`snapshot dir ${dir} contains a symlink ${relative(dir, p)}; remove it by hand`);
    if (e.isDirectory()) walk(p);
    else if (!e.isFile()) throw new Error(`snapshot dir ${dir} contains a non-regular entry ${relative(dir, p)}; remove it by hand`);
    else out.push(relative(dir, p).replaceAll('\\', '/'));
  });
  if (existsSync(dir)) walk(dir);
  return out;
};
// Repos use autocrlf; compare modulo CRLF so checkouts and project copies never churn each other.
const norm = b => b.toString('latin1').replaceAll('\r\n', '\n');

const problems = [];
const plan = [];
const notes = [];
for (const [name, extras] of validated) {
  const src = join(root, name);
  if (!existsSync(src)) {
    problems.push(`${name}: no directory at ${src} (fix projects/projects.json or pass --root)`);
    continue;
  }
  if (!statSync(src).isDirectory()) {
    problems.push(`${name}: ${src} is not a directory`);
    continue;
  }
  assertSourceInside(root, src); // throws if the project escapes the workspace
  // The manifest fully drives capture: a path dropped from contextFiles or extras stops
  // refreshing, and its existing snapshot is left untouched (never deleted).
  // `have` only feeds the gone-in-project notes below.
  const selected = new Set([...contextFiles, ...extras]);
  const have = snapFiles(join(data.dir, 'projects', name));
  for (const rel of selected) {
    const from = join(src, rel);
    if (!existsSync(from)) {
      if (extras.includes(rel) && !have.includes(rel)) problems.push(`${name}: listed extra ${rel} is missing in the project`);
      continue;
    }
    if (!statSync(from).isFile()) {
      problems.push(`${name}: ${rel} is not a regular file`);
      continue;
    }
    assertSourceInside(src, from); // throws if the source file escapes its project
    const to = join(data.dir, 'projects', name, rel);
    checkDestination(data.dir, to);
    plan.push({ from, to, bytes: readFileSync(from), old: existsSync(to) ? readFileSync(to) : null });
  }
  for (const rel of have) {
    if (!existsSync(join(src, rel))) notes.push(`${rel} is gone in ${name}; delete projects/${name}/${rel} by hand if stale`);
  }
}
if (problems.length) {
  console.error(`Nothing synced. Fix:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// ponytail: preflight is not a transaction — one snapshot copy may land before a later
// write fails; rerun after fixing the cause. Upgrade to staging+rename if atomicity matters.
let added = 0, updated = 0, unchanged = 0;
for (const { to, bytes, old } of plan) {
  if (old && (old.equals(bytes) || norm(old) === norm(bytes))) { unchanged++; continue; }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes);
  if (old) { updated++; console.log(`updated  ${relative(data.dir, to)}`); }
  else { added++; console.log(`added    ${relative(data.dir, to)}`); }
}
notes.forEach(n => console.log(`note: ${n}`));
console.log(`${added} added, ${updated} updated, ${unchanged} unchanged from ${root}`);
