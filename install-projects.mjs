#!/usr/bin/env node
// Installs the per-project agent context snapshots from <data>/projects/ into the workspace checkouts:
// the inverse of sync-projects.mjs (capture), and the last step of provision (after sync.mjs and
// install-user.mjs), so a snapshot commit that changes a listed file reaches the board checkout
// without anyone running the capture script board-side. Usage:
//   node install-projects.mjs --data <dir> --root <workspaceDir>
// Without --root (the server knows no workspace) it prints why on both streams and exits 0. The
// manifest (projects/projects.json) fully drives the install: a path dropped from it stops being
// installed, and its file is never deleted. The capture baselines (specs/capture-baseline.md) are
// shared with sync-projects.mjs (same record at <root>/.alate/captured-projects.json, same
// '<name>/<rel>' key format): a machine copy that still holds the captured state is refreshed from
// the snapshot, and a machine edit is replaced by the snapshot (the accepted gate decision: the
// snapshot is the source of truth). The log line names every replacement, so nothing changes
// silently. A refusal (invalid manifest, a path guard) writes nothing and exits 1.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertSourceInside, checkDestination, fingerprint, parseArgs, PROVISION_ENV, readBaselines, resolveDataDir, safeRel, writeBaselines, writeProvisionResults } from './lib/data.mjs';

/** @typedef {{ values: Record<string, string | undefined>, flags: Set<string>, positional: string[] }} CliArgs */
/** @typedef {{ contextFiles: string[], projects: Record<string, string[]> }} ProjectsManifest */
/** @typedef {{ item: string, status: 'added' | 'updated' | 'unchanged', rule: null, at: null }} ProvisionItem */
/** @typedef {{ key: string, dest: string, snapBytes: Buffer, fpSnap: string, status: 'added' | 'updated' | 'unchanged', log: string | null }} Plan */

const NO_ROOT = 'install-projects: no --root; project files not provisioned';
const args = /** @type {CliArgs} */ (parseArgs(process.argv.slice(2), ['--data', '--root']));
const data = resolveDataDir(args, { allowClone: false });

const items = /** @type {ProvisionItem[]} */ ([]);
let fatal = false;
let error = null;

/**
 * @param {string} root
 * @param {string} manifestPath
 * @returns {void}
 */
function install(root, manifestPath) {
  /** @param {string} message @returns {never} */
  const bad = message => { throw new Error(`projects.json: ${message}`); };
  const manifest = /** @type {ProjectsManifest} */ (JSON.parse(readFileSync(manifestPath, 'utf8')));
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

  // Capture baselines (specs/capture-baseline.md), shared with sync-projects.mjs: per installed
  // file, a fingerprint of the snapshot bytes this machine last wrote or adopted. A corrupt record
  // is named once, never rewritten, and the run then treats every file as having no baseline.
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

  // Plan pass: guards and decisions only, so a refusal happens before any write.
  /** @type {Plan[]} */
  const plan = [];
  /** @type {Set<string>} */
  const touched = new Set();
  for (const [name, extras] of validated) {
    const liveDir = join(root, name);
    if (!existsSync(liveDir) || !statSync(liveDir).isDirectory()) {
      console.log(`projects/${name}: no checkout at ${liveDir}; skipped`);
      continue;
    }
    for (const rel of [...new Set([...contextFiles, ...extras])]) {
      const snapFile = join(data.dir, 'projects', name, ...rel.split('/'));
      if (!existsSync(snapFile)) {
        // contextFiles names are alternatives; a missing one is normal, never an error.
        console.log(`projects/${name}/${rel} is not in the snapshot; skipped`);
        continue;
      }
      assertSourceInside(data.dir, snapFile);
      const dest = join(liveDir, ...rel.split('/'));
      if (existsSync(dest)) assertSourceInside(liveDir, dest);
      checkDestination(liveDir, dest);
      const snapBytes = readFileSync(snapFile);
      const machine = existsSync(dest) ? readFileSync(dest) : null;
      const key = `${name}/${rel}`;
      const fpSnap = fingerprint(key, snapBytes);
      const base = baselines ? baselines[key] ?? null : null;
      const fpMachine = machine ? fingerprint(key, machine) : null;
      let status;
      let log;
      if (machine && fpMachine === fpSnap) {
        status = 'unchanged'; // the baseline is seeded below, so the next capture can judge
        log = null;
      } else if (!machine) {
        status = 'added';
        log = `added projects/${key} into ${dest}`;
      } else if (base !== null && fpMachine === base) {
        // The snapshot moved elsewhere and the machine still holds the captured state.
        status = 'updated';
        log = `refreshed projects/${key} into ${dest} (the snapshot changed elsewhere; the machine copy held the captured state)`;
      } else {
        status = 'updated';
        log = base !== null
          ? `replaced projects/${key} into ${dest} (the machine copy changed since the last capture; its local changes were replaced)`
          : `replaced projects/${key} into ${dest} (no capture baseline exists; the machine copy differed from the snapshot)`;
      }
      touched.add(name);
      plan.push({ key, dest, snapBytes, fpSnap, status, log });
    }
  }

  // ponytail: preflight is not a transaction: one copy may land before a later write fails;
  // rerun after fixing the cause. Upgrade to staging+rename if atomicity matters.
  let added = 0, updated = 0, unchanged = 0;
  /** @type {Record<string, string>} */
  const updates = {};
  for (const p of plan) {
    if (p.status === 'unchanged') {
      unchanged++;
      if ((baselines?.[p.key] ?? null) !== p.fpSnap) updates[p.key] = p.fpSnap;
    } else {
      mkdirSync(dirname(p.dest), { recursive: true });
      writeFileSync(p.dest, p.snapBytes);
      updates[p.key] = p.fpSnap;
      console.log(p.log);
      if (p.status === 'added') added++; else updated++;
    }
    items.push({ item: `projects/${p.key}`, status: p.status, rule: null, at: null });
  }
  console.log(`${added} added, ${updated} updated, ${unchanged} unchanged across ${touched.size} projects from ${root}`);
  if (stateUsable && Object.keys(updates).length) {
    try {
      writeBaselines(statePath, { ...baselines, ...updates });
    } catch (err) {
      console.log(`note: ${statePath}: could not write the capture baseline (${/** @type {Error} */ (err).message}); the next run judges without one`);
    }
  }
}

try {
  if (!args.values['--root']) {
    // The server omits --root when the deployment has no workspace: a loud why, never a failure.
    console.error(NO_ROOT);
    console.log(NO_ROOT);
  } else {
    const root = resolve(args.values['--root']);
    const manifestPath = join(data.dir, 'projects', 'projects.json');
    if (!existsSync(manifestPath)) {
      console.log('projects/projects.json is missing in the snapshot; nothing to install');
    } else {
      install(root, manifestPath);
    }
  }
} catch (err) {
  console.error(/** @type {Error} */ (err).message);
  fatal = true;
  error = /** @type {Error} */ (err).message;
  process.exitCode = 1; // not process.exit: the finally below must still write the results file
} finally {
  // The server's per-item results, whatever the run's outcome; a refusal carries fatal: true.
  if (process.env[PROVISION_ENV]) writeProvisionResults(process.env[PROVISION_ENV], { fatal, error, items });
}
