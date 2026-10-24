#!/usr/bin/env node
// Restores the data repo's captured user/ layer onto a machine: the inverse of sync-user.mjs.
// Usage: node install-user.mjs [--home <dir>] [--force] [--skip-plugins] [--data <dir>|--repo <owner/name[@ref]>]
//   data dir: --data <dir>, else --repo (shallow clone), else $ALATE_DATA, else ../agent-data beside this checkout
// Paths mirror the home directory minus the leading dot (user/omp/agent/config.yml -> ~/.omp/agent/config.yml).
// On a live machine omp's own state is the source of truth, so an existing file that differs is refused,
// never overwritten, unless it still holds what alate last installed there (~/.alate/installed.json
// records it): nobody changed it since, so the newer snapshot replaces it. --force overrides for a
// deliberate refresh. Fresh homes (CI, worker images) just copy.
// A path the snapshot dropped is deleted when it still holds what alate installed; a copy changed
// here stays and loses its record.
// On a non-Windows machine, JSON config captured on Windows is adapted to it first (forTarget, lib/data.mjs).
// Plugins install from the captured lockfile with `bun install --frozen-lockfile` in ~/.omp/plugins, the
// same root omp's plugin manager installs into.
// Also installs the per-project package lists Ottr's turns read: workers/<project>/apt.txt ->
// ~/.ottr/workers/<project>/apt.txt. The data repo is their only source, so a changed list replaces
// the machine copy without --force, and a list it no longer ships is deleted.
import { existsSync, mkdirSync, rmdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSourceInside, checkDestination, cleanupData, fingerprint, forTarget, parseArgs, resolveDataDir, sameContent, splitDeploymentBlocks, withoutDeploymentBlocks } from './lib/data.mjs';

const args = parseArgs(process.argv.slice(2), ['--data', '--repo', '--home'], ['--force', '--skip-plugins']);
const home = args.values['--home'] ?? homedir();
const force = args.flags.has('--force');
const skipPlugins = args.flags.has('--skip-plugins');
const data = resolveDataDir(args, { allowClone: true });
const userRoot = join(data.dir, 'user');
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
// A skill snapshot is executable agent content, so install-user scans each one statically
// (fail-closed: findings, a missing scanner, or a crashed scan refuse the whole restore before the
// first write) before anything lands in the home. The scan applies the snapshot's own shipped
// `.skillspector-baseline.yaml` — its accepted findings are review records committed to the data
// repo, the same file the data repo's pre-push gate accepts. The upstream build is
// pinned to a tag on purpose:
// never point this at a moving ref. It needs Python 3.12+ where install-user runs:
//   pip install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@v2.13.0"
const SKILLSPECTOR_REF = 'v2.13.0';
const SKILL_ROOT_NAMES = new Set(['skills', 'managed-skills']);

try {
  if (!existsSync(userRoot)) {
    throw new Error(`No user/ snapshot in ${data.dir}; run sync-user.mjs first.`);
  }
  // user/ itself is not a user-chosen root: a junction here would relocate the whole
  // snapshot outside the data dir, so it is pinned to canonical data.dir before walking.
  assertSourceInside(data.dir, userRoot);
  const walk = (dir, sub = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    SKIP_DIRS.has(e.name) ? []
      : e.isDirectory() ? walk(join(dir, e.name), sub ? `${sub}/${e.name}` : e.name)
      : [sub ? `${sub}/${e.name}` : e.name]);

  // Top-level snapshot dirs are dot-dirs in the home (user/omp -> ~/.omp): the layer's own paths.
  const roots = new Set(readdirSync(userRoot).map(name => '.' + name));
  const plan = [];
  const conflicts = [];
  const notes = [];
  // Snapshot path -> fingerprint of the content alate last installed (or found already in place).
  const manifest = join(home, '.alate', 'installed.json');
  checkDestination(home, manifest);
  let last = {};
  if (existsSync(manifest)) {
    try {
      last = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (err) {
      console.error(`Ignoring unreadable ${manifest} (${err.message}): every file that differs from the snapshot counts as changed here.`);
    }
  }
  // The machine file's fingerprint, the same comparison the install plan uses: config.yml's
  // deployment blocks stay on the target, so they never make a file look changed here.
  const machineFingerprint = (rel, dest) => {
    if (!existsSync(dest)) return null;
    const machineYaml = rel === 'omp/agent/config.yml' ? readFileSync(dest).toString('utf8') : null;
    const base = machineYaml === null ? null : withoutDeploymentBlocks(machineYaml);
    return fingerprint(rel, base === null ? readFileSync(dest) : Buffer.from(base, 'utf8'));
  };

  // Deletes the directories a deletion left empty, up to the mapped root (the top-level
  // dot-dir of the snapshot path, or ~/.ottr for worker lists); never the root itself.
  const pruneEmptyDirs = (dest, root) => {
    for (let dir = dirname(dest); dir.startsWith(root + sep); dir = dirname(dir)) {
      if (readdirSync(dir).length) break;
      rmdirSync(dir);
    }
  };

  const current = {};
  for (const rel of walk(userRoot)) {
    // Snapshot content must resolve inside the snapshot; links escaping it, or cyclic
    // ones, refuse the restore instead of being followed.
    const srcPath = join(userRoot, rel);
    try {
      assertSourceInside(userRoot, srcPath);
    } catch (err) {
      throw new Error(`user/${rel}: ${err.message}`);
    }
    const dest = join(home, '.' + rel);
    // Every destination is preflighted before any content is read or written, so a
    // symlink, hardlink, or directory at dest refuses the whole restore up front —
    // --force overrides the conflict refusal, never this alias guard.
    checkDestination(home, dest);
    const target = forTarget(rel, readFileSync(srcPath), { home, platform: process.platform, roots });
    notes.push(...target.notes);
    // config.yml's top-level hindsight:/alate: blocks are deployment settings that stay on the
    // target: the snapshot never carries them (capture strips them), and the machine's own ride
    // along on every install. Compare deployment-free content, so a target that differs only in
    // those blocks is unchanged and a real conflict cannot hide behind them. `dropped` holds
    // credentials: never log it.
    const machineYaml = rel === 'omp/agent/config.yml' && existsSync(dest)
      ? readFileSync(dest).toString('utf8') : null;
    const deployed = machineYaml === null ? null : splitDeploymentBlocks(machineYaml);
    const want = fingerprint(rel, target.bytes);
    let src = target.bytes;
    if (deployed?.dropped.length) {
      const base = splitDeploymentBlocks(target.bytes.toString('utf8'));
      // The snapshot's own terminator already separates it from the appended blocks; a
      // snapshot that does not end in a newline still gets the blocks on a new line.
      const kept = base.kept[base.kept.length - 1] === '' ? base.kept.slice(0, -1) : base.kept;
      src = Buffer.from([...kept, ...deployed.dropped].join('\n'), 'utf8');
    }
    // The machine text minus its deployment blocks (lib/data.mjs keeps the last kept line's
    // terminator). `dropped` holds credentials: never log it.
    const have = machineFingerprint(rel, dest);
    if (have === want) plan.push(['unchanged', dest, null]);
    else if (have === null || have === last[rel] || force) plan.push(['installed', dest, src]);
    else conflicts.push(dest);
    current[rel] = want;
  }
  const workersRoot = join(data.dir, 'workers');
  if (existsSync(workersRoot)) {
    assertSourceInside(data.dir, workersRoot);
    for (const project of readdirSync(workersRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
      const srcPath = join(workersRoot, project, 'apt.txt');
      if (!existsSync(srcPath)) continue;
      assertSourceInside(workersRoot, srcPath);
      const dest = join(home, '.ottr', 'workers', project, 'apt.txt');
      checkDestination(home, dest);
      const src = readFileSync(srcPath);
      plan.push(existsSync(dest) && sameContent('', readFileSync(dest), src) ? ['unchanged', dest, null] : ['installed', dest, src]);
    }
  }
  // A path the snapshot dropped: delete the machine copy when it still holds what alate last
  // installed (nobody changed it since), keep it with a note when it changed here, and drop
  // the record either way — alate no longer vouches for a path the snapshot lacks. --force
  // never deletes: a file that does not match its record is never deleted.
  const deletions = [];
  for (const [rel, fp] of Object.entries(last)) {
    if (Object.hasOwn(current, rel) || typeof fp !== 'string') continue;
    const dest = join(home, '.' + rel);
    // Same guard as installs: never delete through a symlink, a hardlink alias or a
    // directory, and never outside the home; a violated guard refuses the whole run.
    checkDestination(home, dest);
    if (!existsSync(dest)) continue;
    if (machineFingerprint(rel, dest) === fp) deletions.push([dest, join(home, '.' + rel.split('/')[0])]);
    else notes.push(`changed here, kept: ${dest}`);
  }
  // Worker lists come only from the data repo, so a list it no longer ships is deleted too.
  const homeWorkers = join(home, '.ottr');
  if (existsSync(join(homeWorkers, 'workers'))) {
    const shipped = existsSync(workersRoot)
      ? new Set(readdirSync(workersRoot, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(workersRoot, e.name, 'apt.txt'))).map(e => e.name))
      : new Set();
    for (const project of readdirSync(join(homeWorkers, 'workers'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
      if (shipped.has(project)) continue;
      const dest = join(homeWorkers, 'workers', project, 'apt.txt');
      checkDestination(home, dest);
      if (existsSync(dest)) deletions.push([dest, homeWorkers]);
    }
  }
  if (conflicts.length && !force) {
    throw new Error(`Refusing to overwrite files that hold neither the snapshot nor what alate last installed here (machine state wins: commit the change to the data repo, or --force overrides):\n  ${conflicts.join('\n  ')}`);
  }

  // Fail-closed gate: every directory named skills/ or managed-skills/ in the snapshot
  // holds executable agent content, so each skill in it is scanned before any write, deletion,
  // or record update below. Skills already recorded as unchanged are scanned again too: a copy
  // a pre-gate alate installed was never scanned, and the manifest cannot prove it was. The
  // scanner's own report goes straight to this run's output (stdio: 'inherit'); any non-zero
  // exit — findings (1) or a scanner error (2) — refuses the whole run with a non-zero exit.
  const skillDirs = [];
  const collectSkillDirs = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (SKILL_ROOT_NAMES.has(entry.name)) {
        for (const skill of readdirSync(path, { withFileTypes: true })) {
          if (skill.isDirectory() && !SKIP_DIRS.has(skill.name)) skillDirs.push(join(path, skill.name));
        }
      } else collectSkillDirs(path);
    }
  };
  collectSkillDirs(userRoot);
  if (skillDirs.length) {
    console.log(`Scanning ${skillDirs.length} skill snapshot(s) with SkillSpector ${SKILLSPECTOR_REF} (--no-llm, static only, shipped baselines applied)...`);
    for (const dir of skillDirs) {
      const scan = spawnSync('skillspector', ['scan', dir, '--no-llm', '--fail-on-findings', '--use-shipped-baseline'], { stdio: 'inherit' });
      if (scan.error?.code === 'ENOENT') {
        throw new Error(`skillspector not found; refusing to install ${skillDirs.length} skill snapshot(s). Install the pinned build (Python 3.12+), then retry: pip install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}"`);
      }
      if (scan.error) {
        throw new Error(`skillspector could not run (${scan.error.code ?? scan.error.message}); refusing to install ${skillDirs.length} skill snapshot(s).`);
      }
      if (scan.status !== 0) {
        throw new Error(`SkillSpector rejected ${dir} (exit ${scan.status ?? `signal ${scan.signal}`}); nothing was installed. Review the report above, then fix or drop the skill in the data repo.`);
      }
    }
  }

  let installed = 0, unchanged = 0;
  for (const [kind, dest, bytes] of plan) {
    if (kind === 'unchanged') { unchanged++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    installed++;
  }
  let deleted = 0;
  for (const [dest, root] of deletions) {
    unlinkSync(dest);
    console.log(`deleted  ${relative(home, dest)}`);
    pruneEmptyDirs(dest, root);
    deleted++;
  }
  // The record the snapshot dropped is written as gone: if the path returns, an untouched
  // copy is freshly installed, and a changed copy wins as a plain conflict.
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`${installed} installed, ${unchanged} unchanged, ${deleted} deleted in ${home}`);
  for (const note of notes) console.log(note);

  if (!skipPlugins && existsSync(join(userRoot, 'omp', 'plugins', 'package.json'))) {
    const pluginsDir = join(home, '.omp', 'plugins');
    const bun = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: pluginsDir, stdio: 'inherit' });
    if (bun.error || bun.status !== 0) {
      throw new Error(bun.error?.code === 'ENOENT' ? 'bun not found; cannot install plugins.' : `bun install failed in ${pluginsDir}`);
    }
  } else if (skipPlugins) {
    console.log('plugins skipped');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1; // not process.exit: finally below must still remove a cloned temp dir
} finally {
  cleanupData(data);
}
