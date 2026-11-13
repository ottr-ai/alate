#!/usr/bin/env node
// Pulls per-project agent context snapshots from the workspace into <data>/projects/.
// Usage: node sync-projects.mjs [--root <workspaceDir>] [--data <dir>]   (root default: the dir containing the data repo)
// Direction is project -> data repo. Agents edit their own project files and never
// need to know about this repo; the snapshots here are refreshed copies, never hand-edited.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, resolveDataDir, checkDestination, assertSourceInside, safeRel, fingerprint, readBaselines, writeBaselines } from './lib/data.mjs';

/** @typedef {{ values: Record<string, string | undefined>, flags: Set<string>, positional: string[] }} CliArgs */
/** @typedef {{ contextFiles: string[], projects: Record<string, string[]> }} ProjectsManifest */
/** @typedef {{ key: string, from: string, to: string, bytes: Buffer, old: Buffer | null }} CopyPlan */

const args = /** @type {CliArgs} */ (parseArgs(process.argv.slice(2), ['--root', '--data', '--repo']));
const data = resolveDataDir(args, { allowClone: false });
// Projects live beside the data repo in the workspace, so its parent is the natural default root.
const root = resolve(args.values['--root'] ?? dirname(data.dir));

/** @param {string} message @returns {never} */
const bad = message => { throw new Error(`projects.json: ${message}`); };
const manifest = /** @type {ProjectsManifest} */ (JSON.parse(readFileSync(join(data.dir, 'projects', 'projects.json'), 'utf8')));
if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) bad('manifest must be an object');
if (!Array.isArray(manifest.contextFiles) || manifest.contextFiles.some(f => typeof f !== 'string')) bad('contextFiles must be an array of strings');
const projects = manifest.projects;
if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) bad('projects must be an object');

const contextFiles = [...new Set(manifest.contextFiles.map(f => safeRel(f, 'projects.json: contextFiles')))];
const validated = /** @type {[string, string[]][]} */ (Object.entries(projects).map(([name, extras]) => {
  const safe = safeRel(name, 'projects.json: project name');
  if (safe.includes('/')) bad(`project name ${name} must be one directory segment`);
  if (!Array.isArray(extras) || extras.some(f => typeof f !== 'string')) bad(`${safe}: extras must be an array of strings`);
  return [safe, [...new Set(extras.map(f => safeRel(f, `projects.json: project ${safe}`)))]];
}));

// Snapshot walk: symlinks are never followed (cycles, escapes); relative result keeps '/'.
/** @param {string} dir @returns {string[]} */
const snapFiles = dir => {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
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
/** @type {string[]} */
const problems = [];
/** @type {CopyPlan[]} */
const plan = [];
/** @type {string[]} */
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
    plan.push({ key: `${name}/${rel}`, from, to, bytes: readFileSync(from), old: existsSync(to) ? readFileSync(to) : null });
  }
  for (const rel of have) {
    if (!existsSync(join(src, rel))) notes.push(`${rel} is gone in ${name}; delete projects/${name}/${rel} by hand if stale`);
  }
}
if (problems.length) {
  console.error(`Nothing synced. Fix:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// Capture baselines (specs/capture-baseline.md): per captured file, a fingerprint of the
// snapshot bytes this machine last wrote or adopted. The record tells a machine edit
// (capture) from a snapshot that changed elsewhere (refresh the machine copy); when both
// moved, the file is a conflict and the run writes nothing — it never picks a side silently.
const statePath = join(root, '.alate', 'captured-projects.json');
let baselines;
let stateUsable = true;
try {
  baselines = readBaselines(statePath);
} catch (err) {
  baselines = null;
  stateUsable = false;
  console.log(`note: ${statePath} is not a valid capture baseline (${/** @type {Error} */ (err).message}); every file counts as having no baseline`);
}
const actions = [];
const conflicts = [];
/** @type {Record<string, string>} */
const updates = {};
const noBase = [];
let added = 0, updated = 0, unchanged = 0, refreshed = 0;
for (const entry of plan) {
  const { key, from, to, bytes, old } = entry;
  const fpMachine = fingerprint(key, bytes);
  const fpSnap = old ? fingerprint(key, old) : null;
  const base = baselines ? baselines[key] ?? null : null;
  if (old && fpMachine === fpSnap) { // unchanged: seed the baseline so the next run can judge
    unchanged++;
    if (stateUsable && base !== fpMachine) updates[key] = fpMachine;
    continue;
  }
  if (old && base !== null && base !== fpMachine && base !== fpSnap) {
    conflicts.push({ key, from });
    continue;
  }
  if (base === null) noBase.push(key);
  if (old && fpMachine === base) { // the snapshot moved elsewhere, the machine still holds the captured state
    refreshed++;
    actions.push({ key, from, snap: old });
    if (stateUsable) updates[key] = fingerprint(key, old);
    continue;
  }
  // capture: a machine edit, a first run, or a snapshot file missing in the data repo
  actions.push({ key, to, bytes, old });
  if (stateUsable) updates[key] = fpMachine;
}
if (conflicts.length) {
  console.error('Nothing synced. Resolve by hand, then rerun:');
  for (const { key, from } of conflicts)
    console.error(`conflict: the snapshot ${join(data.dir, 'projects', key)} and the machine file ${from} both changed since the last capture; resolve by hand`);
  process.exit(1);
}
// ponytail: preflight is not a transaction — one snapshot copy may land before a later
// write fails; rerun after fixing the cause. Upgrade to staging+rename if atomicity matters.
for (const a of actions) {
  if (a.snap) { // refresh: the committed snapshot is the newer truth, so the machine takes it
    writeFileSync(a.from, a.snap);
    console.log(`refreshed projects/${a.key} into ${a.from} (the snapshot changed elsewhere; the machine copy was unchanged)`);
    continue;
  }
  mkdirSync(dirname(a.to), { recursive: true });
  writeFileSync(a.to, a.bytes);
  if (a.old) { updated++; console.log(`updated  ${relative(data.dir, a.to)}`); }
  else { added++; console.log(`added    ${relative(data.dir, a.to)}`); }
}
for (const key of noBase) console.log(`note: projects/${key} has no capture baseline; captured the machine copy`);
notes.forEach(n => console.log(`note: ${n}`));
console.log(`${added} added, ${updated} updated, ${unchanged} unchanged${refreshed ? `, ${refreshed} refreshed` : ''} from ${root}`);
if (stateUsable && Object.keys(updates).length) {
  try {
    writeBaselines(statePath, { ...baselines, ...updates });
  } catch (err) {
    console.log(`note: ${statePath}: could not write the capture baseline (${/** @type {Error} */ (err).message}); the next capture runs without one`);
  }
}
