// Worker-list rules for the dashboard's structured bundle edits: the same rules the
// installer applies to a `workers/<p>/apt.txt`, `tools.json`, `env.txt` or
// `requirements.txt` file (specs/bundles.md, Editing). The source of truth is
// install-user.mjs: validateTools, validateEnv, validateRequirements, and the regexes
// they use (TOOL_NAME, ENV_NAME, SHA256, UNPACK, BIN_SEGMENT, REQ_LINE). This module
// mirrors them byte for byte because install-user.mjs cannot be imported: it parses
// process.argv at top level, and the ALAT-180 card fences the install logic. Change a
// rule there, change it here in the same commit.

/** @typedef {'apt' | 'env' | 'requirements' | 'tools'} WorkerKind */

/** @typedef {{ name: string, url: string, sha256: string, unpack: 'zip' | 'tar.gz' | 'none', bin?: string }} WorkerTool */

// The four worker list kinds of a bundle folder, in the order the bundle format names
// them; the two name lists skills.txt and plugins.txt are not worker lists.
/** @type {readonly ['apt', 'env', 'requirements', 'tools']} */
export const WORKER_KINDS = ['apt', 'env', 'requirements', 'tools'];

/** @type {Record<WorkerKind, string>} */
const WORKER_FILE_NAMES = { apt: 'apt.txt', env: 'env.txt', requirements: 'requirements.txt', tools: 'tools.json' };

/**
 * Bundle list file name of one worker kind.
 * @param {WorkerKind} kind
 * @returns {string}
 */
export function workerFileName(kind) {
  return WORKER_FILE_NAMES[kind];
}

// Mirrored from install-user.mjs; keep byte-identical with the names in the header.
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNPACK = new Set(['zip', 'tar.gz', 'none']);
// A bin path is an archive-relative path: safe segments only, so "..", absolute paths and
// anything shell-like never reach the container.
const BIN_SEGMENT = /^[A-Za-z0-9._-]+$/;
const REQ_LINE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([A-Za-z0-9][A-Za-z0-9.+_!-]*)((?: --hash=sha256:[0-9a-f]{64})+)$/;

// The installer passes apt.txt lines to apt-get as they stand and has no validator for
// the file, so the dashboard's rule is the README's: one Debian package name per line.
const APT_NAME = /^[a-z0-9][a-z0-9+.-]*$/;

/**
 * Name of one tools.json entry; '' when the entry carries no string name.
 * @param {unknown} entry
 * @returns {string}
 */
const toolEntryKey = entry => (entry !== null && typeof entry === 'object' && typeof /** @type {{ name?: unknown }} */ (entry).name === 'string')
  ? /** @type {{ name: string }} */ (entry).name
  : '';

/**
 * Dedup key of one worker-list item (specs/bundles.md, merge order): the first token of
 * the line for apt, where a `=version` pin does not change the package, and for env; the
 * package name before `==`, lowercased, for requirements; the entry `name` for tools.
 * @param {WorkerKind} kind
 * @param {string} text
 * @returns {string}
 */
export function workerItemKey(kind, text) {
  if (kind === 'tools') return toolEntryKey(JSON.parse(text));
  const line = text.replace(/#.*/, '').trim();
  if (kind === 'requirements') {
    const m = REQ_LINE.exec(line);
    return (m === null ? line.split('==')[0] : m[1]).toLowerCase();
  }
  const token = line.split(/\s+/)[0];
  return kind === 'apt' ? token.split('=')[0] : token;
}

/**
 * Parsed entries of a tools.json with the installer's two container-level refusals.
 * @param {Buffer} bytes
 * @param {string} path
 * @returns {WorkerTool[]}
 */
function parseToolsList(bytes, path) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${path}: tools.json is not valid JSON (${/** @type {Error} */ (err).message})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path}: tools.json must be a JSON array of downloads`);
  return /** @type {WorkerTool[]} */ (parsed);
}

/**
 * Refuses `bytes` when they break the rules the installer applies to the kind's list
 * file. Throws with the installer's message shapes (the list path, a line or entry
 * number, the rule) and never returns a value. apt.txt has no installer validator, so
 * its rule here is one Debian package name per line.
 * @param {WorkerKind} kind
 * @param {Buffer} bytes
 * @param {string} path
 * @returns {void}
 */
export function validateWorkerBytes(kind, bytes, path) {
  if (kind === 'apt') {
    bytes.toString('utf8').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      if (!APT_NAME.test(line)) throw new Error(`${path}: apt.txt line ${i + 1}: "${line}" is not a valid apt line (one Debian package name per line)`);
    });
    return;
  }
  if (kind === 'env') {
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
    return;
  }
  if (kind === 'requirements') {
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
    return;
  }
  const list = parseToolsList(bytes, path);
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
}

/**
 * Items of one worker list in file order, each as its dedup key plus its text: the
 * non-comment lines verbatim for the three line lists, the entries as JSON text for
 * tools. A malformed tools.json throws the installer's container-level messages.
 * @param {WorkerKind} kind
 * @param {Buffer} bytes
 * @param {string} path
 * @returns {{ key: string, text: string }[]}
 */
export function parseWorkerItems(kind, bytes, path) {
  if (kind === 'tools') {
    return parseToolsList(bytes, path).map(entry => ({ key: toolEntryKey(entry), text: JSON.stringify(entry) }));
  }
  /** @type {{ key: string, text: string }[]} */
  const items = [];
  bytes.toString('utf8').split(/\r?\n/).forEach(raw => {
    if (!raw.replace(/#.*/, '').trim()) return;
    items.push({ key: workerItemKey(kind, raw), text: raw });
  });
  return items;
}

/**
 * Bytes of a worker list after one add. `prev` null starts the file: the three line
 * lists then take `header` (the caller's one-line comment header, newline included)
 * followed by the item, and tools.json starts as the JSON array with the one entry
 * (`header` must be null there). An existing line list keeps every line, inserts the
 * item before the trailing blank run, and takes prev's dominant line ending. tools.json
 * output is always the canonical two-space JSON array with a trailing newline. The
 * caller validates the item body and the composed bytes; a non-object tools item throws
 * an internal error.
 * @param {WorkerKind} kind
 * @param {Buffer | null} prev
 * @param {string} item
 * @param {string | null} header
 * @returns {Buffer}
 */
export function composeWorkerAdd(kind, prev, item, header) {
  if (kind === 'tools') {
    if (header !== null) throw new Error('composeWorkerAdd: tools.json takes no header');
    const entry = /** @type {unknown} */ (JSON.parse(item));
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('composeWorkerAdd: the tools item is not a JSON object');
    /** @type {WorkerTool[]} */
    const entries = prev === null ? [] : [...parseToolsList(prev, 'tools.json')];
    entries.push(/** @type {WorkerTool} */ (entry));
    return Buffer.from(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }
  if (prev === null) {
    if (header === null) throw new Error(`composeWorkerAdd: ${kind} needs a header when the file is new`);
    return Buffer.from(`${header}${item}\n`, 'utf8');
  }
  const text = prev.toString('utf8');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const lines = text.split('\n');
  let at = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].replace(/\r$/, '').trim() !== '') { at = i + 1; break; }
  }
  lines.splice(at, 0, crlf > loneLf ? `${item}\r` : item);
  return Buffer.from(lines.join('\n'), 'utf8');
}
