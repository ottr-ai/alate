// Shared arg parsing + data-dir resolution for the provisioning scripts.
// The tool repo ships no data: rules, user/ and projects/ live in a separate data repo
// (default: ../agent-data beside this checkout).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url))); // lib/../ = tool checkout

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

// Snapshots are captured on Windows; Docker workers and CI run Linux. For a non-Windows target,
// JSON config is adapted first: a Windows path into the captured layer (a segment in `roots`,
// e.g. .omp) is re-rooted at the target home. In omp's mcp.json, a `cmd /c <program>` wrapper
// exists only because Windows cannot spawn npx's .cmd shim directly, so the program runs as the
// command; an environment variable that still holds a Windows path is dropped, so the server's
// own default applies; a server that still needs Windows (an .exe/.cmd/.bat/.ps1 command, a
// Windows path left in its command or args) goes on omp's own disabledServers list. The Linux
// targets are containers that run as root, without a display, with parallel sessions in one home,
// so chrome-devtools-mcp gets --headless, --isolated (a fixed profile dir would collide) and
// Chrome's --no-sandbox (the sandbox refuses root). Returns the input bytes when nothing applies,
// plus one note per change.
// ponytail: Windows -> POSIX container only, the one direction and target used today; add the
// reverse when a snapshot is captured on Linux, and a target option for a Linux desktop.
const WIN_PATH = /^[A-Za-z]:[\\/]/;
const CMD = /^cmd(\.exe)?$/i;
const WIN_ONLY_COMMAND = /^cmd(\.exe)?$|\.(exe|cmd|bat|ps1)$/i;
const CHROME_DEVTOOLS = /^chrome-devtools-mcp(@|$)/;
const CHROME_FLAGS = ['--headless', '--isolated', '--chrome-arg=--no-sandbox'];

// unwrapCmd(server): drop a Windows `cmd /c <program>` wrapper from an MCP server config.
// cmd's own switches (/d, /s, /q) may precede /c; a program with spaces stays wrapped (cmd
// parses it). Returns { command, args } with the wrapper removed, or null when the server is
// not wrapped. forTarget() ports Windows captures to Linux; sync.mjs's origin gate reads
// through the wrapper to the real program.
export function unwrapCmd(server) {
  const args = Array.isArray(server?.args) ? server.args : [];
  const c = args.findIndex(a => /^\/c$/i.test(a));
  if (!CMD.test(String(server?.command ?? '')) || c < 0 || !args.slice(0, c).every(a => /^\/[a-z]$/i.test(a))
    || typeof args[c + 1] !== 'string' || !/^\S+$/.test(args[c + 1])) return null;
  return { command: args[c + 1], args: args.slice(c + 2) };
}

export function forTarget(rel, bytes, { home, platform, roots }) {
  if (platform === 'win32' || !rel.endsWith('.json')) return { bytes, notes: [] };
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { bytes, notes: [] }; // not JSON after all: installed as captured
  }
  const notes = [];
  let moved = 0;
  const rebase = v => {
    if (typeof v === 'string') {
      if (!WIN_PATH.test(v)) return v;
      const parts = v.split(/[\\/]+/);
      const i = parts.findIndex(p => roots.has(p));
      if (i < 0) return v;
      moved++;
      return posix.join(home, ...parts.slice(i));
    }
    if (Array.isArray(v)) return v.map(rebase);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebase(x)]));
    return v;
  };
  doc = rebase(doc);
  if (moved) notes.push(`${rel}: ${moved} Windows path(s) now point into ${home}`);
  if (rel === 'omp/agent/mcp.json' && doc?.mcpServers && typeof doc.mcpServers === 'object') {
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

// Repos use autocrlf; compare modulo CRLF so a checked-out copy and a machine copy never look
// different. omp stamps updatedAt in its marketplace registry on every catalog refresh, so a live
// registry drifts from the snapshot without a change of content; that drift is no conflict.
// install-user.mjs records these fingerprints of what it installed, so the same rules decide
// whether a machine file still holds that content.
export function fingerprint(rel, bytes) {
  let text = bytes.toString('latin1').replaceAll('\r\n', '\n');
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
