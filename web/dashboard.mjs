// Dashboard core for the alate web UI: inventory scan and data-repo import.
// HTTP serving lives in server.ts; this module is transport-free.
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSourceInside, checkDestination, cloneCommand, dataHost, descriptionText, gitAuthEnv, githubHost, parseDataSpec, redactSecrets, serverGitEnv, SNAP_AGENTS_DIR } from '../lib/data.mjs';
import { isBundlesMode, mergeLineSources, mergeNamedSources, mergeToolsSources, parseNameList, readBundleFolder } from '../lib/bundles.mjs';
import { composeWorkerAdd, parseWorkerItems, validateWorkerBytes, workerItemKey } from '../lib/worker-lists.mjs';

/** @typedef {import('node:sqlite').DatabaseSync} DashDb */
/** @typedef {import('../lib/data.mjs').DataSpec} DataSpec */
/** @typedef {{ name: string, description: string }} RuleInfo */
/** @typedef {{ path: string, bytes: number }} FileInfo */
/** @typedef {{ name: string, origin: string, path: string, description: string, bundles: string[], shelf: boolean }} SkillInfo */
/** @typedef {{ name: string, version?: string, origin?: string, bundles: string[], shelf: boolean }} PluginInfo */
/** @typedef {{ name: string, files: string[], skills: string[], plugins: string[], items: { apt: string[], tools: string[], env: string[], requirements: string[] } }} BundleInfo */
/** @typedef {{ path: string, bytes: number, status: string }} InventoryEntry */
/** @typedef {{ item: string, source: string }} NamedItem */
/** @typedef {{ skills: NamedItem[], plugins: NamedItem[], apt: NamedItem[], env: NamedItem[], requirements: NamedItem[], tools: NamedItem[] }} EffectiveLists */
/** @typedef {{ name: string, extras: number, files: number, live: string, bundles: string[], effective: EffectiveLists, entries: InventoryEntry[] }} NamedProject */
/** @typedef {{ contextFiles: string[], named: NamedProject[] }} ProjectsInventory */
/** @typedef {{ rules: RuleInfo[], user: { configFiles: FileInfo[], others: FileInfo[], skills: SkillInfo[], extensions: string[], plugins: PluginInfo[] }, projects: ProjectsInventory, bundles: BundleInfo[], counts: { rules: number, skills: number, plugins: number, extensions: number, projects: number, bundles: number, userFiles: number }, warnings: string[] }} Inventory */
/** @typedef {{ added: string[], removed: string[], updated: string[] }} SectionChanges */
/** @typedef {Record<string, SectionChanges>} Changes */
/** @typedef {{ kind: string, spec: string, name: string, host: string, ref: string, importedSha: string }} SourceMeta */
/** @typedef {SourceMeta & { importedAt: string }} SourceInfo */
/** @typedef {{ dir: string, temp: boolean, source: SourceMeta }} ResolvedSource */
/** @typedef {{ checkedAt: string, remoteSha: string, available: boolean }} UpdateInfo */
/** @typedef {{ source: SourceInfo, inventory: Inventory | null, previous: Inventory | null, changes: Changes | null, update?: UpdateInfo | null, provision?: unknown }} StateDef */
/** @typedef {{ name: string, extras?: number, files?: number, live?: string, entries?: InventoryEntry[] }} ProjectListItem */
/** @typedef {{ rel: string, base: string | null, bytes: Buffer | null, message: string }} EditOp */
/** @typedef {'skill' | 'plugin' | 'apt' | 'env' | 'requirements' | 'tools'} BundleKind */
/** @typedef {{ commit: string, pushed: boolean, warning?: string, state: StateDef }} EditResult */
/** @typedef {Error & { status?: number, snapshotChanged?: boolean }} StatusedError */
/** @typedef {{ path: string, bytes: number, binary: boolean, content: string | null, hash: string }} StoredFile */

// Test hook: point the dashboard's GitHub traffic at a local fixture remote (override only).
const GH_BASE = process.env.ALATE_TEST_GH_BASE ?? null;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const NOT_RULES = new Set(['AGENTS.md', 'README.md']);

// Frontmatter description of a markdown file: '' when absent. Metadata only — the body is never rendered.
/** @param {string} file @returns {string} */
function mdDescription(file) {
  const text = readFileSync(file, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return (front && descriptionText(front[1])) ?? '';
}

// CRLF-normalized comparison basis (same as sync-projects.mjs)
/** @param {Buffer} b */
const norm = b => b.toString('latin1').replaceAll('\r\n', '\n');

// Relative '/'-separated paths of regular files under dir; symlinks are never followed; [] when missing.
/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  /** @param {string} base */
  const walk = base => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out;
}

/** @param {string} dir @returns {number} */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n++;
  }
  return n;
}

const USER_CONFIGS = ['omp/agent/config.yml', 'omp/agent/mcp.json', 'omp/agent/optimizer.json', 'omp/marketplaces.json'];
// Counted under user/ but not listed elsewhere; every counted file needs a row (F2).
const USER_OTHERS = [
  'omp/plugins/package.json',
  'omp/plugins/bun.lock',
  'omp/plugins/omp-plugins.lock.json',
  'omp/plugins/installed_plugins.json',
  `${SNAP_AGENTS_DIR}/.skill-lock.json`,
];
const SKILL_DIRS = [
  ['user/omp/agent/skills', 'skills'],
  ['user/omp/agent/managed-skills', 'managed-skills'],
  [`user/${SNAP_AGENTS_DIR}/skills`, 'agents-skills'],
];

// Read-only inventory of a data repo. Missing pieces are empty, never fatal; findings land in warnings.
/**
 * @param {string} dir
 * @param {string | null} [liveRoot=null]
 * @returns {Inventory}
 */
function scanInventory(dir, liveRoot = null) {
  const warnings = [];
  const rules = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.mdc?$/.test(entry.name) || NOT_RULES.has(entry.name)) continue;
    const file = join(dir, entry.name);
    assertSourceInside(dir, file);
    rules.push({ name: entry.name, description: mdDescription(file) });
  }

  const configFiles = [];
  for (const rel of USER_CONFIGS) {
    const file = join(dir, 'user', rel);
    if (!existsSync(file)) continue;
    assertSourceInside(dir, file);
    configFiles.push({ path: rel, bytes: statSync(file).size });
  }

  /** @type {SkillInfo[]} */
  const skills = [];
  for (const [rel, origin] of SKILL_DIRS) {
    const base = join(dir, ...rel.split('/'));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      assertSourceInside(dir, join(base, entry.name));
      const skillMd = join(base, entry.name, 'SKILL.md');
      skills.push({ name: entry.name, origin, path: `${rel}/${entry.name}/SKILL.md`, description: existsSync(skillMd) ? mdDescription(skillMd) : '', bundles: [], shelf: false });
    }
  }

  const others = [];
  for (const rel of USER_OTHERS) {
    const file = join(dir, 'user', ...rel.split('/'));
    if (!existsSync(file)) continue;
    assertSourceInside(dir, file);
    others.push({ path: rel, bytes: statSync(file).size });
  }
  others.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const extBase = join(dir, 'user', 'omp', 'agent', 'extensions');
  /** @type {string[]} */
  let extensions = [];
  if (existsSync(extBase)) {
    try {
      assertSourceInside(dir, extBase);
      extensions = readdirSync(extBase).sort();
    } catch {
      warnings.push('user/omp/agent/extensions: link escapes the data repo; skipped');
    }
  }

  /** @type {PluginInfo[]} */
  const plugins = [];
  const seen = new Set();
  /** @param {string[]} names */
  const addPlugins = names => {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      plugins.push({ name, bundles: [], shelf: false });
    }
  };
  /** @param {string} rel */
  const readJson = rel => {
    const file = join(dir, ...rel.split('/'));
    if (!existsSync(file)) return null;
    assertSourceInside(dir, file);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      warnings.push(`${rel}: unparseable JSON, skipped`);
      return null;
    }
  };
  const pkg = readJson('user/omp/plugins/package.json');
  for (const name of Object.keys(pkg?.dependencies ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    plugins.push({ name, version: pkg.dependencies[name], origin: 'package.json', bundles: [], shelf: false });
  }
  const lock = readJson('user/omp/plugins/omp-plugins.lock.json');
  const lockNames = Object.keys(lock?.plugins ?? lock ?? {});
  const lockStart = plugins.length;
  addPlugins(lockNames);
  for (let i = lockStart; i < plugins.length; i++) plugins[i].origin = 'omp-plugins.lock.json';
  const installed = readJson('user/omp/plugins/installed_plugins.json');
  const instNames = Object.keys(installed?.plugins ?? installed ?? {});
  const instStart = plugins.length;
  addPlugins(instNames);
  for (let i = instStart; i < plugins.length; i++) plugins[i].origin = 'installed_plugins.json';

  // Bundles mode (specs/bundles.md): list every bundle folder with its present
  // list files and the names in its skills.txt/plugins.txt, and scan the worker
  // lists as further naming sources (workers/_all included). The dashboard
  // warns where the install refuses; it never fails the scan.
  const bundlesMode = isBundlesMode(dir);
  /** @type {BundleInfo[]} */
  const bundles = [];
  /** @type {string[]} */
  const workerSkills = [];
  /** @type {string[]} */
  const workerPlugins = [];
  // Raw list bytes per parsed bundle folder, for the per-project effective merges.
  /** @type {Map<string, Map<string, Buffer>>} */
  const bundleBytes = new Map();
  // Directory names directly under bundles/, for the unknown-bundle warning.
  /** @type {Set<string>} */
  const bundleDirNames = new Set();
  // Parsed name lists per worker folder; a project's own effective source
  // (workers/_all is a shelf-naming source only and never merges into a project).
  /** @type {Map<string, { skills: string[], plugins: string[] }>} */
  const workerNameLists = new Map();
  if (bundlesMode) {
    const workersBase = join(dir, 'workers');
    if (existsSync(workersBase)) {
      try {
        assertSourceInside(dir, workersBase);
        for (const entry of readdirSync(workersBase, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const wdir = join(workersBase, entry.name);
          assertSourceInside(dir, wdir);
          /** Per-folder parsed lists, kept for a project's own effective source. @type {{ skills: string[], plugins: string[] }} */
          const folderLists = { skills: [], plugins: [] };
          workerNameLists.set(entry.name, folderLists);
          /** @param {'skills.txt' | 'plugins.txt'} file @param {'skill' | 'plugin'} kind @param {string[]} into @param {string[]} folderInto */
          const readWorkerNames = (file, kind, into, folderInto) => {
            const path = join(wdir, file);
            if (!existsSync(path)) return;
            assertSourceInside(dir, path);
            try {
              const parsed = parseNameList(readFileSync(path), `workers/${entry.name}/${file}`, kind);
              for (const name of parsed) if (!into.includes(name)) into.push(name);
              folderInto.push(...parsed);
            } catch (err) {
              warnings.push(/** @type {Error} */ (err).message);
            }
          };
          readWorkerNames('skills.txt', 'skill', workerSkills, folderLists.skills);
          readWorkerNames('plugins.txt', 'plugin', workerPlugins, folderLists.plugins);
        }
      } catch {
        warnings.push('workers: link escapes the data repo; lists skipped');
      }
    }
    const knownSkills = new Set(skills.map(s => s.name));
    for (const entry of readdirSync(join(dir, 'bundles'), { withFileTypes: true })) {
      if (entry.isDirectory()) bundleDirNames.add(entry.name);
      let files;
      try {
        files = readBundleFolder(dir, entry.name);
      } catch (err) {
        // not a folder, or a misplaced file: the message names the bundle (and the file)
        warnings.push(/** @type {Error} */ (err).message);
        continue;
      }
      /** @type {string[]} */
      const skillNames = [];
      /** @type {string[]} */
      const pluginNames = [];
      /** @param {string} list @param {'skill' | 'plugin'} kind @param {string[]} into */
      const readNames = (list, kind, into) => {
        if (!files.has(list)) return;
        try {
          into.push(...parseNameList(/** @type {Buffer} */ (files.get(list)), `bundles/${entry.name}/${list}`, kind));
        } catch (err) {
          warnings.push(/** @type {Error} */ (err).message);
        }
      };
      readNames('skills.txt', 'skill', skillNames);
      readNames('plugins.txt', 'plugin', pluginNames);
      for (const name of skillNames) if (!knownSkills.has(name)) warnings.push(`bundles/${entry.name}: unknown skill "${name}"`);
      for (const name of pluginNames) if (!seen.has(name)) warnings.push(`bundles/${entry.name}: unknown plugin "${name}"`);
      // The bundle's own list items, single source, in file order: verbatim
      // lines for the three worker lists, entry names for tools.json.
      /** Parsed lines of one worker list file. @param {string} file @returns {string[]} */
      const fileItems = file => mergeLineSources([[`bundles/${entry.name}/${file}`, /** @type {Buffer} */ (files.get(file))]]).map(r => r.item);
      /** @type {{ apt: string[], tools: string[], env: string[], requirements: string[] }} */
      const items = {
        apt: files.has('apt.txt') ? fileItems('apt.txt') : [],
        tools: [],
        env: files.has('env.txt') ? fileItems('env.txt') : [],
        requirements: files.has('requirements.txt') ? fileItems('requirements.txt') : [],
      };
      if (files.has('tools.json')) {
        try {
          items.tools = mergeToolsSources([[`bundles/${entry.name}/tools.json`, /** @type {Buffer} */ (files.get('tools.json'))]]).map(r => r.item);
        } catch (err) {
          // a malformed array or a nameless entry: the message names the file, and the file yields []
          warnings.push(/** @type {Error} */ (err).message);
        }
      }
      bundles.push({ name: entry.name, files: [...files.keys()].sort(), skills: skillNames, plugins: pluginNames, items });
      bundleBytes.set(entry.name, files);
    }
    // Sorted bundle order: the per-item bundles arrays and the section follow it,
    // and the listing stays stable across platforms' readdir orders.
    bundles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Per-item naming: the bundles that name the item, in bundle scan order; the
    // shelf means no bundle and no worker list names it.
    const bundleSkills = new Map();
    const bundlePlugins = new Map();
    for (const b of bundles) {
      for (const name of b.skills) { if (!bundleSkills.has(name)) bundleSkills.set(name, []); bundleSkills.get(name)?.push(b.name); }
      for (const name of b.plugins) { if (!bundlePlugins.has(name)) bundlePlugins.set(name, []); bundlePlugins.get(name)?.push(b.name); }
    }
    /** @param {string} name @param {Map<string, string[]>} named @param {string[]} workers @returns {{ bundles: string[], shelf: boolean }} */
    const naming = (name, named, workers) => ({ bundles: named.get(name) ?? [], shelf: !named.has(name) && !workers.includes(name) });
    for (const s of skills) Object.assign(s, naming(s.name, bundleSkills, workerSkills));
    for (const p of plugins) Object.assign(p, naming(p.name, bundlePlugins, workerPlugins));
  } else {
    for (const s of skills) { s.bundles = []; s.shelf = false; }
    for (const p of plugins) { p.bundles = []; p.shelf = false; }
  }

  // Per-project effective lists (specs/bundles.md merge order): core, then the
  // project's bundles whose folder exists, then the project's own workers/<p>/
  // lists. Every item keeps its first source; env.txt restatements win and keep
  // their first position. Computed from the already-parsed bundle lists, so a
  // broken file warns once, and the scan never throws.
  /** @param {string} projectName @param {string[]} refs @returns {EffectiveLists} */
  const projectEffective = (projectName, refs) => {
    /** Sources in merge order: the label is `core`, the bundle name, or (own) `workers/<p>`. @type {[string, Map<string, Buffer>][]} */
    const sources = [];
    if (bundleBytes.has('core')) sources.push(['core', /** @type {Map<string, Buffer>} */ (bundleBytes.get('core'))]);
    for (const b of refs) {
      if (!bundleDirNames.has(b)) {
        warnings.push(`projects.json: project "${projectName}" names unknown bundle "${b}" (no folder bundles/${b}/)`);
        continue;
      }
      // A folder that exists but failed to parse already warned in the bundle scan; it contributes nothing.
      if (bundleBytes.has(b)) sources.push([b, /** @type {Map<string, Buffer>} */ (bundleBytes.get(b))]);
    }
    // The own lists ride the worker scan's guards: a folder that scan could not
    // read (its escape already warned) contributes nothing here.
    const ownDir = workerNameLists.has(projectName) ? join(dir, 'workers', projectName) : null;
    /** @param {string} file @returns {Buffer | null} */
    const ownFile = file => {
      if (!ownDir) return null;
      const path = join(ownDir, file);
      if (!existsSync(path)) return null;
      try { assertSourceInside(dir, path); } catch { return null; }
      return readFileSync(path);
    };
    /** Bundle and own bytes of one worker list file, in merge order. @param {string} file @returns {[string, Buffer][]} */
    const lineParts = file => {
      /** @type {[string, Buffer][]} */
      const parts = [];
      for (const [label, bundleFiles] of sources) if (bundleFiles.has(file)) parts.push([label, /** @type {Buffer} */ (bundleFiles.get(file))]);
      const own = ownFile(file);
      if (own !== null) parts.push([`workers/${projectName}`, own]);
      return parts;
    };
    /** @type {[string, string[]][]} */
    const skillParts = [];
    /** @type {[string, string[]][]} */
    const pluginParts = [];
    /** @type {[string, string[]][]} */
    const toolParts = [];
    for (const [label] of sources) {
      const b = bundles.find(x => x.name === label);
      if (b) { skillParts.push([label, b.skills]); pluginParts.push([label, b.plugins]); toolParts.push([label, b.items.tools]); }
    }
    const ownLists = workerNameLists.get(projectName);
    if (ownLists) {
      skillParts.push([`workers/${projectName}`, ownLists.skills]);
      pluginParts.push([`workers/${projectName}`, ownLists.plugins]);
    }
    const ownTools = ownFile('tools.json');
    if (ownTools !== null) {
      try { toolParts.push([`workers/${projectName}`, mergeToolsSources([[`workers/${projectName}/tools.json`, ownTools]]).map(r => r.item)]); }
      catch (err) { warnings.push(/** @type {Error} */ (err).message); }
    }
    return {
      skills: mergeNamedSources(skillParts),
      plugins: mergeNamedSources(pluginParts),
      apt: mergeLineSources(lineParts('apt.txt'), {}),
      env: mergeLineSources(lineParts('env.txt'), { lastWins: true }),
      requirements: mergeLineSources(lineParts('requirements.txt'), { keyOf: line => line.trim().split(/\s+/)[0].split('==')[0].toLowerCase() }),
      tools: mergeNamedSources(toolParts),
    };
  };
  /** @returns {EffectiveLists} */
  const emptyEffective = () => ({ skills: [], plugins: [], apt: [], env: [], requirements: [], tools: [] });

  /** @type {ProjectsInventory} */
  const projects = { contextFiles: [], named: [] };
  const manifest = readJson('projects/projects.json');
  if (manifest) {
    projects.contextFiles = Array.isArray(manifest.contextFiles) && manifest.contextFiles.every(/** @param {unknown} f */ f => typeof f === 'string')
      ? manifest.contextFiles
      : (warnings.push('projects/projects.json: contextFiles must be an array of strings; ignored'), []);
    // W3: the contract requires a non-null object — absent/null/shape-wrong all warn and skip
    let table = null;
    if (manifest.projects !== null && typeof manifest.projects === 'object' && !Array.isArray(manifest.projects)) table = manifest.projects;
    else warnings.push('projects/projects.json: projects must be an object; ignored');
    for (const [name, value] of Object.entries(table ?? {})) {
      // F1: a projects.json key is a single path segment, never a traversal
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
        warnings.push(`projects/projects.json: rejected unsafe project name "${name}"`);
        continue;
      }
      // parseManifestProjects semantics with per-entry tolerance: the legacy
      // value is the extras array, the object form holds extras and bundles.
      /** @type {unknown} */
      let extras;
      /** @type {string[]} */
      let projectBundles = [];
      if (Array.isArray(value)) extras = value;
      else if (value !== null && typeof value === 'object') {
        extras = /** @type {{ extras?: unknown }} */ (value).extras === undefined ? [] : /** @type {{ extras?: unknown }} */ (value).extras;
        const rawBundles = /** @type {{ bundles?: unknown }} */ (value).bundles;
        if (Array.isArray(rawBundles) && rawBundles.every(/** @param {unknown} f */ f => typeof f === 'string')) projectBundles = /** @type {string[]} */ (rawBundles);
        else if (rawBundles !== undefined) warnings.push(`projects/projects.json: bundles for "${name}" must be an array of strings; bundles ignored`);
      } else extras = value;
      if (!Array.isArray(extras) || !extras.every(/** @param {unknown} f */ f => typeof f === 'string')) {
        warnings.push(`projects/projects.json: extras for "${name}" must be an array of strings; project skipped`);
        continue;
      }
      const projectDir = join(dir, 'projects', name);
      // a missing snapshot dir is tolerated like every other missing piece
      const snapRels = existsSync(projectDir) ? (assertSourceInside(dir, projectDir), listFiles(projectDir)) : [];
      const liveDir = /** @type {string} */ (liveRoot ? join(liveRoot, name) : null);
      let live = liveRoot ? (existsSync(liveDir) ? 'checked' : 'gone') : 'off';
      if (live === 'checked') {
        try { assertSourceInside(/** @type {string} */ (liveRoot), liveDir); } catch {
          live = 'off';
          warnings.push(`${name}: live project dir escapes the workspace; drift not checked`);
        }
      }
      const entries = [];
      for (const snapRel of snapRels) {
        const snapFile = join(projectDir, ...snapRel.split('/'));
        let status;
        if (live === 'off') status = 'unknown';
        else {
          const liveFile = join(liveDir, ...snapRel.split('/'));
          status = !existsSync(liveFile) ? 'missing' : (norm(readFileSync(snapFile)) === norm(readFileSync(liveFile)) ? 'sync' : 'changed');
        }
        entries.push({ path: snapRel, bytes: statSync(snapFile).size, status });
      }
      if (live === 'checked') {
        for (const rel of [...projects.contextFiles, ...extras]) {
          if (snapRels.includes(rel)) continue;
          // manifest paths are client-controlled data: validate before use
          const segments = rel.replaceAll('\\', '/').split('/');
          if (segments.some(s => s === '' || s === '.' || s === '..')) {
            warnings.push(`${name}: rejected unsafe snapshot path "${rel}"`);
            continue;
          }
          const liveFile = join(liveDir, ...segments);
          // assertSourceInside realpaths its target, so it is only valid for existing paths
          if (!existsSync(liveFile) || !statSync(liveFile).isFile()) continue;
          try { assertSourceInside(liveDir, liveFile); } catch {
            warnings.push(`${name}: rejected unsafe snapshot path "${rel}"`);
            continue;
          }
          entries.push({ path: rel, bytes: statSync(liveFile).size, status: 'uncaptured' });
        }
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const effective = bundlesMode ? projectEffective(name, projectBundles) : emptyEffective();
      projects.named.push({ name, extras: extras.length, files: snapRels.length, live, bundles: projectBundles, effective, entries });
    }
  } else if (existsSync(join(dir, 'projects'))) {
    warnings.push('projects/projects.json: missing or unparseable; showing what exists');
  }

  // U3: an absent user/ is normal (rules-only repo), not an escape
  let userFiles = 0;
  if (existsSync(join(dir, 'user'))) {
    try {
      assertSourceInside(dir, join(dir, 'user'));
      userFiles = countFiles(join(dir, 'user'));
    } catch {
      warnings.push('user/: link escapes the data repo; count skipped');
    }
  }
  return {
    rules,
    user: { configFiles, others, skills, extensions, plugins },
    projects,
    bundles,
    counts: {
      rules: rules.length,
      skills: skills.length,
      plugins: plugins.length,
      extensions: extensions.length,
      projects: projects.named.length,
      bundles: bundles.length,
      userFiles,
    },
    warnings,
  };
}

// Added/removed by name between two inventories; sections absent from previous are all added.
/**
 * @param {string[]} prevNames
 * @param {string[]} nextNames
 * @returns {SectionChanges}
 */
function sectionChanges(prevNames, nextNames) {
  const prev = new Set(prevNames);
  return {
    added: nextNames.filter(n => !prev.has(n)),
    removed: [...prev].filter(n => !nextNames.includes(n)),
    updated: [], // S7: filled when both sides have the name and the metadata differs
  };
}
/**
 * @param {Inventory | null} prev
 * @param {Inventory} next
 * @returns {Changes}
 */
function computeChanges(prev, next) {
  // names in both inventories whose scanned metadata changed
  /**
   * @template {{ name: string }} T
   * @param {T[]} prevList
   * @param {T[]} nextList
   * @param {(item: T) => string} sig
   * @returns {SectionChanges}
   */
  const withUpdates = (prevList, nextList, sig) => {
    const ch = sectionChanges(prevList.map(x => x.name), nextList.map(x => x.name));
    const prevSig = new Map(prevList.map(x => [x.name, sig(x)]));
    for (const nx of nextList) {
      if (prevSig.has(nx.name) && prevSig.get(nx.name) !== sig(nx)) ch.updated.push(nx.name);
    }
    return ch;
  };
  // W1: User layer changes track the displayed records, not every file under user/.
  // ponytail: content edits to a same-path config file stay invisible — we never read file bodies, only names/sizes.
  /** @param {Inventory | null} inv */
  const userIds = inv => [...new Set([
    ...(inv?.user?.configFiles ?? []).map(f => f.path),
    ...(inv?.user?.others ?? []).map(f => f.path),
    ...(inv?.user?.extensions ?? []),
  ])];
  // W2: Projects changes cover named projects plus context files, prefixed to stay distinct
  /** @param {Inventory | null} inv @returns {ProjectListItem[]} */
  const projList = inv => [
    ...(inv?.projects?.contextFiles ?? []).map(f => ({ name: '@context/' + f })),
    ...(inv?.projects?.named ?? []),
  ];
  const changes = {
    rules: withUpdates(prev?.rules ?? [], next.rules, r => r.description),
    // A bundles/shelf change is metadata: it marks the item updated.
    skills: withUpdates(prev?.user?.skills ?? [], next.user.skills, s => s.origin + '\u0000' + s.description + '\u0000' + (s.bundles ?? []).join(',') + '\u0000' + (s.shelf ? '1' : '0')),
    plugins: withUpdates(prev?.user?.plugins ?? [], next.user.plugins, p => p.version + '\u0000' + p.origin + '\u0000' + (p.bundles ?? []).join(',') + '\u0000' + (p.shelf ? '1' : '0')),
    extensions: sectionChanges(prev?.user?.extensions ?? [], next.user.extensions),
    user: sectionChanges(userIds(prev), userIds(next)),
    projects: withUpdates(projList(prev), projList(next), p => (p.extras ?? 0) + '\u0000' + (p.files ?? 0)),
    bundles: sectionChanges((prev?.bundles ?? []).map(b => b.name), next.bundles.map(b => b.name)),
  };
  return changes;
}

/**
 * @param {DashDb} db
 * @returns {StateDef}
 */
function loadState(db) {
  const row = /** @type {{ value: string } | undefined} */ (db.prepare('SELECT value FROM state WHERE id = 1').get());
  return row ? /** @type {StateDef} */ (JSON.parse(row.value)) : /** @type {StateDef} */ (/** @type {unknown} */ ({ source: null, inventory: null, previous: null, changes: null }));
}

// Resolve a source string to { dir, temp, source }. Throws Error with a client-safe message on failure.
// kind: 'repo' clones, 'path' reads a local directory, absent prefers a local directory.
/**
 * @param {string} spec
 * @param {string | undefined} kind
 * @param {string | undefined} token
 * @returns {ResolvedSource}
 */
function resolveSource(spec, kind, token) {
  const asGiven = existsSync(spec);
  if (kind !== 'repo' && (asGiven || existsSync(resolve(repoRoot, spec)))) {
    const dir = resolve(asGiven ? spec : resolve(repoRoot, spec));
    // a path-kind source stores no host; the cast documents the repo-source shape
    return { dir, temp: false, source: /** @type {SourceMeta} */ ({ kind: 'path', spec, name: dir, ref: '', importedSha: '' }) };
  }
  if (kind === 'path') {
    throw Object.assign(new Error(`no local data repo at ${spec}`), { status: 400 });
  }
  const parsed = parseDataSpec(spec);
  if (!parsed || (!asGiven && (/^([A-Za-z]:[\\/]|\\\\)/.test(spec) || parsed.name.startsWith('.')))) {
    throw Object.assign(new Error(`no data repo at ${spec}; pass a local path or owner/name[@ref]`), { status: 400 });
  }
  return cloneRepo(spec, parsed, token);
}

// A local dir of that name wins over the GitHub URL (cloneRepo, remoteHead and pushes agree).
/** @param {string} name @param {string} [host] @returns {string} */
const remoteUrl = (name, host = '') => (existsSync(name) ? name : `${GH_BASE ?? `https://${host || githubHost().host}`}/${name}`);

// Clone a GitHub repo into a fresh temp dir; temp: true so importSource cleans it up.
/**
 * @param {string} spec
 * @param {DataSpec} parsed
 * @param {string | undefined} token
 * @returns {ResolvedSource}
 */
function cloneRepo(spec, parsed, token) {
  let host;
  try {
    host = dataHost(parsed, process.env);
  } catch (err) {
    throw Object.assign(new Error(/** @type {Error} */ (err).message), { status: 400 });
  }
  const url = remoteUrl(parsed.name, host);
  const active = token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), 'alate-dashboard-'));
  const { args: gitArgs, env } = cloneCommand(url, parsed.ref, active, dir, repoGitBase());
  const git = spawnSync('git', gitArgs, { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (git.status !== 0) {
    rmSync(dir, { recursive: true, force: true }); // our own fresh temp dir only
    const stderr = redactSecrets(git.stderr ?? '', active).trim();
    throw Object.assign(new Error(`git clone failed for ${parsed.name}${parsed.ref ? `@${parsed.ref}` : ''}${stderr ? `: ${stderr}` : ''}`), { status: 400 });
  }
  // HEAD sha at clone time: the baseline the periodic remote check compares against.
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: serverGitEnv(), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  if (head.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cannot read cloned HEAD for ${parsed.name}`);
  }
  const importedSha = head.stdout.trim();
  return { dir, temp: true, source: { kind: 'repo', spec, name: parsed.name, host, ref: parsed.ref, importedSha } };
}

// resolvedIn: an already-resolved { dir, temp, source } to import directly (the editor's
// clone), so a write never clones twice. Absent: resolveSource resolves spec as usual.
/**
 * @param {StateDef} state
 * @param {string} spec
 * @param {string | undefined} kind
 * @param {string | undefined} token
 * @param {DashDb} db
 * @param {ResolvedSource | null} [resolvedIn=null]
 * @returns {StateDef}
 */
function importSource(state, spec, kind, token, db, resolvedIn = null) {
  const resolved = resolvedIn ?? resolveSource(spec, kind, token);
  try {
    const inventory = scanInventory(resolved.dir, resolved.temp ? null : dirname(resolved.dir));
    const previous = state.inventory;
    const changes = previous ? computeChanges(previous, inventory) : null;
    const next = { source: { ...resolved.source, importedAt: new Date().toISOString() }, inventory, previous, changes };
    // One transaction keeps the previous snapshot intact if any source read fails.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM files');
      const insert = db.prepare('INSERT INTO files (path, content) VALUES (?, ?)');
      /** @param {string} dir @param {string} [sub] */
      const walk = (dir, sub = '') => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (['.git', 'node_modules', '__pycache__'].includes(entry.name)) continue;
          const rel = sub ? `${sub}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink() || /[\\:\0]/.test(rel)) throw Object.assign(new Error(`unsafe snapshot path: ${rel}`), { status: 400 });
          const file = join(dir, entry.name);
          assertSourceInside(resolved.dir, file);
          if (entry.isDirectory()) walk(file, rel);
          else if (entry.isFile()) insert.run(rel, readFileSync(file));
          else throw Object.assign(new Error(`snapshot path is not a regular file: ${rel}`), { status: 400 });
        }
      };
      walk(resolved.dir);
      db.prepare('INSERT OR REPLACE INTO state (id, value) VALUES (1, ?)').run(JSON.stringify(next));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return next;
  } finally {
    if (resolved.temp) rmSync(resolved.dir, { recursive: true, force: true });
  }
}

// Existing installers read a directory. It contains only the stored database bytes.
/**
 * @param {DashDb} db
 * @returns {{ dir: string, temp: boolean }}
 */
function snapshotData(db) {
  const dir = mkdtempSync(join(tmpdir(), 'alate-snapshot-'));
  try {
    for (const { path, content } of /** @type {Iterable<{ path: string, content: Buffer }>} */ (db.prepare('SELECT path, content FROM files').iterate())) {
      if (/[\\:\0]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`unsafe snapshot path: ${path}`);
      const dest = join(dir, path);
      checkDestination(dir, dest);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    return { dir, temp: true };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// ---- File editor: verify a base hash, write or delete in a source tree, commit and push. ----

/** @param {Buffer} b @returns {string} */
const sha256 = b => createHash('sha256').update(b).digest('hex');
/** @param {number} status @param {string} message @returns {never} */
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Editor paths are relative '/'-separated snapshot paths. Reject everything the snapshot
// itself rejects (backslash, colon, NUL) plus traversal and any .git segment.
/** @param {unknown} path @returns {string} */
function safeRelPath(path) {
  const shown = typeof path === 'string' ? path.slice(0, 100) : '';
  if (typeof path !== 'string' || path === '' || /[\\:\0]/.test(path) || path.startsWith('/')) fail(400, `unsafe file path: ${shown}`);
  if (path.split('/').some(s => !s || s === '.' || s === '..' || /^\.git$/i.test(s))) fail(400, `unsafe file path: ${shown}`);
  return path;
}

// One stored snapshot file for the editor: null when absent. binary when the bytes are not
// valid UTF-8 or hold NUL, so content is then null; hash covers the stored bytes.
/**
 * @param {DashDb} db
 * @param {string} rel
 * @returns {StoredFile | null}
 */
function readStoredFile(db, rel) {
  safeRelPath(rel);
  const row = /** @type {{ content: Buffer } | undefined} */ (db.prepare('SELECT content FROM files WHERE path = ?').get(rel));
  if (!row) return null;
  const bytes = Buffer.from(row.content);
  let text = null;
  try { text = bytes.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* invalid UTF-8 */ }
  return { path: rel, bytes: bytes.length, binary: text === null, content: text, hash: sha256(bytes) };
}

/** @param {DashDb} db @returns {Array<{ path: string, bytes: number }>} */
function listStoredFiles(db) {
  return /** @type {Array<{ path: string, bytes: number }>} */ (db.prepare('SELECT path, LENGTH(content) AS bytes FROM files ORDER BY path').all());
}

// Commit message: default per action; a caller message is one line of at most 500 characters.
/** @param {unknown} raw @param {string} rel @param {boolean} adding @param {boolean} del */
function editMessage(raw, rel, adding, del) {
  const fallback = `alate: ${del ? 'delete' : adding ? 'add' : 'edit'} ${rel}`;
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') fail(400, 'invalid message');
  const line = raw.replaceAll(/\r\n?|\n/g, ' ').trim() || fallback;
  if (line.length > 500) fail(400, 'message must be 500 characters or fewer');
  return line;
}

// Verify base against the tree's file bytes, then write or delete there. bytes null = delete.
// base null = create, the file must not exist; otherwise the sha256 hex the editor loaded.
/**
 * @param {string} dir
 * @param {string} rel
 * @param {string | null} base
 * @param {Buffer | null} bytes
 */
function applyToTree(dir, rel, base, bytes) {
  const file = join(dir, ...rel.split('/'));
  const current = existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
  if (bytes === null) {
    if (current === null) fail(404, `${rel} not found`);
    if (sha256(current) !== base) fail(409, `${rel} changed since it was loaded; reload it and retry`);
    try { assertSourceInside(dir, file); checkDestination(dir, file); } catch (err) { fail(400, /** @type {Error} */ (err).message); }
    rmSync(file, { force: true });
    // git tracks no folders: drop the ones the delete emptied, so the inventory loses the skill dir too.
    for (let d = dirname(file); d !== dir && d.startsWith(dir) && readdirSync(d).length === 0; d = dirname(d)) rmSync(d, { recursive: true });
  } else {
    if (base === null) { if (current !== null) fail(409, `${rel} changed since it was loaded; reload it and retry`); }
    else if (current === null || sha256(current) !== base) fail(409, `${rel} changed since it was loaded; reload it and retry`);
    try { checkDestination(dir, file); } catch (err) { fail(400, /** @type {Error} */ (err).message); }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

// The one directory whose git children may cross a uid boundary: the operator-configured
// path source, marked once at startup from the source the server boots with (server.ts
// passes the flag, the persisted config, or the persisted database row). Dashboard
// requests can switch the source at runtime (POST /config, POST /api/import), so a
// runtime-chosen directory never gains this trust: git keeps refusing a foreign-owned
// repo there, and its hooks can never run with the server's privileges. The operator
// restarts the server to move the trust to a new source. The worker thread receives the
// directory with each edit op (one worker, one op at a time, so no call can race it).
/** @type {string | null} */
let trustedSourceDir = null;
/** @param {string | null} dir @returns {void} */
function setTrustedPathSource(dir) {
  try { trustedSourceDir = dir === null ? null : realpathSync(dir); } catch { trustedSourceDir = null; }
}
/** @returns {string | null} */
function getTrustedPathSource() {
  return trustedSourceDir;
}

// git in dir; env carries auth through per-process config, never argv or URL. A
// foreign-owned work tree needs safe.directory for git to run in it at all, and git
// reads that setting only from system, global or command-line config — the -c argument
// is the only supported channel, and GIT_CONFIG_* env stays out because it can carry
// helpers. The trust is scoped to the operator-configured source directory: for any
// other directory the ownership check stays on, so a foreign-owned repo that a
// dashboard request names at runtime keeps failing every git call, and its hooks and
// repo config never execute. Resolved, because git compares the entry against the
// resolved path. For the server's own temp clones the argument never applies: they are
// server-owned, so their ownership check already passes.
/** @param {string} dir @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function runGit(dir, args, env = serverGitEnv()) {
  /** @type {string[]} */
  let safe = [];
  try {
    if (trustedSourceDir !== null && realpathSync(dir) === trustedSourceDir) safe = ['-c', `safe.directory=${trustedSourceDir}`];
  } catch { /* a missing dir is git's own error */ }
  return spawnSync('git', ['-C', dir, ...safe, ...args], { env, encoding: 'utf8' });
}

// Repo-source git (alate's own temp clone, ls-remote, push with the token): the isolated
// server env over https or a local path only (local paths serve the test fixtures).
const repoGitBase = () => ({ ...serverGitEnv(), GIT_ALLOW_PROTOCOL: 'https:file' });

// True when dir sits inside a git work tree — the gate editPathSource uses before it
// commits, and the `git` flag GET /health reports for a path source (specs/source-write-flags.md).
// rev-parse never writes to the folder.
/** @param {string} dir @returns {boolean} */
function isGitWorkTree(dir) {
  return runGit(dir, ['rev-parse', '--is-inside-work-tree']).status === 0;
}

// Read-only write signal for a path source (the `writable` flag GET /health reports).
// accessSync(W_OK) never writes, but it can over-report: some kernels pass W_OK on a
// read-only bind mount, and a root process passes W_OK on any existing folder. So
// `false` is reliable; `true` means the PUT can still fail with a raw fs error.
/** @param {string} dir @returns {boolean} */
function isWritableDir(dir) {
  try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
}

// -c identity only when the tree has none: a commit must always be possible.
/** @param {string} dir @param {NodeJS.ProcessEnv} env @returns {string[]} */
function identArgs(dir, env) {
  const id = runGit(dir, ['config', 'user.email'], env);
  return id.status !== 0 || !id.stdout.trim() ? ['-c', 'user.name=alate', '-c', 'user.email=alate@localhost'] : [];
}

// Stage every path of the save, commit only those paths (never other staged work),
// return the new sha. A failure is a client-safe 400.
/**
 * @param {string} dir
 * @param {string[]} rels
 * @param {string} message
 * @param {NodeJS.ProcessEnv} env
 * @param {string | undefined} token
 * @returns {string}
 */
function commitEdit(dir, rels, message, env, token) {
  const add = runGit(dir, ['add', '-A', '--', ...rels], env);
  if (add.status !== 0) fail(400, `git add failed: ${redactSecrets(add.stderr.trim(), token)}`);
  // The pathspecs keep a path-kind edit from sweeping the operator's unrelated staged index
  // into this commit and the push that follows it.
  const commit = runGit(dir, [...identArgs(dir, env), 'commit', '-m', message, '--', ...rels], env);
  if (commit.status !== 0) fail(400, `git commit failed: ${redactSecrets(commit.stderr.trim(), token)}`);
  const head = runGit(dir, ['rev-parse', 'HEAD'], env);
  if (head.status !== 0) fail(400, `cannot read the new commit for ${rels[0]}`);
  return head.stdout.trim();
}

// Repo source: fresh clone, verify each op against the clone, commit every path of the
// save once, push HEAD:<branch>, then import the snapshot from that same clone so
// importedSha is the new commit. Temp dir always cleaned.
/**
 * @param {StateDef} state
 * @param {DashDb} db
 * @param {SourceInfo} src
 * @param {EditOp[]} ops
 * @param {string | undefined} token
 * @returns {EditResult}
 */
function editRepoSource(state, db, src, ops, token) {
  const resolved = cloneRepo(src.spec, { name: src.name, ref: src.ref, host: src.host }, token);
  try {
    for (const op of ops) applyToTree(resolved.dir, op.rel, op.base, op.bytes);
    const env = gitAuthEnv(remoteUrl(src.name, src.host), token, repoGitBase());
    const commit = commitEdit(resolved.dir, ops.map(op => op.rel), ops[0].message, env, token);
    const branch = src.ref || runGit(resolved.dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env).stdout.trim();
    const push = runGit(resolved.dir, ['push', 'origin', `HEAD:${branch}`], env);
    if (push.status !== 0) fail(502, `git push failed: ${redactSecrets(push.stderr.trim(), token)}`);
    resolved.source.importedSha = commit;
    const next = importSource(state, src.spec, src.kind, token, db, resolved);
    return { commit, pushed: true, warning: undefined, state: next };
  } finally {
    if (existsSync(resolved.dir)) rmSync(resolved.dir, { recursive: true, force: true }); // importSource already removed it on success
  }
}

// Path source: verify each op against disk, write, then commit every path of the save and
// push in the user's own work tree (its own hooks and repo config run untouched, never
// --no-verify). Global and system git
// config stay off (serverGitEnv), so a global credential helper or identity does not apply.
// The disk stays the truth: a failed commit or push still re-imports the snapshot before
// the error is rethrown.
/**
 * @param {StateDef} state
 * @param {DashDb} db
 * @param {SourceInfo} src
 * @param {EditOp[]} ops
 * @param {string | undefined} token
 * @returns {EditResult}
 */
function editPathSource(state, db, src, ops, token) {
  const dir = src.name;
  if (!existsSync(dir)) fail(400, `no local data repo at ${src.spec}`);
  let applied = 0;
  try {
    for (const op of ops) { applyToTree(dir, op.rel, op.base, op.bytes); applied++; }
  } catch (err) {
    if (applied > 0) {
      // A later op refused after an earlier one already wrote: the disk changed while
      // the save fails, so the stored snapshot follows the disk before the throw.
      importSource(state, src.spec, src.kind, token, db);
    }
    throw err;
  }
  let commit = '', pushed = false, warning;
  /** @type {StatusedError | null} */
  let failure = null;
  if (isGitWorkTree(dir)) {
    try {
      commit = commitEdit(dir, ops.map(op => op.rel), ops[0].message, serverGitEnv(), token);
      if (runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).status !== 0) {
        warning = 'no upstream configured; the commit stayed local';
      } else {
        const push = runGit(dir, ['push']);
        if (push.status !== 0) failure = Object.assign(new Error(`git push failed: ${redactSecrets(push.stderr.trim(), token)}`), { status: 502 });
        else pushed = true;
      }
    } catch (err) { failure = /** @type {StatusedError} */ (err); }
  }
  const next = importSource(state, src.spec, src.kind, token, db);
  if (failure) {
    // The disk write and the snapshot re-import both happened, so the stored
    // snapshot changed even though the edit fails: fileEdit re-runs the update
    // check on this flag. Repo-source failures throw before their import and
    // stay unflagged.
    failure.snapshotChanged = true;
    throw failure;
  }
  return { commit, pushed, warning, state: next };
}

// One editor operation end to end. edit: { path, base, content?, message?, delete }.
// Throws Error with a client-safe .status and a token-free message.
/**
 * @param {StateDef} state
 * @param {DashDb} db
 * @param {{ path?: unknown, base?: unknown, content?: unknown, message?: unknown, delete: boolean }} edit
 * @param {string | undefined} token
 * @returns {EditResult}
 */
function applyFileEdit(state, db, edit, token) {
  const rel = safeRelPath(edit.path);
  if (!state.source) fail(400, 'no data source configured');
  if (edit.delete && edit.content !== undefined) fail(400, 'delete takes no content');
  if (!edit.delete && typeof edit.content !== 'string') fail(400, 'content must be a string');
  if (edit.base !== null && typeof edit.base !== 'string') fail(400, 'base must be the loaded hash or null');
  const op = {
    rel,
    base: edit.base,
    bytes: edit.delete ? null : Buffer.from(/** @type {string} */ (edit.content), 'utf8'),
    message: editMessage(edit.message, rel, !edit.delete && edit.base === null, edit.delete),
  };
  return dispatchSave(state, db, [op], token);
}

// The editor's source dispatch, shared by the single-op file editor and the bundle
// actions: a repo source edits a fresh clone and pushes, a path source edits the
// operator's tree in place. ops is one save: every op applies, one commit carries all
// the paths, one push follows.
/**
 * @param {StateDef} state
 * @param {DashDb} db
 * @param {EditOp[]} ops
 * @param {string | undefined} token
 * @returns {EditResult}
 */
function dispatchSave(state, db, ops, token) {
  return state.source.kind === 'repo'
    ? editRepoSource(state, db, state.source, ops, token)
    : editPathSource(state, db, state.source, ops, token);
}

// ---- Bundle actions (specs/bundles.md "Editing (ALAT-180)"): the bundle board's
// ---- create/add/remove/move/assign/unassign writes through the editor's save path. ----

// The name rules of lib/bundles.mjs (SKILL_NAME, PLUGIN_NAME), mirrored so a refused
// name is exactly the one the installer refuses; the folder rule is the skill rule.
/** @type {RegExp} */
const bundleFolderName = /^[a-z0-9][a-z0-9-]*$/;
/** @param {'skill' | 'plugin'} kind @returns {RegExp} */
const bundleItemName = kind => (kind === 'skill' ? /^[a-z0-9][a-z0-9-]*$/ : /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/);
/** @param {'skill' | 'plugin'} kind @returns {string} */
const bundleListFile = kind => (kind === 'skill' ? 'skills.txt' : 'plugins.txt');
// The six singular kinds the structured bundle actions accept (specs/bundles.md, Editing).
/** @type {BundleKind[]} */
const ACTION_KINDS = ['skill', 'plugin', 'apt', 'env', 'requirements', 'tools'];
// The four worker kinds: list file, refusal noun, and the one-line comment header a new
// file starts with. tools.json starts as a JSON array and takes no header.
/** @typedef {{ file: string, noun: string, header: (bundle: string) => string | null }} WorkerKindInfo */
/** @type {Record<'apt' | 'env' | 'requirements' | 'tools', WorkerKindInfo>} */
const workerKinds = {
  apt: { file: 'apt.txt', noun: 'package', header: b => `# apt packages of bundle ${b}\n` },
  env: { file: 'env.txt', noun: 'name', header: b => `# env names of bundle ${b}\n` },
  requirements: { file: 'requirements.txt', noun: 'package', header: b => `# requirement pins of bundle ${b}\n` },
  tools: { file: 'tools.json', noun: 'tool', header: () => null },
};
// Two-line comment header every created list file starts with.
/** @param {'skill' | 'plugin'} kind @param {string} bundle @returns {string} */
const bundleListHeader = (kind, bundle) => `# ${kind === 'skill' ? 'skills' : 'plugins'} of bundle ${bundle}\n# one name per line; # comments and blank lines are ignored\n`;
// The unknown-name refusal, word for word what the install throws for the same list.
/** @param {string} rel @param {'skill' | 'plugin'} kind @param {string} name @returns {string} */
const unknownItemMessage = (rel, kind, name) => `${rel}: unknown ${kind} "${name}" (the data repo holds no ${kind === 'skill' ? 'skill folder' : 'plugin'} of that name)`;

// Stored snapshot bytes of one path: the same row readStoredFile hashes, kept raw so the
// bundle actions can parse and recompose list files. null when the snapshot lacks it.
/** @param {DashDb} db @param {string} rel @returns {Buffer | null} */
function storedBytes(db, rel) {
  const row = /** @type {{ content: Buffer } | undefined} */ (db.prepare('SELECT content FROM files WHERE path = ?').get(rel));
  return row ? Buffer.from(row.content) : null;
}

// Stored snapshot paths under bundles/<name>/ — the stored stand-in for the bundle folder
// (git tracks no folders, so "the folder exists" means any of its files is stored).
/** @param {DashDb} db @param {string} name @returns {string[]} */
function storedBundleFiles(db, name) {
  const prefix = `bundles/${name}/`;
  return listStoredFiles(db).map(f => f.path).filter(p => p.startsWith(prefix));
}

// Dedup key of a worker-kind item body: the key parseWorkerItems computes for a stored
// line, with the tools entry pre-checked so every add refusal fires before any compose.
// `rel` names the list in the refusal messages.
/** @param {'apt' | 'env' | 'requirements' | 'tools'} kind @param {string} item @param {string} rel @returns {string} */
function workerItemBodyKey(kind, item, rel) {
  if (kind !== 'tools') return workerItemKey(kind, item);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(item);
  } catch {
    fail(400, `${rel}: the item is not a JSON object`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, `${rel}: the item is not a JSON object`);
  return toolNameOf(parsed);
}

/** @param {unknown} entry @returns {string} */
const toolNameOf = entry => (entry !== null && typeof entry === 'object' && typeof /** @type {{ name?: unknown }} */ (entry).name === 'string')
  ? /** @type {{ name: string }} */ (entry).name
  : '';

// Stored items of one worker list, parsed with the list's path so a malformed stored
// tools.json refuses as a client-safe 400. The three line lists never throw here.
/** @param {'apt' | 'env' | 'requirements' | 'tools'} kind @param {Buffer | null} bytes @param {string} rel @returns {{ key: string, text: string }[]} */
function workerItems(kind, bytes, rel) {
  try {
    return parseWorkerItems(kind, bytes ?? Buffer.alloc(0), rel);
  } catch (err) {
    fail(400, /** @type {Error} */ (err).message);
  }
}

// Bytes of a worker list with the first item whose dedup key is key dropped. The line
// lists keep every other byte: split on \n, splice the one matching line, rejoin.
// tools.json re-serializes the remaining entries as the canonical 2-space JSON array.
// The caller has already parsed the list and found the key, so a lost match here is a
// broken invariant, not a client error.
/** @param {'apt' | 'env' | 'requirements' | 'tools'} kind @param {Buffer} bytes @param {string} key @returns {Buffer} */
function dropWorkerItem(kind, bytes, key) {
  if (kind === 'tools') {
    const entries = parseWorkerItems('tools', bytes, 'tools.json').map(it => JSON.parse(it.text));
    const at = entries.findIndex(entry => toolNameOf(entry) === key);
    if (at === -1) throw new Error('tools.json lost its entry between parse and drop');
    entries.splice(at, 1);
    return Buffer.from(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }
  const lines = bytes.toString('utf8').split('\n');
  const at = lines.findIndex(line => line.replace(/#.*/, '').trim() !== '' && workerItemKey(kind, line) === key);
  if (at === -1) throw new Error('worker list lost its line between parse and drop');
  lines.splice(at, 1);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// Text of a name list after appending name as its last non-empty line: existing lines
// (comments and blanks included) keep their places, the trailing blank run stays at the
// end, and the new line takes the file's dominant EOL. null text means the file does not
// exist yet: the caller composes the header-and-name body instead.
/** @param {string | null} text @param {string} name @returns {string} */
function appendBundleName(text, name) {
  if (text === null) return name;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const lines = text.split('\n');
  let at = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].replace(/\r$/, '').trim() !== '') { at = i + 1; break; }
  }
  lines.splice(at, 0, crlf > loneLf ? `${name}\r` : name);
  return lines.join('\n');
}

// Text of a name list with the first line naming name dropped. Nothing else is
// normalized: split on \n, match on the parse rule's trimmed form, rejoin the original
// line contents, so every surviving line keeps its exact bytes.
/** @param {Buffer} bytes @param {string} name @returns {string} */
function dropBundleName(bytes, name) {
  const lines = bytes.toString('utf8').split('\n');
  lines.splice(lines.findIndex(line => line.replace(/\r$/, '').trim() === name), 1);
  return lines.join('\n');
}

// One bundle-board action end to end: validate the body against the stored snapshot,
// compose the one save's ops, then run the editor dispatch (one commit, one push, the
// editor's result shape). Every refusal throws Error with a client-safe .status and the
// exact message below, before any write.
/**
 * @param {StateDef} state
 * @param {DashDb} db
 * @param {{ action?: unknown, name?: unknown, bundle?: unknown, kind?: unknown, item?: unknown, from?: unknown, to?: unknown, project?: unknown }} body
 * @param {string | undefined} token
 * @param {{ skills: Set<string>, plugins: Set<string> }} known
 * @returns {EditResult}
 */
function applyBundleAction(state, db, body, token, known) {
  if (!state.source) fail(400, 'no data source configured');
  /** @type {EditOp[]} */
  const ops = [];
  let message = '';
  /** @param {string} rel @param {string | null} base @param {Buffer} bytes */
  const stage = (rel, base, bytes) => ops.push({ rel, base, bytes, message });
  /** @param {unknown} kind @returns {BundleKind} */
  const listKind = kind => (ACTION_KINDS.includes(/** @type {BundleKind} */ (kind)) ? /** @type {BundleKind} */ (kind) : fail(400, 'kind must be one of: skill, plugin, apt, env, requirements, tools'));
  const action = body.action;
  if (action === 'create') {
    const name = typeof body.name === 'string' ? body.name : '';
    if (!bundleFolderName.test(name)) fail(400, `bundles: "${name}" is not a valid bundle folder name`);
    // "The folder exists" means any of its list files is stored, so a folder that only
    // apt.txt (or any other single list) holds refuses create too.
    if (storedBundleFiles(db, name).length > 0) fail(409, `bundles/${name}: bundle already exists`);
    message = `alate: add bundle ${name}`;
    stage(`bundles/${name}/skills.txt`, null, Buffer.from(bundleListHeader('skill', name), 'utf8'));
  } else if (action === 'add' || action === 'remove') {
    const kind = listKind(body.kind);
    const bundle = typeof body.bundle === 'string' ? body.bundle : '';
    const workerInfo = kind === 'skill' || kind === 'plugin' ? null : workerKinds[kind];
    const rel = `bundles/${bundle}/${workerInfo ? workerInfo.file : bundleListFile(/** @type {'skill' | 'plugin'} */ (kind))}`;
    if (!bundleFolderName.test(bundle)) fail(400, `bundles: "${bundle}" is not a valid bundle folder name`);
    const bytes = storedBytes(db, rel);
    if (bytes === null && storedBundleFiles(db, bundle).length === 0) fail(404, `bundles: bundle "${bundle}" has no folder under bundles/`);
    if (workerInfo) {
      // The four worker lists carry the whole line (or the tool entry as JSON text) in
      // `item`; the dedup key decides the add refusals and the remove target, and the
      // composed bytes must pass the rules the install applies to the file.
      const workerKind = /** @type {'apt' | 'env' | 'requirements' | 'tools'} */ (kind);
      const item = typeof body.item === 'string' ? body.item.trim() : '';
      if (!item) fail(400, `${rel}: the item is empty`);
      // An add carries the tool entry as JSON text; a remove names the entry and keys on
      // its name, because the inventory rows hold names, not entries.
      const key = action === 'add' ? workerItemBodyKey(workerKind, item, rel) : (workerKind === 'tools' ? item : workerItemKey(workerKind, item));
      if (action === 'add') {
        // A list file that does not exist yet lists nothing (and an absent tools.json
        // must not reach the tools parser as empty bytes).
        if (bytes !== null && workerItems(workerKind, bytes, rel).some(it => it.key === key)) fail(409, `${rel}: already lists ${workerInfo.noun} "${key}"`);
        message = `alate: add ${kind} ${key} to bundle ${bundle}`;
        const composed = composeWorkerAdd(workerKind, bytes, item, bytes === null ? workerInfo.header(bundle) : null);
        try { validateWorkerBytes(workerKind, composed, rel); } catch (err) { fail(400, /** @type {Error} */ (err).message); }
        stage(rel, bytes === null ? null : sha256(bytes), composed);
      } else {
        const hit = bytes === null ? undefined : workerItems(workerKind, bytes, rel).find(it => it.key === key);
        if (!hit) fail(404, `${rel}: no ${workerInfo.noun} "${key}"`);
        message = `alate: remove ${kind} ${key} from bundle ${bundle}`;
        stage(rel, sha256(/** @type {Buffer} */ (bytes)), dropWorkerItem(workerKind, /** @type {Buffer} */ (bytes), key));
      }
    } else {
      // The two name lists keep their body shape and messages; kind is a name kind here.
      const nameKind = /** @type {'skill' | 'plugin'} */ (kind);
      const name = typeof body.name === 'string' ? body.name : '';
      // Format and known-ness gate an add; a remove only asks whether the list holds the name.
      if (action === 'add') {
        if (!bundleItemName(nameKind).test(name)) fail(400, `${rel}: "${name}" is not a valid ${kind} name`);
        const knownSet = nameKind === 'skill' ? known.skills : known.plugins;
        if (!knownSet.has(name)) fail(400, unknownItemMessage(rel, nameKind, name));
      }
      const listed = parseNameList(bytes ?? Buffer.alloc(0), rel, nameKind);
      if (!listed.includes(name)) {
        if (action === 'remove') fail(404, `${rel}: no ${kind} "${name}"`);
        message = `alate: add ${kind} ${name} to bundle ${bundle}`;
        // A list file that does not exist yet starts with the comment header; an existing
        // one keeps its lines and takes the name as its last non-empty line.
        stage(rel, bytes === null ? null : sha256(bytes), bytes === null
          ? Buffer.from(`${bundleListHeader(nameKind, bundle)}${name}\n`, 'utf8')
          : Buffer.from(appendBundleName(bytes.toString('utf8'), name), 'utf8'));
      } else {
        if (action === 'add') fail(409, `${rel}: already names ${kind} "${name}"`);
        message = `alate: remove ${kind} ${name} from bundle ${bundle}`;
        stage(rel, sha256(/** @type {Buffer} */ (bytes)), Buffer.from(dropBundleName(/** @type {Buffer} */ (bytes), name), 'utf8'));
      }
    }
  } else if (action === 'move') {
    const kind = listKind(body.kind);
    const from = typeof body.from === 'string' ? body.from : '';
    const workerInfo = kind === 'skill' || kind === 'plugin' ? null : workerKinds[kind];
    const file = workerInfo ? workerInfo.file : bundleListFile(/** @type {'skill' | 'plugin'} */ (kind));
    const fromRel = `bundles/${from}/${file}`;
    if (workerInfo) {
      // Same semantics as the name lists, keyed on the item's dedup key; the add side
      // against `to` runs the full worker-kind add gates, and the whole move is one save.
      const workerKind = /** @type {'apt' | 'env' | 'requirements' | 'tools'} */ (kind);
      const item = typeof body.item === 'string' ? body.item.trim() : '';
      if (!item) fail(400, `${fromRel}: the item is empty`);
      // A move names the entry (the tool name for tools.json) and the stored entry travels
      // to the target file, so the body never needs the full entry.
      const key = workerKind === 'tools' ? item : workerItemKey(workerKind, item);
      const fromBytes = storedBytes(db, fromRel);
      // An absent list file names nothing; an absent tools.json must not reach the tools parser as empty bytes.
      const fromHit = fromBytes === null ? undefined : workerItems(workerKind, fromBytes, fromRel).find(it => it.key === key);
      if (!fromHit) fail(409, `${fromRel}: does not name ${kind} "${key}"`);
      const label = kind === 'tools' ? key : item;
      if (body.to === 'shelf') {
        // The shelf: drop the key from every stored list of this kind that lists it,
        // wherever it sits; `from` only names the refusal when nothing lists the key.
        const rels = listStoredFiles(db).map(f => f.path).filter(p => p.endsWith(`/${file}`) && p.startsWith('bundles/') && p.split('/').length === 3);
        const hits = rels.filter(rel => workerItems(workerKind, storedBytes(db, rel), rel).some(it => it.key === key));
        if (hits.length === 0) fail(404, `${fromRel}: no ${workerInfo.noun} "${key}"`);
        message = `alate: move ${kind} ${label} from ${from} to shelf`;
        for (const rel of hits) {
          const bytes = /** @type {Buffer} */ (storedBytes(db, rel));
          stage(rel, sha256(bytes), dropWorkerItem(workerKind, bytes, key));
        }
      } else {
        const to = typeof body.to === 'string' ? body.to : '';
        const toRel = `bundles/${to}/${file}`;
        const toBytes = storedBytes(db, toRel);
        if (!bundleFolderName.test(to)) fail(400, `bundles: "${to}" is not a valid bundle folder name`);
        if (toBytes === null && storedBundleFiles(db, to).length === 0) fail(404, `bundles: bundle "${to}" has no folder under bundles/`);
        if (toBytes !== null && workerItems(workerKind, toBytes, toRel).some(it => it.key === key)) fail(409, `${toRel}: already lists ${workerInfo.noun} "${key}"`);
        message = `alate: move ${kind} ${label} from ${from} to ${to}`;
        const composed = composeWorkerAdd(workerKind, toBytes, fromHit.text, toBytes === null ? workerInfo.header(to) : null);
        try { validateWorkerBytes(workerKind, composed, toRel); } catch (err) { fail(400, /** @type {Error} */ (err).message); }
        stage(fromRel, sha256(/** @type {Buffer} */ (fromBytes)), dropWorkerItem(workerKind, /** @type {Buffer} */ (fromBytes), key));
        stage(toRel, toBytes === null ? null : sha256(toBytes), composed);
      }
    } else {
      const nameKind = /** @type {'skill' | 'plugin'} */ (kind);
      const name = typeof body.name === 'string' ? body.name : '';
      const fromBytes = storedBytes(db, fromRel);
      if (!parseNameList(fromBytes ?? Buffer.alloc(0), fromRel, nameKind).includes(name)) fail(409, `${fromRel}: does not name ${kind} "${name}"`);
      if (body.to === 'shelf') {
        // The shelf: drop the name from every stored list of this kind that names it,
        // wherever it sits; `from` only names the refusal when nothing lists the name.
        const rels = listStoredFiles(db).map(f => f.path).filter(p => p.endsWith(`/${file}`) && p.startsWith('bundles/') && p.split('/').length === 3);
        const hits = rels.filter(rel => parseNameList(/** @type {Buffer} */ (storedBytes(db, rel)), rel, nameKind).includes(name));
        if (hits.length === 0) fail(404, `${fromRel}: no ${kind} "${name}"`);
        message = `alate: move ${kind} ${name} from ${from} to shelf`;
        for (const rel of hits) {
          const bytes = /** @type {Buffer} */ (storedBytes(db, rel));
          stage(rel, sha256(bytes), Buffer.from(dropBundleName(bytes, name), 'utf8'));
        }
      } else {
        const to = typeof body.to === 'string' ? body.to : '';
        const toRel = `bundles/${to}/${file}`;
        const toBytes = storedBytes(db, toRel);
        if (!bundleFolderName.test(to)) fail(400, `bundles: "${to}" is not a valid bundle folder name`);
        if (toBytes === null && storedBundleFiles(db, to).length === 0) fail(404, `bundles: bundle "${to}" has no folder under bundles/`);
        const knownSet = nameKind === 'skill' ? known.skills : known.plugins;
        if (parseNameList(toBytes ?? Buffer.alloc(0), toRel, nameKind).includes(name)) fail(409, `${toRel}: already names ${kind} "${name}"`);
        if (!knownSet.has(name)) fail(400, unknownItemMessage(toRel, nameKind, name));
        message = `alate: move ${kind} ${name} from ${from} to ${to}`;
        stage(fromRel, sha256(/** @type {Buffer} */ (fromBytes)), Buffer.from(dropBundleName(/** @type {Buffer} */ (fromBytes), name), 'utf8'));
        stage(toRel, toBytes === null ? null : sha256(toBytes), toBytes === null
          ? Buffer.from(`${bundleListHeader(nameKind, to)}${name}\n`, 'utf8')
          : Buffer.from(appendBundleName(toBytes.toString('utf8'), name), 'utf8'));
      }
    }
  } else if (action === 'assign' || action === 'unassign') {
    const project = typeof body.project === 'string' ? body.project : '';
    const bundle = typeof body.bundle === 'string' ? body.bundle : '';
    const manifestRel = 'projects/projects.json';
    const manifestBytes = storedBytes(db, manifestRel);
    if (manifestBytes === null) fail(404, 'projects/projects.json not found');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail(400, 'projects/projects.json: unparseable JSON'); }
    const table = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest.projects : null;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) fail(400, 'projects.json: projects must be an object');
    if (!Object.hasOwn(table, project)) fail(404, `projects.json: no project "${project}"`);
    if (storedBundleFiles(db, bundle).length === 0) fail(400, `projects.json: project "${project}" names unknown bundle "${bundle}" (no folder bundles/${bundle}/)`);
    // Legacy array values become the object form; every other key and the parsed key
    // order of both levels survive, because only the bundles array changes.
    const value = table[project];
    const entry = Array.isArray(value) ? { extras: [...value], bundles: [] } : (value !== null && typeof value === 'object' ? value : { extras: [], bundles: [] });
    if (!Array.isArray(entry.bundles)) entry.bundles = [];
    if (action === 'assign') {
      if (entry.bundles.includes(bundle)) fail(409, `projects.json: project "${project}" already names bundle "${bundle}"`);
      entry.bundles.push(bundle);
      message = `alate: assign bundle ${bundle} to project ${project}`;
    } else {
      const current = /** @type {string[]} */ (entry.bundles);
      if (!current.includes(bundle)) fail(409, `projects.json: project "${project}" does not name bundle "${bundle}"`);
      entry.bundles = current.filter(b => b !== bundle);
      message = `alate: unassign bundle ${bundle} from project ${project}`;
    }
    table[project] = entry;
    stage(manifestRel, sha256(manifestBytes), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  } else if (action === 'turn-on') {
    // The migration action of specs/bundles.md "Turn on bundles" (ALAT-192): on a
    // repo with no bundles content it creates bundles/core/ holding every skill
    // and plugin that installs today plus the four fleet worker lists, so the
    // effective item list of every project stays the list before. Any stored
    // bundles/ path refuses, so a second click does nothing.
    if (listStoredFiles(db).some(f => f.path.startsWith('bundles/'))) fail(409, 'bundles: the data repo already holds bundles content');
    message = 'alate: turn on bundles with core';
    const turnSkills = [...known.skills].sort();
    const turnPlugins = [...known.plugins].sort();
    stage('bundles/core/skills.txt', null, Buffer.from(`${bundleListHeader('skill', 'core')}${turnSkills.map(n => `${n}\n`).join('')}`, 'utf8'));
    stage('bundles/core/plugins.txt', null, Buffer.from(`${bundleListHeader('plugin', 'core')}${turnPlugins.map(n => `${n}\n`).join('')}`, 'utf8'));
    // Core is the only bundle whose worker lists merge into every project, so the
    // fleet lists keep reaching every project through the merge, and the dashboard's
    // per-project effective lists — which never merge workers/_all/ — keep showing
    // them. The copies stay byte-for-byte: every bundle worker list validates raw at
    // install, and the _all copies are raw checkout bytes like any bundle source.
    for (const file of ['apt.txt', 'tools.json', 'env.txt', 'requirements.txt']) {
      const fleetBytes = storedBytes(db, `workers/_all/${file}`);
      if (fleetBytes !== null) stage(`bundles/core/${file}`, null, fleetBytes);
    }
  } else {
    fail(400, 'unknown bundle action');
  }
  return dispatchSave(state, db, ops, token);
}

// First sha of `git ls-remote` for a dashboard repo source; '' when the check fails (client-safe).
/**
 * @param {string} name
 * @param {string} ref
 * @param {string | undefined} token
 * @param {string} [host='']
 * @returns {string}
 */
function remoteHead(name, ref, token, host = '') {
  const url = remoteUrl(name, host);
  const git = spawnSync('git', ['ls-remote', url, ref || 'HEAD'], {
    env: gitAuthEnv(url, token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, repoGitBase()),
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  return git.status === 0 && git.stdout ? git.stdout.split('\n')[0].trim().split(/\s+/)[0] : '';
}

export { scanInventory, importSource, isGitWorkTree, isWritableDir, loadState, remoteHead, snapshotData, readStoredFile, listStoredFiles, applyFileEdit, applyBundleAction, setTrustedPathSource, getTrustedPathSource };
