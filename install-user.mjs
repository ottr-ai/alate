#!/usr/bin/env node
// Restores the data repo's captured user/ layer onto a machine: the inverse of sync-user.mjs.
// Usage: node install-user.mjs [--home <dir>] [--force] [--skip-plugins] [--layer] [--data <dir>|--repo <owner/name[@ref]>]
// --layer (or ALATE_LAYER=1) installs into a fresh <home>/.alate/layers/<commit>-<n> and atomically
// switches the <home>/.alate/current symlink to it, so a provision never rewrites files a running
// turn reads; see specs/agent-layer-switch.md for the layout, link set, and cleanup rules.
//   data dir: --data <dir>, else --repo (shallow clone), else $ALATE_DATA, else ../agent-data beside this checkout
// Paths mirror the home directory minus the leading dot (user/omp/agent/config.yml -> ~/.omp/agent/config.yml).
// On a live machine omp's own state is the source of truth, so an existing file that differs is refused,
// never overwritten, unless it still holds what alate last installed there (~/.alate/installed.json
// records it): nobody changed it since, so the newer snapshot replaces it. --force overrides for a
// deliberate refresh. Fresh homes (CI, worker images) just copy.
// A path the snapshot dropped is deleted when it still holds what alate installed; a copy changed
// here stays and loses its record.
// JSON config is adapted to the target machine first (forTarget, lib/data.mjs): a Windows capture
// on a non-Windows machine, a POSIX-absolute capture path on Windows.
// Plugins install from the captured lockfile with `bun install --frozen-lockfile` in ~/.omp/plugins, the
// same root omp's plugin manager installs into.
// Also installs the per-project worker additions Ottr's turns read: workers/<project>/apt.txt
// (Debian packages), tools.json (declarative downloads), env.txt (env names, never values) and
// requirements.txt (pinned, hashed Python packages)
// -> ~/.ottr/workers/<project>/<file>; workers/_all/ is provisioned like a project. The data
// repo is their only source, so a changed list replaces the machine copy without --force, and a
// list it no longer ships is deleted. tools.json, env.txt and requirements.txt are validated before any write.
import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, availableParallelism } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertSourceInside, checkDestination, cleanupData, fingerprint, forTarget, nextLayerCounter, parseArgs, remapHomePaths, resolveDataDir, ruleProblems, sameContent, splitDeploymentBlocks, withoutDeploymentBlocks, withoutMemoryBackend } from './lib/data.mjs';

const args = parseArgs(process.argv.slice(2), ['--data', '--repo', '--home'], ['--force', '--skip-plugins', '--layer']);
const home = args.values['--home'] ?? homedir();
const force = args.flags.has('--force');
const skipPlugins = args.flags.has('--skip-plugins');
const layerMode = args.flags.has('--layer') || process.env.ALATE_LAYER === '1';
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
// The scan prefers the pinned venv (SKILLSPECTOR_VENV, default ~/.cache/skillspector-venv, the
// same layout the data repo's .githooks/skillspector-scan.sh bootstraps) and verifies the
// version before it trusts any verdict: baseline fingerprints bind to scanner_version, so a
// scanner that is not the pin would silently suppress nothing.
const SKILLSPECTOR_REF = 'v2.13.0';
const SKILL_ROOT_NAMES = new Set(['skills', 'managed-skills']);

// Worker additions Ottr's turns read, provisioned per project folder (workers/_all/ is the fleet
// folder and is provisioned like a project). The data repo is their only source: a changed list
// replaces the machine copy without --force, a list the repo no longer ships is deleted.
// tools.json, env.txt and requirements.txt are validated before the plan turns into any write: an invalid file
// fails the whole provision with its path and the first rule it breaks, so a valid folder is
// never half-written. Declarative only — no shell commands of any kind.
const WORKER_FILES = ['apt.txt', 'tools.json', 'env.txt', 'requirements.txt'];
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNPACK = new Set(['zip', 'tar.gz', 'none']);
// A bin path is an archive-relative path: safe segments only, so "..", absolute paths and
// anything shell-like never reach the container.
const BIN_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Every directory named skills/ or managed-skills/ anywhere under a root holds executable
// agent content; each skill inside it goes to the scanner.
const collectSkillDirs = dir => {
  const found = [];
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (SKILL_ROOT_NAMES.has(entry.name)) {
        for (const skill of readdirSync(child, { withFileTypes: true })) {
          if (skill.isDirectory() && !SKIP_DIRS.has(skill.name)) found.push(join(child, skill.name));
        }
      } else visit(child);
    }
  };
  visit(dir);
  return found;
};

// Fail-closed gate: every skill snapshot is scanned before anything lands on disk (or, in
// layer mode, before the layer goes live). Each scan's report is buffered and printed as one
// block, so parallel scans never interleave lines; any non-zero exit — findings (1) or a
// scanner error (2) — refuses the whole run with a non-zero exit, and the refusal names the
// skill folder on its own line so the tail of a deploy log shows it. A scan costs ~15 s per
// skill, which made a 57-skill deploy seed wait ~14 minutes even when one file changed, so
// the gate re-scans only what changed: it hashes the exact bytes of each skill folder itself
// (never a hash the data repo ships — .skill-lock.json is data, not proof), keys a verdict on
// that hash plus the scanner build (pin and probed version) and the scan arguments, and runs
// the remaining scans concurrently, at most min(8, availableParallelism()) at a time. Only
// passes are recorded, in the target home's .alate/skillspector-pass.json (temp file, then
// atomic rename): a rejection is never cached, and a changed skill, a changed scanner, or an
// unreadable cache file always means a full rescan. A lost update between two installs that
// share a home only costs a rescan.
const SCAN_ARGS = ['--no-llm', '--fail-on-findings', '--use-shipped-baseline'];
const scanCachePath = join(home, '.alate', 'skillspector-pass.json');

const hashSkillDir = dir => {
  const hash = createHash('sha256');
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(path, entry.name);
      const rel = relative(dir, child);
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        visit(child);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${rel}\0${readlinkSync(child)}\0`);
      } else {
        hash.update(`f\0${rel}\0`);
        hash.update(readFileSync(child));
      }
    }
  };
  visit(dir);
  return hash.digest('hex');
};

// A missing file is just the first run; unreadable or malformed means prove nothing: scan
// everything and rewrite the file fresh.
const readPasses = () => {
  let raw = null;
  try {
    raw = readFileSync(scanCachePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`${scanCachePath} is unreadable (${err.code ?? err.message}); scanning every skill snapshot.`);
    return {};
  }
  try {
    const passes = JSON.parse(raw);
    if (passes && typeof passes === 'object' && !Array.isArray(passes)) return passes;
  } catch { /* malformed */ }
  console.log(`${scanCachePath} is malformed; scanning every skill snapshot.`);
  return {};
};

const recordPass = passes => {
  mkdirSync(dirname(scanCachePath), { recursive: true });
  const tmp = `${scanCachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(passes, null, 2)}\n`);
    renameSync(tmp, scanCachePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
};

// The pinned build's verdict for these exact bytes, printed as one block so a tail of the
// output always shows a whole report.
const scanOne = (scanner, dir, total) => new Promise((resolve, reject) => {
  const child = spawn(scanner, ['scan', dir, ...SCAN_ARGS], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], errOut = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => errOut.push(chunk));
  child.on('error', err => reject(new Error(`skillspector could not run (${err.code ?? err.message}); refusing to install ${total} skill snapshot(s).`)));
  child.on('close', (code, signal) => {
    const report = `${Buffer.concat(out).toString('utf8')}${Buffer.concat(errOut).toString('utf8')}`.trimEnd();
    console.log(`--- SkillSpector report: ${dir}${report ? `\n${report}` : ''}`);
    if (code === 0) resolve();
    else reject(new Error(`SkillSpector rejected ${dir} (exit ${code ?? `signal ${signal}`}); nothing was installed. Review the report above, then fix or drop the skill in the data repo.`));
  });
});

const runScan = async skillDirs => {
  // The pin is enforced, not just documented: v2 baseline fingerprints bind to scanner_version,
  // so a scanner that is not the pinned build silently suppresses nothing and every accepted
  // finding resurfaces as a fresh rejection (the 2026-10-31 Windows host failure). Prefer the
  // pinned venv (same layout and SKILLSPECTOR_VENV override as the data repo's
  // .githooks/skillspector-scan.sh), fall back to PATH only when its version matches the pin.
  const venvBin = join(
    process.env.SKILLSPECTOR_VENV ?? join(homedir(), '.cache', 'skillspector-venv'),
    process.platform === 'win32' ? join('Scripts', 'skillspector.exe') : join('bin', 'skillspector'),
  );
  const pinnedVersion = `SkillSpector v${SKILLSPECTOR_REF.slice(1)}`;
  let scanner = null;
  let reported = null;
  for (const candidate of [venvBin, 'skillspector']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') continue;
    if (probe.error) {
      throw new Error(`skillspector could not run (${probe.error.code ?? probe.error.message}); refusing to install ${skillDirs.length} skill snapshot(s).`);
    }
    reported = String(probe.stdout ?? '').trim();
    // A candidate that cannot answer the probe is broken, not wrong: a Python upgrade leaves
    // the venv's packages in lib/python3.x while bin/python3 points at the new interpreter,
    // so its entry point dies before printing a version (the 2026-11-01 ottr-alate-1 failure
    // that stopped every provision). Skip it and let the next candidate serve. A candidate
    // that runs and reports a version is held to the pin.
    if (probe.status !== 0 || !reported) continue;
    if (reported !== pinnedVersion) {
      throw new Error(`skillspector is ${reported}, not the pinned ${pinnedVersion}; baseline fingerprints bind to the scanner version, so this build would suppress nothing and every accepted finding would resurface. Install the pinned build, then retry: pip install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}"`);
    }
    scanner = candidate;
    break;
  }
  if (!scanner) {
    const venvRoot = join(venvBin, '..', '..');
    throw new Error(`skillspector not found; refusing to install ${skillDirs.length} skill snapshot(s). The venv at ${venvRoot} is broken (a Python upgrade makes an old venv unusable) or missing: rebuild it with rm -rf "${venvRoot}" && python3 -m venv "${venvRoot}" && "${join(venvRoot, 'bin', 'pip')}" install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}", or install the pinned build (Python 3.12+), then retry: pip install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}"`);
  }
  const passes = readPasses();
  const keys = new Map(skillDirs.map(dir => [dir, `${hashSkillDir(dir)} ${SKILLSPECTOR_REF} ${reported} scan ${SCAN_ARGS.join(' ')}`]));
  const pending = skillDirs.filter(dir => passes[keys.get(dir)] !== true);
  console.log(`Scanning ${pending.length} of ${skillDirs.length} skill snapshot(s) (${skillDirs.length - pending.length} cached) with SkillSpector ${SKILLSPECTOR_REF} at ${scanner} (--no-llm, static only, shipped baselines applied)...`);
  if (!pending.length) return;
  // One rejection or scanner error stops the install (nothing is written past this gate):
  // stop scheduling, let the in-flight scans finish, then refuse with the first failure.
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (!failures.length && next < pending.length) {
      const dir = pending[next++];
      try {
        await scanOne(scanner, dir, skillDirs.length);
        passes[keys.get(dir)] = true;
        recordPass(passes);
      } catch (err) {
        if (!failures.length) failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism(), pending.length) }, worker));
  if (failures.length) {
    // Stdout too: the deploy log's tail must end on the line naming the rejected skill.
    console.log(failures[0].message);
    throw failures[0];
  }
};

const validateTools = (bytes, path) => {
  let list;
  try {
    list = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${path}: tools.json is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(list)) throw new Error(`${path}: tools.json must be a JSON array of downloads`);
  const seen = new Set();
  list.forEach((entry, i) => {
    const at = `${path}: tools.json entry ${i + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${at}: must be a JSON object`);
    const keys = Object.keys(entry);
    const unknown = keys.find(k => !['name', 'url', 'sha256', 'unpack', 'bin'].includes(k));
    if (unknown !== undefined) throw new Error(`${at}: unknown key "${unknown}" (downloads are declarative: name, url, sha256, unpack, bin)`);
    for (const key of ['name', 'url', 'sha256', 'unpack']) {
      if (!keys.includes(key)) throw new Error(`${at}: missing key "${key}"`);
    }
    if (!UNPACK.has(entry.unpack)) throw new Error(`${at}: "unpack" must be one of: zip, tar.gz, none`);
    if (entry.unpack === 'none') {
      if ('bin' in entry) throw new Error(`${at}: "bin" must be absent when unpack is none`);
    } else if (!keys.includes('bin')) {
      throw new Error(`${at}: missing key "bin" (required unless unpack is none)`);
    }
    if (typeof entry.name !== 'string' || !TOOL_NAME.test(entry.name)) throw new Error(`${at}: "name" must match ${TOOL_NAME.source}`);
    if (seen.has(entry.name)) throw new Error(`${at}: duplicate name "${entry.name}"`);
    seen.add(entry.name);
    if (typeof entry.url !== 'string' || !entry.url.startsWith('https://')) throw new Error(`${at}: "url" must start with https://`);
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) throw new Error(`${at}: "sha256" must be 64 lowercase hex characters`);
    if ('bin' in entry && (typeof entry.bin !== 'string' || entry.bin.split('/').some(s => s === '.' || s === '..' || !BIN_SEGMENT.test(s)))) {
      throw new Error(`${at}: "bin" must be a relative archive path whose segments are letters, digits, dot, underscore or dash, without ".."`);
    }
  });
};

const validateEnv = (bytes, path) => {
  // Names only, never values: a broken line is reported by number, its content is never printed.
  bytes.toString('utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (!ENV_NAME.test(line)) throw new Error(`${path}: env.txt line ${i + 1}: a name must match ${ENV_NAME.source} (names only, never values)`);
  });
};

const REQ_LINE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([A-Za-z0-9][A-Za-z0-9.+_!-]*)((?: --hash=sha256:[0-9a-f]{64})+)$/;
const validateRequirements = (bytes, path) => {
  // Reference grammar is ottr's parseRequirements (src/python.ts); the two must stay in sync.
  // A broken line is reported by number, its content is never printed.
  const seen = new Set();
  bytes.toString('utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const m = REQ_LINE.exec(line);
    if (!m) throw new Error(`${path}: requirements.txt line ${i + 1}: not a pinned, hashed line (name==version --hash=sha256:<64 hex>)`);
    const name = m[1].toLowerCase();
    if (seen.has(name)) throw new Error(`${path}: requirements.txt line ${i + 1}: duplicate package "${name}"`);
    seen.add(name);
  });
};

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

  const base = join(home, '.alate');
  const currentLink = join(base, 'current');
  const layersDir = join(base, 'layers');
  let writeRoot = home, readRoot = home, machineRoot = home, newLayerDir = null;
  if (layerMode) {
    // Preflight before any write: current is absent or a symlink, never anything else —
    // an in-place migration of a real directory is out of scope.
    const st = lstatSync(currentLink, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) throw new Error(`refusing: ${currentLink} exists and is not a symlink; remove or migrate it by hand`);
    const gitHead = spawnSync('git', ['-C', data.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const commit = gitHead.status === 0 && /^[0-9a-f]{40,64}$/.test((gitHead.stdout ?? '').trim()) ? gitHead.stdout.trim().slice(0, 12) : 'nogit';
    newLayerDir = join(layersDir, `${commit}-${nextLayerCounter(existsSync(layersDir) ? readdirSync(layersDir) : [], commit)}`);
    writeRoot = newLayerDir;
    // Machine state lives in the live layer when there is one: the new layer reads it there,
    // a first layer (no resolvable current) reads the snapshot as a fresh home does.
    let live = null;
    try { live = realpathSync(currentLink); } catch { /* absent or dangling */ }
    readRoot = live !== null && live.startsWith(layersDir + sep) ? live : newLayerDir;
    // The machine part of config.yml comes from the live layer when there is one; on a
    // first layer over an in-place home it comes from the home itself, so the deployment
    // blocks and the entry script's machine edit survive the migration.
    machineRoot = live !== null ? live : (existsSync(join(home, '.omp', 'agent', 'config.yml')) ? home : newLayerDir);
  }

  const plan = [];
  const conflicts = [];
  const notes = [];
  // Content-gate problems for the snapshot's rules, collected during the walk and refused before any write.
  const ruleGate = [];
  // Snapshot path -> fingerprint of the content alate last installed (or found already in place).
  // The record rides in the layer it describes; the previous install's record is read through
  // the live layer.
  const manifest = join(writeRoot, '.alate', 'installed.json');
  checkDestination(writeRoot, manifest);
  const lastManifest = join(readRoot, '.alate', 'installed.json');
  let last = {};
  if (existsSync(lastManifest)) {
    try {
      last = JSON.parse(readFileSync(lastManifest, 'utf8'));
    } catch (err) {
      console.error(`Ignoring unreadable ${lastManifest} (${err.message}): every file that differs from the snapshot counts as changed here.`);
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
    const dest = join(writeRoot, '.' + rel);
    // Every destination is preflighted before any content is read or written, so a
    // symlink, hardlink, or directory at dest refuses the whole restore up front —
    // --force overrides the conflict refusal, never this alias guard.
    checkDestination(writeRoot, dest);
    const machineSrc = layerMode && rel === 'omp/agent/config.yml' ? machineRoot : readRoot;
    const readDest = join(machineSrc, '.' + rel);
    // forTarget roots a captured absolute path at the real home; in layer mode the remap
    // below alone moves it into the layer — writeRoot here would put the layer prefix in twice.
    const target = forTarget(rel, readFileSync(srcPath), { home, platform: process.platform, roots });
    notes.push(...target.notes);
    // Captured config can point at absolute paths in the capture home; a layer re-roots them
    // so a turn pinned to the layer resolves files under its own path.
    let snapshot = target.bytes;
    // The memory backend is a deployment choice the board injects at spawn (--config overlay),
    // never snapshot content: capture strips it, and a snapshot captured by an older alate
    // loses the entry here, so the provisioned config.yml never carries the choice.
    if (rel === 'omp/agent/config.yml') snapshot = Buffer.from(withoutMemoryBackend(snapshot.toString('utf8')), 'utf8');
    if (layerMode && /\.(?:json|ya?ml)$/.test(rel)) snapshot = Buffer.from(remapHomePaths(snapshot.toString('utf8'), home, newLayerDir), 'utf8');
    // config.yml's top-level hindsight:/alate: blocks are deployment settings that stay on the
    // target: the snapshot never carries them (capture strips them), and the machine's own ride
    // along on every install. In layer mode they come from the live layer's config, the fresh
    // one has none yet. Compare deployment-free content, so a target that differs only in
    // those blocks is unchanged and a real conflict cannot hide behind them. `dropped` holds
    // credentials: never log it.
    const machineYaml = rel === 'omp/agent/config.yml' && existsSync(readDest)
      ? readFileSync(readDest).toString('utf8') : null;
    const deployed = machineYaml === null ? null : splitDeploymentBlocks(machineYaml);
    const want = fingerprint(rel, snapshot);
    let src = snapshot;
    if (deployed?.dropped.length) {
      const base = splitDeploymentBlocks(snapshot.toString('utf8'));
      // The snapshot's own terminator already separates it from the appended blocks; a
      // snapshot that does not end in a newline still gets the blocks on a new line.
      const kept = base.kept[base.kept.length - 1] === '' ? base.kept.slice(0, -1) : base.kept;
      src = Buffer.from([...kept, ...deployed.dropped].join('\n'), 'utf8');
    }
    // Rules restored through user/ land in the live agent rules dir, so every Markdown there
    // passes the same content gate sync.mjs applies to data-root rules: hidden characters
    // that smuggle instructions past human review ("Rules File Backdoor"), plus a frontmatter
    // description. omp loads agent-context Markdown elsewhere in the snapshot as always-on
    // instructions too (AGENTS.md, RULES.md, SYSTEM.md, CLAUDE.md), so every .md/.mdc gets the
    // hidden-character scan; only the snapshot's own rules dir is a rule and needs the frontmatter.
    if (/\.(md|mdc)$/.test(rel)) ruleGate.push(...ruleProblems(`user/${rel}`, src.toString('utf8'), { frontmatter: /^omp\/agent\/rules\/[^/]+\.mdc?$/.test(rel) }));
    // The machine text minus its deployment blocks (lib/data.mjs keeps the last kept line's
    // terminator). `dropped` holds credentials: never log it.
    const have = machineFingerprint(rel, readDest);
    if (have === want && !layerMode) plan.push(['unchanged', dest, null]);
    else if (layerMode && have === want) plan.push(['installed', dest, src]);
    else if (layerMode && have !== null && have !== last[rel]) {
      // A machine change beyond the deployment blocks is never a refusal in layer mode:
      // machine state wins and rides into the new layer, --force takes the snapshot instead.
      // have !== want is implied by the branch above; layer mode never reaches conflicts.
      if (force) {
        plan.push(['installed', dest, src]);
        notes.push(`machine change overridden by --force: ${readDest}`);
      } else {
        // A kept file can hold paths re-rooted into the live layer at its install, so they
        // re-root into the new layer and clean-up can delete the live one; paths into the
        // shared home stay shared.
        let keptBytes = readFileSync(readDest);
        if (/\.(?:json|ya?ml)$/.test(rel)) keptBytes = Buffer.from(remapHomePaths(keptBytes.toString('utf8'), machineSrc, newLayerDir), 'utf8');
        plan.push(['installed', dest, keptBytes]);
        notes.push(`machine change kept: ${readDest} (--force takes the snapshot)`);
      }
    }
    else if (have === null || have === last[rel] || force) plan.push(['installed', dest, src]);
    else conflicts.push(dest);
    current[rel] = want;
  }
  if (ruleGate.length) {
    throw new Error(`Nothing installed. Fix:\n  ${ruleGate.join('\n  ')}`);
  }
  const workersRoot = join(data.dir, 'workers');
  const shipped = new Set();
  if (existsSync(workersRoot)) {
    assertSourceInside(data.dir, workersRoot);
    for (const project of readdirSync(workersRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
      for (const file of WORKER_FILES) {
        const srcPath = join(workersRoot, project, file);
        if (!existsSync(srcPath)) continue;
        assertSourceInside(workersRoot, srcPath);
        const src = readFileSync(srcPath);
        if (file === 'tools.json') validateTools(src, srcPath);
        else if (file === 'env.txt') validateEnv(src, srcPath);
        else if (file === 'requirements.txt') validateRequirements(src, srcPath);
        shipped.add(`${project}/${file}`);
        const dest = join(writeRoot, '.ottr', 'workers', project, file);
        checkDestination(writeRoot, dest);
        plan.push(existsSync(dest) && sameContent('', readFileSync(dest), src) ? ['unchanged', dest, null] : ['installed', dest, src]);
      }
    }
  }
  // A path the snapshot dropped: delete the machine copy when it still holds what alate last
  // installed (nobody changed it since), keep it with a note when it changed here, and drop
  // the record either way — alate no longer vouches for a path the snapshot lacks. --force
  // never deletes: a file that does not match its record is never deleted. A fresh layer
  // never carries dropped paths, so layer mode collects nothing here.
  const deletions = [];
  if (!layerMode) for (const [rel, fp] of Object.entries(last)) {
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
  if (!layerMode && existsSync(join(homeWorkers, 'workers'))) {
    for (const project of readdirSync(join(homeWorkers, 'workers'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
      for (const file of WORKER_FILES) {
        if (shipped.has(`${project}/${file}`)) continue;
        const dest = join(homeWorkers, 'workers', project, file);
        checkDestination(home, dest);
        if (existsSync(dest)) deletions.push([dest, homeWorkers]);
      }
    }
  }
  if (conflicts.length && !force) {
    throw new Error(`Refusing to overwrite files that hold neither the snapshot nor what alate last installed here (machine state wins: commit the change to the data repo, or --force overrides):\n  ${conflicts.join('\n  ')}`);
  }

  // Fail-closed gate: every directory named skills/ or managed-skills/ in the snapshot
  // holds executable agent content, so each skill in it is scanned before any write, deletion,
  // or record update below (layer mode scans the installed layer after the writes, before the
  // switch). Skills already recorded as unchanged are scanned again too: a copy a pre-gate
  // alate installed was never scanned, and the manifest cannot prove it was.
  const skillDirs = collectSkillDirs(userRoot);
  if (!layerMode && skillDirs.length) await runScan(skillDirs);

  // Layer mode: everything from here to the switch is disposable. Any failure before the
  // rename deletes the fresh layer and leaves current — and with it every running turn —
  // untouched; the switch itself is one atomic rename.
  let switched = false;
  let tmpLink = null;
  try {
    if (layerMode) {
      // The layer dir exists only after every content gate passed (rule gate, worker validation).
      mkdirSync(newLayerDir, { recursive: true });
      // The data-root rules install straight into the layer, through the same sync.mjs and its
      // fail-closed gates the server-side provision uses.
      const toolDir = dirname(fileURLToPath(import.meta.url));
      const rules = spawnSync(process.execPath, [join(toolDir, 'sync.mjs'), join(newLayerDir, '.omp', 'agent', 'rules'), '--data', data.dir], { encoding: 'utf8' });
      if (rules.error || rules.status !== 0) throw new Error(`rules install failed:\n${rules.stderr || rules.stdout}`);
      if (rules.stdout) console.log(rules.stdout);
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
    console.log(`${installed} installed, ${unchanged} unchanged, ${deleted} deleted in ${writeRoot}`);
    for (const note of notes) console.log(note);

    if (layerMode) {
      const layerSkillDirs = collectSkillDirs(newLayerDir);
      if (layerSkillDirs.length) await runScan(layerSkillDirs);
    }

    if (!skipPlugins && existsSync(join(userRoot, 'omp', 'plugins', 'package.json'))) {
      const pluginsDir = join(writeRoot, '.omp', 'plugins');
      const bun = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: pluginsDir, stdio: 'inherit' });
      if (bun.error || bun.status !== 0) {
        throw new Error(bun.error?.code === 'ENOENT' ? 'bun not found; cannot install plugins.' : `bun install failed in ${pluginsDir}`);
      }
    } else if (skipPlugins) {
      console.log('plugins skipped');
    }

    if (layerMode) {
      // Shared state stays in the home: each new layer links back to it, so a turn that runs
      // with HOME=<layer> reads and writes the same state as an in-place install. A path the
      // snapshot itself ships is left as snapshot content, so an allowlist change cannot
      // silently drop shared state.
      const fileLinks = ['.omp/agent/agent.db', '.gitconfig', '.pi/agent/optimizer.json'];
      const dirLinks = ['.omp/oauth', '.omp/sessions', '.omp/agent/sessions', '.omp/agent/memories', '.omp/memories', '.config', '.cache', '.bun'];
      for (const rel of [...fileLinks, ...dirLinks]) {
        if (lstatSync(join(newLayerDir, rel), { throwIfNoEntry: false })) {
          console.log('layer keeps snapshot content: ' + rel);
          continue;
        }
        const target = join(home, rel);
        mkdirSync(dirname(target), { recursive: true });
        if (dirLinks.includes(rel)) mkdirSync(target, { recursive: true });
        mkdirSync(dirname(join(newLayerDir, rel)), { recursive: true });
        symlinkSync(target, join(newLayerDir, rel));
      }
      // A reader of current sees the old or the new target, never a gap: rename() over the
      // symlink is atomic.
      let previousTarget = null;
      try { previousTarget = realpathSync(currentLink); } catch { /* first layer: nothing before it */ }
      tmpLink = join(base, `.current-${process.pid}-${Date.now()}.tmp`);
      symlinkSync(newLayerDir, tmpLink);
      renameSync(tmpLink, currentLink);
      switched = true;
      console.log(`switched ${currentLink} -> ${newLayerDir}`);
      // Clean-up keeps the live layer, the one before it, the new one, and anything a pinned
      // turn holds (in-use.json; absent means no runner has pinned a layer yet). An unreadable
      // record stops deletion: safety over disk space.
      const keep = new Set([newLayerDir]);
      try { keep.add(realpathSync(currentLink)); } catch { /* dangling: kept via newLayerDir */ }
      if (previousTarget) keep.add(previousTarget);
      const inUsePath = join(base, 'in-use.json');
      let inUse = null;
      let stopCleanup = false;
      if (existsSync(inUsePath)) {
        try { inUse = JSON.parse(readFileSync(inUsePath, 'utf8')); }
        catch { console.log('in-use.json unreadable; keeping every layer'); stopCleanup = true; }
      }
      if (inUse) for (const id of inUse.layers ?? []) keep.add(join(layersDir, id));
      if (!stopCleanup) for (const name of readdirSync(layersDir)) {
        if (!/^(?:[0-9a-f]{12}|nogit)-\d+$/.test(name) || keep.has(join(layersDir, name))) continue;
        rmSync(join(layersDir, name), { recursive: true });
        console.log(`deleted layer ${name}`);
      }
    }
  } catch (err) {
    // A layer that never went live must not survive its own failed install.
    if (layerMode && !switched) rmSync(newLayerDir, { recursive: true, force: true });
    if (tmpLink) rmSync(tmpLink, { force: true });
    throw err;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1; // not process.exit: finally below must still remove a cloned temp dir
} finally {
  cleanupData(data);
}
