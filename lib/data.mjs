// Shared arg parsing + data-dir resolution for the provisioning scripts.
// The tool repo ships no data: rules, user/ and projects/ live in a separate data repo
// (default: ../agent-data beside this checkout).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url))); // lib/../ = tool checkout

/** @typedef {{ values: Record<string, string | undefined>, flags: Set<string>, positional: string[] }} ParsedArgs */
/** @typedef {{ dir: string, temp: boolean }} DataDir */
/** @typedef {{ host: string, isDefault: boolean, apiBase: string, webBase: string, error?: undefined } | { error: string, host?: undefined }} GithubHost */
/** @typedef {{ name: string, ref: string, host: string }} DataSpec */

// Snapshot layout: the home dot-dir ~/.agents is stored under user/ without the leading dot
// (user/agents/...). sync.mjs, the update checker and the dashboard inventory all read this
// one name, so a reader can never drift back to the dotted home form.
export const SNAP_AGENTS_DIR = 'agents';

/**
 * @param {string} message
 * @returns {never}
 */
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
/**
 * @param {(rand: () => number, run: number) => unknown} gen
 * @param {(input: unknown) => void} prop
 */
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
      throw new Error(`property failed: seed=${seed} run=${i} input=${JSON.stringify(input)}: ${/** @type {Error} */ (e).message}`);
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
/**
 * One mcp.json server entry, as alate reads it. Values are untrusted JSON.
 * @typedef {{ command?: string, args?: string[], env?: Record<string, string>, [name: string]: unknown }} McpServerEntry
 */

/**
 * @param {McpServerEntry | null | undefined} server
 * @returns {{ command: string, args: string[] } | null}
 */
export function unwrapCmd(server) {
  const args = Array.isArray(server?.args) ? server.args : [];
  const c = args.findIndex(a => /^\/c$/i.test(a));
  if (!CMD.test(String(server?.command ?? '')) || c < 0 || !args.slice(0, c).every(a => /^\/[a-z]$/i.test(a))
    || typeof args[c + 1] !== 'string' || !/^\S+$/.test(args[c + 1])) return null;
  return { command: args[c + 1], args: args.slice(c + 2) };
}

/**
 * @param {string} rel
 * @param {Buffer} bytes
 * @param {{ home: string, platform: string, roots: Set<string> }} target
 * @returns {{ bytes: Buffer, notes: string[] }}
 */
export function forTarget(rel, bytes, { home, platform, roots }) {
  if (!rel.endsWith('.json')) return { bytes, notes: [] };
  const winTarget = platform === 'win32';
  /** @type {{ mcpServers?: Record<string, McpServerEntry>, disabledServers?: string[] }} */
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
  /** @type {(v: string) => boolean} */
  const capturedPath = winTarget ? (v => v.startsWith('/')) : (v => WIN_PATH.test(v));
  const joinPath = winTarget ? win32.join : posix.join;
  // Arbitrary parsed JSON in and out, so the recursive walk stays one type.
  /** @type {(v: any) => any} */
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
    /** @type {(v: unknown) => boolean} */
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
        delete /** @type {Record<string, string>} */ (server.env)[key];
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
/** @param {Buffer} bytes @returns {string} */
export const normText = bytes => bytes.toString('latin1').replaceAll('\r\n', '\n');

// omp stamps updatedAt in its marketplace registry on every catalog refresh, so a live
// registry drifts from the snapshot without a change of content; that drift is no conflict.
// install-user.mjs records these fingerprints of what it installed, so the same rules decide
// whether a machine file still holds that content.
/**
 * @param {string} rel
 * @param {Buffer} bytes
 * @returns {string}
 */
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

/** @param {string} rel @param {Buffer} machine @param {Buffer} snapshot @returns {boolean} */
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
/**
 * @param {string} text
 * @returns {{ kept: string[], dropped: string[], tail: boolean }}
 */
export function splitDeploymentBlocks(text) {
  let excluded = false;
  /** @type {string[]} */
  const kept = [], dropped = /** @type {string[]} */ ([]);
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
/**
 * @param {string} text
 * @returns {string}
 */
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
/**
 * @param {string} text
 * @returns {{ kept: string[], dropped: string[], tail: boolean } | null}
 */
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
    /** @type {number[]} */
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
/**
 * @param {string} text
 * @returns {string}
 */
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
/**
 * @param {string} text
 * @returns {{ kept: string[], dropped: string[], tail: boolean } | null}
 */
export function splitHostPaths(text) {
  const SHELL = /^(?:shellPath|"(?:shellPath)"|'(?:shellPath)')[ \t]*:/;
  // Lines are '\n'-split, so a CRLF file's lines end in '\r'. The prefix anchors above and
  // below tolerate that, but this end-anchored one must too, or a CRLF config's skills
  // entry survives the strip whole.
  const SKILLS = /^(?:skills|"(?:skills)"|'(?:skills)')[ \t]*:[ \t]*\r?$/;
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
    /** @type {number[]} */
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
/**
 * @param {string} text
 * @returns {string}
 */
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
/**
 * @param {string} text
 * @param {string} home
 * @param {string} layer
 * @returns {string}
 */
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
/**
 * @param {string[]} names
 * @param {string} commit
 * @returns {number}
 */
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
/**
 * @param {string[]} argv
 * @param {string[]} [valued=[]]
 * @param {string[]} [flagged=[]]
 * @param {boolean} [allowPositionals=false]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, valued = [], flagged = [], allowPositionals = false) {
  /** @type {Record<string, { type: import('node:util').ParseArgsOptionsType, multiple?: false }>} */
  const options = {};
  for (const o of [...valued, ...flagged]) options[o.slice(2)] = { type: valued.includes(o) ? 'string' : 'boolean' };
  /** @type {{ values: Record<string, string | boolean | undefined>, positionals: string[] }} */
  let parsed;
  try {
    parsed = nodeParseArgs({ args: argv, options, strict: true, allowPositionals });
  } catch (err) {
    die(`Usage error: ${/** @type {Error} */ (err).message}`);
  }
  /** @type {Record<string, string | undefined>} */
  const values = {};
  for (const o of valued) {
    if (parsed.values[o.slice(2)] !== undefined) {
      if (parsed.values[o.slice(2)] === '') die(`Usage error: ${o} needs a value`);
      values[o] = /** @type {string} */ (parsed.values[o.slice(2)]);
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
/**
 * @param {string} root
 * @param {string} dest
 * @returns {void}
 */
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
/**
 * @param {string} root
 * @param {string} path
 * @returns {void}
 */
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
/**
 * @param {string} raw
 * @param {string} label
 * @returns {string}
 */
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
/**
 * @param {ParsedArgs} args
 * @param {{ allowClone?: boolean }} [options]
 * @returns {DataDir}
 */
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

// One GitHub host per board: ALATE_GITHUB_HOST (default github.com) and the values derived
// from it — the REST API base and the web base. Cloning a data repo reads them here, so the
// clone follows the host: github.com unchanged, <tenant>.ghe.com is Enterprise Cloud with
// data residency (API at api.<host>), any other host is Enterprise Server (API at
// <host>/api/v3).
export const GITHUB_HOST_ENV = 'ALATE_GITHUB_HOST';
export const DEFAULT_GITHUB_HOST = 'github.com';

// One label: never empty, never starts or ends with a hyphen. The dots are split off first.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// The trust boundary for the host setting: total, never throws, one shared error. A scheme,
// path, port, whitespace, userinfo, query or fragment cannot survive the charset check, so a
// derived URL can never leave the configured host.
/**
 * @param {unknown} raw
 * @returns {GithubHost}
 */
export function parseGithubHost(raw) {
  /** @param {string} why @returns {string} */
  const error = why => `${GITHUB_HOST_ENV}: ${why} (use a bare hostname, for example ${DEFAULT_GITHUB_HOST} or acme.ghe.com)`;
  if (typeof raw !== 'string') return { error: error('must be a string') };
  if (raw === '') return { error: error('must not be empty') };
  if (/[^a-zA-Z0-9.-]/.test(raw)) return { error: error('must hold only letters, digits, dots and hyphens') };
  if (raw.length > 253) return { error: error('is longer than 253 characters') };
  const host = raw.toLowerCase();
  if (!host.split('.').every(label => LABEL_RE.test(label))) return { error: error('has an empty or misplaced label') };
  const isDefault = host === DEFAULT_GITHUB_HOST;
  // A *.ghe.com tenant serves its REST API on its own api.<host> name; Enterprise Server
  // keeps the classic /api/v3 path.
  const apiBase = isDefault ? `https://api.${DEFAULT_GITHUB_HOST}` : host.endsWith('.ghe.com') ? `https://api.${host}` : `https://${host}/api/v3`;
  return { host, isDefault, apiBase, webBase: `https://${host}` };
}

// The host of the data repo clone: the default when the setting is unset or blank.
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GithubHost}
 */
export function githubHost(env = process.env) {
  const raw = env[GITHUB_HOST_ENV];
  const parsed = raw === undefined || raw.trim() === '' ? parseGithubHost(DEFAULT_GITHUB_HOST) : parseGithubHost(raw);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

// --repo spec: an existing local path wins whole (so paths containing '@' work);
// otherwise <owner/name[@ref]>, <host>/owner/name[@ref] (any GitHub host: a bare
// hostname with a dot) or an https URL on such a host, where everything after the
// first '@' is the ref — owner/name cannot contain '@', so refs like feature@draft
// survive intact. host is '' for local paths and plain owner/name (the ambient
// ALATE_GITHUB_HOST decides), else the lowercased host. Returns null if unusable.
/**
 * @param {string} spec
 * @returns {DataSpec | null}
 */
export function parseDataSpec(spec) {
  if (existsSync(spec)) return { name: spec, ref: '', host: '' };
  const at = spec.indexOf('@');
  const head = at === -1 ? spec : spec.slice(0, at);
  const ref = at === -1 ? '' : spec.slice(at + 1);
  // github.com look-alikes ('github.com.evil', 'www.github.com') never count as hosts.
  /** @param {string} raw @returns {string | null} */
  const hostOf = raw => {
    if (!raw.includes('.')) return null;
    const parsed = parseGithubHost(raw);
    if (parsed.error) return null;
    if (parsed.host !== DEFAULT_GITHUB_HOST && ((/** @type {{ host: string }} */ (parsed)).host.startsWith('github.com.') || (/** @type {{ host: string }} */ (parsed)).host.endsWith('.github.com'))) return null;
    return /** @type {string} */ (parsed.host);
  };
  // URL form: https://<host>/<owner>/<name>[.git][/]
  const url = /^https:\/\/([^/@?#]+)\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(head);
  if (url) {
    const host = hostOf(url[1]);
    if (host === null) return null;
    const name = url[2];
    if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split('/').some(n => n === '.' || n === '..' || n.startsWith('-'))) return null;
    return { name, ref, host };
  }
  // Three-segment form: <host>/<owner>/<name>
  const three = /^([^/@]+)\/([\w.-]+\/[\w.-]+)$/.exec(head);
  if (three && hostOf(three[1]) !== null) {
    const name = three[2];
    if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split('/').some(n => n === '.' || n === '..' || n.startsWith('-'))) return null;
    return { name, ref, host: /** @type {string} */ (hostOf(three[1])) };
  }
  // Plain form: <owner>/<name>
  const name = head;
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split('/').some(n => n === '.' || n === '..' || n.startsWith('-'))) return null;
  return { name, ref, host: '' };
}

// The host a data spec clones from: the spec's explicit host, else the ambient
// ALATE_GITHUB_HOST (github.com by default). Throws when the setting is invalid.
/**
 * @param {DataSpec} parsed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataHost(parsed, env = process.env) {
  if (parsed.host) return parsed.host;
  return /** @type {string} */ (githubHost(env).host);
}

// The clone source: an existing local path passes through unchanged, anything else
// becomes an https URL on the resolved host. Throws when ALATE_GITHUB_HOST is invalid.
/**
 * @param {DataSpec} parsed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataRepoUrl(parsed, env = process.env) {
  if (existsSync(parsed.name)) return parsed.name;
  return `https://${dataHost(parsed, env)}/${parsed.name}`;
}

// Effective description text without a YAML dependency: plain scalars lose a trailing
// " #..." comment (YAML only starts a comment at whitespace-then-#), quoted values are
// unwrapped and must be non-blank, and |/>/|-/>- block scalars collect their indented lines.
/**
 * @param {string} front
 * @returns {string | null}
 */
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
// BOM), variation selectors. The one exception is normal emoji text: a text/emoji-style
// selector (U+FE0E/U+FE0F) right after an emoji or symbol code point, and a ZWJ (U+200D)
// joining two emoji code points with skin-tone modifiers or variation selectors between —
// a normal upstream skill bump carrying these must not stop every provision. Every other
// hit stays fatal.
const HIDDEN = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const AFTER_EMOJI = /(?:\p{Extended_Pictographic}|\p{Symbol})$/u;
const IN_EMOJI_RUN = /\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}]*$/u;
const JOINS_EMOJI_RUN = /^[\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}]*\p{Extended_Pictographic}/u;

// The rule-content gate sync.mjs (data-root rules) and install-user.mjs (Markdown under
// omp/agent/rules/ in the user/ snapshot) share: one problem string per finding, an empty
// array installs. `frontmatter: false` scans only hidden characters — agent-context Markdown
// (AGENTS.md, README.md) gets the scan but is no rule. A line reports its first fatal hit.
/**
 * @param {string} label
 * @param {string} text
 * @param {{ frontmatter?: boolean }} [options]
 * @returns {string[]}
 */
export function ruleProblems(label, text, { frontmatter = true } = {}) {
  const problems = [];
  text.split('\n').forEach((line, i) => {
    HIDDEN.lastIndex = 0;
    let hit;
    while ((hit = HIDDEN.exec(line))) {
      const cp = /** @type {number} */ (hit[0].codePointAt(0));
      if (cp === 0xfe0e || cp === 0xfe0f) {
        if (AFTER_EMOJI.test(line.slice(0, hit.index))) continue;
      } else if (cp === 0x200d) {
        if (IN_EMOJI_RUN.test(line.slice(0, hit.index)) && JOINS_EMOJI_RUN.test(line.slice(hit.index + 1))) continue;
      }
      const codePoint = cp.toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${label}:${i + 1}:${hit.index + 1}: hidden character U+${codePoint}`);
      break;
    }
  });
  if (frontmatter) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front || !descriptionText(front[1])) problems.push(`${label}: needs frontmatter with a description`);
  }
  return problems;
}

// Skill metadata accepts indented scalars without changing the dashboard's description reader.
/**
 * @param {string} front
 * @param {string} key
 * @returns {string | null}
 */
function skillScalarText(front, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front);
  if (!match) return null;
  const rest = match[1].trim();
  const lines = [];
  for (const line of front.slice(match.index + match[0].length).split('\n').slice(1)) {
    if (!line.trim()) continue;
    if (!/^[ \t]/.test(line)) break;
    lines.push(line.trim());
  }
  if (/^[|>][+-]?(?:[ \t]+#.*)?$/.test(rest)) return lines.join(' ').trim() || null;
  const values = [rest, ...lines];
  const start = values.findIndex(line => line && !line.startsWith('#'));
  const scalar = start < 0 ? '' : values.slice(start).join(' ');
  if (/^["']/.test(scalar)) {
    const quoted = /^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(scalar)
      ?? /^'((?:''|[^'])*)'\s*(?:#.*)?$/.exec(scalar);
    if (!quoted) return null;
    let value;
    if (scalar.startsWith('"')) {
      try {
        value = JSON.parse(`"${quoted[1]}"`);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return null;
      }
    } else {
      value = quoted[1].replace(/''/g, "'");
    }
    return value.trim() ? value : null;
  }
  return scalar.replace(/\s+#.*$/, '').trim() || null;
}

/**
 * @param {string} label
 * @param {string} text
 * @returns {string[]}
 */
export function skillProblems(label, text) {
  const problems = ruleProblems(label, text, { frontmatter: false });
  const opening = /^---\r?\n/.exec(text);
  const rest = opening ? text.slice(opening[0].length) : '';
  const closing = /^---(?:\r?\n|(?![\s\S]))/m.exec(rest);
  if (!opening || !closing) {
    problems.push(`${label}: needs complete frontmatter at byte 0`);
    return problems;
  }
  const front = rest.slice(0, closing.index).replace(/\r\n/g, '\n');
  const name = skillScalarText(front, 'name');
  if (!name) problems.push(`${label}: needs a non-empty name`);
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) problems.push(`${label}: name must match ^[a-z0-9][a-z0-9-]*$`);
  if (!skillScalarText(front, 'description')) problems.push(`${label}: needs a non-empty description`);
  return problems;
}

// Redact every credential shape git could echo back: raw token, URL-encoded form,
// and the base64 basic-auth credential. Longest first so compound forms win.
/**
 * @param {string} text
 * @param {string | undefined} token
 * @returns {string}
 */
export function redactSecrets(text, token) {
  if (!token) return text;
  const encoded = encodeURIComponent(token);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return [basic, encoded, token].reduce((t, s) => t.replaceAll(s, '***'), text);
}

// Build the git auth environment. Auth rides in per-process git config
// environment (http.https://<hostname>/.extraheader keyed by the clone URL's
// own host), never in the URL: no token can reach argv or the cloned repo's
// .git/config. The token rides only to the configured host (ALATE_GITHUB_HOST,
// github.com by default); a clone URL on any other host gets no auth. An
// invalid host setting fails closed the same way. file://, http:// and local
// paths get no auth. Prompts are off so a missing token on a private repo
// fails fast instead of hanging.
/**
 * @param {string} url
 * @param {string | undefined} token
 * @returns {NodeJS.ProcessEnv}
 */
export function gitAuthEnv(url, token) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let parsed;
  try { parsed = new URL(url); } catch { return env; }
  let configured;
  try { configured = githubHost().host; } catch { return env; }
  if (!token || parsed.protocol !== 'https:' || parsed.hostname !== configured || parseGithubHost(parsed.hostname).error) return env;
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = `http.https://${parsed.hostname}/.extraheader`;
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return env;
}

// --config pins LF in the clone (checkout and later commits): a host with core.autocrlf=true
// would otherwise check out CRLF, and SkillSpector baselines fingerprint the repo's LF bytes.
/**
 * @param {string} url
 * @param {string} ref
 * @param {string | undefined} token
 * @param {string} dir
 * @returns {{ args: string[], env: NodeJS.ProcessEnv }}
 */
export function cloneCommand(url, ref, token, dir) {
  const args = ['clone', '--quiet', '--depth', '1', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', ...(ref ? ['--branch', ref] : []), url, dir];
  const env = gitAuthEnv(url, token);
  return { args, env };
}

/**
 * @param {string} spec
 * @returns {DataDir}
 */
function cloneData(spec) {
  const parsed = parseDataSpec(spec);
  if (!parsed) die(`--repo must be <owner/name[@ref]>, <host>/owner/name[@ref] or an existing path, got: ${spec}`);
  const { name, ref } = parsed;
  let url;
  try { url = dataRepoUrl(parsed); } catch (e) { die(/** @type {Error} */ (e).message); }
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

/**
 * @param {DataDir} data
 * @returns {void}
 */
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
/**
 * @param {string} text
 * @param {string} rel
 * @returns {string[]}
 */
export const yamlProblems = (text, rel) => {
  /** @type {string[]} */
  const issues = [];
  let docStarted = false;
  text.split('\n').forEach((line, i) => {
    /** @param {string} why */
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

// Root Markdown that is agent context, never a rule: the hidden-character scan applies,
// the rule frontmatter gate does not, and neither file is installed by sync.mjs.
export const NOT_RULES = new Set(['AGENTS.md', 'README.md']);

// ---- Per-item provisioning (specs/provision-item-by-item.md) ----
// The provisioning scripts report one result per item and install every item that
// passed; only failed items stay out. sync.mjs and install-user.mjs share the item
// keys, the results-file protocol, and the origin gate here.

// Environment variable holding the absolute results-file path. The server sets it per
// child; a direct CLI run without it just prints the human output.
export const PROVISION_ENV = 'ALATE_PROVISION_RESULTS';

// Atomic, mode-0600 write of one run's per-item results. An unwritable path is a
// diagnostics loss, not a provisioning failure: warn and let the run's exit code stand
// (the server reads no results then and fails closed).
/**
 * @param {string} path
 * @param {{ fatal: boolean, error: string | null, items: unknown[] }} payload
 * @returns {void}
 */
export function writeProvisionResults(path, payload) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    console.error(`could not write the per-item results file (${/** @type {Error} */ (err).message ?? err}); the caller reads no per-item results from this run`);
  }
}

// One content-gate problem line ("b.md:6:5: hidden character U+200B") split into the
// status summary fields: the gate rule that fired and where. A problem without a
// position ("needs frontmatter with a description") keeps the label as the position.
/**
 * @param {string} problem
 * @returns {{ rule: string, at: string | null }}
 */
export function describeProblem(problem) {
  const m = /^(.*?):(\d+):(\d+): (.+)$/.exec(problem);
  if (m) return { rule: m[4], at: `${m[1]}:${m[2]}:${m[3]}` };
  const i = problem.indexOf(': ');
  return i >= 0 ? { rule: problem.slice(i + 2), at: problem.slice(0, i) } : { rule: problem, at: null };
}

// The pinned scanner prints findings as "  HIGH: SC2 - External Script Fetching..."
// followed by "    Location: SKILL.md:7". The first finding supplies the per-item
// status summary; the full report travels alongside it.
/**
 * @param {string} report
 * @returns {{ rule: string | null, at: string | null }}
 */
export function describeScanReport(report) {
  const rule = /^[^\S\n]*[A-Z]+: ([A-Z]+\d+) -/m.exec(report)?.[1] ?? null;
  const loc = /^[^\S\n]*Location: (\S+):(\d+)$/m.exec(report);
  return { rule, at: loc ? `${loc[1]}:${loc[2]}` : null };
}

// The origin gate (upstreams.json): every public item needs a recorded origin there.
// Fatal problems mean the gate itself is broken (unreadable file, structurally invalid
// entry): no origin verdict is possible, so the caller refuses the whole run. The
// uncovered list names the item keys that lack coverage; the caller turns each one
// into a `no origin` failure for that item alone. Extracted from sync.mjs so both
// provisioning scripts judge coverage identically.
/**
 * @param {string} dataDir
 * @returns {{ fatal: string[], uncovered: string[], hints: Record<string, string> }}
 */
export function originGate(dataDir) {
  /** @type {string[]} */
  const fatal = [], uncovered = /** @type {string[]} */ ([]);
  const upFile = join(dataDir, 'upstreams.json');
  if (!existsSync(upFile)) return { fatal, uncovered, hints: {} };
  /** @type {{ items?: any[], own?: any[] } | null} */
  let up = null;
  let parsed = false;
  try { up = JSON.parse(readFileSync(upFile, 'utf8')); parsed = true; }
  catch (err) { fatal.push(`upstreams.json: ${/** @type {Error} */ (err).message}`); }
  if (!parsed) return { fatal, uncovered, hints: {} };
  const KINDS = new Set(['image-pin', 'mcp', 'rule-set', 'skill', 'plugin']);
  const CHECKS = new Set(['github-release', 'github-path', 'npm', 'node-dist', 'chrome-for-testing', 'pypi']);
  const items = Array.isArray((/** @type {{ items?: any[], own?: any[] }} */ (up)).items) ? (/** @type {{ items?: any[], own?: any[] }} */ (up)).items : [];
  const own = Array.isArray((/** @type {{ items?: any[], own?: any[] }} */ (up)).own) ? (/** @type {{ items?: any[], own?: any[] }} */ (up)).own : [];
  items.forEach((item, i) => {
    const label = item?.name ? `item "${item.name}"` : `item "#${i}"`;
    if (!KINDS.has(item?.kind)) fatal.push(`upstreams.json: ${label}: unknown kind ${item?.kind ?? '(missing)'}`);
    if (typeof item?.origin !== 'string' || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(item.origin))
      fatal.push(`upstreams.json: ${label}: origin is not a GitHub repo URL`);
    if (item?.check !== undefined && !CHECKS.has(item.check?.type))
      fatal.push(`upstreams.json: ${label}: unknown check type ${item.check?.type ?? '(missing)'}`);
    if (item?.pin !== undefined && !(typeof item.pin === 'object' && item.pin && [item.pin.repo, item.pin.file, item.pin.key].every(v => typeof v === 'string' && v)))
      fatal.push(`upstreams.json: ${label}: pin needs repo, file and key`);
  });
  // ponytail: hand-rolled glob, only **, *, ? (no {} alternation / character classes); switch to a glob lib if upstreams.json ever needs them.
  /** @param {string} pat @returns {RegExp} */
  const globRe = pat => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replaceAll('\0', '.*') + '$');
  /** @param {string} p @returns {boolean} */
  const covered = p => own.some(g => globRe(g).test(p)) || items.some(it => (Array.isArray(it?.paths) ? /** @type {string[]} */ (it?.paths) : []).some(g => globRe(g).test(p)));
  const rootRules = [];
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.mdc?$/.test(entry.name) && !NOT_RULES.has(entry.name)) rootRules.push(entry.name);
  }
  for (const name of rootRules) if (!covered(name)) uncovered.push(name);
  /** @param {string} rel */
  const readJson = rel => {
    try { return JSON.parse(readFileSync(join(dataDir, rel), 'utf8')); }
    catch (err) {
      if (/** @type {{ code?: unknown }} */ (err).code !== 'ENOENT') fatal.push(`${rel}: ${/** @type {Error} */ (err).message}`); // a missing file means nothing to check
      return null;
    }
  };
  const skillLock = readJson(`user/${SNAP_AGENTS_DIR}/.skill-lock.json`);
  const lockDir = join(dataDir, 'user', SNAP_AGENTS_DIR, 'skills');
  if (existsSync(lockDir)) for (const d of readdirSync(lockDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const rel = `user/${SNAP_AGENTS_DIR}/skills/${d.name}`;
    if (!skillLock?.skills?.[d.name] && !covered(rel)) uncovered.push(rel);
  }
  for (const sub of ['user/omp/agent/skills', 'user/omp/agent/managed-skills']) {
    const dir = join(dataDir, sub);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (!covered(`${sub}/${d.name}`)) uncovered.push(`${sub}/${d.name}`);
    }
  }
  const mcp = readJson('user/omp/agent/mcp.json');
  /** @param {McpServerEntry | null | undefined} cfg @returns {string[]} */
  const serverArgs = cfg => (Array.isArray(cfg?.args) ? cfg.args : []).filter(a => typeof a === 'string');
  // Pinned Python MCP servers (uvx, pipx run): a concrete PEP 440 pin is
  // "<name>==<final/prerelease/post/dev version>"; an empty version, a wildcard or a range
  // leaves the release open and does not count as pinned.
  /** @param {string} spec @returns {string | undefined} */
  const pyPin = spec => {
    const at = spec.indexOf('==');
    return at >= 0 && /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+|\.(?:post|dev)\d+)?$/i.test(spec.slice(at + 2)) ? spec.slice(0, at) : undefined;
  };
  // Own-glob coverage only reaches self-written servers inside the running machine's home;
  // a vendor path or another user's file is foreign, and a bare program name is never a home path.
  const home = homedir();
  /** @param {unknown} cmd @returns {boolean} */
  const inHome = cmd => {
    if (typeof cmd !== 'string' || !isAbsolute(cmd)) return false;
    const rel = relative(home, cmd);
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  };
  /** @type {Record<string, string>} */
  const hints = {};
  for (const [name, cfg] of Object.entries(mcp?.mcpServers ?? {})) {
    const bare = unwrapCmd(cfg) ?? cfg ?? {}; // a Windows capture wraps npx in cmd /c; judge the real program
    const strs = [bare.command, ...serverArgs(bare)].filter(s => typeof s === 'string');
    const firstArg = serverArgs(bare).find(a => !a.startsWith('-'));
    const pySpec = bare.command === 'uvx' ? firstArg
      : (bare.command === 'pipx' && firstArg === 'run') ? serverArgs(bare).slice(1).find(a => !a.startsWith('-')) : undefined;
    const key = `user/omp/agent/mcp.json "${name}"`;
    const ok = strs.some(s => /(^|[\\/])plugins[\\/]/.test(s))
      || (inHome(bare.command) && own.some(g => globRe(g).test(bare.command)))
      || ((bare.command === 'npx' || bare.command === 'bunx') && items.some(it => it?.kind === 'mcp'
        && typeof it.check?.package === 'string' && (firstArg === it.check.package || firstArg?.startsWith(`${it.check.package}@`))))
      || (typeof pySpec === 'string' && items.some(it => it?.kind === 'mcp' && it.check?.type === 'pypi'
        && typeof it.check?.package === 'string' && it.check.package && pyPin(pySpec) === it.check.package));
    if (!ok && typeof pySpec === 'string' && pyPin(pySpec) === undefined) {
      const pyName = pySpec.split('==')[0];
      hints[key] = `${bare.command === 'pipx' ? 'pipx run' : bare.command} package "${pyName}" is not pinned to a version — pin it in mcp.json args as "${pyName}==<version>" and add an upstreams.json item with check {"type":"pypi","package":"${pyName}"}`;
    }
    if (!ok) uncovered.push(key);
  }
  uncovered.sort();
  return { fatal, uncovered, hints };
}
