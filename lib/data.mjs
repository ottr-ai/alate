// Shared arg parsing + data-dir resolution for the provisioning scripts.
// The tool repo ships no data: rules, user/ and projects/ live in a separate data repo
// (default: ../agent-data beside this checkout).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url))); // lib/../ = tool checkout

// Snapshot layout: the home dot-dir ~/.agents is stored under user/ without the leading dot
// (user/agents/...). sync.mjs, the update checker and the dashboard inventory all read this
// one name, so a reader can never drift back to the dotted home form.
export const SNAP_AGENTS_DIR = 'agents';

export const die = message => {
  console.error(message);
  process.exit(1);
};

// ALATE_KEEP_TEMP keeps every temp fixture for strict no-delete runs.
export const keepTemp = () => !!process.env.ALATE_KEEP_TEMP;

// Property-test driver for the self-checks: gate tier is 200 runs at the fixed seed 42,
// so every run and every mutant sees the same inputs; PROP_RUNS=<n> re-seeds from the
// clock for the review deep tier. A failure reports the seed and the failing input.
// ponytail: no shrinking; inputs grow slowly, so the first failure stays small. Upgrade: fast-check.
export function forAll(gen, prop) {
  const runs = Number(process.env.PROP_RUNS ?? 200);
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error(`bad PROP_RUNS: ${process.env.PROP_RUNS}`);
  const seed = process.env.PROP_RUNS === undefined ? 42 : Date.now() >>> 0;
  let s = seed;
  const rand = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < runs; i++) {
    const input = gen(rand, 1 + Math.floor(i / 10));
    try {
      prop(input);
    } catch (e) {
      throw new Error(`property failed: seed=${seed} run=${i} input=${JSON.stringify(input)}: ${e.message}`);
    }
  }
}

// Snapshots are captured on Windows; Docker workers and CI run Linux. JSON config is adapted
// to its target first, in both directions: an absolute path of the captured platform into the
// captured layer (a segment in `roots`, e.g. .omp) is re-rooted at the target home — a Windows
// path on a Linux target, a POSIX absolute path (a Linux worker capture) on a Windows target.
// Only strings that pass through a known root move; everything else installs as captured. In
// omp's mcp.json, a `cmd /c <program>` wrapper
// exists only because Windows cannot spawn npx's .cmd shim directly, so the program runs as the
// command; an environment variable that still holds a Windows path is dropped, so the server's
// own default applies; a server that still needs Windows (an .exe/.cmd/.bat/.ps1 command, a
// Windows path left in its command or args) goes on omp's own disabledServers list. The Linux
// targets are containers that run as root, without a display, with parallel sessions in one home,
// so chrome-devtools-mcp gets --headless, --isolated (a fixed profile dir would collide) and
// Chrome's --no-sandbox (the sandbox refuses root). Returns the input bytes when nothing applies,
// plus one note per change.
// ponytail: both capture platforms (Windows, Linux worker) port to the one target shape used
// today (a home); a target option for a Linux desktop would need its own direction.
const WIN_PATH = /^[A-Za-z]:[\\/]/;
const CMD = /^cmd(\.exe)?$/i;
const WIN_ONLY_COMMAND = /^cmd(\.exe)?$|\.(exe|cmd|bat|ps1)$/i;
const CHROME_DEVTOOLS = /^chrome-devtools-mcp(@|$)/;
const CHROME_FLAGS = ['--headless', '--isolated', '--chrome-arg=--no-sandbox'];

// unwrapCmd(server): drop a Windows `cmd /c <program>` wrapper from an MCP server config.
// cmd's own switches (/d, /s, /q) may precede /c; a program with spaces stays wrapped (cmd
// parses it). Returns { command, args } with the wrapper removed, or null when the server is
// not wrapped. forTarget() ports a capture to its target's platform; sync.mjs's origin gate reads
// through the wrapper to the real program.
export function unwrapCmd(server) {
  const args = Array.isArray(server?.args) ? server.args : [];
  const c = args.findIndex(a => /^\/c$/i.test(a));
  if (!CMD.test(String(server?.command ?? '')) || c < 0 || !args.slice(0, c).every(a => /^\/[a-z]$/i.test(a))
    || typeof args[c + 1] !== 'string' || !/^\S+$/.test(args[c + 1])) return null;
  return { command: args[c + 1], args: args.slice(c + 2) };
}

export function forTarget(rel, bytes, { home, platform, roots }) {
  if (!rel.endsWith('.json')) return { bytes, notes: [] };
  const winTarget = platform === 'win32';
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { bytes, notes: [] }; // not JSON after all: installed as captured
  }
  const notes = [];
  let moved = 0;
  // An absolute path of the captured platform moves when it passes through a known layer
  // root; any other string has no target home, so it stays as captured. The target decides
  // the join, so the port lands with the target's separators.
  const capturedPath = winTarget ? (v => v.startsWith('/')) : (v => WIN_PATH.test(v));
  const joinPath = winTarget ? win32.join : posix.join;
  const rebase = v => {
    if (typeof v === 'string') {
      if (!capturedPath(v)) return v;
      const parts = v.split(/[\\/]+/);
      const i = parts.findIndex(p => roots.has(p));
      if (i < 0) return v;
      moved++;
      return joinPath(home, ...parts.slice(i));
    }
    if (Array.isArray(v)) return v.map(rebase);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebase(x)]));
    return v;
  };
  doc = rebase(doc);
  if (moved) notes.push(`${rel}: ${moved} ${winTarget ? 'POSIX' : 'Windows'} path(s) now point into ${home}`);
  // The rest is Linux-container adaptation only: a Windows target runs the capture as is.
  if (!winTarget && rel === 'omp/agent/mcp.json' && doc?.mcpServers && typeof doc.mcpServers === 'object') {
    const winPath = v => (typeof v === 'string' ? WIN_PATH.test(v) : !!v && typeof v === 'object' && Object.values(v).some(winPath));
    const disabled = new Set(Array.isArray(doc.disabledServers) ? doc.disabledServers : []);
    let added = 0;
    for (const [name, server] of Object.entries(doc.mcpServers)) {
      if (disabled.has(name) || !server || typeof server !== 'object') continue;
      const bare = unwrapCmd(server);
      if (bare) {
        server.command = bare.command;
        server.args = bare.args;
        notes.push(`${rel}: MCP server ${name} runs ${bare.command} directly, without cmd /c`);
      }
      for (const [key, value] of Object.entries(server.env && typeof server.env === 'object' ? server.env : {})) {
        if (!winPath(value)) continue;
        delete server.env[key];
        notes.push(`${rel}: MCP server ${name}: ${key} held a Windows path, so it is dropped here`);
      }
      const argv = Array.isArray(server.args) ? server.args : [];
      const flags = CHROME_FLAGS.filter(f => !argv.includes(f));
      if (flags.length && [server.command, ...argv].some(a => CHROME_DEVTOOLS.test(String(a)))) {
        server.args = [...argv, ...flags];
        notes.push(`${rel}: MCP server ${name} runs Chrome headless and isolated, without its sandbox`);
      }
      const why = WIN_ONLY_COMMAND.test(String(server.command ?? '')) ? `runs through ${server.command}`
        : winPath(server) ? 'points at a Windows path' : null;
      if (!why) continue;
      disabled.add(name);
      added++;
      notes.push(`${rel}: MCP server ${name} ${why}, so it is disabled here`);
    }
    if (added) doc.disabledServers = [...disabled].sort();
  }
  return notes.length ? { bytes: Buffer.from(`${JSON.stringify(doc, null, 2)}\n`), notes } : { bytes, notes };
}

// Repos use autocrlf; compare modulo CRLF so a checked-out copy and a machine copy never
// look different. latin1 maps bytes one-to-one, so non-UTF-8 files compare byte for byte.
export const normText = bytes => bytes.toString('latin1').replaceAll('\r\n', '\n');

// omp stamps updatedAt in its marketplace registry on every catalog refresh, so a live
// registry drifts from the snapshot without a change of content; that drift is no conflict.
// install-user.mjs records these fingerprints of what it installed, so the same rules decide
// whether a machine file still holds that content.
export function fingerprint(rel, bytes) {
  let text = normText(bytes);
  if (rel === 'omp/marketplaces.json') {
    try {
      text = JSON.stringify(JSON.parse(bytes.toString('utf8')), (k, v) => (k === 'updatedAt' ? undefined : v));
    } catch {
      // unparsable: its raw text is the content, so it differs from any parsable registry
    }
  }
  return createHash('sha256').update(text).digest('hex');
}

export const sameContent = (rel, machine, snapshot) => fingerprint(rel, machine) === fingerprint(rel, snapshot);

// The top-level `hindsight` and `alate` blocks of .omp/agent/config.yml are deployment
// settings: the target's endpoints and credentials, never part of the portable user layer.
// sync-user.mjs drops them on capture; install-user.mjs re-appends the target's own. A block
// starts at a top-level hindsight:/alate: key (bare or quoted) and runs until the next
// top-level key; the BOM goes with it. Returns the lines outside those blocks (kept) and the
// dropped lines, both byte for byte; [...kept, ...dropped].join('\n') rebuilds the input.
// `tail` is true when the text ends inside a dropped block: the block then took the text's
// final line, and a terminator must go back on when the blocks are stripped off. Never log
// `dropped`: it holds credentials.
export function splitDeploymentBlocks(text) {
  let excluded = false;
  const kept = [], dropped = [];
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('#'))
      excluded = /^(?:hindsight|alate|"(?:hindsight|alate)"|'(?:hindsight|alate)')[ \t]*:/.test(line);
    (excluded ? dropped : kept).push(line);
  }
  return { kept, dropped, tail: excluded };
}

// The text of a config without its deployment blocks, per the rule above: the kept lines,
// and the line end of the last kept line when a trailing block took it (`tail`). Capture and
// install-user both compare through this text, so they cannot disagree by one terminator.
// A file that holds only deployment blocks gives an empty text.
export function withoutDeploymentBlocks(text) {
  const { kept, tail } = splitDeploymentBlocks(text);
  const base = kept.join('\n');
  return base && tail ? `${base}\n` : base;
}

// The top-level `memory:` key's direct `backend:` entry of .omp/agent/config.yml is a
// deployment choice, not agent-layer content: the board derives the backend from the
// deployment (HINDSIGHT_API_URL or a saved Settings URL, mnemopi otherwise) and injects it
// into every omp spawn with a --config overlay. sync-user.mjs drops the entry on capture;
// install-user.mjs drops it from the snapshot before install, so a snapshot captured by an
// older alate still installs clean and the provisioned config.yml never carries the choice.
// The entry is the `backend:` line (bare or quoted key) at the mapping's child indent; a
// `backend:` deeper under `memory:` is other content and stays. When nothing else sits under
// `memory:`, the whole mapping goes, its interior comment and blank lines with it. A file can
// hold several top-level `memory:` keys (capture refuses that YAML, but install strips
// ungated snapshot bytes): every one is treated the same, so the strip is idempotent.
// Everything else stays byte for byte: `kept` and `dropped` hold the original lines in file
// order. `tail` is true when the text's end sits inside a block that had a drop;
// withoutMemoryBackend adds the terminator back only when the kept lines do not already end
// with one. Returns null when there is nothing to drop.
export function splitMemoryBackend(text) {
  const MEMORY = /^(?:memory|"(?:memory)"|'(?:memory)')[ \t]*:/;
  const BACKEND = /^(?:backend|"(?:backend)"|'(?:backend)')[ \t]*:/;
  const lines = text.split('\n');
  const kept = [], dropped = [];
  let tail = false;
  for (let i = 0; i < lines.length;) {
    // A BOM can only sit on the text's first line, ahead of the key.
    if (!MEMORY.test(i === 0 ? lines[i].replace(/^\uFEFF/, '') : lines[i])) { kept.push(lines[i++]); continue; }
    let end = lines.length; // exclusive: the next top-level key, or the text's end
    for (let j = i + 1; j < lines.length; j++)
      if (/^\S/.test(lines[j]) && !lines[j].startsWith('#')) { end = j; break; }
    const block = lines.slice(i + 1, end);
    const first = block.find(line => line.trim() && !line.trimStart().startsWith('#'));
    const indent = first === undefined ? -1 : first.length - first.trimStart().length;
    const at = [];
    block.forEach((line, k) => {
      if (line.length - line.trimStart().length === indent && BACKEND.test(line.trimStart())) at.push(k);
    });
    if (!at.length) { kept.push(lines[i++]); continue; } // a childless memory:, or no direct backend entry
    if (block.some((line, k) => !at.includes(k) && line.trim() && !line.trimStart().startsWith('#'))) {
      kept.push(lines[i]); // the memory: key stays over its other children
      for (let k = i + 1; k < end; k++) (at.includes(k - i - 1) ? dropped : kept).push(lines[k]);
    } else {
      for (let k = i; k < end; k++) dropped.push(lines[k]); // the emptied mapping goes whole
    }
    tail = end === lines.length;
    i = end;
  }
  if (!dropped.length) return null;
  return { kept, dropped, tail };
}

// The text of a config without its top-level memory backend entry, per the rule above. A
// text that holds nothing else gives an empty text.
export function withoutMemoryBackend(text) {
  const split = splitMemoryBackend(text);
  if (split === null) return text;
  const base = split.kept.join('\n');
  if (!base || base.endsWith('\n')) return base;
  return split.tail ? `${base}\n` : base;
}

// The top-level `shellPath:` key and the direct `customDirectories:` entries under a
// top-level `skills:` key of .omp/agent/config.yml name the capture machine's own shell
// setup: an absolute path of that host (C:\...\pwsh.exe, C:/Users/<user>/...). Another
// platform's worker cannot use them, so sync-user.mjs drops both on capture, the same way
// the memory backend entry is dropped. `shellPath:` is machine content whole: the entry
// (key line and everything under it until the next top-level key) goes. A
// `customDirectories:` entry is the key line plus its value: a same-line flow list ends
// there, a block value runs to the first non-blank, non-comment line at or above the
// entry's indent that is not a `- ` sequence item (a block sequence may sit at the parent
// key's indent), so deeper items and items at the parent's indent all go; a comment inside
// that region goes with the entry. A `customDirectories:` deeper under `skills:` is other
// content and stays. When nothing else sits under `skills:`, the whole mapping goes, its
// interior comment and blank lines with it. A file can hold several top-level `skills:`
// keys (capture refuses that YAML, but a reader strips ungated snapshot bytes): every one
// is treated the same, so the strip is idempotent. Flow-mapping forms (`skills: {...}`,
// `shellPath: {...}` with the value on the key line) are not omp's shape and stay.
// Everything else stays byte for byte: `kept` and `dropped` hold the original lines in
// file order. `tail` is true when the text's end sits inside a region that had a drop;
// withoutHostPaths adds the terminator back only when the kept lines do not already end
// with one. Returns null when there is nothing to drop.
export function splitHostPaths(text) {
  const SHELL = /^(?:shellPath|"(?:shellPath)"|'(?:shellPath)')[ \t]*:/;
  const SKILLS = /^(?:skills|"(?:skills)"|'(?:skills)')[ \t]*:[ \t]*$/;
  const CUSTOM = /^(?:customDirectories|"(?:customDirectories)"|'(?:customDirectories)')[ \t]*:/;
  const lines = text.split('\n');
  const kept = [], dropped = [];
  let tail = false;
  for (let i = 0; i < lines.length;) {
    // A BOM can only sit on the text's first line, ahead of the key.
    const key = i === 0 ? lines[i].replace(/^\uFEFF/, '') : lines[i];
    const host = /^\S/.test(key) && !key.startsWith('#') && (SHELL.test(key) || SKILLS.test(key));
    if (!host) { kept.push(lines[i++]); continue; }
    let end = lines.length; // exclusive: the next top-level key, or the text's end
    for (let j = i + 1; j < lines.length; j++)
      if (/^\S/.test(lines[j]) && !lines[j].startsWith('#')) { end = j; break; }
    if (SHELL.test(key)) {
      for (let k = i; k < end; k++) dropped.push(lines[k]); // the whole entry is machine content
      tail = end === lines.length;
      i = end;
      continue;
    }
    const block = lines.slice(i + 1, end);
    const first = block.find(line => line.trim() && !line.trimStart().startsWith('#'));
    const indent = first === undefined ? -1 : first.length - first.trimStart().length;
    const at = [];
    block.forEach((line, k) => {
      if (line.length - line.trimStart().length === indent && CUSTOM.test(line.trimStart())) at.push(k);
    });
    if (!at.length) { kept.push(lines[i++]); continue; } // a skills mapping without a direct customDirectories entry
    const gone = new Set();
    for (const k of at) {
      gone.add(k);
      if (block[k].trimStart().slice(block[k].trimStart().indexOf(':') + 1).trim()) continue; // flow value: the key line is the whole entry
      for (let e = k + 1; e < block.length; e++) { // block value: items, blanks and comments to the next sibling
        const l = block[e];
        const t = l.trim();
        if (!t || t.startsWith('#')) { gone.add(e); continue; }
        const ind = l.length - l.trimStart().length;
        if (ind > indent || (ind === indent && /^-([ \t]|$)/.test(l.trimStart()))) { gone.add(e); continue; }
        break;
      }
    }
    if (block.some((line, k) => !gone.has(k) && line.trim() && !line.trimStart().startsWith('#'))) {
      kept.push(lines[i]); // the skills: key stays over its other children
      for (let k = i + 1; k < end; k++) (gone.has(k - i - 1) ? dropped : kept).push(lines[k]);
    } else {
      for (let k = i; k < end; k++) dropped.push(lines[k]); // the emptied mapping goes whole
    }
    tail = end === lines.length;
    i = end;
  }
  if (!dropped.length) return null;
  return { kept, dropped, tail };
}

// The text of a config without the host shell keys, per the rule above. A text that holds
// nothing else gives an empty text.
export function withoutHostPaths(text) {
  const split = splitHostPaths(text);
  if (split === null) return text;
  const base = split.kept.join('\n');
  if (!base || base.endsWith('\n')) return base;
  return split.tail ? `${base}\n` : base;
}

// Captured config can hold absolute paths into the capture home: catalogPath in
// .omp/marketplaces.json, MCP args, plugin paths. Layer mode re-roots every occurrence of
// `<home>/` to `<layer>/` while installing, so a turn pinned to a layer resolves the file
// under the path it expects. The rewrite fires only behind a boundary — a JSON string start
// (`"`), whitespace, or `:` — so a path fragment inside a longer word never changes.
// Byte-precise: a text without a boundary occurrence returns unchanged.
export function remapHomePaths(text, home, layer) {
  const from = `${home.replace(/\/$/, '')}/`;
  const to = `${layer.replace(/\/$/, '')}/`;
  let out = '';
  let at = 0;
  for (;;) {
    const hit = text.indexOf(from, at);
    if (hit === -1) return out + text.slice(at);
    const before = hit === 0 ? '"' : text[hit - 1];
    if (before === '"' || /\s/.test(before) || before === ':') {
      out += text.slice(at, hit) + to;
      at = hit + from.length;
    } else {
      // Not a boundary: keep the occurrence verbatim and scan on behind it.
      out += text.slice(at, hit + from.length);
      at = hit + from.length;
    }
  }
}

// Layer dirs are named `<commit>-<n>`; the next install continues the highest counter
// already on disk for its commit, starting at 1.
export function nextLayerCounter(names, commit) {
  let next = 1;
  for (const name of names) {
    const match = new RegExp(`^${commit}-(\\d+)$`).exec(name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

// parseArgs(['--data','x','--force','pos'], ['--data','--home'], ['--force'], true)
//   -> { values: {'--data':'x'}, flags: Set(['--force']), positional: ['pos'] }
// Option names are dashed ('--data'); node:util keys strip the leading dashes.
export function parseArgs(argv, valued = [], flagged = [], allowPositionals = false) {
  const options = {};
  for (const o of [...valued, ...flagged]) options[o.slice(2)] = { type: valued.includes(o) ? 'string' : 'boolean' };
  let parsed;
  try {
    parsed = nodeParseArgs({ args: argv, options, strict: true, allowPositionals });
  } catch (err) {
    die(`Usage error: ${err.message}`);
  }
  const values = {};
  for (const o of valued) {
    if (parsed.values[o.slice(2)] !== undefined) {
      if (parsed.values[o.slice(2)] === '') die(`Usage error: ${o} needs a value`);
      values[o] = parsed.values[o.slice(2)];
    }
  }
  const flags = new Set(flagged.filter(o => parsed.values[o.slice(2)]));
  return { values, flags, positional: parsed.positionals };
}

// checkDestination(root, dest): side-effect-free preflight for a file we are about to write.
// Throws when dest lexically escapes root, when a component below the explicitly chosen root
// is an existing symbolic link (root itself may be a chosen symlink), when dest exists as a
// directory or special file, when an ancestor is not a directory, or when dest is a
// multiply-linked file. ponytail: preflight is not a transaction — a race after the check
// can still mutate a swapped path; add O_PATH/reopen-by-fd if that threat becomes real.
export function checkDestination(root, dest) {
  const r = resolve(root);
  const d = resolve(dest);
  const rel = relative(r, d);
  // Only a parent traversal escapes; a child literally named '..notes.md' is fine.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Destination ${dest} is outside ${root}`);
  let cur = r;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) continue;
    if (i < parts.length - 1) {
      if (st.isSymbolicLink()) throw new Error(`${cur} is a symbolic link below the chosen root ${root}`);
      if (!st.isDirectory()) throw new Error(`${cur} is not a directory`);
    } else if (!st.isFile()) {
      throw new Error(`${dest} exists and is not a regular file`);
    } else if (st.nlink > 1) {
      throw new Error(`${dest} has ${st.nlink} hard links; refusing to write it`);
    }
  }
}

// assertSourceInside(root, path): side-effect-free source guard for existing paths.
// Resolves both canonically and rejects escape (path === root is allowed).
export function assertSourceInside(root, path) {
  const r = realpathSync.native(root);
  const p = realpathSync.native(path);
  const rel = relative(r, p);
  if (rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return;
  throw new Error(`Source ${path} is outside ${root}`);
}

// safeRel(raw, label): normalize a manifest-relative path to the documented '/' separator
// and reject absolute/drive/UNC/parent/dot/empty segments. Throws for an invalid path;
// label prefixes the error (sync-projects.mjs passes 'projects.json: ...' labels).
export function safeRel(raw, label) {
  const norm = String(raw).replaceAll('\\', '/');
  if (norm === '') throw new Error(`${label}: empty path`);
  if (isAbsolute(norm) || /^[a-zA-Z]:/.test(norm) || norm.startsWith('//')) throw new Error(`${label}: absolute path ${raw}`);
  const parts = norm.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error(`${label}: invalid segment in ${raw}`);
  return parts.join('/');
}

// Precedence: --data <dir> | --repo <owner/name[@ref]> (shallow clone; needs allowClone) |
// $ALATE_DATA | ../agent-data beside this checkout. Returns { dir, temp }.
export function resolveDataDir(args, { allowClone = false } = {}) {
  const repo = args.values['--repo'];
  if (args.values['--data'] && repo) die('Pass either --data <dir> or --repo <owner/name[@ref]>, not both.');
  if (repo) {
    if (!allowClone) die('--repo needs a git clone; capture scripts run against a local checkout: pass --data <dir>.');
    return cloneData(repo);
  }
  const fallback = process.env.ALATE_DATA ? resolve(process.env.ALATE_DATA) : join(toolRoot, '..', 'agent-data');
  const dir = args.values['--data'] ? resolve(args.values['--data']) : fallback;
  if (!existsSync(dir)) {
    die(`No data dir at ${dir}\nPass --data <dir>, or --repo <owner/name[@ref]>, or set ALATE_DATA.`);
  }
  return { dir, temp: false };
}

// --repo spec: an existing local path wins whole (so paths containing '@' work);
// otherwise <owner/name[@ref]>, where everything after the first '@' is the ref —
// owner/name cannot contain '@', so refs like feature@draft survive intact.
// Returns { name, ref } with ref '' meaning the default branch, or null if unusable.
export function parseDataSpec(spec) {
  if (existsSync(spec)) return { name: spec, ref: '' };
  spec = spec.replace(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?(?=@|$)/, '$1');
  const at = spec.indexOf('@');
  const name = at === -1 ? spec : spec.slice(0, at);
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split('/').some(n => n === '.' || n === '..' || n.startsWith('-'))) return null;
  return { name, ref: at === -1 ? '' : spec.slice(at + 1) };
}

// Effective description text without a YAML dependency: plain scalars lose a trailing
// " #..." comment (YAML only starts a comment at whitespace-then-#), quoted values are
// unwrapped and must be non-blank, and |/>/|-/>- block scalars collect their indented lines.
export function descriptionText(front) {
  const m = /^description:[ \t]*(.*)$/m.exec(front);
  if (!m) return null;
  const rest = m[1].trim();
  if (/^[|>][+-]?$/.test(rest)) {
    const lines = [];
    for (const line of front.slice(m.index + m[0].length).split('\n').slice(1)) {
      if (line.trim() === '') continue;
      if (!/^[ \t]/.test(line)) break;
      lines.push(line.trim());
    }
    return lines.join(' ').trim() || null;
  }
  // Quoted scalar: must terminate on the same quote and may trail a comment; a quote
  // character inside (doubled for ', backslashed for ") stays part of the value.
  const qm = /^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(rest) ?? /^'((?:''|[^'])*)'\s*(?:#.*)?$/.exec(rest);
  if (qm) return qm[1].replace(/\\(.)/g, '$1').replace(/''/g, "'").trim() || null;
  // Plain scalar: a comment-only value is blank, and a comment starts at whitespace-then-#
  // (so 'C# tips' survives as YAML defines it).
  const text = /^#/.test(rest) ? '' : rest.replace(/\s+#.*$/, '');
  return text.trim() || null;
}

// Invisible characters smuggle instructions past human review ("Rules File Backdoor"): C0/C1
// controls except tab/LF/CR, Unicode format chars (zero-width, bidi overrides, tag characters,
// BOM), variation selectors.
const HIDDEN = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

// The rule-content gate sync.mjs (data-root rules) and install-user.mjs (Markdown under
// omp/agent/rules/ in the user/ snapshot) share: one problem string per finding, an empty
// array installs. `frontmatter: false` scans only hidden characters — agent-context Markdown
// (AGENTS.md, README.md) gets the scan but is no rule.
export function ruleProblems(label, text, { frontmatter = true } = {}) {
  const problems = [];
  text.split('\n').forEach((line, i) => {
    const hit = HIDDEN.exec(line);
    if (hit) {
      const codePoint = hit[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${label}:${i + 1}:${hit.index + 1}: hidden character U+${codePoint}`);
    }
  });
  if (frontmatter) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front || !descriptionText(front[1])) problems.push(`${label}: needs frontmatter with a description`);
  }
  return problems;
}

// Redact every credential shape git could echo back: raw token, URL-encoded form,
// and the base64 basic-auth credential. Longest first so compound forms win.
export function redactSecrets(text, token) {
  if (!token) return text;
  const encoded = encodeURIComponent(token);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return [basic, encoded, token].reduce((t, s) => t.replaceAll(s, '***'), text);
}

// Build the git auth environment. Auth rides in per-process git config
// environment (http.https://github.com/.extraheader), never in the URL: no
// token can reach argv or the cloned repo's .git/config. Prompts are off so a
// missing token on a private repo fails fast instead of hanging.
export function gitAuthEnv(url, token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token && url.startsWith('https://github.com/')) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

// --config pins LF in the clone (checkout and later commits): a host with core.autocrlf=true
// would otherwise check out CRLF, and SkillSpector baselines fingerprint the repo's LF bytes.
export function cloneCommand(url, ref, token, dir) {
  const args = ['clone', '--quiet', '--depth', '1', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', ...(ref ? ['--branch', ref] : []), url, dir];
  const env = gitAuthEnv(url, token);
  return { args, env };
}

function cloneData(spec) {
  const parsed = parseDataSpec(spec);
  if (!parsed) die(`--repo must be <owner/name[@ref]> or an existing path, got: ${spec}`);
  const { name, ref } = parsed;
  const url = existsSync(name) ? name : `https://github.com/${name}`;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), 'alate-data-'));
  const { args, env } = cloneCommand(url, ref, token, dir);
  const git = spawnSync('git', args, { env, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
  if (git.status !== 0) {
    rmSync(dir, { recursive: true, force: true }); // our own fresh temp dir only
    const stderr = redactSecrets(git.stderr ?? '', token).trim();
    die(`git clone failed for ${name}${ref ? `@${ref}` : ''}${stderr ? `:\n${stderr}` : ''}`);
  }
  return { dir, temp: true };
}

export function cleanupData(data) {
  if (data.temp && !keepTemp()) rmSync(data.dir, { recursive: true, force: true });
}

// Supported config.yml syntax, fail closed: a single block-style document of one-line `key: value`
// entries — plain or quoted scalars, comments, blank lines, nested mappings and sequences. YAML decodes
// spellings the raw bytes don't contain ("api\u004bey" is the key apiKey), so a construct this scanner
// cannot decode exactly — escapes in double-quoted scalars, anchors, aliases, flow collections, block
// scalars, tags, complex keys, merge keys, directives, multi-document files — refuses the run instead
// of being scanned raw (see README). Complements the per-key value scan in sync-user.mjs, which judges
// the values of secret-named keys: this contract keeps every key's spelling identical to its raw bytes.
const YAML_NODE_INDICATORS = new Set(('&*!%@?[{}],|>' + '`').split(''));
export const yamlProblems = (text, rel) => {
  const issues = [];
  let docStarted = false;
  text.split('\n').forEach((line, i) => {
    const bad = why => issues.push(`~/${rel}:${i + 1}: unsupported YAML syntax (${why}); keep ${rel} one-line block style`);
    if (/^\s*%/.test(line)) return bad('directive');
    if (/^\s*\.\.\.\s*$/.test(line)) return bad('end-of-document marker');
    if (/^\s*---\s*$/.test(line)) {
      if (i === 0 && !docStarted) { docStarted = true; return; }
      return bad('multi-document file');
    }
    // nodeStart: a key/value node may begin at this character (line start, after ": " or after "- ").
    let quote = null, nodeStart = true;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote === '"') {
        if (ch === '\\') return bad('escape in a double-quoted scalar');
        if (ch === '"') { quote = null; nodeStart = false; }
        continue;
      }
      if (quote === "'") {
        if (ch === "'") { if (line[c + 1] === "'") c++; else { quote = null; nodeStart = false; } }
        continue;
      }
      if (ch === '#' && (c === 0 || /\s/.test(line[c - 1]))) break; // comment: the rest of the line is prose
      if (ch === '"' || ch === "'") { nodeStart = false; quote = ch; continue; }
      if (/\s/.test(ch)) continue;
      if (ch === ':' && (c + 1 === line.length || /\s/.test(line[c + 1]))) { nodeStart = true; continue; }
      if (ch === '-' && nodeStart && (c + 1 === line.length || /\s/.test(line[c + 1]))) continue;
      if (nodeStart) {
        if (ch === '<' && line[c + 1] === '<') return bad('merge key');
        if (YAML_NODE_INDICATORS.has(ch)) return bad(`node indicator "${ch}"`);
        nodeStart = false;
      }
    }
    if (quote) return bad('quoted scalar spans lines');
  });
  return issues;
};
