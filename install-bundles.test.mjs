// Self-check for the per-project bundle install (specs/bundles.md): node install-bundles.test.mjs
// Hermetic: the data repo, the tool script, and the target home live in a temp dir; every run
// uses --skip-plugins, so bun and the network stay out. Skills fixtures are minimal SKILL.md
// folders; the scan gate runs against the same stub skillspector install-user.test.mjs uses.
// The stub is a POSIX shell script: on Windows the scan gate cannot run it, so this file
// skips itself there (install-user.test.mjs keeps the Windows coverage).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'alate-install-bundles-'));
const scriptDir = join(tmp, 'tool');
const data = join(tmp, 'data');
const home = join(tmp, 'home');
const childHome = join(tmp, 'child-home');
mkdirSync(childHome);
mkdirSync(join(scriptDir, 'lib'), { recursive: true });
for (const rel of ['install-user.mjs', 'lib/data.mjs', 'lib/bundles.mjs', 'lib/shipped.mjs']) {
  copyFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), join(scriptDir, rel));
}
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
};
copyTree(fileURLToPath(new URL('./shipped/ottr', import.meta.url)), join(scriptDir, 'shipped', 'ottr'));
copyFileSync(fileURLToPath(new URL('./shipped/skillspector-reviews.json', import.meta.url)), join(scriptDir, 'shipped', 'skillspector-reviews.json'));

// The scan-gate stub: answers the pinned build's report shape, logs every scan call.
const scanned = process.platform !== 'win32';
const stubDir = join(tmp, 'stub');
const callsLog = join(stubDir, 'calls.log');
const scanReport = JSON.stringify({ issues: [], suppressed: [], suppressed_count: 0 });
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'skillspector'), [
  '#!/bin/sh',
  `[ "$1" = scan ] && printf '%s\\n' "$*" >> '${callsLog}'`,
  `if [ "$1" = "--version" ]; then echo 'SkillSpector v2.13.0'; exit 0; fi`,
  `printf '%s\\n' '${scanReport}'`,
  'exit 0',
  '',
].join('\n'));
chmodSync(join(stubDir, 'skillspector'), 0o755);

const sandbox = () => ({
  ...process.env,
  HOME: childHome,
  USERPROFILE: childHome,
  ALATE_DATA: join(tmp, 'no-aldata'),
  PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
  SKILLSPECTOR_VENV: join(tmp, 'no-venv'),
  SKILLSPECTOR_BIN: '',
});

/** @param {string} dir @param {string} rel @param {string} text */
const put = (dir, rel, text) => {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const skillMd = name => `---\nname: ${name}\ndescription: Test skill.\n---\nBody\n`;
const SKILLS = ['core-skill', 'gamedev-skill', 'shelf-skill'];
const PROJECTS_JSON = JSON.stringify({
  contextFiles: [],
  projects: { alpha: { bundles: ['gamedev-2d'] }, beta: [] },
});

/**
 * Builds a fresh fixture pair and returns the run helper. opts.flip holds
 * scenario mutations keyed by a short name.
 * @param {{ bundles?: boolean, unknownSkill?: boolean, unknownBundle?: boolean, unknownPlugin?: boolean, dropBundleSkill?: string }} [opts]
 */
const fixture = (opts = {}) => {
  const n = readdirSync(tmp).length;
  const dataDir = join(tmp, `data-${n}`);
  const homeDir = join(tmp, `home-${n}`);
  mkdirSync(homeDir);
  put(dataDir, 'user/omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\n');
  for (const name of SKILLS) put(dataDir, `user/omp/agent/skills/${name}/SKILL.md`, skillMd(name));
  put(dataDir, 'user/omp/plugins/package.json', JSON.stringify({ dependencies: { 'pony-a': '1.0.0', '@scope/web-b': '2.0.0' } }, null, 2) + '\n');
  if (opts.bundles !== false) {
    const gamedevSkills = opts.unknownSkill ? 'gamedev-skill\nno-such-skill\n' : opts.dropBundleSkill === 'gamedev-2d' ? '' : 'gamedev-skill\n';
    const gamedevPlugins = opts.unknownPlugin ? '@scope/no-such-plugin\n' : '@scope/web-b\n';
    put(dataDir, 'bundles/core/skills.txt', 'core-skill\n');
    // Core names no plugin: beta (no bundles) must then get an empty, present
    // plugin list, never the home-wide fallback.
    put(dataDir, 'bundles/core/apt.txt', '# shared first\npkg-one\n');
    put(dataDir, 'bundles/gamedev-2d/skills.txt', gamedevSkills);
    put(dataDir, 'bundles/gamedev-2d/plugins.txt', gamedevPlugins);
    put(dataDir, 'bundles/gamedev-2d/apt.txt', 'pkg-two\npkg-one\n');
  }
  put(dataDir, 'workers/alpha/skills.txt', 'gamedev-skill\n');
  put(dataDir, 'workers/alpha/apt.txt', 'pkg-three\n');
  put(dataDir, 'workers/_all/apt.txt', 'fleet-pkg\n');
  // The _all fleet lists hold the canonical form too (specs/canonical-form.md): the CRLF
  // fixture bytes and the per-OS tools.json must land rendered and resolved.
  put(dataDir, 'workers/_all/env.txt', 'FLEET_VAR\r\n');
  put(dataDir, 'workers/_all/tools.json', JSON.stringify([
    {
      name: 'fleet-tool',
      url: { linux: 'https://example/fleet-linux.tar.gz', win32: 'https://example/fleet-win.zip' },
      sha256: 'a'.repeat(64),
      unpack: 'zip',
      bin: { linux: 'fleet', win32: 'fleet.exe' },
    },
    { name: 'win-only', os: ['win32'], url: 'https://example/fleet.exe', sha256: 'b'.repeat(64), unpack: 'none' },
  ]));
  put(dataDir, 'projects/projects.json', opts.unknownBundle
    ? JSON.stringify({ contextFiles: [], projects: { alpha: { bundles: ['ghost-bundle'] }, beta: [] } })
    : PROJECTS_JSON);
  const run = extra => spawnSync(process.execPath, [join(scriptDir, 'install-user.mjs'), '--home', homeDir, '--data', dataDir, '--skip-plugins', ...extra], {
    encoding: 'utf8',
    env: sandbox(),
  });
  return { dataDir, homeDir, run };
};
const got = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

try {
  if (!scanned) {
    console.log('install-bundles.test.mjs: skipped (needs a POSIX stub scanner)');
  } else {
    // Bundles mode: the fixture above. Everything below fails before the change.
    let { dataDir, homeDir, run } = fixture();
    let r = run([]);
    assert.equal(r.status, 0, `bundles-mode install: ${r.stderr}`);
    // Project alpha (bundles gamedev-2d) gets the bundle skill; beta does not.
    assert.equal(got(homeDir, '.ottr/project-skills/alpha/gamedev-skill/SKILL.md'), skillMd('gamedev-skill'));
    assert.ok(!existsSync(join(homeDir, '.ottr/project-skills/beta')), 'beta plans no non-core skills');
    // The bundle skill leaves the home roots; core stays global; the shelf skill loads nowhere.
    assert.ok(!existsSync(join(homeDir, '.omp/agent/skills/gamedev-skill')), 'a bundle skill never installs into the shared home roots');
    assert.ok(existsSync(join(homeDir, '.omp/agent/skills/core-skill')), 'a core skill installs into the shared home roots');
    assert.ok(!existsSync(join(homeDir, '.omp/agent/skills/shelf-skill')), 'a shelf skill installs into no home root');
    assert.ok(!existsSync(join(homeDir, '.ottr/project-skills/alpha/shelf-skill')), 'a shelf skill installs into no project folder');
    // Worker lists merge core, bundle, own; _all installs its own lists rendered to the
    // canonical form (unmerged).
    assert.equal(got(homeDir, '.ottr/workers/alpha/apt.txt'), 'pkg-one\npkg-two\npkg-three\n');
    assert.equal(got(homeDir, '.ottr/workers/beta/apt.txt'), 'pkg-one\n');
    assert.equal(got(homeDir, '.ottr/workers/_all/apt.txt'), 'fleet-pkg\n');
    assert.equal(got(homeDir, '.ottr/workers/_all/env.txt'), 'FLEET_VAR\n', 'a CRLF checkout of _all/env.txt installs LF');
    const fleetTools = JSON.parse(got(homeDir, '.ottr/workers/_all/tools.json'));
    const onWin = process.platform === 'win32';
    assert.deepEqual(fleetTools, [
      {
        name: 'fleet-tool',
        url: onWin ? 'https://example/fleet-win.zip' : 'https://example/fleet-linux.tar.gz',
        sha256: 'a'.repeat(64),
        unpack: 'zip',
        bin: onWin ? 'fleet.exe' : 'fleet',
      },
    ], 'the _all tools.json resolves per-OS values and drops os-filtered entries');
    // Per-project plugin lists merge core, bundle, own. Core names no plugin,
    // so beta's set is empty — and its file must still exist (empty), because
    // the consumer scopes plugins only when the file exists: a missing file
    // would fall back to every plugin of the home, the gamedev plugin
    // included.
    assert.equal(got(homeDir, '.ottr/plugins/alpha.txt'), '@scope/web-b\n');
    assert.equal(got(homeDir, '.ottr/plugins/beta.txt'), '', 'beta plans no plugin, so its list file exists and is empty');
    // Shelf skills are still scanned like today (the stub logged their scan call).
    const calls = readFileSync(callsLog, 'utf8');
    assert.match(calls, /scan .*shelf-skill/, 'the shelf skill is scanned like today');
    assert.match(calls, /scan .*gamedev-skill/, 'the bundle skill is scanned');

    // A second run is unchanged; dropping the skill from every naming source
    // (the bundle and the project's own list) then deletes its per-project copy.
    r = run([]);
    assert.equal(r.status, 0, r.stderr);
    rmSync(join(dataDir, 'bundles/gamedev-2d/skills.txt'));
    rmSync(join(dataDir, 'workers/alpha/skills.txt'));
    r = run([]);
    assert.equal(r.status, 0, `run after the bundle drops the skill: ${r.stderr}`);
    assert.ok(!existsSync(join(homeDir, '.ottr/project-skills/alpha/gamedev-skill')), 'a skill that left its bundle is deleted from the project folder');
    assert.ok(existsSync(join(homeDir, '.ottr/workers/alpha/apt.txt')), 'the merged worker list survives while its sources stand');
    assert.equal(got(homeDir, '.ottr/plugins/alpha.txt'), '@scope/web-b\n', 'the plugin list is unchanged by the skill drop');

    // Unknown skill name in a bundle: refusal before any write.
    ({ homeDir, run } = fixture({ unknownSkill: true }));
    r = run([]);
    assert.equal(r.status, 1, 'an unknown bundle skill name refuses the run');
    assert.match(r.stderr, /bundles\/gamedev-2d\/skills\.txt.*no-such-skill/, r.stderr);
    assert.ok(!existsSync(join(homeDir, '.omp')), 'the refusal writes nothing into the home');

    // Unknown plugin name: refusal before any write.
    ({ homeDir, run } = fixture({ unknownPlugin: true }));
    r = run([]);
    assert.equal(r.status, 1, 'an unknown bundle plugin name refuses the run');
    assert.match(r.stderr, /bundles\/gamedev-2d\/plugins\.txt.*@scope\/no-such-plugin/, r.stderr);
    assert.ok(!existsSync(join(homeDir, '.omp')), 'the refusal writes nothing into the home');

    // Unknown bundle name in projects.json: refusal naming project and bundle.
    ({ homeDir, run } = fixture({ unknownBundle: true }));
    r = run([]);
    assert.equal(r.status, 1, 'an unknown bundle reference refuses the run');
    assert.match(r.stderr, /project "alpha".*ghost-bundle/, r.stderr);
    assert.ok(!existsSync(join(homeDir, '.omp')), 'the refusal writes nothing into the home');

    // Migration: no bundles/ dir installs as today, with the legacy manifest form.
    ({ dataDir, homeDir, run } = fixture({ bundles: false }));
    put(dataDir, 'projects/projects.json', JSON.stringify({ contextFiles: [], projects: { alpha: ['a.md'], beta: [] } }));
    r = run([]);
    assert.equal(r.status, 0, `no-bundles install: ${r.stderr}`);
    for (const name of SKILLS) assert.ok(existsSync(join(homeDir, '.omp/agent/skills', name)), `a repo without bundles installs every skill globally (${name})`);
    assert.ok(!existsSync(join(homeDir, '.ottr/project-skills')), 'a repo without bundles installs no per-project skills');
    assert.ok(!existsSync(join(homeDir, '.ottr/plugins')), 'a repo without bundles installs no per-project plugin lists');
    assert.equal(got(homeDir, '.ottr/workers/alpha/apt.txt'), 'pkg-three\n', 'worker lists stay verbatim without bundles');
  }
  console.log('install-bundles.test.mjs: all checks passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
