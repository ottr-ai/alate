#!/usr/bin/env node
// Restores the data repo's captured user/ layer onto a machine: the inverse of sync-user.mjs.
// Usage: node install-user.mjs [--home <dir>] [--force] [--skip-plugins] [--layer] [--commit <sha>] [--data <dir>|--repo <owner/name[@ref]>]
// --layer (or ALATE_LAYER=1) installs into a fresh <home>/.alate/layers/<commit>-<n> and atomically
// switches the <home>/.alate/current symlink to it, so a provision never rewrites files a running
// turn reads; see specs/agent-layer-switch.md for the layout, link set, and cleanup rules.
//   data dir: --data <dir>, else --repo (shallow clone), else $ALATE_DATA, else ../agent-data beside this checkout
// Paths mirror the home directory minus the leading dot (user/omp/agent/config.yml -> ~/.omp/agent/config.yml).
// A snapshot entry user/alate (any case) refuses the run: it would land in ~/.alate, alate's own state.
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
// same root omp's plugin manager installs into. While bun runs, a barrier ~/.omp/package.json with
// empty workspaces stops bun's workspace-root search, so bun never adopts a turn-planted
// package.json higher in the home as its workspace root. The install runs with --ignore-scripts
// unless the data repo opts in with a plugins-allow-scripts marker at its root, and with an
// allowlisted environment, so server secrets never reach bun or a lifecycle script. Packages
// install with bun's copyfile backend and hoisted linker, so the provisioner never creates a
// hard link into the snapshot tree, and from a fresh private package cache, so a turn-written
// ~/.bun cache entry never lands in the plugins. In layer mode a machine change to the plugins
// install files (package.json, bun.lock, patches/) never rides into the new layer: the snapshot wins.
// Also installs the per-project worker additions Ottr's turns read: workers/<project>/apt.txt
// (Debian packages), tools.json (declarative downloads), env.txt (env names, never values) and
// requirements.txt (pinned, hashed Python packages)
// -> ~/.ottr/workers/<project>/<file>; workers/_all/ is provisioned like a project. The data
// repo is their only source, so a changed list replaces the machine copy without --force, and a
// list it no longer ships is deleted. tools.json, env.txt and requirements.txt are validated before any write.
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertDirIdentity, assertSourceInside, CAPTURE_ROOTS, checkDestination, cleanupData, describeProblem, describeScanReport, dirIdentity, fingerprint, forTarget, makeDirInside, nextLayerCounter, originGate, parseArgs, PROVISION_ENV, readMachineFile, remapHomePaths, resolveDataDir, ruleProblems, sameContent, SKILL_ROOT_NAMES, skillProblems, skillRootAlias, splitDeploymentBlocks, withoutDeploymentBlocks, withoutHostPaths, withoutMemoryBackend, writeFileInside, writeProvisionResults, yamlProblems } from './lib/data.mjs';
import { SHIPPED_SKILLS_DIR, SHIPPED_TREE, shippedSkills } from './lib/shipped.mjs';

/** @typedef {{ values: Record<string, string | undefined>, flags: Set<string>, positional: string[] }} CliArgs */
/** @typedef {{ item: string, status: 'installed' | 'unchanged' | 'added' | 'updated' | 'rejected' | 'no-origin', rule: string | null, at: string | null, report?: string }} ProvisionItem */
/** @typedef {{ rule?: string, at?: string, report: string }} ScanRejection */
/** @typedef {{ skill: string, rule: string, file: string, key: string, reason: string }} ReviewEntry */
/** @typedef {{ id?: unknown, severity?: unknown, pattern?: unknown, category?: unknown, explanation?: unknown, match_fingerprint?: unknown, location?: { file?: unknown, start_line?: unknown } | null }} ScanFinding */
/** @typedef {{ name: string, url: string, sha256: string, unpack: string, bin?: string }} WorkerTool */
/** @typedef {['unchanged', string, null, string, string | null] | ['installed', string, Buffer, string, string | null]} PlanEntry */

const args = /** @type {CliArgs} */ (parseArgs(process.argv.slice(2), ['--data', '--repo', '--home', '--commit'], ['--force', '--skip-plugins', '--layer']));
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
/** @param {string} given @returns {string} */
const resolveHome = given => {
  let prefix = resolve(given);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(prefix), ...tail);
    } catch (err) {
      if ((/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT' && /** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOTDIR') || dirname(prefix) === prefix) throw err;
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
// The alate checkout itself: the vendored shipped skills and their review file live under it.
const toolRoot = dirname(fileURLToPath(import.meta.url));
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
/** @param {string} rel @returns {boolean} */
const pluginInstallFile = rel =>
  rel === 'omp/plugins/package.json' || rel === 'omp/plugins/bun.lock' || rel.startsWith('omp/plugins/patches/');
// A skill snapshot is executable agent content, so install-user scans each one statically before
// anything lands in the home (or, in layer mode, before the layer goes live): findings and
// scan errors reject that one skill (left out, reported), while a missing scanner or a scanner
// that cannot run refuse the whole restore before the first write. The scan applies the snapshot's own shipped
// `.skillspector-baseline.yaml`, but that file ships with the skill, so the gate caps it
// (specs/skillspector-reviewed-acceptances.md): it may accept LOW and MEDIUM findings, and any
// other accepted finding needs a review entry from a skillspector-reviews.json outside every
// skill folder (the data repo root, alate's shipped/). The upstream build is
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

// The config.yml that installs: no memory backend entry (a deployment choice) and no
// skills.customDirectories entry. The skill gates judge only the SKILL_ROOT_NAMES folders,
// so a folder named there would load skills that no gate saw. The line-based strip knows
// only omp's own block shape, so the bytes that install must pass configProblems: the
// fail-closed yamlProblems gate that capture runs too (a flow mapping, an escaped key
// spelling, a tag, an indented root, a CR-only line break are refused), and with that gate
// passed every key is spelled as its raw bytes, so a mapping key that names customDirectories
// (alone, dotted, or behind an invisible prefix) is an entry the strip did not remove; omp
// has no other key of that name. Comments and scalar values are never keys. The gate judges
// the whole text, deployment blocks included: they ride from the machine, which a turn can
// write in layer mode.
/** @param {string} text @returns {string[]} */
const configProblems = text => {
  const problems = yamlProblems(text, '.omp/agent/config.yml');
  text.split('\n').forEach((line, i) => {
    const key = lineKey(line);
    if (key !== null && /customDirectories/i.test(key))
      problems.push(`~/.omp/agent/config.yml:${i + 1}: skills.customDirectories left after the strip; take it out of the data repo`);
  });
  return problems;
};
// The decoded mapping key a line opens, or null. A line that passed yamlProblems is an
// indent, any `- ` sequence markers, then a plain or quoted key whose `:` comes before a
// blank or the line end (one key per line: block style allows no second one). A comment
// starts at a `#` after a blank, so a `#` ahead of the colon means the line opens no key.
/** @param {string} line @returns {string | null} */
const lineKey = line => {
  let s = line.replace(/\r$/, '').trimStart();
  while (/^-(?:[ \t]|$)/.test(s)) s = s.slice(1).trimStart();
  if (s.startsWith('"')) return /^"([^"]*)"[ \t]*:(?:[ \t]|$)/.exec(s)?.[1] ?? null;
  if (s.startsWith("'")) return /^'((?:[^']|'')*)'[ \t]*:(?:[ \t]|$)/.exec(s)?.[1].replaceAll("''", "'") ?? null;
  const m = /^(.*?)[ \t]*:(?:[ \t]|$)/.exec(s);
  return m && !s.startsWith('#') && !/[ \t]#/.test(m[1]) ? m[1] : null;
};
/** @param {string} text @returns {{ text: string, dropped: boolean, problems: string[] }} */
const gatedConfig = text => {
  const base = withoutMemoryBackend(text);
  const out = withoutHostPaths(base, { shellPath: false });
  return { text: out, dropped: out !== base, problems: configProblems(out) };
};

// Spawned children get allowlisted environments: ALATE_API_KEY and every other server
// secret never crosses a spawn boundary (specs/skillspector-scanner-trust.md, contract 5).
// Scanner children additionally force PYTHONNOUSERSITE=1 (scannerEnv); it is never passed
// through from the parent, so it is not in this allowlist.
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT'];
/** @param {string[]} [extra] @returns {Record<string, string>} */
const childEnv = extra => {
  /** @type {Record<string, string>} */
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
/** @param {string} path @returns {boolean} */
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
// agent content; each skill inside it goes to the scanner. A directory whose name only
// aliases a skill root (case variant `Skills/`, 8.3 short name `MANAGE~1/`,
// ignorable-code-point variant `skil\u200Cls/`, trailing-dot `skills./`) is collected into
// `aliases`, never descended into: the caller rejects it whole before any write.
/** @param {string} dir @param {string[]} [aliases] @returns {string[]} */
const collectSkillDirs = (dir, aliases = []) => {
  /** @type {string[]} */
  const found = [];
  /** @param {string} path */
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (SKILL_ROOT_NAMES.has(entry.name)) {
        for (const skill of readdirSync(child, { withFileTypes: true })) {
          if (skill.isDirectory() && !SKIP_DIRS.has(skill.name)) found.push(join(child, skill.name));
        }
      } else if (skillRootAlias(entry.name)) aliases.push(child);
      else visit(child);
    }
  };
  visit(dir);
  return found;
};

// Fail-closed gate: every skill snapshot is scanned before anything lands on disk (or, in
// layer mode, before the layer goes live). The scanner writes a JSON report to stdout, which
// the gate judges and prints as one text block, so parallel scans never interleave lines and
// a log never holds raw JSON. A judged report (exit 0 or 1, a JSON object with issues and
// suppressed lists) rejects that one skill when it holds an issue, or when the shipped
// baseline suppressed a finding above MEDIUM that no review entry covers (rule `unreviewed
// baseline acceptance`): the skill is left out of the install and reported. Any other scan
// result of one skill folder (another exit, a signal kill, stdout that is not such a report)
// rejects that skill too, with rule `scan error` and the scanner output as the report. A spawn
// error means the scanner cannot run at all, which cannot produce verdicts, so the whole run
// refuses. A skill whose own bytes cannot be hashed is rejected as unreadable rather than
// scanned. A scan costs ~15 s per
// skill, which made a 57-skill deploy seed wait ~14 minutes even when one file changed, so
// the gate re-scans only what changed: it hashes the exact bytes of each skill folder itself
// (never a hash the data repo ships — .skill-lock.json is data, not proof), one framed digest
// per entry (rel\0size\0sha256 of the bytes; a symlink contributes its resolved target bytes,
// the bytes the install copies), and keys a verdict on a format token, that hash, the
// scanner build (pin and probed version), the full scan arguments, and the sorted keys of the
// review entries for that skill item (a changed entry rescans only its skill); it runs
// the remaining scans concurrently, at most min(8, availableParallelism()) at a time. Only
// passes are recorded, in the target home's .alate/skillspector-pass.json (temp file, then
// atomic rename): a rejection is never cached, and a changed skill, a changed scanner, or an
// unreadable cache file always means a full rescan. A lost update between two installs that
// share a home only costs a rescan.
const SCAN_ARGS = ['--no-llm', '--fail-on-findings', '--use-shipped-baseline', '--show-suppressed', '--format', 'json'];
const scanCachePath = join(home, '.alate', 'skillspector-pass.json');

// The key must bind the bytes the install copies, so each file entry is framed as
// rel\0size\0sha256(bytes): no entry's bytes can fuse into a neighbor's stream, and a
// re-split of one stream into two files cannot reproduce the key. A symlink hashes its
// resolved target bytes (readFileSync follows the link) — the exact bytes the install walk
// copies — never the link text. The format token prefixed to every key makes entries an
// older alate wrote miss once and rescan instead of surviving a framing change.
const SCAN_CACHE_FORMAT = 'skill-pass-fmt-3';
/** @param {string} dir @returns {string} */
const hashSkillDir = dir => {
  const hash = createHash('sha256');
  /** @param {string} path */
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
/** @returns {Record<string, boolean>} */
const readPasses = () => {
  let raw = null;
  try {
    raw = readFileSync(scanCachePath, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') console.log(`${scanCachePath} is unreadable (${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {NodeJS.ErrnoException} */ (err).message}); scanning every skill snapshot.`);
    return {};
  }
  try {
    const passes = JSON.parse(raw);
    if (passes && typeof passes === 'object' && !Array.isArray(passes)) return passes;
  } catch { /* malformed */ }
  console.log(`${scanCachePath} is malformed; scanning every skill snapshot.`);
  return {};
};

/** @param {Record<string, boolean>} passes @returns {void} */
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

// A Windows host bind-mounts the data repo with every file marked executable (the
// board-seed `docker run --rm -v <data-repo>:/data:ro board-seed --data /data` shape), and
// the pinned scanner reads any file whose mode carries an exec bit as executable content.
// A shipped `.skillspector-baseline.yaml` is also a dot-path, which the scanner treats as a
// hidden artifact, so it reports the baseline as a concealed executable (SC9, HIGH) and the
// install drops every skill that ships a baseline. The mount can be read-only, so the gate
// cannot clean the mode in place: a skill folder whose explicitly selected baseline carries
// an exec bit is scanned through a byte-identical staging copy whose files carry clean
// modes. The scanner then reads executability from file suffix and content magic only,
// never from mount noise, and the shipped baseline still applies — the staged bytes are the
// snapshot's bytes, so the verdict cache keys (bytes only) hold and a warm cache never
// stages at all.
const SHIPPED_BASELINE = '.skillspector-baseline.yaml';
/** @param {string} dir @returns {boolean} */
const scanNeedsStaging = dir => {
  try {
    return (statSync(join(dir, SHIPPED_BASELINE)).mode & 0o111) !== 0;
  } catch {
    // No baseline (or an unreadable one): nothing to normalize; the scan judges the folder
    // as it is, and the hash gate already rejects an unreadable snapshot.
    return false;
  }
};
/** @param {string} dir @param {string} root @param {number} index @returns {string} */
const stageScanCopy = (dir, root, index) => {
  const dest = join(root, `${String(index).padStart(3, '0')}-${basename(dir)}`);
  /** @param {string} from @param {string} to */
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const child = join(from, entry.name);
      if (entry.isDirectory()) copy(child, join(to, entry.name));
      // Bytes only: a fresh file carries a clean mode, and a symlink contributes its
      // resolved target bytes — exactly what hashSkillDir keyed and the install walk copies.
      else writeFileSync(join(to, entry.name), readFileSync(child));
    }
  };
  copy(dir, dest);
  return dest;
};

// Severity cap on shipped baselines (specs/skillspector-reviewed-acceptances.md): the
// baseline --use-shipped-baseline applies sits inside the scanned folder, from the skill's own
// author, and the scanner caps no severity — one glob rule hides every finding. So a suppressed
// finding passes on the baseline alone only at LOW or MEDIUM; any other severity (HIGH,
// CRITICAL, or one the gate does not know) needs a review entry from a file no skill folder
// holds: the data repo root's skillspector-reviews.json (sync-user never captures it, the
// install never copies it) or alate's own shipped/skillspector-reviews.json for the vendored
// shipped skills. The gate uses the union of both.
const REVIEW_FILE = 'skillspector-reviews.json';
const REVIEW_FIELDS = ['skill', 'rule', 'file', 'key', 'reason'];
const REVIEW_KEY_RE = /^sha256:[0-9a-f]{64}$/;
const BASELINE_SEVERITIES = new Set(['LOW', 'MEDIUM']);

// A missing review file holds no entries. Any other read error, or the first broken format
// rule, throws with the file path first; the caller loads both files before any write, so a
// broken file refuses the whole run.
/** @param {string} path @returns {ReviewEntry[]} */
const loadReviews = path => {
  /** @param {string} rule @returns {Error} */
  const broken = rule => new Error(`${path}: ${rule}`);
  /** @type {Buffer} */
  let raw;
  try {
    raw = readFileSync(path);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ENOENT') return [];
    throw broken(`unreadable (${e.code ?? e.message})`);
  }
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (err) {
    throw broken(`not UTF-8 JSON (${/** @type {Error} */ (err).message})`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw broken('the top level must be a JSON object');
  const top = /** @type {Record<string, unknown>} */ (doc);
  if (top.version !== 1) throw broken('version must be 1');
  if (!Array.isArray(top.accepted)) throw broken('accepted must be an array');
  const extra = Object.keys(top).find(k => k !== 'version' && k !== 'accepted');
  if (extra !== undefined) throw broken(`unknown top-level key ${JSON.stringify(extra)}`);
  /** @type {ReviewEntry[]} */
  const entries = [];
  const pairs = new Set();
  for (const [i, value] of /** @type {unknown[]} */ (top.accepted).entries()) {
    const at = `accepted[${i}]`;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw broken(`${at} must be an object`);
    const fields = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(fields);
    if (keys.length !== REVIEW_FIELDS.length || !REVIEW_FIELDS.every(k => keys.includes(k))) throw broken(`${at} must have exactly the keys ${REVIEW_FIELDS.join(', ')}`);
    const nonString = REVIEW_FIELDS.find(k => typeof fields[k] !== 'string');
    if (nonString !== undefined) throw broken(`${at}.${nonString} must be a string`);
    const { skill, rule, file, key, reason } = /** @type {ReviewEntry} */ (/** @type {unknown} */ (fields));
    if (!skill.startsWith('user/') || skill.includes('\\') || skill.split('/').some(s => s === '' || s === '.' || s === '..')) {
      throw broken(`${at}.skill must start with user/ and have no empty, ".", or ".." segment and no backslash (got ${JSON.stringify(skill)})`);
    }
    if (rule === '') throw broken(`${at}.rule must not be empty`);
    if (file === '') throw broken(`${at}.file must not be empty`);
    if (!REVIEW_KEY_RE.test(key)) throw broken(`${at}.key must match ${REVIEW_KEY_RE.source} (got ${JSON.stringify(key)})`);
    if (reason.trim() === '') throw broken(`${at}.reason must not be empty`);
    const pair = JSON.stringify([skill, key]);
    if (pairs.has(pair)) throw broken(`${at} repeats the skill ${JSON.stringify(skill)} and key ${key} of an earlier entry`);
    pairs.add(pair);
    entries.push({ skill, rule, file, key, reason });
  }
  return entries;
};

// The finding key binds rule, severity, file, matched text, and the sha256 of the flagged file's
// whole bytes. The scanner's match fingerprint and explanation see only the matched phrase, so
// without the file bytes a review of quoted example text would still cover the same phrase
// rewritten as a direct instruction. Any change to the flagged file therefore needs a new
// review; line numbers stay out of the key because the file hash already covers them. The spec
// carries the Python twin. Returns null when the flagged file cannot be read inside the scanned
// folder: such a finding has no key, so no entry can cover it.
/** @param {ScanFinding} f @param {string} dir @returns {string | null} */
const findingKey = (f, dir) => {
  const file = f.location?.file;
  if (typeof file !== 'string' || file === '') return null;
  const path = resolve(dir, file);
  const rel = relative(dir, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  let content;
  try {
    content = createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
  return `sha256:${createHash('sha256').update(JSON.stringify([
    f.id ?? null, f.severity ?? null, file, f.match_fingerprint ?? null, f.explanation ?? null, content,
  ])).digest('hex')}`;
};

// Scanner text is untrusted: one rendered field never spans lines or carries control bytes, so
// a crafted pattern cannot forge a Location line for describeScanReport or the log reader.
/** @param {unknown} value @returns {string} */
const oneLine = value => String(value ?? '?').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
/** @param {ScanFinding} f @returns {string} */
const findingAt = f => `${oneLine(f.location?.file)}:${oneLine(f.location?.start_line)}`;
// The scanner's terminal shape: `HIGH: SC2 - <pattern>` (indented by the caller) and
// `    Location: <file>:<line>`, the two lines describeScanReport parses.
/** @param {ScanFinding} f @returns {[string, string]} */
const findingLines = f => [`${oneLine(f.severity)}: ${oneLine(f.id)} - ${oneLine(f.pattern ?? f.category)}`, `    Location: ${findingAt(f)}`];

// A judged report is a JSON object whose issues and suppressed lists hold objects, with a
// suppressed_count that agrees; anything else proves nothing and is a scan error. `truncated`
// is true when the scanner's completeness ledger records an `output_limit` exception: the
// pinned build stops one analyzer at 10,000 findings and skips the files after that point, so
// a skill can flood an early file with LOW findings its own baseline accepts and push a HIGH
// finding out of both lists. Other partial-coverage reasons (static_parse_limit,
// reference_missing) are common in benign skills and drop no finding from the lists.
/** @param {string} stdout @returns {{ issues: ScanFinding[], suppressed: ScanFinding[], truncated: boolean } | null} */
const parseScanReport = stdout => {
  /** @type {unknown} */
  let doc;
  try { doc = JSON.parse(stdout); } catch { return null; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const { issues, suppressed, suppressed_count: count, analysis_completeness: completeness } = /** @type {Record<string, unknown>} */ (doc);
  if (!Array.isArray(issues) || !Array.isArray(suppressed) || count !== suppressed.length) return null;
  /** @param {unknown} f @returns {boolean} */
  const isFinding = f => f !== null && typeof f === 'object' && !Array.isArray(f);
  if (!issues.every(isFinding) || !suppressed.every(isFinding)) return null;
  const exceptions = isFinding(completeness) ? /** @type {Record<string, unknown>} */ (completeness).ledger_exceptions : undefined;
  const truncated = Array.isArray(exceptions) && exceptions.some(e => isFinding(e) && /** @type {Record<string, unknown>} */ (e).reason_code === 'output_limit');
  return { issues, suppressed, truncated };
};

// The pinned build's verdict for these exact bytes, printed as one text block so a tail of the
// output always shows a whole report. A judged report (exit 0 or 1) resolves with its issues and
// the suppressed findings above MEDIUM that no entry for `skill` covers; any other result
// resolves as a scan error — a per-skill rejection carrying the failure line and the scanner
// output. Only a spawn error rejects: the scanner cannot run at all, which the caller turns into
// a whole-run refusal. `display` names the folder in every message: a staged scan copy reports
// under the snapshot folder's name, so a deploy log's tail still names the skill.
/**
 * @param {string} scanner @param {string} dir @param {number} total @param {string} display
 * @param {string} skill @param {ReviewEntry[]} entries
 * @returns {Promise<{ issues: ScanFinding[], unreviewed: ScanFinding[], report: string } | { scanError: string, report: string }>}
 */
const scanOne = (scanner, dir, total, display, skill, entries) => new Promise((resolve, reject) => {
  const child = spawn(scanner, ['scan', dir, ...SCAN_ARGS], { stdio: ['ignore', 'pipe', 'pipe'], env: scannerEnv() });
  /** @type {Buffer[]} */
  const out = [];
  /** @type {Buffer[]} */
  const errOut = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => errOut.push(chunk));
  child.on('error', /** @param {NodeJS.ErrnoException} err */ err => reject(new Error(`skillspector could not run (${err.code ?? err.message}); refusing to install ${total} skill snapshot(s).`)));
  child.on('close', (code, signal) => {
    const stdout = Buffer.concat(out).toString('utf8');
    const parsed = parseScanReport(stdout);
    /** @type {string[]} */
    const lines = [];
    /** @type {ScanFinding[]} */
    const unreviewed = [];
    if (parsed) {
      /** @type {string[]} */
      const acceptances = [];
      let capped = 0;
      for (const f of parsed.suppressed) {
        if (BASELINE_SEVERITIES.has(/** @type {string} */ (f.severity))) continue;
        capped++;
        // The scanned copy holds the snapshot's exact bytes (a staged copy too), so the file
        // hash in the key is the hash of the bytes the scanner judged and the install copies.
        const key = findingKey(f, dir);
        if (key !== null && entries.some(e => e.skill === skill && e.rule === f.id && e.file === f.location?.file && e.key === key)) continue;
        unreviewed.push(f);
        const [head, location] = findingLines(f);
        const entry = key === null
          ? `none possible (the flagged file ${oneLine(f.location?.file)} is not readable inside the skill folder)`
          : JSON.stringify({ skill, rule: f.id ?? null, file: f.location?.file ?? null, key, reason: '<review note>' });
        acceptances.push(`  Unreviewed baseline acceptance: ${head}`, location, `    Review entry: ${entry}`);
      }
      lines.push(`Issues (${parsed.issues.length})`);
      for (const f of parsed.issues) {
        const [head, location] = findingLines(f);
        lines.push(`  ${head}`, location);
      }
      lines.push(`Suppressed by the shipped baseline (${parsed.suppressed.length}): ${parsed.suppressed.length - capped} LOW/MEDIUM, ${capped - unreviewed.length} reviewed, ${unreviewed.length} unreviewed`, ...acceptances);
    } else if (stdout.trim()) lines.push(stdout.trimEnd());
    const stderr = Buffer.concat(errOut).toString('utf8').trimEnd();
    if (stderr) lines.push(stderr);
    const report = lines.join('\n');
    console.log(`--- SkillSpector report: ${display}${report ? `\n${report}` : ''}`);
    if (parsed && !parsed.truncated && (code === 0 || code === 1)) resolve({ issues: parsed.issues, unreviewed, report });
    else {
      const why = parsed?.truncated
        ? 'the scanner reached its finding output limit, so findings past the limit are missing from the report'
        : code === 0 || code === 1 ? `exit ${code}, stdout is not a SkillSpector JSON report` : `exit ${code ?? `signal ${signal}`}`;
      resolve({ report, scanError: `SkillSpector scan of ${display} failed (${why}).` });
    }
  });
});

/**
 * @param {string[]} skillDirs
 * @param {(dir: string) => string} keyOf the skill item key of a dir, as the provision results spell it
 * @param {Map<string, ReviewEntry[]>} reviews review entries by skill item key
 * @returns {Promise<{ rejected: Map<string, ScanRejection> }>}
 */
const runScan = async (skillDirs, keyOf, reviews) => {
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
    if (/** @type {NodeJS.ErrnoException | undefined} */ (probe.error)?.code === 'ENOENT') continue;
    if (probe.error) {
      throw new Error(`skillspector could not run (${/** @type {NodeJS.ErrnoException} */ (probe.error).code ?? /** @type {NodeJS.ErrnoException} */ (probe.error).message}); refusing to install ${skillDirs.length} skill snapshot(s).`);
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
  /** @type {Map<string, ScanRejection>} */
  const rejected = new Map();
  /** @type {Map<string, string>} */
  const keys = new Map();
  for (const dir of skillDirs) {
    // A pass depends on the review entries too: every matched field (rule, file, key) of this
    // skill item's entries joins the cache key, sorted, so a new, removed, or edited entry
    // rescans only its own skill. The reason is a note and never changes a verdict.
    const entryIds = (reviews.get(keyOf(dir)) ?? []).map(e => JSON.stringify([e.rule, e.file, e.key])).sort();
    const reviewDigest = createHash('sha256').update(JSON.stringify(entryIds)).digest('hex');
    try {
      keys.set(dir, `${SCAN_CACHE_FORMAT} ${hashSkillDir(dir)} ${SKILLSPECTOR_REF} ${reported} scan ${SCAN_ARGS.join(' ')} reviews ${reviewDigest}`);
    } catch (err) {
      rejected.set(dir, { rule: 'unreadable skill files', report: `${dir}: ${/** @type {Error} */ (err).message}` });
    }
  }
  const scanList = skillDirs.filter(dir => keys.has(dir));
  const pending = scanList.filter(dir => passes[/** @type {string} */ (keys.get(dir))] !== true);
  console.log(`Scanning ${pending.length} of ${scanList.length} skill snapshot(s) (${scanList.length - pending.length} cached) with SkillSpector ${SKILLSPECTOR_REF} at ${scanner} (--no-llm, static only, shipped baselines applied up to MEDIUM, above it only with a review entry)...`);
  if (!pending.length) return { rejected };
  // Findings and unreviewed baseline acceptances reject their own skill only; so does any other
  // scan failure (another exit, a signal kill, a report that does not parse): the skill is left
  // out with rule `scan error` and the scan continues. Only a spawn error — the scanner cannot
  // run at all, so no verdict is possible — stops scheduling, lets the in-flight scans finish,
  // and refuses the whole run.
  let fatal = /** @type {Error | null} */ (null);
  let next = 0;
  // Staged scan copies for folders whose shipped baseline carries exec bits (the Windows
  // bind-mount shape); created lazily, so a clean mount never pays for one, and removed
  // before this function returns, whatever the scans decided.
  /** @type {string | null} */
  let stageRoot = null;
  let staged = 0;
  /** @param {string} dir @returns {string} */
  const scanTargetFor = dir => {
    if (!scanNeedsStaging(dir)) return dir;
    if (stageRoot === null) stageRoot = mkdtempSync(join(tmpdir(), 'alate-scan-'));
    return stageScanCopy(dir, stageRoot, staged++);
  };
  try {
    /** @returns {Promise<void>} */
    const worker = async () => {
      while (fatal === null && next < pending.length) {
        const dir = pending[next++];
        let scanTarget;
        try {
          scanTarget = scanTargetFor(dir);
        } catch (err) {
          // Staging reads the same bytes the hash gate just read, so this is a mid-run race,
          // not a broken snapshot: reject the one skill, scan the rest.
          rejected.set(dir, { rule: 'unreadable skill files', report: `${dir}: ${/** @type {Error} */ (err).message}` });
          continue;
        }
        try {
          // The verdict and the entries belong to the snapshot dir, never to a staged copy.
          const skill = keyOf(dir);
          const res = await scanOne(/** @type {string} */ (scanner), scanTarget, skillDirs.length, dir, skill, reviews.get(skill) ?? []);
          if ('scanError' in res) {
            rejected.set(dir, { rule: 'scan error', report: `${res.scanError}${res.report ? `\n${res.report}` : ''}` });
            // Stdout too: the deploy log's tail must name the rejected skill folder.
            console.log(`${res.scanError} The skill is left out of this install.`);
          } else if (res.issues.length) {
            rejected.set(dir, { rule: oneLine(res.issues[0].id), at: findingAt(res.issues[0]), report: res.report });
            // Stdout too: the deploy log's tail must name the rejected skill folder.
            console.log(`SkillSpector rejected ${dir} (${res.issues.length} finding(s)); the skill is left out of this install.`);
          } else if (res.unreviewed.length) {
            rejected.set(dir, { rule: 'unreviewed baseline acceptance', at: findingAt(res.unreviewed[0]), report: res.report });
            console.log(`SkillSpector rejected ${dir}: its shipped baseline accepts ${res.unreviewed.length} finding(s) above MEDIUM that no review entry covers; the skill is left out of this install.`);
          } else {
            passes[/** @type {string} */ (keys.get(dir))] = true;
            recordPass(passes);
          }
        } catch (err) {
          fatal = /** @type {Error} */ (err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, availableParallelism(), pending.length) }, worker));
    if (fatal !== null) {
      // Stdout too: the deploy log's tail must end on the line naming the broken scan.
      console.log(fatal.message);
      throw fatal;
    }
  } finally {
    if (stageRoot !== null) rmSync(stageRoot, { recursive: true, force: true });
  }
  return { rejected };
};

/** @param {Buffer} bytes @param {string} path @returns {void} */
const validateTools = (bytes, path) => {
  /** @type {WorkerTool[]} */
  let list;
  try {
    list = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${path}: tools.json is not valid JSON (${/** @type {Error} */ (err).message})`);
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

/** @param {Buffer} bytes @param {string} path @returns {void} */
const validateEnv = (bytes, path) => {
  // Reference grammar is ottr's parseEnvTxt (src/tools.ts); the two must stay in sync.
  // A line holds one name, then optionally the word "plain". Names only, never values: a
  // broken line is reported by number, its content is never printed.
  bytes.toString('utf8').split(/\r?\n/).forEach((raw, i) => {
    const words = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    if (words.length > 2 || !ENV_NAME.test(words[0]) || (words.length === 2 && words[1] !== 'plain')) {
      throw new Error(`${path}: env.txt line ${i + 1}: a line is one name, then optionally the word "plain" (a name must match ${ENV_NAME.source}; names only, never values)`);
    }
  });
};

const REQ_LINE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([A-Za-z0-9][A-Za-z0-9.+_!-]*)((?: --hash=sha256:[0-9a-f]{64})+)$/;
/** @param {Buffer} bytes @param {string} path @returns {void} */
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
/** @type {ProvisionItem[]} */
const items = [];
let fatal = false;
let error = null;
let nestedFailed = false;
// A failed item's report is diagnostics with a bound, like every stored report.
/** @param {string} report @returns {string} */
const capReport = report => report.length > 4000 ? `${report.slice(0, 4000)}…` : report;
/** @param {string} item @param {ProvisionItem['status']} status @param {string | null} [rule] @param {string | null} [at] @param {string | null} [report] */
const failItem = (item, status, rule, at, report) =>
  items.push({ item, status, rule: rule ?? null, at: at ?? null, ...(report == null ? {} : { report: capReport(report) }) });
// A scan rejection carries the first SkillSpector finding (or the first unreviewed baseline
// acceptance) as rule and position; a scan-error rejection carries rule `scan error`; the
// hash-error rejection carries its own rule. `key` is the item key of the skill dir.
/** @param {string} key @param {ScanRejection} info @returns {void} */
const addScanRejection = (key, info) => {
  if (info.rule !== undefined) failItem(key, 'rejected', info.rule, info.at ?? null, info.report);
  else {
    const d = describeScanReport(info.report);
    failItem(key, 'rejected', d.rule, d.at, info.report);
  }
};
// The item key of a skill dir: snapshot-relative under userRoot; in a fresh layer the top-level
// dir is a dot-dir (.omp), so the leading dot drops out for the snapshot spelling.
/** @param {string} root @param {string} dir @returns {string} */
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
  // ~/.alate holds alate's own state (installed.json, the scan pass cache, layers). A
  // snapshot entry user/alate would map onto it and plant scan verdicts or install records,
  // so it refuses the run before any scan or write. The match ignores case: a
  // case-insensitive file system maps user/Alate onto the same dir.
  const reserved = readdirSync(userRoot).find(name => name.toLowerCase() === 'alate');
  if (reserved !== undefined) throw new Error(`refusing: user/${reserved} would install into ~/.alate, alate's own state dir; remove it from the snapshot`);
  // The review entries for baseline acceptances above MEDIUM (specs/skillspector-reviewed-
  // acceptances.md) load before any write or layer creation, in both modes: an invalid file
  // refuses the whole run, naming the file, and a missing one holds no entries.
  /** @type {Map<string, ReviewEntry[]>} */
  const reviews = new Map();
  for (const entry of [...loadReviews(join(data.dir, REVIEW_FILE)), ...loadReviews(join(toolRoot, 'shipped', REVIEW_FILE))]) {
    const list = reviews.get(entry.skill);
    if (list) list.push(entry);
    else reviews.set(entry.skill, [entry]);
  }
  // Check source bytes on every install, before target reads, scanner calls, or layer creation.
  /** @type {string[]} */
  const rootAliases = [];
  const skillDirs = collectSkillDirs(userRoot, rootAliases);
  // Origin gate (upstreams.json): fatal problems mean the gate itself is broken, so no origin
  // verdict is possible and the run refuses. An uncovered skill dir is excluded (failed item
  // `no origin`) before the walk; an uncovered MCP server is only reported — one uncovered
  // server never disconnects the other servers on the machine. Bare keys are data-root rules,
  // which sync.mjs installs, so they are not this script's business.
  const gate = /** @type {{ fatal: string[], uncovered: string[], hints: Record<string, string> }} */ (originGate(data.dir));
  if (gate.fatal.length) throw new Error(`Nothing installed. Fix:\n  ${gate.fatal.join('\n  ')}`);
  const dirByKey = new Map(skillDirs.map(dir => [`user/${relative(userRoot, dir).split(sep).join('/')}`, dir]));
  /** @type {Set<string>} */
  const rejectedSkills = new Set();
  // A folder whose name only aliases a skill root (case variant `Skills/` or trailing-dot
  // `skills./`, 8.3 short name `MANAGE~1/`, ignorable-code-point variant `skil\u200Cls/`)
  // is the root's folder as Windows and macOS resolve it, but no skill gate ever saw its
  // skills: the whole folder is rejected and excluded.
  for (const dir of rootAliases) {
    const key = `user/${relative(userRoot, dir).split(sep).join('/')}`;
    const alias = /** @type {{ root: string, reason: 'case variant' | '8.3 short name' | 'ignorable code point variant' }} */ (skillRootAlias(basename(dir)));
    const why = alias.reason === 'case variant'
      ? `a case-insensitive filesystem installs it as ${alias.root}/ unchecked by the skill gates`
      : alias.reason === '8.3 short name'
        ? `NTFS resolves the 8.3 short name to the long folder, so it installs as ${alias.root}/ unchecked by the skill gates`
        : `HFS+ name comparison ignores these code points, so it installs as ${alias.root}/ unchecked by the skill gates`;
    failItem(key, 'rejected', `${alias.reason} of skill root "${alias.root}"`, null, `${key}: ${alias.reason} of skill root "${alias.root}"; ${why}. Rename the folder to ${alias.root}/.`);
    rejectedSkills.add(dir);
  }
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
    /** @type {string[]} */
    const problems = [];
    let text;
    try {
      assertSourceInside(userRoot, entrypoint);
      if (!statSync(entrypoint).isFile()) throw new Error('SKILL.md must be a regular file');
      text = readFileSync(entrypoint, 'utf8');
    } catch (err) {
      problems.push(`${label}: cannot read SKILL.md (/** @type {Error} */ (err).message)`);
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
  /** @param {string} rel @param {Iterable<string>} dirs @returns {boolean} */
  const inRejected = (rel, dirs) => {
    for (const dir of dirs) {
      const p = relative(userRoot, dir).split(sep).join('/');
      if (rel === p || rel.startsWith(`${p}/`)) return true;
    }
    return false;
  };
  /** @param {string} dir @param {string} [sub] @returns {string[]} */
  const walk = (dir, sub = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    SKIP_DIRS.has(e.name) ? []
      : e.isDirectory() ? walk(join(dir, e.name), sub ? `${sub}/${e.name}` : e.name)
      : [sub ? `${sub}/${e.name}` : e.name]);

  // Hidden-character gate over each skill folder as a whole: one bad .md/.mdc file (the
  // SKILL.md entrypoint is judged by the structure gate above) rejects the whole skill
  // under its skill key, so no half-installed skill ships — the scan verdict covered the
  // full source folder, not the installed subset a per-file rejection would leave
  // (specs/provision-item-by-item.md, docs/specs/shipped-skills.md). The walk below skips
  // every rel of a rejected skill and keeps judging Markdown outside skill folders per
  // file; skillRelPrefixes names that boundary for both.
  const skillRelPrefixes = skillDirs.map(dir => relative(userRoot, dir).split(sep).join('/'));
  for (const dir of skillDirs) {
    if (rejectedSkills.has(dir)) continue;
    const key = skillKey(userRoot, dir);
    /** @type {string[]} */
    const problems = [];
    for (const file of walk(dir)) {
      if (!/\.(md|mdc)$/i.test(file) || file === 'SKILL.md') continue;
      const label = `${key}/${file}`;
      const srcPath = join(dir, file);
      try {
        assertSourceInside(userRoot, srcPath);
      } catch (err) {
        throw new Error(`${label}: ${/** @type {Error} */ (err).message}`);
      }
      problems.push(...ruleProblems(label, readFileSync(srcPath, 'utf8'), { frontmatter: false }));
    }
    if (problems.length) {
      const first = describeProblem(problems[0]);
      failItem(key, 'rejected', first.rule, first.at, problems.join('\n'));
      rejectedSkills.add(dir);
    }
  }

  // The capture roots (lib/data.mjs) are dot-dirs in the home (user/omp -> ~/.omp); the full
  // list, never just this snapshot's top-level dirs, so a stored path through a root the
  // snapshot lacks still moves.
  const roots = CAPTURE_ROOTS;

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

  /** @type {PlanEntry[]} */
  const plan = [];
  /** @type {string[]} */
  let conflicts = [];
  /** @type {string[]} */
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
  // read, and the bytes come from one no-follow fd (readMachineFile), so a violation or a
  // swap after the check refuses the run before any write instead of copying the target's
  // bytes into the new layer. A first layer over an in-place home reads the home's own
  // record instead of the layer's, guarded the same way against layerHome. In-place mode
  // reads the manifest path it already guards as dest, so the guard there changes nothing.
  // A guard violation throws here, outside the catch below: it refuses the run.
  const lastBytes = readMachineFile(migratingHome ? layerHome : readRoot, lastManifest);
  /** @type {Record<string, string>} */
  let last = {};
  if (lastBytes !== null) {
    try {
      last = JSON.parse(lastBytes.toString('utf8'));
    } catch (err) {
      console.error(`Ignoring unreadable ${lastManifest} (/** @type {Error} */ (err).message): every file that differs from the snapshot counts as changed here.`);
    }
  }
  // The machine file's fingerprint, the same comparison the install plan uses: config.yml's
  // deployment blocks stay on the target, so they never make a file look changed here. Layer
  // mode also compares modulo the memory backend entry (a deployment choice, above): a home
  // config.yml that differs from the snapshot or its record only by the entry is not a
  // machine change. In-place mode keeps the entry in the comparison, so a file that differs
  // by the entry still refuses and --force still rewrites the entry away.
  /** @param {string} rel @param {Buffer | null} bytes @returns {string | null} */
  const machineFingerprint = (rel, bytes) => {
    if (bytes === null) return null;
    const machineYaml = rel === 'omp/agent/config.yml' ? bytes.toString('utf8') : null;
    let base = machineYaml === null ? null : withoutDeploymentBlocks(machineYaml);
    if (base !== null && layerMode) base = withoutMemoryBackend(base);
    return fingerprint(rel, base === null ? bytes : Buffer.from(base, 'utf8'));
  };
  // The live copy's fingerprint in the new layer's coordinate space, for the snapshot
  // comparison: paths the previous install re-rooted into the live layer re-root into the
  // new layer here, so a file whose only difference from the snapshot is the layer prefix
  // compares equal (the snapshot is remapped the same way). The plain machineFingerprint
  // stays the record and deletion comparison: the record describes the live layer in its
  // own coordinates.
  /** @param {string} rel @param {Buffer | null} bytes @param {string} machineSrc @returns {string | null} */
  const layerMachineFingerprint = (rel, bytes, machineSrc) => {
    if (layerMode && /\.(?:json|ya?ml)$/.test(rel)) {
      if (bytes === null) return null;
      let text = bytes.toString('utf8');
      if (rel === 'omp/agent/config.yml') text = withoutMemoryBackend(withoutDeploymentBlocks(text));
      return fingerprint(rel, Buffer.from(remapHomePaths(text, machineSrc, /** @type {string} */ (newLayerDir)), 'utf8'));
    }
    return machineFingerprint(rel, bytes);
  };
  // The record an alate older than the memory-backend strip wrote hashes the snapshot bytes it
  // installed, and those still carried the entry. Layer mode accepts that legacy record too: a
  // home config.yml that, with only the deployment blocks stripped, still holds exactly the
  // bytes such an alate installed matches its record, so an untouched pre-strip home migrates
  // to the snapshot instead of freezing as a machine change. For a file without the entry the
  // legacy form equals the plain one, so later layers (whose records strip-era alate wrote)
  // compare identically. Only config.yml can carry the entry; other files and in-place mode
  // never use the legacy form.
  /** @param {string} rel @param {Buffer | null} bytes @returns {string | null} */
  const legacyFingerprint = (rel, bytes) =>
    rel === 'omp/agent/config.yml' && layerMode && bytes !== null
      ? fingerprint(rel, Buffer.from(withoutDeploymentBlocks(bytes.toString('utf8')), 'utf8'))
      : null;

  // The report label against the live layer: added when it lacks the file, unchanged when
  // the bytes that land in the new layer match it through the machine-fingerprint
  // normalization, updated otherwise. The compare base is the live layer, never the fresh
  // one being written.
  /** @param {string} rel @param {Buffer} bytes @param {string | null} have @returns {'added' | 'updated' | 'unchanged'} */
  const layerLabel = (rel, bytes, have) => {
    if (have === null) return 'added';
    const machineYaml = rel === 'omp/agent/config.yml' ? bytes.toString('utf8') : null;
    let base = machineYaml === null ? null : withoutDeploymentBlocks(machineYaml);
    if (base !== null) base = withoutMemoryBackend(base);
    return fingerprint(rel, base === null ? bytes : Buffer.from(base, 'utf8')) === have ? 'unchanged' : 'updated';
  };

  // Deletes the directories a deletion left empty, up to the mapped root (the top-level
  // dot-dir of the snapshot path, or ~/.ottr for worker lists); never the root itself.
  /** @param {string} dest @param {string} root @returns {void} */
  const pruneEmptyDirs = (dest, root) => {
    for (let dir = dirname(dest); dir.startsWith(root + sep); dir = dirname(dir)) {
      if (readdirSync(dir).length) break;
      rmdirSync(dir);
    }
  };

  /** @type {Record<string, string>} */
  const current = {};
  // Which walk contributed each planned rel: 'snapshot' or the vendored shipped dir. The
  // rel namespace is shared — agents/skills/<name> can hold either source's entries — so
  // the rejection cleanup below strips only what the rejected dir itself contributed.
  /** @type {Map<string, string>} */
  const relSource = new Map();
  // Record fingerprints of files whose machine copy still matches what alate last
  // installed: a scan-rejected skill keeps these files and their record entries
  // (specs/provision-item-by-item.md), so a spurious rejection never deletes a good
  // install through the deletion path below.
  /** @type {Map<string, string>} */
  const recordedFp = new Map();
  for (const rel of walk(userRoot)) {
    // A skill left out by a gate contributes nothing: no plan entry, no manifest record, no
    // conflict, so its installed copy is deleted later like any path the snapshot dropped.
    if (inRejected(rel, rejectedSkills)) continue;
    relSource.set(rel, 'snapshot');
    // Snapshot content must resolve inside the snapshot; links escaping it, or cyclic
    // ones, refuse the restore instead of being followed.
    const srcPath = join(userRoot, rel);
    try {
      assertSourceInside(userRoot, srcPath);
    } catch (err) {
      throw new Error(`user/${rel}: ${/** @type {Error} */ (err).message}`);
    }
    const dest = join(writeRoot, '.' + rel);
    // Every destination is preflighted before any content is read or written, so a
    // symlink, hardlink, or directory at dest refuses the whole restore up front —
    // --force overrides the conflict refusal, never this alias guard.
    checkDestination(writeRoot, dest);
    const machineSrc = layerMode && rel === 'omp/agent/config.yml' ? machineRoot : readRoot;
    const readDest = join(machineSrc, '.' + rel);
    // The machine copy feeds config.yml's deployment blocks, the fingerprints, and the kept
    // bytes: one read through a no-follow fd, never an alias out of the live layer, or out
    // of an in-place home on a first layer. See the guard on lastManifest above.
    const machineBytes = readMachineFile(machineSrc, readDest);
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
    // skills.customDirectories goes too (gatedConfig above); capture strips it already, so
    // only a hand-written snapshot carries it. A config the syntax gate refuses is rejected
    // per item: no plan entry, no manifest record, no conflict.
    if (rel === 'omp/agent/config.yml') {
      const gated = gatedConfig(snapshot.toString('utf8'));
      if (gated.problems.length) {
        const first = describeProblem(gated.problems[0]);
        failItem(`user/${rel}`, 'rejected', first.rule, first.at, gated.problems.join('\n'));
        continue;
      }
      if (gated.dropped) notes.push(`user/${rel}: dropped skills.customDirectories (the skill gates never judge those folders)`);
      snapshot = Buffer.from(gated.text, 'utf8');
    }
    // The remap prefix must spell the home exactly as forTarget rooted it above, so a
    // non-canonical --home still re-roots once; the layer side is canonical.
    if (layerMode && /\.(?:json|ya?ml)$/.test(rel)) snapshot = Buffer.from(remapHomePaths(snapshot.toString('utf8'), home, /** @type {string} */ (newLayerDir)), 'utf8');
    // config.yml's top-level hindsight:/alate: blocks are deployment settings that stay on the
    // target: the snapshot never carries them (capture strips them), and the machine's own ride
    // along on every install. In layer mode they come from the live layer's config, the fresh
    // one has none yet. Compare deployment-free content, so a target that differs only in
    // those blocks is unchanged and a real conflict cannot hide behind them. `dropped` holds
    // credentials: never log it.
    const machineYaml = rel === 'omp/agent/config.yml' && machineBytes !== null
      ? machineBytes.toString('utf8') : null;
    const deployed = machineYaml === null ? null : splitDeploymentBlocks(machineYaml);
    const want = fingerprint(rel, snapshot);
    let src = snapshot;
    if (deployed?.dropped.length) {
      const base = splitDeploymentBlocks(snapshot.toString('utf8'));
      // The snapshot's own terminator already separates it from the appended blocks; a
      // snapshot that does not end in a newline still gets the blocks on a new line.
      const kept = base.kept[base.kept.length - 1] === '' ? base.kept.slice(0, -1) : base.kept;
      src = Buffer.from([...kept, ...deployed.dropped].join('\n'), 'utf8');
      // The machine's blocks ride into the installed file, so the whole text passes the
      // config gate (the snapshot alone passed it above); its messages carry line numbers
      // only, never block content.
      const problems = configProblems(src.toString('utf8'));
      if (problems.length) {
        const first = describeProblem(problems[0]);
        failItem(`user/${rel}`, 'rejected', first.rule, first.at, problems.join('\n'));
        continue;
      }
    }
    // Rules restored through user/ land in the live agent rules dir, so every Markdown there
    // passes the same content gate sync.mjs applies to data-root rules: hidden characters
    // that smuggle instructions past human review ("Rules File Backdoor"), plus a frontmatter
    // description. omp loads agent-context Markdown elsewhere in the snapshot as always-on
    // instructions too (AGENTS.md, RULES.md, SYSTEM.md, CLAUDE.md), so every .md/.mdc gets the
    // hidden-character scan; only the snapshot's own rules dir is a rule and needs the frontmatter.
    // The extension matches without case: on a case-insensitive filesystem (Windows, macOS)
    // omp's fixed-path read of RULES.md opens a RULES.MD too.
    // A file with problems is rejected per item: no plan entry, no manifest record, no conflict.
    // Files inside a skill folder are judged by the whole-skill gate above, never per file.
    if (/\.(md|mdc)$/i.test(rel) && !skillEntrypoints.has(srcPath)
        && !skillRelPrefixes.some(p => rel === p || rel.startsWith(`${p}/`))) {
      const problems = ruleProblems(`user/${rel}`, src.toString('utf8'), { frontmatter: /^omp\/agent\/rules\/[^/]+\.mdc?$/.test(rel) });
      if (problems.length) {
        const first = describeProblem(problems[0]);
        failItem(`user/${rel}`, 'rejected', first.rule, first.at, problems.join('\n'));
        continue;
      }
    }
    // The machine text minus its deployment blocks (lib/data.mjs keeps the last kept line's
    // terminator). `dropped` holds credentials: never log it.
    const have = machineFingerprint(rel, machineBytes);
    // The snapshot comparison uses the layer-normalized form: a file whose only difference
    // from the snapshot is the layer prefix in re-rooted paths is unchanged.
    const haveLayer = layerMachineFingerprint(rel, machineBytes, machineSrc);
    // The record-match: the plain form (strip-era records, and every non-config file) or the
    // legacy form above (records a pre-strip alate wrote, entry included). A matched file was
    // not changed on the machine since the install, so the snapshot may replace it.
    const record = have !== null && (have === last[rel] || legacyFingerprint(rel, machineBytes) === last[rel]);
    if (record) recordedFp.set(rel, /** @type {string} */ (last[rel]));
    // The item key rides on every plan entry, so the per-item results can aggregate by key.
    const itemKey = `user/${rel}`;
    if (have === want && !layerMode) plan.push(['unchanged', dest, null, itemKey, null]);
    else if (layerMode && haveLayer === want) plan.push(['installed', dest, src, itemKey, layerLabel(rel, src, haveLayer)]);
    else if (layerMode && machineBytes !== null && !record) {
      // A machine change beyond the deployment blocks is never a refusal in layer mode:
      // machine state wins and rides into the new layer, --force takes the snapshot instead.
      // have !== want is implied by the branch above; layer mode never reaches conflicts.
      // Plugin install files are the exception: the provisioner itself runs bun install
      // over them, so a turn-edited copy must never ride into the new layer. The snapshot
      // wins, --force or not; a deliberate change goes through a data-repo commit.
      if (pluginInstallFile(rel)) {
        plan.push(['installed', dest, src, itemKey, layerLabel(rel, src, haveLayer)]);
        notes.push(`plugin install file takes the snapshot, machine change ignored: ${readDest}`);
      }
      else if (force) {
        plan.push(['installed', dest, src, itemKey, layerLabel(rel, src, haveLayer)]);
        notes.push(`machine change overridden by --force: ${readDest}`);
      } else {
        // A kept file can hold paths re-rooted into the live layer at its install, so they
        // re-root into the new layer and clean-up can delete the live one; paths into the
        // shared home stay shared.
        let keptBytes = machineBytes;
        // The entry is a deployment choice: a kept config.yml loses it here, the same way the
        // snapshot does above, so the choice never rides along with the machine part. A turn
        // writes the live layer, so its customDirectories goes the same way too, and a kept
        // copy the syntax gate refuses gives way to the snapshot, which passed it above.
        const gated = rel === 'omp/agent/config.yml' ? gatedConfig(keptBytes.toString('utf8')) : null;
        if (gated?.problems.length) {
          plan.push(['installed', dest, src, itemKey, layerLabel(rel, src, haveLayer)]);
          notes.push(`machine copy takes the snapshot, its YAML syntax is unsupported (${describeProblem(gated.problems[0]).rule}): ${readDest}`);
        } else {
          if (gated) {
            if (gated.dropped) notes.push(`user/${rel}: dropped skills.customDirectories from the kept machine copy (the skill gates never judge those folders)`);
            keptBytes = Buffer.from(gated.text, 'utf8');
          }
          if (/\.(?:json|ya?ml)$/.test(rel)) keptBytes = Buffer.from(remapHomePaths(keptBytes.toString('utf8'), machineSrc, /** @type {string} */ (newLayerDir)), 'utf8');
          plan.push(['installed', dest, keptBytes, itemKey, layerLabel(rel, keptBytes, haveLayer)]);
          notes.push(`machine change kept: ${readDest} (--force takes the snapshot)`);
        }
      }
    }
    else if (have === null || record || force) plan.push(['installed', dest, src, itemKey, layerLabel(rel, src, haveLayer)]);
    else conflicts.push(dest);
    current[rel] = want;
  }
  const workersRoot = join(data.dir, 'workers');
  /** @type {Set<string>} */
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
        // The compare base is the machine side (the live layer in layer mode), never the
        // fresh layer being written. Layer mode still writes every file and labels it;
        // in-place mode skips a matching copy.
        const liveCopy = join(readRoot, '.ottr', 'workers', project, file);
        // The compare base is machine side (the live layer in layer mode): the same alias
        // guard and single no-follow read every machine-side read gets, so a planted link or
        // special file refuses the run instead of being followed out of the layer.
        const liveBytes = readMachineFile(readRoot, liveCopy);
        const haveWorker = liveBytes !== null && sameContent('', liveBytes, src);
        plan.push(haveWorker && !layerMode ? ['unchanged', dest, null, `workers/${project}/${file}`, null]
          : ['installed', dest, src, `workers/${project}/${file}`, layerMode ? (haveWorker ? 'unchanged' : liveBytes !== null ? 'updated' : 'added') : null]);
      }
    }
  }
  // Ottr ships its agent skills in its own checkout, alate vendors the whole tree at one
  // pinned commit (lib/shipped.mjs, shipped/ottr/.agents/skills), and omp only loads
  // .agents/skills for runs inside the Ottr checkout itself — so every provision installs
  // every vendored folder under ~/.agents/skills/<name>. The pinned whole tree is the
  // source, not a fixed list. The same gates apply in the same order as for snapshot
  // skills: a data repo skill of the same name wins (presence-based, any skills/ or
  // managed-skills/ folder name), then the structure gate, then the scan gate below — a
  // rejection fails that one skill per item and never stops the others. The vendored bytes
  // are upstream content, never captured machine config, so no forTarget and no
  // remapHomePaths apply.
  // Presence-based, but only for a copy the gates so far accept: a rejected snapshot skill
  // (no origin, structure) installs nothing and its rels leave the plan, the manifest, and
  // the conflicts, so counting it would suppress the shipped skill here and then let the
  // deletion path remove the home's copy — one sync-user capture round trip disabled every
  // shipped skill (ALAT-124). sync-user leaves a name out of the capture only when its
  // bytes equal the vendored copy, so the normal round trip never creates such a copy.
  const snapshotSkillNames = new Set(skillDirs.filter(dir => !rejectedSkills.has(dir)).map(dir => basename(dir)));
  /** @type {string[]} */
  const shippedScanDirs = [];
  /** @type {Map<string, string>} */
  const shippedDirKey = new Map();
  // Fail closed: shippedSkills throws when the vendored tree is absent or unreadable, and
  // an empty enumeration would delete the shipped skills already in the home as obsolete.
  // This sits before the scan gate, the deletions, and the layer creation, so the throw
  // flows through the main try: fatal results file, exit 1, nothing written or deleted,
  // and in layer mode no layer is created or switched. A tree that exists but holds zero
  // folders stays the note below, not an error.
  /** @type {{ name: string, dir: string }[]} */
  let shippedList;
  try {
    shippedList = shippedSkills(toolRoot);
  } catch (err) {
    throw new Error(`refusing to install: the vendored shipped skills tree ${SHIPPED_TREE}/${SHIPPED_SKILLS_DIR} is missing or unreadable (/** @type {Error} */ (err).message); a run without it would delete the shipped skills already in the home`);
  }
  if (!shippedList.length) {
    notes.push(`shipped skills: the vendored tree ${SHIPPED_TREE}/${SHIPPED_SKILLS_DIR} holds no skill folders; nothing shipped installs`);
  }
  for (const { name, dir: vendored } of shippedList) {
    if (snapshotSkillNames.has(name)) {
      notes.push(`shipped skill ${name} skipped: the data repo has its own copy`);
      continue;
    }
    const entrypoint = join(vendored, 'SKILL.md');
    const label = `user/agents/skills/${name}/SKILL.md`;
    const problems = [];
    let text;
    try {
      assertSourceInside(toolRoot, entrypoint);
      if (!statSync(entrypoint).isFile()) throw new Error('SKILL.md must be a regular file');
      text = readFileSync(entrypoint, 'utf8');
    } catch (err) {
      problems.push(`${label}: cannot read SKILL.md (/** @type {Error} */ (err).message)`);
    }
    if (text !== undefined) problems.push(...skillProblems(label, text));
    if (problems.length) {
      const first = describeProblem(problems[0]);
      failItem(`user/agents/skills/${name}`, 'rejected', first.rule, first.at, problems.join('\n'));
      continue;
    }
    // Hidden-character gate over the whole vendored folder: one bad .md/.mdc file (the
    // SKILL.md entrypoint is judged by skillProblems above) rejects the whole skill under
    // its skill key, like the snapshot walk — the scan verdict covered the full source
    // folder, not the installed subset a per-file rejection would leave. A rejected skill
    // is never planned here and never joins the scan gate below.
    /** @type {string[]} */
    const hidden = [];
    for (const file of walk(vendored)) {
      if (!/\.(md|mdc)$/i.test(file) || file === 'SKILL.md') continue;
      const label = `user/agents/skills/${name}/${file}`;
      const srcPath = join(vendored, file);
      try {
        assertSourceInside(vendored, srcPath);
      } catch (err) {
        throw new Error(`${label}: ${/** @type {Error} */ (err).message}`);
      }
      hidden.push(...ruleProblems(label, readFileSync(srcPath, 'utf8'), { frontmatter: false }));
    }
    if (hidden.length) {
      const first = describeProblem(hidden[0]);
      failItem(`user/agents/skills/${name}`, 'rejected', first.rule, first.at, hidden.join('\n'));
      rejectedSkills.add(vendored);
      shippedDirKey.set(vendored, `user/agents/skills/${name}`);
      continue;
    }
    for (const file of walk(vendored)) {
      const rel = `agents/skills/${name}/${file}`;
      relSource.set(rel, vendored);
      const srcPath = join(vendored, file);
      try {
        assertSourceInside(vendored, srcPath);
      } catch (err) {
        throw new Error(`user/${rel}: ${/** @type {Error} */ (err).message}`);
      }
      const dest = join(writeRoot, '.' + rel);
      checkDestination(writeRoot, dest);
      const readDest = join(readRoot, '.' + rel);
      const machineBytes = readMachineFile(readRoot, readDest);
      const srcBytes = readFileSync(srcPath);
      const want = fingerprint(rel, srcBytes);
      const have = machineBytes !== null ? fingerprint(rel, machineBytes) : null;
      const record = have !== null && have === last[rel];
      if (record) recordedFp.set(rel, last[rel]);
      const itemKey = `user/${rel}`;
      if (have === want && !layerMode) plan.push(['unchanged', dest, null, itemKey, null]);
      else if (layerMode && have === want) plan.push(['installed', dest, srcBytes, itemKey, layerLabel(rel, srcBytes, have)]);
      else if (layerMode && machineBytes !== null && !record) {
        // Same machine-state rules as snapshot skills: layer mode keeps the machine copy,
        // --force takes the shipped bytes.
        if (force) {
          plan.push(['installed', dest, srcBytes, itemKey, layerLabel(rel, srcBytes, have)]);
          notes.push(`machine change overridden by --force: ${readDest}`);
        } else {
          plan.push(['installed', dest, machineBytes, itemKey, layerLabel(rel, machineBytes, have)]);
          notes.push(`machine change kept: ${readDest} (--force takes the snapshot)`);
        }
      }
      else if (have === null || record || force) plan.push(['installed', dest, srcBytes, itemKey, layerLabel(rel, srcBytes, have)]);
      else conflicts.push(dest);
      current[rel] = want;
    }
    shippedScanDirs.push(vendored);
    shippedDirKey.set(vendored, `user/agents/skills/${name}`);
  }
  // In-place scan gate: before any write, and before the deletions are computed, so a skill
  // the scan rejects is dropped from the plan, the manifest, and the conflicts first — its
  // installed record-matching copy then flows into the deletion loop below, and its own
  // changed copy never blocks the conflicts refusal. Skills already recorded as unchanged are
  // scanned again too: a copy a pre-gate alate installed was never scanned, and the manifest
  // cannot prove it was. The shipped skills join the same single runScan call, with their own
  // rejection keys (user/agents/skills/<name>) and their own prefix pass for the plan,
  // current, and conflicts cleanup. Layer mode scans the installed layer after the writes
  // instead: the shipped skills ride in the layer, and the existing post-write cleanup
  // removes a rejected one.
  // CRLF guard (ALAT-178), before the scan and before any write, in both modes: the
  // scan verdicts bind bytes, and the shipped baselines fingerprint LF bytes. A stale
  // checkout (made before the data repo's .gitattributes, with core.autocrlf=true) or
  // a CRLF text file committed against it changes every finding key, so no baseline
  // entry matches and the gate would reject whole skills that are fine. Refuse with
  // the fix instead. Unreadable files stay out (the hash and scan gates report them),
  // and a NUL byte marks binary content whose CR bytes are data, not line endings.
  /** @type {string[]} */
  const crlfFiles = [];
  for (const dir of skillDirs) {
    if (rejectedSkills.has(dir)) continue;
    if (!existsSync(join(dir, SHIPPED_BASELINE))) continue;
    for (const file of walk(dir)) {
      let bytes;
      try {
        bytes = readFileSync(join(dir, file));
      } catch {
        continue;
      }
      if (bytes.includes(0) || !bytes.includes(13)) continue;
      crlfFiles.push(`${skillKey(userRoot, dir)}/${file}`);
    }
  }
  if (crlfFiles.length) {
    crlfFiles.sort();
    const named = crlfFiles.slice(0, 10);
    throw new Error([
      `refusing: ${crlfFiles.length} text file${crlfFiles.length === 1 ? '' : 's'} in baseline-shipping skills of ${data.dir} hold CR bytes (CRLF line endings).`,
      'The scan baselines fingerprint LF bytes, so CRLF source bytes would reject skills that are fine.',
      'Fix the data repo checkout, then run again: rewrite the files from HEAD (remove them and run git checkout -- . in the data repo), or set core.autocrlf=false there.',
      ...named.map(f => `  ${f}`),
      ...(crlfFiles.length > named.length ? [`  … and ${crlfFiles.length - named.length} more`] : []),
    ].join('\n'));
  }
  if (!layerMode && (skillDirs.length || shippedScanDirs.length)) {
    /** @param {string} dir @returns {string} */
    const itemKey = dir => shippedDirKey.get(dir) ?? skillKey(userRoot, dir);
    const scan = await runScan([...skillDirs.filter(dir => !rejectedSkills.has(dir)), ...shippedScanDirs], itemKey, reviews);
    // Retention applies to scan-gate rejections only (specs/provision-item-by-item.md):
    // a skill a pre-walk gate rejected (alias, no origin, structure, hidden characters)
    // keeps today's deletion rule, so the retention paths below must not see it.
    /** @type {Set<string>} */
    const scanRejected = new Set();
    for (const [dir, info] of scan.rejected) {
      addScanRejection(itemKey(dir), info);
      rejectedSkills.add(dir);
      scanRejected.add(dir);
    }
    // Drop every rel inside a rejected skill from the plan, the manifest, and the conflicts.
    // A rejection strips only the entries its own dir contributed (relSource): a rejected
    // snapshot copy of a shipped name must never strip the shipped walk's rels of the same
    // name, or the deletion path below removes the shipped files the home still holds
    // (ALAT-124); and a scan-rejected shipped copy must never strip an accepted snapshot
    // copy's rels of the same name.
    const snapshotPrefixes = [...rejectedSkills].filter(dir => !shippedDirKey.has(dir))
      .map(dir => relative(userRoot, dir).split(sep).join('/'));
    /** @param {string} rel @returns {boolean} */
    const relRejected = rel => {
      const source = relSource.get(rel);
      if (source === 'snapshot')
        return snapshotPrefixes.some(p => rel === p || rel.startsWith(`${p}/`));
      return source !== undefined && rejectedSkills.has(source);
    };
    for (let i = plan.length - 1; i >= 0; i--) if (relRejected(plan[i][3].slice('user/'.length))) plan.splice(i, 1);
    // A scan-rejected skill never installs its snapshot bytes, but its installed copy
    // stays whole: a record-matching file keeps its record entry and a warning note, so a
    // spurious rejection — a stale checkout's CRLF bytes against LF baseline
    // fingerprints, a scanner regression — never deletes a good install. A file that
    // changed on the machine keeps the existing path: it stays with its note and loses
    // its record (specs/provision-item-by-item.md).
    // Ownership helpers: the rel-space prefix of a rejected skill (snapshot spelling for
    // snapshot dirs, the shipped key's for vendored dirs) and the longest rejected prefix
    // a rel sits under. Skill dirs never nest today, but the ownership must not depend
    // on that.
    /** @param {string} dir @returns {string} */
    const rejectedPrefix = dir => {
      const key = shippedDirKey.get(dir);
      return key !== undefined ? key.slice('user/'.length) : relative(userRoot, dir).split(sep).join('/');
    };
    /** @param {string} rel @returns {string | null} */
    const owningRejectedKey = rel => {
      let best = '';
      for (const dir of scanRejected) {
        const p = rejectedPrefix(dir);
        if ((rel === p || rel.startsWith(`${p}/`)) && p.length > best.length) best = p;
      }
      return best ? `user/${best}` : null;
    };
    /** @type {Set<string>} */
    const keptKeys = new Set();
    for (const rel of Object.keys(current)) {
      if (!relRejected(rel)) continue;
      const fp = recordedFp.get(rel);
      if (fp === undefined) {
        delete current[rel];
        continue;
      }
      current[rel] = fp;
      const source = relSource.get(rel);
      if (source === 'snapshot') {
        const owner = owningRejectedKey(rel);
        if (owner !== null) keptKeys.add(owner);
      } else if (source !== undefined) {
        keptKeys.add(/** @type {string} */ (shippedDirKey.get(source)));
      }
    }
    // The copy is whole, never partial: a recorded file the rejected snapshot or vendored
    // tree no longer ships never entered `current`, so without this the deletion path
    // below would take it while the run reports the old version kept. Resurrect every
    // recorded rel under a rejected prefix whose machine copy still matches its record,
    // through the same alias guard and single no-follow read the deletion path uses, so
    // a planted link refuses instead of being followed.
    for (const [rel, fp] of Object.entries(last)) {
      if (typeof fp !== 'string' || Object.hasOwn(current, rel)) continue;
      const owner = owningRejectedKey(rel);
      if (owner === null) continue;
      const dest = join(home, '.' + rel);
      checkDestination(home, dest);
      const bytes = readMachineFile(home, dest);
      if (bytes === null || machineFingerprint(rel, bytes) !== fp) continue;
      current[rel] = fp;
      keptKeys.add(owner);
    }
    for (const key of keptKeys) notes.push(`scan rejected ${key}, kept the previously installed version`);
    conflicts = conflicts.filter(dest => {
      const rel = relative(home, dest).split(sep).join('/');
      return !relRejected(rel.startsWith('.') ? rel.slice(1) : rel);
    });
  }
  // A path the snapshot dropped: in-place mode deletes the machine copy when it still
  // holds what alate last installed (nobody changed it since), keeps it with a note when
  // it changed here, and drops the record either way — alate no longer vouches for a path
  // the snapshot lacks. --force never deletes: a file that does not match its record is
  // never deleted. Layer mode counts the live layer's dropped files for the summary and
  // leaves every layer dir untouched on disk.
  /** @type {[string, string][]} */
  const deletions = [];
  let layerDropped = 0;
  for (const [rel, fp] of Object.entries(last)) {
    if (Object.hasOwn(current, rel) || typeof fp !== 'string') continue;
    if (layerMode) {
      // The new layer simply leaves a dropped file out; the live layer stays untouched on
      // disk. A first layer (no resolvable live layer) has nothing to compare with.
      if (readRoot === newLayerDir) continue;
      const dest = join(readRoot, '.' + rel);
      // Same guard as the machine reads in the walk: never follow an alias out of the
      // live layer; a violated guard refuses the whole run.
      checkDestination(readRoot, dest);
      if (!existsSync(dest)) continue;
      layerDropped++;
      if (machineFingerprint(rel, readMachineFile(readRoot, dest)) !== fp) notes.push(`changed here, left out of the new layer: ${dest}`);
      continue;
    }
    const dest = join(home, '.' + rel);
    // Same guard as installs: never delete through a symlink, a hardlink alias or a
    // directory, and never outside the home; a violated guard refuses the whole run.
    checkDestination(home, dest);
    if (!existsSync(dest)) continue;
    if (machineFingerprint(rel, readMachineFile(home, dest)) === fp) deletions.push([dest, join(home, '.' + rel.split('/')[0])]);
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
  let layerCreated = false;
  /** @type {{ dir: string, id: string } | null} */
  let layerPin = null;
  // A turn can rename the fresh layer away and put a symlink or its own directory at the
  // path while the build runs; every later write and the switch check the pinned identity.
  const assertLayer = () => { if (layerPin) assertDirIdentity(layerPin.dir, layerPin.id); };
  let tmpLink = null;
  try {
    if (layerMode) {
      // The layer dir exists only after every content gate passed (rule gate, worker validation).
      // A turn can write the shared home, so the layer path is created exclusively and never
      // through a link: a planted entry at the layer name or a symlinked .alate/layers refuses
      // the run, where a recursive mkdir adopted it and every write landed at the link target.
      makeDirInside(layerHome, /** @type {string} */ (newLayerDir), true);
      layerCreated = true;
      layerPin = { dir: /** @type {string} */ (newLayerDir), id: dirIdentity(/** @type {string} */ (newLayerDir)) };
      // The rules dir is created here, through no link. The nested sync gets the home as the
      // root of its path checks and the layer identity as its pin: only the layer root's
      // identity plus a symlink-free path proves containment (a pinned rules dir could be
      // moved into a replacement layer and keep its inode).
      const rulesDir = join(/** @type {string} */ (newLayerDir), '.omp', 'agent', 'rules');
      makeDirInside(layerHome, rulesDir);
      assertLayer();
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
      // The nested sync labels its rules against the live layer's rules dir when there is
      // one, so an unchanged layer install reports no rule changes. An absent rules dir is
      // fine: sync labels every rule 'added' against it. A present one is a read root for
      // the child, not a write destination: resolve it (any planted symlink chain) and
      // refuse when it leaves the live layer, before sync reads anything.
      const compareRules = readRoot === newLayerDir ? null : join(readRoot, '.omp', 'agent', 'rules');
      if (compareRules && lstatSync(compareRules, { throwIfNoEntry: false })) assertSourceInside(readRoot, compareRules);
      const rules = spawnSync(process.execPath, [join(toolDir, 'sync.mjs'), rulesDir, '--data', data.dir, '--within', layerHome, '--layer', layerPin.dir, '--pin', layerPin.id, ...(compareRules ? ['--compare', compareRules] : [])], { encoding: 'utf8', env: rulesEnv });
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
    // Layer mode counts the labels against the live layer; every plan entry still writes,
    // because the fresh layer needs the bytes even when the live layer already holds them.
    const labels = { added: 0, updated: 0, unchanged: 0 };
    for (const [kind, dest, bytes, , label] of plan) {
      if (!layerMode && kind === 'unchanged') { unchanged++; continue; }
      writeFileInside(layerHome, dest, /** @type {Buffer} */ (bytes), false, layerPin);
      installed++;
      // A layer-mode plan entry always carries a label string; null is the in-place shape.
      if (layerMode) labels[/** @type {'added' | 'updated' | 'unchanged'} */ (label)]++;
    }
    let deleted = 0;
    for (const [dest, root] of deletions) {
      unlinkSync(dest);
      console.log(`deleted  ${relative(home, dest)}`);
      pruneEmptyDirs(dest, root);
      deleted++;
    }
    if (layerMode) console.log(`${labels.updated} updated, ${labels.added} added, ${labels.unchanged} unchanged, ${layerDropped} deleted in ${writeRoot}`);
    else console.log(`${installed} installed, ${unchanged} unchanged, ${deleted} deleted in ${writeRoot}`);
    for (const note of notes) console.log(note);

    if (layerMode) {
      assertLayer();
      const layerSkillDirs = collectSkillDirs(/** @type {string} */ (newLayerDir));
      if (layerSkillDirs.length) {
        /** @param {string} dir @returns {string} */
        const itemKey = dir => skillKey(/** @type {string} */ (newLayerDir), dir);
        const scan = await runScan(layerSkillDirs, itemKey, reviews);
        for (const [dir, info] of scan.rejected) {
          // The manifest must never name a file the layer lacks: the rejected skill dir is
          // removed from the fresh layer, and its rels from the record, before the switch.
          // Never delete through a swapped layer or a symlink planted on the skill's path.
          assertLayer();
          makeDirInside(layerHome, dir);
          rmSync(dir, { recursive: true, force: true });
          addScanRejection(itemKey(dir), info);
          // The layer mirrors the home in dot-dirs (.omp); the record keys use the snapshot
          // spelling (omp), so the leading dot drops out of the top-level segment.
          const layerRel = relative(/** @type {string} */ (newLayerDir), dir).split(sep).join('/');
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
    // A fresh layer never holds its record yet: O_EXCL refuses one planted there.
    writeFileInside(layerHome, manifest, `${JSON.stringify(current, null, 2)}\n`, layerMode, layerPin);

    let pluginsStatus = /** @type {'installed' | 'unchanged' | null} */ (null);
    const pluginsInSnapshot = existsSync(join(userRoot, 'omp', 'plugins', 'package.json'));
    if (!skipPlugins && pluginsInSnapshot) {
      const pluginsDir = join(writeRoot, '.omp', 'plugins');
      // bun install adopts an ancestor package.json whose workspaces glob matches the install
      // dir as its workspace root and runs that root's lifecycle scripts, and the ancestors of
      // pluginsDir sit in the turn-writable home. bun ends that search at the first parent
      // that declares workspaces, matching or not (seen on Bun 1.4.2 and 1.4.4), so a barrier
      // in pluginsDir's parent hides every ancestor above it. bun still runs in pluginsDir
      // itself, so relative file: deps and workspace build output keep their real paths. An
      // existing entry at the barrier path moves aside (rename never follows a link) and
      // comes back after the install; the exclusive write refuses a path replanted meanwhile.
      assertLayer();
      const barrier = join(writeRoot, '.omp', 'package.json');
      const aside = lstatSync(barrier, { throwIfNoEntry: false }) ? `${barrier}.alate-aside-${process.pid}` : null;
      if (aside) renameSync(barrier, aside);
      // A fresh, provisioner-private package cache per install: bun copies cached package
      // bytes without checking them against bun.lock's integrity (measured on 1.4.4), and the
      // shared ~/.bun cache is turn-writable (each layer links .bun back to the home). The
      // env var wins over any bunfig.toml cache dir, so a planted bunfig cannot redirect it.
      const bunCache = mkdtempSync(join(tmpdir(), 'alate-bun-cache-'));
      let bun;
      try {
        writeFileSync(barrier, '{ "private": true, "workspaces": [] }\n', { flag: 'wx' });
        // copyfile, never bun's hardlink default: a file: dep's snapshot source would end up
        // with a second link, and the alias guards on machine reads and writes would refuse
        // the next provision. Planted aliases still refuse; the provisioner creates none.
        // The hoisted linker too: a manifest with workspaces defaults to bun's isolated
        // linker, which hardlinks file: deps whatever the backend (Bun 1.4.2 and 1.4.4).
        const bunArgs = ['install', '--frozen-lockfile', '--backend', 'copyfile', '--linker', 'hoisted'];
        if (!allowPluginScripts) bunArgs.push('--ignore-scripts');
        bun = spawnSync('bun', bunArgs, {
          cwd: pluginsDir,
          stdio: 'inherit',
          env: { ...Object.fromEntries(BUN_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), BUN_INSTALL_CACHE_DIR: bunCache },
        });
      } finally {
        rmSync(bunCache, { recursive: true, force: true });
        rmSync(barrier, { force: true });
        if (aside) renameSync(aside, barrier);
      }
      if (bun.error || bun.status !== 0) {
        throw new Error(/** @type {NodeJS.ErrnoException} */ (bun.error)?.code === 'ENOENT' ? 'bun not found; cannot install plugins.' : `bun install failed in ${pluginsDir}`);
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
        if (lstatSync(join(/** @type {string} */ (newLayerDir), rel), { throwIfNoEntry: false })) {
          console.log('layer keeps snapshot content: ' + rel);
          continue;
        }
        const target = join(layerHome, rel);
        mkdirSync(dirname(target), { recursive: true });
        if (dirLinks.includes(rel)) mkdirSync(target, { recursive: true });
        assertLayer();
        makeDirInside(layerHome, dirname(join(/** @type {string} */ (newLayerDir), rel)));
        symlinkSync(target, join(/** @type {string} */ (newLayerDir), rel));
      }
      // A reader of current sees the old or the new target, never a gap: rename() over the
      // symlink is atomic.
      let previousTarget = null;
      try { previousTarget = realpathSync(currentLink); } catch { /* first layer: nothing before it */ }
      tmpLink = join(base, `.current-${process.pid}-${Date.now()}.tmp`);
      // The switch makes the layer path live: it must still name the directory this run built.
      assertLayer();
      symlinkSync(/** @type {string} */ (newLayerDir), tmpLink);
      renameSync(tmpLink, currentLink);
      switched = true;
      console.log(`switched ${currentLink} -> ${newLayerDir}`);
      // Clean-up keeps the live layer, the one before it, the new one, and anything a pinned
      // turn holds (in-use.json; absent means no runner has pinned a layer yet). An unreadable
      // record stops deletion: safety over disk space. Keep entries are layer ids, never full
      // paths: realpath values and join-built paths must never disagree about the spelling of
      // the same layer, or clean-up deletes the layer current points at.
      const keep = new Set([basename(/** @type {string} */ (newLayerDir))]);
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
    /** @param {string} key @returns {string} */
    const itemKeyOf = key => {
      const m = /^user\/((?:omp\/agent\/(?:skills|managed-skills)|agents\/skills)\/[^/]+)\//.exec(key);
      if (m) return `user/${m[1]}`;
      if (key.startsWith('user/omp/plugins')) return 'user/omp/plugins';
      return key;
    };
    /** @type {Map<string, ProvisionItem['status']>} */
    const statuses = new Map();
    if (layerMode) {
      // The labels aggregate per key: a key whose files are all added stays added, any
      // other change makes it updated, unchanged files keep it unchanged.
      const counts = new Map();
      for (const [, , , key, label] of plan) {
        const item = itemKeyOf(key);
        const agg = counts.get(item) ?? { added: 0, changed: 0, total: 0 };
        agg.total++;
        if (label === 'added') agg.added++;
        else if (label === 'updated') agg.changed++;
        counts.set(item, agg);
        statuses.set(item, agg.added === agg.total ? 'added' : agg.added + agg.changed > 0 ? 'updated' : 'unchanged');
      }
    } else {
      for (const [kind, , , key] of plan) {
        const item = itemKeyOf(key);
        const prev = statuses.get(item);
        statuses.set(item, kind === 'installed' || prev === 'installed' ? 'installed' : 'unchanged');
      }
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
    // A layer that never went live must not survive its own failed install; a path this run
    // did not create (a refused planted entry, or a layer a turn replaced) stays untouched.
    if (layerMode && !switched && layerCreated) {
      let ours = true;
      try { assertLayer(); } catch { ours = false; }
      if (ours) rmSync(/** @type {string} */ (newLayerDir), { recursive: true, force: true });
      else console.error(`left in place: ${newLayerDir} is no longer the layer this run created`);
    }
    if (tmpLink) rmSync(tmpLink, { force: true });
    throw err;
  }
} catch (err) {
  console.error(/** @type {Error} */ (err).message);
  fatal = true;
  error = /** @type {Error} */ (err).message;
  process.exitCode = 1; // not process.exit: finally below must still remove a cloned temp dir
} finally {
  // The server's per-item results, whatever the run's outcome; a refusal carries
  // fatal: true and the items the gates judged before it.
  if (process.env[PROVISION_ENV]) writeProvisionResults(/** @type {string} */ (process.env[PROVISION_ENV]), { fatal, error, items });
  cleanupData(data);
}
