#!/usr/bin/env node
// Restores the data repo's captured user/ layer onto a machine: the inverse of sync-user.mjs.
// Usage: node install-user.mjs [--home <dir>] [--force] [--skip-plugins] [--layer] [--commit <sha>] [--data <dir>|--repo <owner/name[@ref]>]
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
// Provision is per item (specs/provision-item-by-item.md): a skill or Markdown file that fails
// a content or scan gate, or a snapshot item with no recorded origin in upstreams.json, is left
// out and reported while every item that passed still installs. Global refusals stay
// all-or-nothing: a broken gate itself (missing or wrong-version scanner, a scanner that
// cannot run, invalid worker list, unreadable or structurally broken upstreams.json,
// machine-changed copies) refuses the whole run. When ALATE_PROVISION_RESULTS holds an absolute path, one JSON file with the
// per-item results is written there at the end of every run (success, item failures, and
// refusals); failed items are also printed as one stdout block at the end.
// JSON config is adapted to the target machine first (forTarget, lib/data.mjs): a Windows capture
// on a non-Windows machine, a POSIX-absolute capture path on Windows.
// Plugins install from the captured lockfile with `bun install --frozen-lockfile` in ~/.omp/plugins, the
// same root omp's plugin manager installs into. The install runs with --ignore-scripts unless the data
// repo opts in with a plugins-allow-scripts marker at its root, and with an allowlisted environment, so
// server secrets never reach bun or a lifecycle script. Packages install with bun's copyfile
// backend, so the provisioner never creates a hard link into the snapshot tree. In layer mode a
// machine change to the plugins install files (package.json, bun.lock, patches/) never rides into
// the new layer: the snapshot wins.
// Also installs the per-project worker additions Ottr's turns read: workers/<project>/apt.txt
// (Debian packages), tools.json (declarative downloads), env.txt (env names, never values) and
// requirements.txt (pinned, hashed Python packages)
// -> ~/.ottr/workers/<project>/<file>; workers/_all/ is provisioned like a project. The data
// repo is their only source, so a changed list replaces the machine copy without --force, and a
// list it no longer ships is deleted. tools.json, env.txt and requirements.txt are validated before any write.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, availableParallelism } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertSourceInside, checkDestination, cleanupData, describeProblem, describeScanReport, fingerprint, forTarget, nextLayerCounter, originGate, parseArgs, PROVISION_ENV, remapHomePaths, resolveDataDir, ruleProblems, sameContent, skillProblems, splitDeploymentBlocks, withoutDeploymentBlocks, withoutMemoryBackend, writeProvisionResults } from './lib/data.mjs';

const args = parseArgs(process.argv.slice(2), ['--data', '--repo', '--home', '--commit'], ['--force', '--skip-plugins', '--layer']);
// The imported commit names the layer id in layer mode: the server passes it for a repo
// source (specs/agent-layer-switch.md). Exactly 40 hex is a git SHA-1, exactly 64 a
// SHA-256 repository; anything between is malformed and refuses the run.
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const home = args.values['--home'] ?? homedir();
const force = args.flags.has('--force');
const skipPlugins = args.flags.has('--skip-plugins');
const layerMode = args.flags.has('--layer') || process.env.ALATE_LAYER === '1';
// Layer mode canonicalizes the home once, through the longest existing prefix, so a fresh
// (not yet created) home still resolves. A --home given relative or through a symlink must
// behave exactly like the path it resolves to: clean-up compares realpath(current) values
// against join(layersDir, name), the switch and shared-state links must carry absolute
// targets, and the home remap re-roots captured paths by the home prefix. A non-canonical
// home broke all three: clean-up deleted the layer current pointed at, machine state was
// read from the fresh layer, and a relative home left current dangling. Non-layer mode
// keeps the home exactly as given.
const resolveHome = given => {
  let prefix = resolve(given);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(prefix), ...tail);
    } catch (err) {
      if ((err.code !== 'ENOENT' && err.code !== 'ENOTDIR') || dirname(prefix) === prefix) throw err;
      tail.unshift(basename(prefix));
      prefix = dirname(prefix);
    }
  }
};
const layerHome = layerMode ? resolveHome(home) : home;
// The scanner trust gate anchors on the canonical home: a --home given through a symlink
// must measure containment like the path it resolves to (same invariant as layerHome),
// or a venv planted in the real home passes as "outside".
const trustHome = resolveHome(home);
const data = resolveDataDir(args, { allowClone: true });
const userRoot = join(data.dir, 'user');
// Lifecycle scripts are off unless the data repo opts in: a `plugins-allow-scripts` marker
// file at the data repo root (never under user/, so it never installs into the home) turns
// bun's --ignore-scripts off. The install environment is an allowlist either way, so the
// server's secrets (ALATE_API_KEY, tokens) never reach bun or a script it runs.
const allowPluginScripts = existsSync(join(data.dir, 'plugins-allow-scripts'));
const BUN_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
// Snapshot items the provisioner itself executes or feeds to its own bun install: the
// plugins manifest drives the install, bun.lock pins it, patches/ hold applied patches.
// A turn-edited copy in the live layer is untrusted content, so layer mode never keeps
// its bytes: the snapshot always wins, --force or not.
const pluginInstallFile = rel =>
  rel === 'omp/plugins/package.json' || rel === 'omp/plugins/bun.lock' || rel.startsWith('omp/plugins/patches/');
// A skill snapshot is executable agent content, so install-user scans each one statically before
// anything lands in the home (or, in layer mode, before the layer goes live): findings and
// scan errors reject that one skill (left out, reported), while a missing scanner or a scanner
// that cannot run refuse the whole restore before the first write. The scan applies the snapshot's own shipped
// `.skillspector-baseline.yaml` — its accepted findings are review records committed to the data
// repo, the same file the data repo's pre-push gate accepts. The upstream build is
// pinned to a tag on purpose:
// never point this at a moving ref. It needs Python 3.12+ where install-user runs:
//   pip install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@v2.13.0"
// Scanner resolution is a trust contract (specs/skillspector-scanner-trust.md): the home
// volume is shared with worker agent turns, so a candidate that lives inside the home (or a
// venv inside it, or one not owned by root) is never executed — not even for a --version
// probe. SKILLSPECTOR_BIN wins when set: it must be an absolute path outside the target
// home, otherwise the run refuses. Next the pinned venv (SKILLSPECTOR_VENV, default
// ~/.cache/skillspector-venv, the same layout the data repo's .githooks/skillspector-scan.sh
// bootstraps) is probed only when it exists, is root-owned on POSIX, and sits outside the
// home; then PATH. The version is verified before any verdict is trusted: baseline
// fingerprints bind to scanner_version, so a scanner that is not the pin would silently
// suppress nothing.
const SKILLSPECTOR_REF = 'v2.13.0';
const SKILL_ROOT_NAMES = new Set(['skills', 'managed-skills']);

// Spawned children get allowlisted environments: ALATE_API_KEY and every other server
// secret never crosses a spawn boundary (specs/skillspector-scanner-trust.md, contract 5).
// Scanner children additionally force PYTHONNOUSERSITE=1 (scannerEnv); it is never passed
// through from the parent, so it is not in this allowlist.
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT'];
const childEnv = extra => {
  const env = {};
  for (const key of [...CHILD_ENV_KEYS, ...(extra ?? [])]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

// Python loads user site-packages from HOME (in the container the shared home volume) and
// executes .pth files and usercustomize.py there at interpreter start, so the scanner child
// always forces PYTHONNOUSERSITE=1 — probe included, because a planted .pth runs at probe
// time too (specs/skillspector-scanner-trust.md, contract 7). Never passed through from the
// parent.
const scannerEnv = () => ({ ...childEnv(), PYTHONNOUSERSITE: '1' });

// True when the path (realpath when it exists, else itself, resolved) lies inside the
// canonical target home install-user writes into. A scanner inside that home is
// agent-turn-writable, so it is never executed — not even for a --version probe.
const insideHome = path => {
  const real = (() => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  })();
  const rel = relative(trustHome, resolve(real));
  return rel === '' || !rel.startsWith(`..${sep}`);
};

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
// block, so parallel scans never interleave lines. Exit 1 (findings) rejects that one skill:
// it is left out of the install and reported. Any other scan failure of one skill folder
// (another non-zero exit, a signal kill — for example an unparseable baseline file) rejects
// that skill too, with rule `scan error` and the scanner output as the report. A spawn error
// means the scanner cannot run at all, which cannot produce verdicts, so the whole run refuses.
// A skill whose own bytes cannot be hashed is rejected as unreadable rather than scanned. A scan costs ~15 s per
// skill, which made a 57-skill deploy seed wait ~14 minutes even when one file changed, so
// the gate re-scans only what changed: it hashes the exact bytes of each skill folder itself
// (never a hash the data repo ships — .skill-lock.json is data, not proof), one framed digest
// per entry (rel\0size\0sha256 of the bytes; a symlink contributes its resolved target bytes,
// the bytes the install copies), and keys a verdict on a format token, that hash, the
// scanner build (pin and probed version) and the scan arguments; it runs
// the remaining scans concurrently, at most min(8, availableParallelism()) at a time. Only
// passes are recorded, in the target home's .alate/skillspector-pass.json (temp file, then
// atomic rename): a rejection is never cached, and a changed skill, a changed scanner, or an
// unreadable cache file always means a full rescan. A lost update between two installs that
// share a home only costs a rescan.
const SCAN_ARGS = ['--no-llm', '--fail-on-findings', '--use-shipped-baseline'];
const scanCachePath = join(home, '.alate', 'skillspector-pass.json');

// The key must bind the bytes the install copies, so each file entry is framed as
// rel\0size\0sha256(bytes): no entry's bytes can fuse into a neighbor's stream, and a
// re-split of one stream into two files cannot reproduce the key. A symlink hashes its
// resolved target bytes (readFileSync follows the link) — the exact bytes the install walk
// copies — never the link text. The format token prefixed to every key makes entries an
// older alate wrote miss once and rescan instead of surviving a framing change.
const SCAN_CACHE_FORMAT = 'skill-pass-fmt-2';
const hashSkillDir = dir => {
  const hash = createHash('sha256');
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(path, entry.name);
      const rel = relative(dir, child);
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        visit(child);
      } else {
        // A symlink hashes the bytes its target resolves to, exactly what the install walk
        // copies; the link text proves nothing. An unreadable entry throws and refuses the
        // install, fail-closed like the gate itself.
        const bytes = readFileSync(child);
        hash.update(`f\0${rel}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\0`);
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
// output always shows a whole report. Exit 0 resolves clean, exit 1 resolves with the findings
// report (a per-skill rejection); any other exit or a signal kill resolves as a scan error —
// also a per-skill rejection, carrying the failure line and the scanner output. Only a spawn
// error rejects: the scanner cannot run at all, which the caller turns into a whole-run refusal.
const scanOne = (scanner, dir, total) => new Promise((resolve, reject) => {
  const child = spawn(scanner, ['scan', dir, ...SCAN_ARGS], { stdio: ['ignore', 'pipe', 'pipe'], env: scannerEnv() });
  const out = [], errOut = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => errOut.push(chunk));
  child.on('error', err => reject(new Error(`skillspector could not run (${err.code ?? err.message}); refusing to install ${total} skill snapshot(s).`)));
  child.on('close', (code, signal) => {
    const report = `${Buffer.concat(out).toString('utf8')}${Buffer.concat(errOut).toString('utf8')}`.trimEnd();
    console.log(`--- SkillSpector report: ${dir}${report ? `\n${report}` : ''}`);
    if (code === 0) resolve({ report: null });
    else if (code === 1) resolve({ report });
    else resolve({ report, scanError: `SkillSpector scan of ${dir} failed (exit ${code ?? `signal ${signal}`}).` });
  });
});

const runScan = async skillDirs => {
  // Trust first, probe second (specs/skillspector-scanner-trust.md): no candidate runs
  // before its trust check. SKILLSPECTOR_BIN wins when set and is hard-validated — absolute
  // and outside the target home — with no fallback. Then the pinned venv (same layout and
  // SKILLSPECTOR_VENV override as the data repo's .githooks/skillspector-scan.sh), which
  // serves only when it is root-owned on POSIX and outside the home. Then PATH. The pin is
  // enforced, not just documented: v2 baseline fingerprints bind to scanner_version, so a
  // scanner that is not the pinned build silently suppresses nothing and every accepted
  // finding resurfaces as a fresh rejection (the 2026-10-31 Windows host failure). Both
  // scanner spawns (probe and scan) force PYTHONNOUSERSITE=1 so Python never loads user
  // site-packages from the home (contract 7).
  const venvBin = join(
    process.env.SKILLSPECTOR_VENV ?? join(homedir(), '.cache', 'skillspector-venv'),
    process.platform === 'win32' ? join('Scripts', 'skillspector.exe') : join('bin', 'skillspector'),
  );
  const pinnedVersion = `SkillSpector v${SKILLSPECTOR_REF.slice(1)}`;
  const candidates = [];
  const refusals = [];
  if (process.env.SKILLSPECTOR_BIN !== undefined && process.env.SKILLSPECTOR_BIN !== '') {
    const bin = process.env.SKILLSPECTOR_BIN;
    if (!isAbsolute(bin)) {
      throw new Error(`SKILLSPECTOR_BIN must be an absolute path (got "${bin}"); point it at an absolute scanner outside the home install-user writes into (${trustHome}).`);
    }
    if (insideHome(bin)) {
      throw new Error(`SKILLSPECTOR_BIN points inside the home install-user writes into (${trustHome}): "${bin}". A scanner in that home is agent-turn-writable, so it is never executed. Point SKILLSPECTOR_BIN at an absolute scanner outside that home.`);
    }
    candidates.push(bin);
  }
  if (existsSync(venvBin)) {
    const st = statSync(venvBin);
    const reasons = [];
    if (process.platform !== 'win32' && st.uid !== 0) reasons.push('not owned by root');
    if (insideHome(venvBin)) reasons.push(`inside the home install-user writes into (${trustHome})`);
    if (reasons.length) {
      console.log(`skipping venv scanner at ${venvBin}: ${reasons.join(', ')}`);
      refusals.push(`venv scanner at ${venvBin}: ${reasons.join(', ')}`);
    } else {
      candidates.push(venvBin);
    }
  } else {
    refusals.push(`venv scanner at ${venvBin} is missing`);
  }
  candidates.push('skillspector');
  let scanner = null;
  let reported = null;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', env: scannerEnv() });
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
    const refused = refusals.length ? ` No trusted candidate served the scan:\n${refusals.map(r => `- ${r}`).join('\n')}.` : '';
    throw new Error(`skillspector not found; refusing to install ${skillDirs.length} skill snapshot(s).${refused} Remediation: set SKILLSPECTOR_BIN to an absolute scanner outside the home install-user writes into (${trustHome}), point SKILLSPECTOR_VENV at a root-owned venv outside that home, or install the pinned build (Python 3.12+) on PATH. To rebuild the venv (it must be root-owned and live outside the home): rm -rf "${venvRoot}" && python3 -m venv "${venvRoot}" && "${join(venvRoot, 'bin', 'pip')}" install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}", or install the pinned build, then retry: pip install "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}"`);
  }
  const passes = readPasses();
  // An unreadable skill dir cannot be hashed, so it cannot be keyed or cached: reject it
  // without scanning (rule `unreadable skill files`) instead of letting one bad dir stop
  // every other skill.
  const rejected = new Map();
  const keys = new Map();
  for (const dir of skillDirs) {
    try {
      keys.set(dir, `${SCAN_CACHE_FORMAT} ${hashSkillDir(dir)} ${SKILLSPECTOR_REF} ${reported} scan ${SCAN_ARGS.join(' ')}`);
    } catch (err) {
      rejected.set(dir, { rule: 'unreadable skill files', report: `${dir}: ${err.message}` });
    }
  }
  const scanList = skillDirs.filter(dir => keys.has(dir));
  const pending = scanList.filter(dir => passes[keys.get(dir)] !== true);
  console.log(`Scanning ${pending.length} of ${scanList.length} skill snapshot(s) (${scanList.length - pending.length} cached) with SkillSpector ${SKILLSPECTOR_REF} at ${scanner} (--no-llm, static only, shipped baselines applied)...`);
  if (!pending.length) return { rejected };
  // Findings (exit 1) reject their own skill only; so does any other scan failure (another
  // non-zero exit, a signal kill): the skill is left out with rule `scan error` and the scan
  // continues. Only a spawn error — the scanner cannot run at all, so no verdict is possible —
  // stops scheduling, lets the in-flight scans finish, and refuses the whole run.
  let fatal = null;
  let next = 0;
  const worker = async () => {
    while (fatal === null && next < pending.length) {
      const dir = pending[next++];
      try {
        const res = await scanOne(scanner, dir, skillDirs.length);
        if (res.report === null) {
          passes[keys.get(dir)] = true;
          recordPass(passes);
        } else if (res.scanError !== undefined) {
          rejected.set(dir, { rule: 'scan error', report: `${res.scanError}${res.report ? `\n${res.report}` : ''}` });
          // Stdout too: the deploy log's tail must name the rejected skill folder.
          console.log(`${res.scanError} The skill is left out of this install.`);
        } else {
          rejected.set(dir, { report: res.report });
          // Stdout too: the deploy log's tail must name the rejected skill folder.
          console.log(`SkillSpector rejected ${dir} (exit 1); the skill is left out of this install.`);
        }
      } catch (err) {
        fatal = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism(), pending.length) }, worker));
  if (fatal !== null) {
    // Stdout too: the deploy log's tail must end on the line naming the broken scan.
    console.log(fatal.message);
    throw fatal;
  }
  return { rejected };
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

// Per-item results (specs/provision-item-by-item.md): the gates push failed items as they
// judge them, the plan's surviving items aggregate at the end of the try, and the finally
// below writes the results file when the server asked for one. fatal/error describe a
// whole-run refusal; every pre-existing throw class stays fatal.
const items = [];
let fatal = false;
let error = null;
let nestedFailed = false;
// A failed item's report is diagnostics with a bound, like every stored report.
const capReport = report => report.length > 4000 ? `${report.slice(0, 4000)}…` : report;
const failItem = (item, status, rule, at, report) =>
  items.push({ item, status, rule: rule ?? null, at: at ?? null, ...(report == null ? {} : { report: capReport(report) }) });
// A scan rejection carries the first SkillSpector finding as rule and position; a scan-error
// rejection carries rule `scan error`; the hash-error rejection carries its own rule. `key` is
// the item key of the skill dir.
const addScanRejection = (key, info) => {
  if (info.rule !== undefined) failItem(key, 'rejected', info.rule, null, info.report);
  else {
    const d = describeScanReport(info.report);
    failItem(key, 'rejected', d.rule, d.at, info.report);
  }
};
// The item key of a skill dir: snapshot-relative under userRoot; in a fresh layer the top-level
// dir is a dot-dir (.omp), so the leading dot drops out for the snapshot spelling.
const skillKey = (root, dir) => `user/${relative(root, dir).split(sep).join('/')}`.replace(/^user\/\./, 'user/');

try {
  // A malformed --commit refuses the run before anything else, any mode: the refusal goes
  // through the standard catch (fatal results file, non-zero exit, no writes).
  if (args.values['--commit'] !== undefined && !COMMIT_RE.test(args.values['--commit'])) {
    throw new Error(`refusing: --commit must be 40 or 64 hex characters (got "${args.values['--commit']}")`);
  }
  if (!existsSync(userRoot)) {
    throw new Error(`No user/ snapshot in ${data.dir}; run sync-user.mjs first.`);
  }
  // user/ itself is not a user-chosen root: a junction here would relocate the whole
  // snapshot outside the data dir, so it is pinned to canonical data.dir before walking.
  assertSourceInside(data.dir, userRoot);
  // Check source bytes on every install, before target reads, scanner calls, or layer creation.
  const skillDirs = collectSkillDirs(userRoot);
  // Origin gate (upstreams.json): fatal problems mean the gate itself is broken, so no origin
  // verdict is possible and the run refuses. An uncovered skill dir is excluded (failed item
  // `no origin`) before the walk; an uncovered MCP server is only reported — one uncovered
  // server never disconnects the other servers on the machine. Bare keys are data-root rules,
  // which sync.mjs installs, so they are not this script's business.
  const gate = originGate(data.dir);
  if (gate.fatal.length) throw new Error(`Nothing installed. Fix:\n  ${gate.fatal.join('\n  ')}`);
  const dirByKey = new Map(skillDirs.map(dir => [`user/${relative(userRoot, dir).split(sep).join('/')}`, dir]));
  const rejectedSkills = new Set();
  for (const key of gate.uncovered) {
    const dir = dirByKey.get(key);
    if (dir) {
      failItem(key, 'no-origin', null, null, gate.hints?.[key] ?? null);
      rejectedSkills.add(dir);
    }
    else if (/^user\/omp\/agent\/mcp\.json "/.test(key)) failItem(key, 'no-origin', null, null, gate.hints?.[key] ?? null);
  }
  // Structure gate per skill: a skill with problems is rejected (failed item with the first
  // problem split into rule and position, the full report attached) and excluded, so its own
  // SKILL.md problems never gate any other skill.
  const skillEntrypoints = new Set();
  for (const dir of skillDirs) {
    const entrypoint = join(dir, 'SKILL.md');
    const label = `user/${relative(userRoot, entrypoint).split(sep).join('/')}`;
    skillEntrypoints.add(entrypoint);
    const problems = [];
    let text;
    try {
      assertSourceInside(userRoot, entrypoint);
      if (!statSync(entrypoint).isFile()) throw new Error('SKILL.md must be a regular file');
      text = readFileSync(entrypoint, 'utf8');
    } catch (err) {
      problems.push(`${label}: cannot read SKILL.md (${err.message})`);
    }
    if (text !== undefined) problems.push(...skillProblems(label, text));
    if (problems.length) {
      const first = describeProblem(problems[0]);
      failItem(`user/${relative(userRoot, dir).split(sep).join('/')}`, 'rejected', first.rule, first.at, problems.join('\n'));
      rejectedSkills.add(dir);
    }
  }
  // Skills left out by the origin or structure gate: their snapshot rels never enter the plan,
  // the manifest, or the conflicts below, so the existing deletion path removes a previously
  // installed, record-matching copy and keeps a copy that changed on the machine.
  const inRejected = (rel, dirs) => {
    for (const dir of dirs) {
      const p = relative(userRoot, dir).split(sep).join('/');
      if (rel === p || rel.startsWith(`${p}/`)) return true;
    }
    return false;
  };
  const walk = (dir, sub = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    SKIP_DIRS.has(e.name) ? []
      : e.isDirectory() ? walk(join(dir, e.name), sub ? `${sub}/${e.name}` : e.name)
      : [sub ? `${sub}/${e.name}` : e.name]);

  // Top-level snapshot dirs are dot-dirs in the home (user/omp -> ~/.omp): the layer's own paths.
  const roots = new Set(readdirSync(userRoot).map(name => '.' + name));

  const base = join(layerHome, '.alate');
  const currentLink = join(base, 'current');
  const layersDir = join(base, 'layers');
  let writeRoot = home, readRoot = home, machineRoot = home, newLayerDir = null;
  // A first layer over an in-place home: machineRoot below resolves to the home, and the
  // home's own installed.json becomes the plan's baseline (the layer manifest does not exist
  // yet), so a home file that still matches its record takes the snapshot, not a machine win.
  let migratingHome = false;
  if (layerMode) {
    // Preflight before any write: current is absent or a symlink, never anything else —
    // an in-place migration of a real directory is out of scope.
    const st = lstatSync(currentLink, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) throw new Error(`refusing: ${currentLink} exists and is not a symlink; remove or migrate it by hand`);
    // The layer id names the installed commit: --commit (the server passes the imported
    // commit of a repo source) wins; without it the data dir's git HEAD decides, and a
    // dir without git is "nogit".
    let commit;
    if (args.values['--commit'] !== undefined) {
      commit = args.values['--commit'].slice(0, 12);
    } else {
      const gitHead = spawnSync('git', ['-C', data.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: childEnv() });
      commit = gitHead.status === 0 && COMMIT_RE.test((gitHead.stdout ?? '').trim()) ? gitHead.stdout.trim().slice(0, 12) : 'nogit';
    }
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
    machineRoot = live !== null ? live : (existsSync(join(layerHome, '.omp', 'agent', 'config.yml')) ? layerHome : newLayerDir);
    migratingHome = machineRoot === layerHome;
  }

  const plan = [];
  let conflicts = [];
  const notes = [];
  // Content-gate problems for the snapshot's rules are now judged per file during the walk:
  // a failing Markdown item is rejected (failed item) and skipped, never a whole-run refusal.
  // Snapshot path -> fingerprint of the content alate last installed (or found already in place).
  // The record rides in the layer it describes; the previous install's record is read through
  // the live layer. A first layer over an in-place home has no layer record yet, so the
  // home's own record is the baseline: a home file that still matches it takes the snapshot
  // instead of freezing as a machine change.
  const manifest = join(writeRoot, '.alate', 'installed.json');
  checkDestination(writeRoot, manifest);
  const lastManifest = migratingHome ? join(layerHome, '.alate', 'installed.json') : join(readRoot, '.alate', 'installed.json');
  // Layer mode reads machine state out of the live layer, which a turn can write: it runs
  // with HOME=<live layer> on the shared home volume, so a snapshot path or this record
  // can hold a symlink, hard link, or special file whose target only the alate container
  // can read. The same alias guard the write side gets applies to every machine-side
  // read, and a violation refuses the run before any write instead of copying the
  // target's bytes into the new layer. A first layer over an in-place home reads the
  // home's own record instead of the layer's, guarded the same way against layerHome.
  // In-place mode reads only paths it already guards as dest (or writes itself), so this
  // is layer-only.
  if (layerMode) checkDestination(migratingHome ? layerHome : readRoot, lastManifest);
  let last = {};
  if (existsSync(lastManifest)) {
    try {
      last = JSON.parse(readFileSync(lastManifest, 'utf8'));
    } catch (err) {
      console.error(`Ignoring unreadable ${lastManifest} (${err.message}): every file that differs from the snapshot counts as changed here.`);
    }
  }
  // The machine file's fingerprint, the same comparison the install plan uses: config.yml's
  // deployment blocks stay on the target, so they never make a file look changed here. Layer
  // mode also compares modulo the memory backend entry (a deployment choice, above): a home
  // config.yml that differs from the snapshot or its record only by the entry is not a
  // machine change. In-place mode keeps the entry in the comparison, so a file that differs
  // by the entry still refuses and --force still rewrites the entry away.
  const machineFingerprint = (rel, dest) => {
    if (!existsSync(dest)) return null;
    const machineYaml = rel === 'omp/agent/config.yml' ? readFileSync(dest).toString('utf8') : null;
    let base = machineYaml === null ? null : withoutDeploymentBlocks(machineYaml);
    if (base !== null && layerMode) base = withoutMemoryBackend(base);
    return fingerprint(rel, base === null ? readFileSync(dest) : Buffer.from(base, 'utf8'));
  };
  // The record an alate older than the memory-backend strip wrote hashes the snapshot bytes it
  // installed, and those still carried the entry. Layer mode accepts that legacy record too: a
  // home config.yml that, with only the deployment blocks stripped, still holds exactly the
  // bytes such an alate installed matches its record, so an untouched pre-strip home migrates
  // to the snapshot instead of freezing as a machine change. For a file without the entry the
  // legacy form equals the plain one, so later layers (whose records strip-era alate wrote)
  // compare identically. Only config.yml can carry the entry; other files and in-place mode
  // never use the legacy form.
  const legacyFingerprint = (rel, dest) =>
    rel === 'omp/agent/config.yml' && layerMode && existsSync(dest)
      ? fingerprint(rel, Buffer.from(withoutDeploymentBlocks(readFileSync(dest).toString('utf8')), 'utf8'))
      : null;

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
    // A skill left out by a gate contributes nothing: no plan entry, no manifest record, no
    // conflict, so its installed copy is deleted later like any path the snapshot dropped.
    if (inRejected(rel, rejectedSkills)) continue;
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
    // The machine copy is read three times below (config.yml's deployment blocks, the
    // fingerprint, the kept bytes): never follow an alias out of the live layer, or out
    // of an in-place home on a first layer. See the guard on lastManifest above.
    if (layerMode) checkDestination(machineSrc, readDest);
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
    // The remap prefix must spell the home exactly as forTarget rooted it above, so a
    // non-canonical --home still re-roots once; the layer side is canonical.
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
    // A file with problems is rejected per item: no plan entry, no manifest record, no conflict.
    if (/\.(md|mdc)$/.test(rel) && !skillEntrypoints.has(srcPath)) {
      const problems = ruleProblems(`user/${rel}`, src.toString('utf8'), { frontmatter: /^omp\/agent\/rules\/[^/]+\.mdc?$/.test(rel) });
      if (problems.length) {
        const first = describeProblem(problems[0]);
        failItem(`user/${rel}`, 'rejected', first.rule, first.at, problems.join('\n'));
        continue;
      }
    }
    // The machine text minus its deployment blocks (lib/data.mjs keeps the last kept line's
    // terminator). `dropped` holds credentials: never log it.
    const have = machineFingerprint(rel, readDest);
    // The record-match: the plain form (strip-era records, and every non-config file) or the
    // legacy form above (records a pre-strip alate wrote, entry included). A matched file was
    // not changed on the machine since the install, so the snapshot may replace it.
    const record = have !== null && (have === last[rel] || legacyFingerprint(rel, readDest) === last[rel]);
    // The item key rides on every plan entry, so the per-item results can aggregate by key.
    const itemKey = `user/${rel}`;
    if (have === want && !layerMode) plan.push(['unchanged', dest, null, itemKey]);
    else if (layerMode && have === want) plan.push(['installed', dest, src, itemKey]);
    else if (layerMode && have !== null && !record) {
      // A machine change beyond the deployment blocks is never a refusal in layer mode:
      // machine state wins and rides into the new layer, --force takes the snapshot instead.
      // have !== want is implied by the branch above; layer mode never reaches conflicts.
      // Plugin install files are the exception: the provisioner itself runs bun install
      // over them, so a turn-edited copy must never ride into the new layer. The snapshot
      // wins, --force or not; a deliberate change goes through a data-repo commit.
      if (pluginInstallFile(rel)) {
        plan.push(['installed', dest, src, itemKey]);
        notes.push(`plugin install file takes the snapshot, machine change ignored: ${readDest}`);
      }
      else if (force) {
        plan.push(['installed', dest, src, itemKey]);
        notes.push(`machine change overridden by --force: ${readDest}`);
      } else {
        // A kept file can hold paths re-rooted into the live layer at its install, so they
        // re-root into the new layer and clean-up can delete the live one; paths into the
        // shared home stay shared.
        let keptBytes = readFileSync(readDest);
        // The entry is a deployment choice: a kept config.yml loses it here, the same way the
        // snapshot does above, so the choice never rides along with the machine part.
        if (rel === 'omp/agent/config.yml') keptBytes = Buffer.from(withoutMemoryBackend(keptBytes.toString('utf8')), 'utf8');
        if (/\.(?:json|ya?ml)$/.test(rel)) keptBytes = Buffer.from(remapHomePaths(keptBytes.toString('utf8'), machineSrc, newLayerDir), 'utf8');
        plan.push(['installed', dest, keptBytes, itemKey]);
        notes.push(`machine change kept: ${readDest} (--force takes the snapshot)`);
      }
    }
    else if (have === null || record || force) plan.push(['installed', dest, src, itemKey]);
    else conflicts.push(dest);
    current[rel] = want;
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
        plan.push(existsSync(dest) && sameContent('', readFileSync(dest), src) ? ['unchanged', dest, null, `workers/${project}/${file}`] : ['installed', dest, src, `workers/${project}/${file}`]);
      }
    }
  }
  // In-place scan gate: before any write, and before the deletions are computed, so a skill
  // the scan rejects is dropped from the plan, the manifest, and the conflicts first — its
  // installed record-matching copy then flows into the deletion loop below, and its own
  // changed copy never blocks the conflicts refusal. Skills already recorded as unchanged are
  // scanned again too: a copy a pre-gate alate installed was never scanned, and the manifest
  // cannot prove it was. Layer mode scans the installed layer after the writes instead.
  if (!layerMode && skillDirs.length) {
    const scan = await runScan(skillDirs.filter(dir => !rejectedSkills.has(dir)));
    for (const [dir, info] of scan.rejected) {
      addScanRejection(skillKey(userRoot, dir), info);
      rejectedSkills.add(dir);
    }
    // Drop every rel inside a rejected skill from the plan, the manifest, and the conflicts.
    const prefixes = [...rejectedSkills].map(dir => relative(userRoot, dir).split(sep).join('/'));
    const relRejected = rel => prefixes.some(p => rel === p || rel.startsWith(`${p}/`));
    for (let i = plan.length - 1; i >= 0; i--) if (relRejected(plan[i][3].slice('user/'.length))) plan.splice(i, 1);
    for (const rel of Object.keys(current)) if (relRejected(rel)) delete current[rel];
    conflicts = conflicts.filter(dest => !prefixes.some(p => {
      const guard = join(home, `.${p}`);
      return dest === guard || dest.startsWith(`${guard}${sep}`);
    }));
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
      // per-item gates the server-side provision uses. When the server asked for per-item
      // results, sync.mjs writes its own file beside ours: its fatal refusal aborts the layer,
      // a per-item failure only merges into this run's items and marks the run failed, so the
      // good rules stay installed. Without the results env (a plain CLI layer run) a non-zero
      // sync still aborts the layer, as before.
      const toolDir = dirname(fileURLToPath(import.meta.url));
      const resultsPath = process.env[PROVISION_ENV] ? `${process.env[PROVISION_ENV]}.rules.json` : null;
      const rulesEnv = childEnv(['ALATE_TEST_SCRIPT_GATE']);
      if (resultsPath) rulesEnv[PROVISION_ENV] = resultsPath;
      const rules = spawnSync(process.execPath, [join(toolDir, 'sync.mjs'), join(newLayerDir, '.omp', 'agent', 'rules'), '--data', data.dir], { encoding: 'utf8', env: rulesEnv });
      let nested = null;
      if (resultsPath) {
        try { nested = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch { nested = null; }
      }
      if (!nested || nested.fatal === true) {
        // Unreadable results file, or the server never asked for one: the old all-or-nothing
        // contract applies.
        if (rules.error || rules.status !== 0) throw new Error(`rules install failed:\n${rules.stderr || rules.stdout}`);
      } else {
        for (const item of Array.isArray(nested.items) ? nested.items : []) items.push(item);
        if (rules.status !== 0) nestedFailed = true;
      }
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
    console.log(`${installed} installed, ${unchanged} unchanged, ${deleted} deleted in ${writeRoot}`);
    for (const note of notes) console.log(note);

    if (layerMode) {
      const layerSkillDirs = collectSkillDirs(newLayerDir);
      if (layerSkillDirs.length) {
        const scan = await runScan(layerSkillDirs);
        for (const [dir, info] of scan.rejected) {
          // The manifest must never name a file the layer lacks: the rejected skill dir is
          // removed from the fresh layer, and its rels from the record, before the switch.
          rmSync(dir, { recursive: true, force: true });
          addScanRejection(skillKey(newLayerDir, dir), info);
          // The layer mirrors the home in dot-dirs (.omp); the record keys use the snapshot
          // spelling (omp), so the leading dot drops out of the top-level segment.
          const layerRel = relative(newLayerDir, dir).split(sep).join('/');
          const prefix = layerRel.startsWith('.') ? layerRel.slice(1) : layerRel;
          for (const rel of Object.keys(current)) {
            if (rel === prefix || rel.startsWith(`${prefix}/`)) delete current[rel];
          }
        }
      }
    }
    // The record the snapshot dropped is written as gone: if the path returns, an untouched
    // copy is freshly installed, and a changed copy wins as a plain conflict. In layer mode
    // the write sits after the layer scan, so a scan-rejected skill never enters the record.
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, `${JSON.stringify(current, null, 2)}\n`);

    let pluginsStatus = null;
    const pluginsInSnapshot = existsSync(join(userRoot, 'omp', 'plugins', 'package.json'));
    if (!skipPlugins && pluginsInSnapshot) {
      const pluginsDir = join(writeRoot, '.omp', 'plugins');
      // copyfile, never bun's hardlink default: a file: dep's snapshot source would end up
      // with a second link, and the alias guards on machine reads and writes would refuse
      // the next provision. Planted aliases still refuse; the provisioner creates none.
      const bunArgs = allowPluginScripts
        ? ['install', '--frozen-lockfile', '--backend', 'copyfile']
        : ['install', '--frozen-lockfile', '--backend', 'copyfile', '--ignore-scripts'];
      const bun = spawnSync('bun', bunArgs, {
        cwd: pluginsDir,
        stdio: 'inherit',
        env: Object.fromEntries(BUN_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
      });
      if (bun.error || bun.status !== 0) {
        throw new Error(bun.error?.code === 'ENOENT' ? 'bun not found; cannot install plugins.' : `bun install failed in ${pluginsDir}`);
      }
      pluginsStatus = 'installed';
    } else if (skipPlugins && pluginsInSnapshot) {
      console.log('plugins skipped');
      pluginsStatus = 'unchanged';
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
        const target = join(layerHome, rel);
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
      // record stops deletion: safety over disk space. Keep entries are layer ids, never full
      // paths: realpath values and join-built paths must never disagree about the spelling of
      // the same layer, or clean-up deletes the layer current points at.
      const keep = new Set([basename(newLayerDir)]);
      try { keep.add(basename(realpathSync(currentLink))); } catch { /* dangling: kept via newLayerDir */ }
      if (previousTarget) keep.add(basename(previousTarget));
      const inUsePath = join(base, 'in-use.json');
      let inUse = null;
      let stopCleanup = false;
      if (existsSync(inUsePath)) {
        try { inUse = JSON.parse(readFileSync(inUsePath, 'utf8')); }
        catch { console.log('in-use.json unreadable; keeping every layer'); stopCleanup = true; }
      }
      if (inUse) for (const id of inUse.layers ?? []) keep.add(id);
      if (!stopCleanup) for (const name of readdirSync(layersDir)) {
        if (!/^(?:[0-9a-f]{12}|nogit)-\d+$/.test(name) || keep.has(name)) continue;
        rmSync(join(layersDir, name), { recursive: true });
        console.log(`deleted layer ${name}`);
      }
    }

    // One result per item key: the plan aggregates (any write wins over all-unchanged), the
    // plugin install adds its entry, and the failed items the gates collected join in. Skill
    // files aggregate to their skill-dir key and the plugin files to the one plugins key,
    // matching the shared item-key table. The block prints at the end, so a deploy log's
    // tail names every failure.
    const itemKeyOf = key => {
      const m = /^user\/((?:omp\/agent\/(?:skills|managed-skills)|agents\/skills)\/[^/]+)\//.exec(key);
      if (m) return `user/${m[1]}`;
      if (key.startsWith('user/omp/plugins')) return 'user/omp/plugins';
      return key;
    };
    const statuses = new Map();
    for (const [kind, , , key] of plan) {
      const item = itemKeyOf(key);
      const prev = statuses.get(item);
      statuses.set(item, kind === 'installed' || prev === 'installed' ? 'installed' : 'unchanged');
    }
    if (pluginsStatus) statuses.set('user/omp/plugins', pluginsStatus);
    for (const [key, status] of statuses) items.push({ item: key, status, rule: null, at: null });
    items.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    const failed = items.filter(i => i.status === 'rejected' || i.status === 'no-origin');
    if (failed.length) {
      console.log('Failed items:');
      for (const f of failed) {
        console.log(`  ${f.item} — ${f.status === 'no-origin' ? 'no origin' : `rejected: ${f.rule}${f.at ? ` at ${f.at}` : ''}`}`);
        // Rejected skills already printed their full scan report block above; only the short
        // origin hints (for example the pinned-Python remediation) ride on the status line.
        if (f.status === 'no-origin' && f.report) console.log(`    ${f.report}`);
      }
    }
    if (failed.length || nestedFailed) process.exitCode = 1;
  } catch (err) {
    // A layer that never went live must not survive its own failed install.
    if (layerMode && !switched) rmSync(newLayerDir, { recursive: true, force: true });
    if (tmpLink) rmSync(tmpLink, { force: true });
    throw err;
  }
} catch (err) {
  console.error(err.message);
  fatal = true;
  error = err.message;
  process.exitCode = 1; // not process.exit: finally below must still remove a cloned temp dir
} finally {
  // The server's per-item results, whatever the run's outcome; a refusal carries
  // fatal: true and the items the gates judged before it.
  if (process.env[PROVISION_ENV]) writeProvisionResults(process.env[PROVISION_ENV], { fatal, error, items });
  cleanupData(data);
}
