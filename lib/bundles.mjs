// Bundle resolution for per-project skills, plugins and worker lists
// (specs/bundles.md). Pure reads and validation: every problem throws a
// whole-run refusal message that names its source, and no function writes.
// The data repo layout: bundles/<name>/ holds any of the six list files;
// projects/projects.json maps each project to the bundles it uses. A bundle
// named core applies to every project. Merge order is core, then the
// project's bundles in array order, then the project's own workers/<p>/
// lists; an item named twice counts once, at its first name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The list files a bundle folder may hold: the four worker files plus the two bundle-only name lists. */
export const BUNDLE_FILES = ['apt.txt', 'tools.json', 'env.txt', 'requirements.txt', 'skills.txt', 'plugins.txt'];

// The name rules of specs/bundles.md: skills follow the skill structure gate's
// rule; plugins are npm package names, one optional @scope/ prefix on the same
// rule.
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/;

/** @param {string} dataDir @returns {boolean} True when bundles/ exists as a directory. */
export function isBundlesMode(dataDir) {
  const dir = join(dataDir, 'bundles');
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * Parses the projects table of projects.json. A project value is the legacy
 * extras array or an object with optional `extras` and `bundles` arrays.
 * Throws with a `projects.json: ...` message on any malformed entry.
 * @param {unknown} table @returns {{ name: string, extras: string[], bundles: string[] }[]}
 */
export function parseManifestProjects(table) {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) throw new Error('projects.json: projects must be an object');
  return Object.entries(table).map(([name, value]) => {
    /** @param {string} label @param {unknown} v @returns {string[]} */
    const stringArray = (label, v) => {
      if (!Array.isArray(v) || v.some(f => typeof f !== 'string')) throw new Error(`projects.json: ${label} for "${name}" must be an array of strings`);
      return v;
    };
    if (Array.isArray(value)) return { name, extras: stringArray('extras', value), bundles: [] };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`projects.json: project "${name}" must be an extras array or an object with extras and bundles`);
    return {
      name,
      extras: value.extras === undefined ? [] : stringArray('extras', value.extras),
      bundles: value.bundles === undefined ? [] : stringArray('bundles', value.bundles),
    };
  });
}

/**
 * Reads one bundle folder into file -> bytes for the known list files.
 * Throws when the folder is missing, is not a directory, or holds a file
 * outside BUNDLE_FILES.
 * @param {string} dataDir @param {string} name @returns {Map<string, Buffer>}
 */
export function readBundleFolder(dataDir, name) {
  if (!SKILL_NAME.test(name)) throw new Error(`bundles: "${name}" is not a valid bundle folder name`);
  const dir = join(dataDir, 'bundles', name);
  let st;
  try { st = statSync(dir); } catch { throw new Error(`bundles: bundle "${name}" has no folder under bundles/`); }
  if (!st.isDirectory()) throw new Error(`bundles: bundle "${name}" is not a folder under bundles/`);
  const files = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!BUNDLE_FILES.includes(entry.name)) throw new Error(`bundles/${name}: unexpected file "${entry.name}" (allowed: ${BUNDLE_FILES.join(', ')})`);
    if (entry.isFile()) files.set(entry.name, readFileSync(join(dir, entry.name)));
    else throw new Error(`bundles/${name}: "${entry.name}" must be a regular file`);
  }
  return files;
}

/**
 * Parses a name list (skills.txt or plugins.txt): one name per line, `#`
 * comments and blank lines. Throws with the path and the first broken rule.
 * @param {Buffer} bytes @param {string} path @param {'skill' | 'plugin'} kind @returns {string[]}
 */
export function parseNameList(bytes, path, kind) {
  const re = kind === 'skill' ? SKILL_NAME : PLUGIN_NAME;
  const names = [];
  for (const [i, raw] of bytes.toString('utf8').split('\n').entries()) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (!re.test(line)) throw new Error(`${path}:${i + 1}: "${line}" is not a valid ${kind} name`);
    names.push(line);
  }
  return names;
}

/**
 * Merges name lists in order; an item named twice counts once, at its first
 * name. @param {string[][]} lists @returns {string[]}
 */
export function mergeNameLists(...lists) {
  const seen = new Set();
  for (const list of lists) for (const name of list) if (!seen.has(name)) seen.add(name);
  return [...seen];
}

/**
 * Non-name list lines (apt.txt, env.txt, requirements.txt): `#` comments and
 * blank lines out, everything else kept verbatim. @param {Buffer} bytes @returns {string[]}
 */
const listLines = bytes => bytes.toString('utf8').split('\n')
  .map(l => l.replace(/\r$/, ''))
  .filter(l => l.trim() && !l.trim().startsWith('#'));

/** First token of a list line: the dedup key for apt and env lines. @param {string} line */
const firstToken = line => line.trim().split(/\s+/)[0];

/**
 * Merges line lists in order, keeping the first line of every item. With
 * `lastWins`, a later line of an already-merged item replaces the earlier
 * line, keeping the earlier line's position: env.txt lines carry an optional
 * `plain` modifier, so a name seen again in a later list re-states the form.
 * `keyOf` overrides the dedup key: requirements.txt lines spell
 * `name==version --hash=...`, so the key is the package name before `==`.
 * The merged file drops comments and blank lines (derived state; the sources
 * keep them). @param {Buffer[]} parts @param {{ lastWins?: boolean, keyOf?: (line: string) => string }} [opts] @returns {Buffer | null}
 */
function mergeLineFiles(parts, { lastWins = false, keyOf = firstToken } = {}) {
  if (!parts.length) return null;
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const part of parts) for (const line of listLines(part)) {
    const key = keyOf(line);
    if (byKey.has(key) && !lastWins) continue;
    byKey.set(key, line);
  }
  return byKey.size ? Buffer.from(`${[...byKey.values()].join('\n')}\n`) : null;
}

// The platforms a tools.json entry may name in its optional `os` filter or in a per-OS
// value object (specs/canonical-form.md, "Per-OS differences as data"): install
// resolves both for the target and drops the resolved wrapper, so no file is ever
// duplicated per OS. An entry whose `os` misses the target drops; a plain object value
// is per-OS only when every own key names one of these platforms.
const PLATFORMS = ['linux', 'win32', 'darwin'];

// resolveToolsEntries(path, bytes, platform): parses one tools.json buffer into the
// entries resolved for `platform`. Per entry: the name rule holds; the optional `os`
// filter must be an array of known platforms or the run refuses, and an entry it
// excludes from the target drops; the `os` field itself never survives (resolved
// capture-side data); a plain object value resolves to the target platform's value.
// Throws with the path and the entry name on any broken rule. One walker for
// mergeToolsFiles and renderToolsJson, so the two cannot drift.
/**
 * @param {string} path @param {Buffer} bytes @param {string} platform @returns {Record<string, unknown>[]}
 */
function resolveToolsEntries(path, bytes, platform) {
  let arr;
  try { arr = JSON.parse(bytes.toString('utf8')); } catch (err) { throw new Error(`${path}: ${(/** @type {Error} */ (err)).message}`); }
  if (!Array.isArray(arr)) throw new Error(`${path}: tools.json must be a JSON array`);
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const entry of arr) {
    const rec = /** @type {Record<string, unknown>} */ (entry);
    const name = rec?.name;
    if (typeof name !== 'string' || !name) throw new Error(`${path}: every tools.json entry needs a string name`);
    if (rec.os !== undefined) {
      const os = rec.os;
      if (!Array.isArray(os) || os.some(p => !PLATFORMS.includes(/** @type {string} */ (p)))) {
        throw new Error(`${path}: entry "${name}": os must be an array of platform names (${PLATFORMS.join(', ')})`);
      }
      if (!os.includes(platform)) continue;
    }
    /** @type {Record<string, unknown>} */
    const resolved = { ...rec };
    delete resolved.os;
    for (const [key, value] of Object.entries(resolved)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const keys = Object.keys(value);
      const unknown = keys.find(k => !PLATFORMS.includes(k));
      if (unknown !== undefined) throw new Error(`${path}: entry "${name}": unknown platform "${unknown}" in "${key}" (${PLATFORMS.join(', ')})`);
      if (!keys.length) continue;
      if (!Object.hasOwn(value, platform)) throw new Error(`${path}: entry "${name}": "${key}" has no value for platform "${platform}" (keys: ${keys.join(', ')})`);
      resolved[key] = /** @type {Record<string, unknown>} */ (value)[platform];
    }
    out.push(resolved);
  }
  return out;
}

/**
 * Merges tools.json arrays in order, resolving every entry for `platform` first, so
 * the name dedup, first wins, applies to the resolved entries. Throws with the path
 * when a part is not a JSON array or an entry breaks a per-OS rule.
 * @param {[string, Buffer][]} parts @param {string} platform @returns {Buffer | null}
 */
function mergeToolsFiles(parts, platform) {
  if (!parts.length) return null;
  const seen = new Set();
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const [path, bytes] of parts) {
    for (const entry of resolveToolsEntries(path, bytes, platform)) {
      const name = /** @type {string} */ (entry.name);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(entry);
    }
  }
  return out.length ? Buffer.from(`${JSON.stringify(out, null, 2)}\n`) : null;
}

/**
 * Renders one tools.json file's bytes for `platform` (specs/canonical-form.md): the
 * same per-OS entry rules as the merge, then the merged serialization. Null when
 * every entry drops for the platform. Refusals name the bare file, not a bundle or
 * workers path; the caller owns the fuller label. Serves the verbatim non-bundles
 * install path; resolveBundlePlan serves the bundles path through mergeToolsFiles.
 * @param {Buffer} bytes @param {string} platform @returns {Buffer | null}
 */
export function renderToolsJson(bytes, platform) {
  const out = resolveToolsEntries('tools.json', bytes, platform);
  return out.length ? Buffer.from(`${JSON.stringify(out, null, 2)}\n`) : null;
}

// Reads one worker list file of a folder, null when absent.
/** @param {string} dir @param {string} file @returns {Buffer | null} */
const readWorkerFile = (dir, file) => {
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p) : null;
};

/**
 * Resolves the full bundle plan for a data repo (specs/bundles.md). Throws a
 * whole-run refusal message on any unknown name, unknown bundle, misplaced
 * file, or malformed manifest, so a caller can refuse before its first write.
 *
 * @param {{
 *   dataDir: string,
 *   projects: { name: string, extras: string[], bundles: string[] }[],
 *   knownSkills: Set<string>,
 *   knownPlugins: Set<string>,
 *   platform?: string,
 * }} input
 * `platform` is the target OS for the per-OS tools.json rules; it defaults to
 * `process.platform` for today's callers (the install host is the target).
 * @returns {{ core: { lists: Map<string, string[]>, workerFiles: Map<string, Buffer> }, projects: { name: string, lists: Map<string, string[]>, workerFiles: Map<string, Buffer> }[] }}
 * `lists` holds the merged `skills` and `plugins` name lists. `workerFiles`
 * holds the merged worker-list bytes per file (absent files omitted); an
 * empty map means the project plans no worker file.
 */
export function resolveBundlePlan({ dataDir, projects, knownSkills, knownPlugins, platform = process.platform }) {
  const bundleNames = existsSync(join(dataDir, 'bundles'))
    ? readdirSync(join(dataDir, 'bundles'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];
  // A bundle folder's name lists are validated once, against the repo's known
  // items, so every later reference is already proven known.
  /** @type {Map<string, { lists: Map<string, string[]>, workerFiles: Map<string, Buffer> }>} */
  const bundles = new Map();
  for (const name of bundleNames) {
    const files = readBundleFolder(dataDir, name);
    const lists = new Map();
    const skills = files.get('skills.txt');
    if (skills !== undefined) {
      const parsed = parseNameList(skills, `bundles/${name}/skills.txt`, 'skill');
      for (const item of parsed) if (!knownSkills.has(item)) throw new Error(`bundles/${name}/skills.txt: unknown skill "${item}" (the data repo holds no skill folder of that name)`);
      lists.set('skills', parsed);
    }
    const plugins = files.get('plugins.txt');
    if (plugins !== undefined) {
      const parsed = parseNameList(plugins, `bundles/${name}/plugins.txt`, 'plugin');
      for (const item of parsed) if (!knownPlugins.has(item)) throw new Error(`bundles/${name}/plugins.txt: unknown plugin "${item}" (the data repo holds no plugin of that name)`);
      lists.set('plugins', parsed);
    }
    /** @type {Map<string, Buffer>} */
    const workerFiles = new Map();
    for (const file of ['apt.txt', 'tools.json', 'env.txt', 'requirements.txt']) {
      const bytes = files.get(file);
      if (bytes !== undefined) workerFiles.set(file, bytes);
    }
    bundles.set(name, { lists, workerFiles });
  }
  // The core bundle rides on every project; its worker files also merge into
  // every project's lists.
  const core = bundles.get('core') ?? { lists: new Map(), workerFiles: new Map() };
  /** @typedef {{ lists: Map<string, string[]>, workerFiles: Map<string, Buffer> }} Bundle */
  /** @param {{ name: string, bundles: string[] }} project @param {string} dir @param {[string, Bundle][]} refs Name/bundle pairs, each bundle proven to exist by the caller. */
  const forProject = (project, dir, refs) => {
    /** @type {Map<string, string[]>} */
    const lists = new Map();
    /** @type {{ kind: 'skill' | 'plugin', path: string, known: Set<string> }[]} */
    const kinds = [
      { kind: 'skill', path: 'skills.txt', known: knownSkills },
      { kind: 'plugin', path: 'plugins.txt', known: knownPlugins },
    ];
    for (const { kind, path, known } of kinds) {
      const ownBytes = readWorkerFile(dir, path);
      const bundleLists = refs.map(([, bundle]) => bundle.lists.get(`${kind}s`) ?? []);
      const coreNames = core.lists.get(`${kind}s`) ?? [];
      // No own file and no names from core or the bundles: no per-project
      // skill list at all (an empty set plans no folder). The plugins list
      // must always exist, though: the consumer scopes a project's plugins
      // only when the file exists, so an empty set still writes an empty
      // file — a missing one would fall back to every plugin of the home.
      const pluginsKind = kind === 'plugin';
      if (!pluginsKind && ownBytes === null && !coreNames.length && !bundleLists.some(l => l.length)) continue;
      const parsed = ownBytes === null ? [] : parseNameList(ownBytes, `workers/${project.name}/${path}`, kind);
      for (const item of parsed) if (!known.has(item)) throw new Error(`workers/${project.name}/${path}: unknown ${kind} "${item}" (the data repo holds no ${kind} of that name)`);
      const merged = mergeNameLists(coreNames, ...bundleLists, parsed);
      // Skills named by core install into the home roots for every project, so
      // they never ride the per-project folder; the plugins list stays the
      // complete per-project set, because it replaces the unscoped fallback.
      const coreSet = new Set(coreNames);
      const final = kind === 'skill' ? merged.filter(name => !coreSet.has(name)) : merged;
      if (final.length || pluginsKind) lists.set(`${kind}s`, final);
    }
    // Worker files merge core, then the project's bundles in array order, then
    // the project's own list. A bundle reference is proven to exist above.
    /** @type {Map<string, Buffer>} */
    const workerFiles = new Map();
    for (const file of ['apt.txt', 'tools.json', 'env.txt', 'requirements.txt']) {
      const own = readWorkerFile(dir, file);
      const parts = [
        ...(core.workerFiles.has(file) ? [[`bundles/core/${file}`, core.workerFiles.get(file)]] : []),
        ...refs.filter(([, bundle]) => bundle.workerFiles.has(file)).map(([name, bundle]) => /** @type {[string, Buffer]} */ ([`bundles/${name}/${file}`, /** @type {Buffer} */ (bundle.workerFiles.get(file))])),
        ...(own !== null ? [[`workers/${project.name}/${file}`, own]] : []),
      ];
      if (!parts.length) continue;
      const merged = file === 'tools.json'
        ? mergeToolsFiles(/** @type {[string, Buffer][]} */ (parts), platform)
        : file === 'requirements.txt'
          // The key mirrors validateRequirements' duplicate rule: the package
          // name before `==`, lowercased, so `PyYAML` and `pyyaml` count as
          // one package and the merged bytes never carry a duplicate.
          ? mergeLineFiles(/** @type {Buffer[]} */ (parts.map(([, bytes]) => bytes)), { keyOf: line => firstToken(line).split('==')[0].toLowerCase() })
          : mergeLineFiles(/** @type {Buffer[]} */ (parts.map(([, bytes]) => bytes)), { lastWins: file === 'env.txt' });
      if (merged !== null) workerFiles.set(file, merged);
    }
    return { lists, workerFiles };
  };
  return {
    core,
    projects: projects.map(project => {
      // Validate the bundle references before any merge, so a typo refuses the
      // run naming the project and the bundle.
      for (const b of project.bundles) if (!bundles.has(b)) throw new Error(`projects.json: project "${project.name}" names unknown bundle "${b}" (no folder bundles/${b}/)`);
      const refs = /** @type {[string, Bundle][]} */ (project.bundles.map(b => [b, bundles.get(b)]));
      return { name: project.name, ...forProject(project, join(dataDir, 'workers', project.name), refs) };
    }),
  };
}
