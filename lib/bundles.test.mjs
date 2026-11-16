// Self-check for lib/bundles.mjs: node lib/bundles.test.mjs
// Hermetic: every fixture lives in a temp dir; nothing outside it is read or written.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE_FILES, isBundlesMode, mergeNameLists, parseManifestProjects, parseNameList, readBundleFolder, resolveBundlePlan } from './bundles.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-bundles-test-'));
/**
 * Asserts fn throws an Error whose message holds needle.
 * @param {() => unknown} fn @param {string} needle @returns {void}
 */
const throws = (fn, needle) => assert.throws(fn, /** @param {unknown} err */ err => err instanceof Error && err.message.includes(needle));
// Bytes of a text fixture. The zero-deps gate reads a Buffer.from call whose
// argument is a quoted literal as a module specifier, so the tests route
// every literal through this helper.
/** @param {string} text @returns {Buffer} */
const bytes = text => Buffer.from(text);
/** @param {string} rel */
const put = rel => {
  const path = join(tmp, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  /** @param {string} bytes */
  return bytes => writeFileSync(path, bytes);
};
/** @param {string} name */
const rmBundle = name => rmSync(join(tmp, 'bundles', name), { recursive: true, force: true });
/** @param {string} name */
/** @param {string} name */
const putBundle = name => /** @param {string} rel */ rel => put(`bundles/${name}/${rel}`);
const core = putBundle('core');
/** @param {string} name */
const skillMd = name => `---\nname: ${name}\ndescription: Test skill.\n---\nBody\n`;
try {
  // isBundlesMode: absent, a plain file, a directory.
  assert.equal(isBundlesMode(tmp), false);
  writeFileSync(join(tmp, 'bundles'), 'not a dir');
  assert.equal(isBundlesMode(tmp), false);
  rmSync(join(tmp, 'bundles'));
  mkdirSync(join(tmp, 'bundles'));
  assert.equal(isBundlesMode(tmp), true);

  // parseManifestProjects: legacy array form, object form, mixed, and the refusals.
  const projects = parseManifestProjects({
    legacy: ['a.md'],
    modern: { extras: ['b.md'], bundles: ['core'] },
    bundlesOnly: { bundles: ['gamedev-2d'] },
  });
  assert.deepEqual(projects, [
    { name: 'legacy', extras: ['a.md'], bundles: [] },
    { name: 'modern', extras: ['b.md'], bundles: ['core'] },
    { name: 'bundlesOnly', extras: [], bundles: ['gamedev-2d'] },
  ]);
  for (const [label, table, message] of /** @type {[string, Record<string, unknown>, string][]} */ ([
    ['projects not an object', [], 'projects must be an object'],
    ['project value a string', { p: 'x' }, 'must be an extras array or an object'],
    ['extras not strings', { p: [1] }, 'extras for "p" must be an array of strings'],
    ['bundles not strings', { p: { bundles: [1] } }, 'bundles for "p" must be an array of strings'],
  ])) {
    throws(() => parseManifestProjects(table), message);
    assert.ok(label, 'each refusal case names itself');
  }

  // readBundleFolder: the six known files, and the refusals.
  for (const f of BUNDLE_FILES) core(f)(`${f}\n`);
  const read = readBundleFolder(tmp, 'core');
  assert.deepEqual([...read.keys()].sort(), [...BUNDLE_FILES].sort());
  putBundle('extra')('random.txt')('x');
  throws(() => readBundleFolder(tmp, 'extra'), 'bundles/extra: unexpected file "random.txt"');
  rmBundle('extra');
  mkdirSync(join(tmp, 'bundles', 'nested', 'apt.txt'), { recursive: true });
  throws(() => readBundleFolder(tmp, 'nested'), 'bundles/nested: "apt.txt" must be a regular file');
  rmBundle('nested');
  throws(() => readBundleFolder(tmp, 'missing'), 'bundle "missing" has no folder');
  throws(() => readBundleFolder(tmp, 'Bad_Name'), 'not a valid bundle folder name');

  // parseNameList: comments, blanks, CRLF, and the two name rules.
  const names = parseNameList(bytes('# lead\npony-a\r\n\n@scope/web-b\n# tail\n'), 'x/plugins.txt', 'plugin');
  assert.deepEqual(names, ['pony-a', '@scope/web-b']);
  throws(() => parseNameList(bytes('Bad Skill\n'), 'x/skills.txt', 'skill'), 'x/skills.txt:1: "Bad Skill" is not a valid skill name');
  throws(() => parseNameList(bytes('@scope/name\n'), 'x/skills.txt', 'skill'), 'is not a valid skill name');
  throws(() => parseNameList(bytes('under_score\n'), 'x/plugins.txt', 'plugin'), 'is not a valid plugin name');
  assert.deepEqual(parseNameList(bytes('gamedev-2d\n'), 'x/skills.txt', 'skill'), ['gamedev-2d']);

  // mergeNameLists: first occurrence wins, order kept.
  assert.deepEqual(mergeNameLists(['a', 'b'], ['b', 'c'], [], ['a', 'd']), ['a', 'b', 'c', 'd']);

  // resolveBundlePlan over a full fixture.
  /** @param {string} name */
  const putSkill = name => put(`user/omp/agent/skills/${name}/SKILL.md`)(skillMd(name));
  for (const name of ['core-skill', 'gamedev-skill', 'shelf-skill']) putSkill(name);
  putBundle('core')('skills.txt')('core-skill\n');
  putBundle('core')('plugins.txt')('pony-a\n');
  putBundle('core')('apt.txt')('# shared\npkg-one\n');
  putBundle('core')('tools.json')(JSON.stringify([{ name: 'ripgrep', url: 'https://x/rg.zip', sha256: 'a'.repeat(64), unpack: 'zip', bin: 'rg' }]));
  putBundle('core')('env.txt')('SHARED_TOKEN\n');
  putBundle('core')('requirements.txt')('rich==1.0.0 --hash=sha256:' + 'b'.repeat(64) + '\n');
  putBundle('gamedev-2d')('skills.txt')('gamedev-skill\n');
  putBundle('gamedev-2d')('plugins.txt')('@scope/web-b\n');
  putBundle('gamedev-2d')('apt.txt')('pkg-two\npkg-one\n');
  putBundle('gamedev-2d')('tools.json')(JSON.stringify([{ name: 'ripgrep', url: 'https://y/rg.zip', sha256: 'c'.repeat(64), unpack: 'zip', bin: 'rg' }, { name: 'godot', url: 'https://y/godot.zip', sha256: 'd'.repeat(64), unpack: 'zip', bin: 'godot' }]));
  putBundle('gamedev-2d')('env.txt')('GAME_TOKEN\nSHARED_TOKEN plain\n');
  putBundle('gamedev-2d')('requirements.txt')('pygame==2.0.0 --hash=sha256:' + 'e'.repeat(64) + '\nrich==2.0.0 --hash=sha256:' + 'f'.repeat(64) + '\n');
  put('workers/alpha/skills.txt')('gamedev-skill\nshelf-skill\n');
  put('workers/alpha/apt.txt')('pkg-three\n');
  const knownSkills = new Set(['core-skill', 'gamedev-skill', 'shelf-skill']);
  const knownPlugins = new Set(['pony-a', '@scope/web-b']);
  const plan = resolveBundlePlan({
    dataDir: tmp,
    projects: [{ name: 'alpha', extras: [], bundles: ['gamedev-2d'] }, { name: 'beta', extras: [], bundles: [] }],
    knownSkills,
    knownPlugins,
  });
  // core keeps its own lists; alpha merges core, bundle, own (dedup, first wins).
  assert.deepEqual(plan.core.lists.get('skills'), ['core-skill']);
  assert.deepEqual(plan.projects[0].lists.get('skills'), ['gamedev-skill', 'shelf-skill']);
  assert.equal(plan.projects[1].lists.get('skills'), undefined, 'beta bundles no non-core skills, so no per-project skills list');
  assert.deepEqual(plan.projects[0].lists.get('plugins'), ['pony-a', '@scope/web-b']);
  assert.deepEqual(plan.projects[1].lists.get('plugins'), ['pony-a']);
  const alphaApt = /** @type {Buffer} */ (plan.projects[0].workerFiles.get('apt.txt')).toString();
  assert.equal(alphaApt, 'pkg-one\npkg-two\npkg-three\n', `merge order core, bundle, own with dedup: ${JSON.stringify(alphaApt)}`);
  const alphaTools = /** @type {{ name: string, url: string }[]} */ (JSON.parse(/** @type {Buffer} */ (plan.projects[0].workerFiles.get('tools.json')).toString()));
  assert.deepEqual(alphaTools.map(t => t.name), ['ripgrep', 'godot'], 'first tools.json occurrence wins whole');
  assert.equal(alphaTools[0].url, 'https://x/rg.zip');
  const alphaEnv = /** @type {Buffer} */ (plan.projects[0].workerFiles.get('env.txt')).toString();
  assert.equal(alphaEnv, 'SHARED_TOKEN plain\nGAME_TOKEN\n', 'env merge: the later list wins per name, the plain modifier rides along');
  const alphaReq = /** @type {Buffer} */ (plan.projects[0].workerFiles.get('requirements.txt')).toString();
  assert.match(alphaReq, /^rich==1\.0\.0 [^\n]+\npygame==2\.0\.0 [^\n]+\n$/, 'requirements dedup by package name');
  // beta has no own workers/ dir and no bundle lists beyond core: core-only files.
  assert.deepEqual(plan.projects[1].workerFiles.get('apt.txt')?.toString(), 'pkg-one\n');
  // A project with bundles only, no workers/ dir at all.
  const gamma = resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'gamma', extras: [], bundles: ['gamedev-2d'] }], knownSkills, knownPlugins });
  assert.deepEqual(gamma.projects[0].lists.get('skills'), ['gamedev-skill']);
  assert.ok(gamma.projects[0].workerFiles.has('apt.txt'), 'bundle worker files reach a project without its own workers dir');

  // A project whose merged plugin set is empty still gets a list entry: the
  // consumer scopes a project's plugins only when the file exists, so an
  // empty set must write an empty file, never fall back to the home's whole
  // plugin set.
  rmSync(join(tmp, 'bundles/core/plugins.txt'));
  const leanPlan = resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: ['gamedev-2d'] }, { name: 'beta', extras: [], bundles: [] }], knownSkills, knownPlugins });
  assert.deepEqual(leanPlan.projects[1].lists.get('plugins'), [], 'beta plans an empty, present plugin list');
  assert.deepEqual(leanPlan.projects[0].lists.get('plugins'), ['@scope/web-b']);

  // Refusals, each naming its source and item.
  putBundle('gamedev-2d')('skills.txt')('gamedev-skill\nno-such-skill\n');
  throws(() => resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: ['gamedev-2d'] }], knownSkills, knownPlugins }),
    'bundles/gamedev-2d/skills.txt: unknown skill "no-such-skill"');
  putBundle('gamedev-2d')('skills.txt')('gamedev-skill\n');
  putBundle('gamedev-2d')('plugins.txt')('no-such-plugin\n');
  throws(() => resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: ['gamedev-2d'] }], knownSkills, knownPlugins }),
    'bundles/gamedev-2d/plugins.txt: unknown plugin "no-such-plugin"');
  putBundle('gamedev-2d')('plugins.txt')('@scope/web-b\n');
  put('workers/alpha/skills.txt')('ghost-skill\n');
  throws(() => resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: ['gamedev-2d'] }], knownSkills, knownPlugins }),
    'workers/alpha/skills.txt: unknown skill "ghost-skill"');
  put('workers/alpha/skills.txt')('gamedev-skill\nshelf-skill\n');
  throws(() => resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: ['ghost-bundle'] }], knownSkills, knownPlugins }),
    'project "alpha" names unknown bundle "ghost-bundle"');
  putBundle('badtools')('tools.json')('{ not json');
  throws(() => resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: ['badtools'] }], knownSkills, knownPlugins }),
    'bundles/badtools/tools.json:');
  rmBundle('badtools');
  // A worker list line that is not a name refuses with the line number.
  put('workers/alpha/skills.txt')('gamedev-skill\nBad Name\n');
  throws(() => resolveBundlePlan({ dataDir: tmp, projects: [{ name: 'alpha', extras: [], bundles: [] }], knownSkills, knownPlugins }),
    'workers/alpha/skills.txt:2: "Bad Name" is not a valid skill name');

  console.log('lib/bundles.test.mjs: all checks passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
