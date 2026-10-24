#!/usr/bin/env node
// Architecture self-check for the provisioning CLIs. Plain node:assert, no frameworks.
// Usage: node architecture.test.mjs [toolSourceRoot]   (default: this checkout)
// Runs the real CLIs from the given root against throwaway fixtures. Fixtures are
// NEVER deleted or renamed; the single retained root is printed at startup.
// Cases are grouped by consumer defect. Sanitized env keeps every run inside the
// fixture root even when a script misbehaves.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOL = resolve(process.argv[2] ?? '.');
const ROOT = mkdtempSync(join(tmpdir(), 'alate-arch-'));
console.log(`fixtures retained at ${ROOT}`);

const WIN = process.platform === 'win32';
const writeF = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const bytes = p => readFileSync(p);
const text = p => readFileSync(p, 'utf8');
const linkDir = (target, link) => symlinkSync(target, link, WIN ? 'junction' : 'dir');
const freshCase = name => {
  const dir = mkdtempSync(join(ROOT, `${name}-`));
  const c = { dir, home: join(dir, 'home'), aldata: join(dir, 'empty-aldata'), out: join(dir, 'outside') };
  for (const p of [c.home, c.aldata, c.out]) mkdirSync(p, { recursive: true });
  return c;
};
const cliEnv = c => ({
  ...process.env,
  HOME: c.home, USERPROFILE: c.home,
  PI_CODING_AGENT_DIR: join(c.dir, 'agentdir'),
  ALATE_DATA: c.aldata, // exists but empty: a fallback lands in the sandbox, visibly broken
  GH_TOKEN: 'sanitized-no-network', GITHUB_TOKEN: 'sanitized-no-network',
});
const runCli = (c, script, args) =>
  spawnSync(process.execPath, [join(TOOL, script), ...args], { cwd: c.dir, env: cliEnv(c), encoding: 'utf8' });

const refused = (r, what) => assert(r.status !== null && r.status !== 0,
  `${what}: expected nonzero exit, got 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
const absent = p => assert(!existsSync(p), `must not exist: ${p}`);
const present = p => assert(existsSync(p), `must exist: ${p}`);
const sameBytes = (a, b, what) => assert(Buffer.compare(bytes(a), bytes(b)) === 0, `${what}: bytes differ`);

// ---- fixture builders ----------------------------------------------------

const ruleMd = desc => `---\n${desc}\n---\nbody text\n`;
const OK_DESC = 'description: Fine rule';
const DATA_RULES = { 'a.md': ruleMd(OK_DESC), 'b.md': ruleMd('description: Other rule') };
const dataWithRules = (c, rules = DATA_RULES) => {
  for (const [n, s] of Object.entries(rules)) writeF(join(c.dir, 'data', n), s);
  return join(c.dir, 'data');
};

// sync-user requires every ITEMS entry to exist, else it refuses. The one exception is the
// capture's OPTIONAL set (~/.omp/plugins/patches): these fixtures deliberately lack it.
const USER_ITEMS = [
  '.omp/agent/config.yml', '.omp/agent/mcp.json', '.omp/agent/optimizer.json',
  '.pi/agent/pix.json',
  '.omp/agent/extensions', '.omp/agent/skills', '.omp/agent/managed-skills',
  '.omp/marketplaces.json', '.omp/plugins/package.json', '.omp/plugins/bun.lock',
  '.omp/plugins/omp-plugins.lock.json', '.omp/plugins/installed_plugins.json',
  '.agents/.skill-lock.json', '.agents/skills',
];
// Dummy secrets assembled from benign fragments; never credential-shaped literals.
const FRAGS = ['harbor', 'lantern', 'meadow'];
const dummy = `${FRAGS[0]}-${FRAGS[1]}-${FRAGS[2]}-42`;
const USER_CONFIG = `model: glm\napiKey: $HARBOR_TOKEN\nmaxTokens: 4096\nstrict: true\n`;
const USER_MCP = `{"server":{"secret":"\${HARBOR_TOKEN}"}}\n`;
const mkUserHome = (c, { config = USER_CONFIG, mcp = USER_MCP } = {}) => {
  for (const it of USER_ITEMS) {
    const p = join(c.home, it);
    if (it === '.omp/agent/skills') continue; // caller decides (dir vs junction)
    if (['.omp/agent/extensions', '.omp/agent/managed-skills', '.agents/skills'].includes(it)) mkdirSync(p, { recursive: true });
    else if (it === '.omp/agent/config.yml') writeF(p, config);
    else if (it === '.omp/agent/mcp.json') writeF(p, mcp);
    else writeF(p, it.endsWith('.lock') || it.endsWith('.json') ? '{}' : '');
  }
  return c;
};
const withSkillsDir = c => { mkdirSync(join(c.home, '.omp/agent/skills'), { recursive: true }); return c; };

const projectsManifest = (c, manifest) => {
  writeF(join(c.dir, 'data', 'projects', 'projects.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return join(c.dir, 'data');
};

// ---- cases ---------------------------------------------------------------

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// -- argument handling (all four callers) --

test('sync: unknown option is refused', () => {
  const c = freshCase('sync-unknown-opt');
  const data = dataWithRules(c);
  const target = join(c.dir, 'rules');
  const r = runCli(c, 'sync.mjs', [target, '--data', data, '--torso', '1']);
  refused(r, 'unknown --torso must be rejected');
});

test('sync: missing --data value refuses', () => {
  const c = freshCase('sync-missing-value');
  const target = join(c.dir, 'rules');
  const r = runCli(c, 'sync.mjs', [target, '--data']);
  refused(r, 'trailing --data must be rejected');
  absent(target);
});

test('shared data selection: conflicting valid sources refuse before cloning', () => {
  const c = freshCase('sync-data-repo');
  const data = dataWithRules(c);
  const repo = join(c.dir, 'repo');
  writeF(join(repo, 'rule.md'), ruleMd(OK_DESC));
  const env = cliEnv(c);
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const config = join(c.dir, 'empty-gitconfig');
  writeF(config, '');
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    TEMP: c.dir, TMP: c.dir, TMPDIR: c.dir,
  });
  for (const args of [['init', '--quiet', repo], ['-C', repo, 'add', 'rule.md'], ['-C', repo, 'commit', '--quiet', '-m', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: c.dir, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  // Call the shared interface directly so the original clone stays retained, without cleanupData.
  const module = pathToFileURL(join(TOOL, 'lib', 'data.mjs')).href;
  const code = `import { resolveDataDir } from ${JSON.stringify(module)}; resolveDataDir({ values: { '--data': process.argv[1], '--repo': process.argv[2] }, flags: new Set() }, { allowClone: true });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code, data, repo],
    { cwd: c.dir, env, encoding: 'utf8' });
  refused(r, 'conflicting valid --data/--repo sources must refuse');
  assert(!readdirSync(c.dir).some(name => name.startsWith('alate-data-')), 'conflicting sources started a clone');
});

test('install-user: unknown option --forc is refused', () => {
  const c = freshCase('install-unknown-opt');
  const home = join(c.dir, 'fresh');
  mkdirSync(home, { recursive: true });
  writeF(join(c.dir, 'data', 'user', 'omp', 'agent', 'config.yml'), 'captured\n');
  const r = runCli(c, 'install-user.mjs', ['--forc', '--data', join(c.dir, 'data'), '--home', home, '--skip-plugins']);
  refused(r, 'typo --forc must be rejected, not ignored');
  absent(join(home, '.omp'));
});

test('install-user: positional argument is refused', () => {
  const c = freshCase('install-positional');
  const home = join(c.dir, 'fresh');
  mkdirSync(home, { recursive: true });
  writeF(join(c.dir, 'data', 'user', 'omp', 'agent', 'config.yml'), 'captured\n');
  const r = runCli(c, 'install-user.mjs', ['stray', '--data', join(c.dir, 'data'), '--home', home, '--skip-plugins']);
  refused(r, 'install-user takes no positional target');
  absent(join(home, '.omp'));
});

test('install-user: --home without a value refuses, nothing installed', () => {
  const c = freshCase('install-home-noval');
  const home = join(c.dir, 'fresh');
  mkdirSync(home, { recursive: true });
  writeF(join(c.dir, 'data', 'user', 'omp', 'agent', 'config.yml'), 'captured\n');
  const r = runCli(c, 'install-user.mjs', ['--data', join(c.dir, 'data'), '--skip-plugins', '--home']);
  refused(r, 'valueless --home must be rejected');
  absent(join(home, '.omp'));
});

test('install-user: --home consuming --force never creates a "--force" home', () => {
  const c = freshCase('install-home-swallows-flag');
  const home = join(c.dir, 'fresh');
  mkdirSync(home, { recursive: true });
  writeF(join(c.dir, 'data', 'user', 'omp', 'agent', 'config.yml'), 'captured\n');
  const r = runCli(c, 'install-user.mjs', ['--home', '--force', '--data', join(c.dir, 'data')]);
  refused(r, '--home cannot consume --force');
  absent(join(c.dir, '--force')); // the flag must never be swallowed as a value and used as a home
  absent(join(home, '.omp')); // and no restore may land in the default home either
});

test('sync-user: unknown option --hom is refused', () => {
  const c = freshCase('capture-unknown-opt');
  mkUserHome(withSkillsDir(c));
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--hom', join(c.dir, 'other'), '--data', data]);
  refused(r, 'typo --hom must be rejected, not silently fall back to the default home');
});

test('sync-projects: stray positional is refused', () => {
  const c = freshCase('projects-positional');
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
  const data = projectsManifest(c, { contextFiles: ['a.txt'], projects: { proj: [] } });
  const r = runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data, 'stray']);
  refused(r, 'sync-projects takes no positional');
});

test('capture scripts refuse --repo even with --data', () => {
  const c = freshCase('capture-repo');
  mkUserHome(withSkillsDir(c));
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--data', data, '--repo', 'bad name@@x']);
  refused(r, 'sync-user must never clone');
  absent(join(data, 'user'));
});

// -- rules install (sync.mjs) --

test('gate chain: the fixture smoke never writes the running home', () => {
  // sync.mjs without a target installs into $PI_CODING_AGENT_DIR/rules or ~/.omp/agent/rules.
  // Ottr agents run the gate chain inside containers that share one live home, so the smoke
  // in AGENTS.md and sync.yml must pass a throwaway target dir (install.yml is exempt: that
  // job checks an install into the CI runner's own home on purpose).
  for (const doc of ['AGENTS.md', join('.github', 'workflows', 'sync.yml')]) {
    assert.ok(!/node sync\.mjs\s+--data examples\b/.test(text(join(TOOL, doc))),
      `${doc}: the fixture smoke needs a target dir before --data (a bare run writes the live home)`);
  }
  const c = freshCase('sync-smoke-target');
  const env = cliEnv(c);
  delete env.PI_CODING_AGENT_DIR; // the default target must fall back to the (fake) home
  const r = spawnSync('sh', ['-c', 'node sync.mjs "$(mktemp -d)" --data examples/data'],
    { cwd: TOOL, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `documented smoke run failed: ${r.stderr}`);
  absent(join(c.home, '.omp', 'agent', 'rules'));
});

test('sync: valid install mirrors exact bytes, idempotent, keeps stale files', () => {
  const c = freshCase('sync-valid');
  const data = dataWithRules(c);
  const target = join(c.dir, 'rules');
  let r = runCli(c, 'sync.mjs', [target, '--data', data]);
  assert.strictEqual(r.status, 0, `install failed: ${r.stderr}`);
  sameBytes(join(data, 'a.md'), join(target, 'a.md'), 'installed rule');
  writeF(join(target, 'stale.md'), 'stale\n'); // pre-existing, not from data repo
  r = runCli(c, 'sync.mjs', [target, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* (added|updated)/.test(r.stdout), `not idempotent: ${r.stdout}`);
  present(join(target, 'stale.md'));
});

test('sync: blank description installs nothing', () => {
  const c = freshCase('sync-blank-desc');
  const data = dataWithRules(c, { 'a.md': ruleMd(OK_DESC), 'z.md': ruleMd('description:') });
  const target = join(c.dir, 'rules');
  refused(runCli(c, 'sync.mjs', [target, '--data', data]), 'blank description must refuse');
  absent(join(target, 'a.md'));
  absent(join(target, 'z.md'));
});

test('sync: comment-only description installs nothing', () => {
  const c = freshCase('sync-comment-desc');
  const data = dataWithRules(c, { 'a.md': ruleMd(OK_DESC), 'z.md': ruleMd('description: # see docs') });
  const target = join(c.dir, 'rules');
  refused(runCli(c, 'sync.mjs', [target, '--data', data]), 'comment-only description must refuse');
  absent(join(target, 'a.md'));
  absent(join(target, 'z.md'));
});

test('sync: empty-quoted description installs nothing', () => {
  const c = freshCase('sync-quoted-desc');
  const data = dataWithRules(c, { 'a.md': ruleMd(OK_DESC), 'z.md': ruleMd('description: ""') });
  const target = join(c.dir, 'rules');
  refused(runCli(c, 'sync.mjs', [target, '--data', data]), 'empty quoted description must refuse');
  absent(join(target, 'a.md'));
  absent(join(target, 'z.md'));
});

test('sync: destination directory blocks all earlier writes', () => {
  const c = freshCase('sync-dest-dir');
  const data = dataWithRules(c, { 'a.md': ruleMd(OK_DESC), 'z.md': ruleMd(OK_DESC) });
  const target = join(c.dir, 'rules');
  mkdirSync(join(target, 'z.md'), { recursive: true }); // z sorts last: a.md would be written first
  refused(runCli(c, 'sync.mjs', [target, '--data', data]), 'directory at destination must refuse up front');
  absent(join(target, 'a.md')); // preflight: nothing written before the failure
});

test('sync: multiply-linked destination blocks all writes', () => {
  const c = freshCase('sync-dest-hardlink');
  const data = dataWithRules(c);
  const target = join(c.dir, 'rules');
  const sentinel = join(c.out, 'sentinel.txt');
  writeF(join(target, 'a.md'), 'old\n');
  linkSync(join(target, 'a.md'), sentinel);
  refused(runCli(c, 'sync.mjs', [target, '--data', data]), 'hardlinked destination must refuse');
  assert.strictEqual(text(sentinel), 'old\n', 'hardlink alias was overwritten');
  absent(join(target, 'b.md')); // no partial install either
});

test('sync: caller-chosen junction target is a valid root, installs through it', () => {
  const c = freshCase('sync-target-junction');
  const data = dataWithRules(c);
  const target = join(c.out, 'tgt'); // explicit caller-chosen root that itself is a junction
  mkdirSync(target, { recursive: true });
  const link = join(c.dir, 'rules');
  linkDir(target, link);
  const r = runCli(c, 'sync.mjs', [link, '--data', data]);
  assert.strictEqual(r.status, 0, `chosen junction root must install: ${r.stderr}`);
  sameBytes(join(data, 'a.md'), join(target, 'a.md'), 'rule installed through junction root');
});

test('sync: target resolving to the data dir itself refuses', () => {
  const c = freshCase('sync-target-self');
  const data = dataWithRules(c);
  linkDir(data, join(c.dir, 'alias'));
  const r = runCli(c, 'sync.mjs', [join(c.dir, 'alias'), '--data', data]);
  refused(r, 'installing into the data dir itself must refuse');
  assert.strictEqual(text(join(data, 'a.md')), ruleMd(OK_DESC), 'data source was modified');
});

test('sync: quoted meaningful description with # is valid; empty quoted with trailing comment refuses', () => {
  const c = freshCase('sync-desc-quotes');
  const data = dataWithRules(c, { 'q.md': ruleMd('description: "# meaningful quoted"') });
  const target = join(c.dir, 'rules');
  let r = runCli(c, 'sync.mjs', [target, '--data', data]);
  assert.strictEqual(r.status, 0, `quoted meaningful description must stay valid: ${r.stderr}`);
  present(join(target, 'q.md'));
  const c2 = freshCase('sync-desc-quotes-bad');
  const data2 = dataWithRules(c2, { 'a.md': ruleMd(OK_DESC), 'z.md': ruleMd(`description: '' # note`) });
  const target2 = join(c2.dir, 'rules');
  refused(runCli(c2, 'sync.mjs', [target2, '--data', data2]), 'empty quoted with trailing comment must refuse');
  absent(join(target2, 'a.md'));
  absent(join(target2, 'z.md'));
});

// -- project snapshots (sync-projects.mjs) --

test('projects: valid snapshot is idempotent, CRLF-stable, keeps stale files', () => {
  const c = freshCase('projects-valid');
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
  writeF(join(c.dir, 'ws', 'proj', 'extra.md'), 'extra\n');
  const data = projectsManifest(c, { contextFiles: ['a.txt'], projects: { proj: ['extra.md'] } });
  writeF(join(data, 'projects', 'proj', 'old.txt'), 'stale\n');
  let r = runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  sameBytes(join(c.dir, 'ws', 'proj', 'a.txt'), join(data, 'projects', 'proj', 'a.txt'), 'snapshot');
  r = runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* added/.test(r.stdout), `not idempotent: ${r.stdout}`);
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\r\n');
  r = runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* (added|updated)/.test(r.stdout), `CRLF churned: ${r.stdout}`);
  assert.strictEqual(text(join(data, 'projects', 'proj', 'a.txt')), 'alpha\n', 'snapshot CRLF rewritten');
  present(join(data, 'projects', 'proj', 'old.txt'));
  assert(r.stdout.includes('old.txt'), `stale file not reported: ${r.stdout}`);
});

test('projects: traversal in project name refuses without writing', () => {
  const c = freshCase('projects-traversal');
  writeF(join(c.out, 'a.txt'), 'secret\n'); // '../outside' from the data dir lands here
  const data = projectsManifest(c, { contextFiles: ['a.txt'], projects: { '../outside': [] } });
  refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
    'project name with .. must refuse');
  absent(join(data, 'outside'));
  absent(join(data, 'projects', 'outside'));
});

test('projects: traversal in tracked extra path refuses without writing', () => {
  const c = freshCase('projects-extra-traversal');
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
  writeF(join(c.dir, 'ws', 'outside.md'), 'secret\n');
  const data = projectsManifest(c, { contextFiles: ['a.txt'], projects: { proj: ['../outside.md'] } });
  refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
    'extra path with .. must refuse');
  absent(join(data, 'projects', 'outside.md'));
});

test('projects: manifest shapes are validated', () => {
  for (const [i, manifest] of [
    '{"contextFiles":[],"projects":[]}',
    '{"contextFiles":"x","projects":{}}',
    '{"contextFiles":[],"projects":{"proj":"oops"}}',
  ].entries()) {
    const c = freshCase(`projects-shape-${i}`);
    writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
    const data = projectsManifest(c, manifest);
    refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
      `invalid manifest ${manifest} must refuse cleanly`);
    absent(join(data, 'projects', 'proj'));
  }
});

test('projects: project path that is a file refuses', () => {
  const c = freshCase('projects-file-proj');
  writeF(join(c.dir, 'ws', 'proj'), 'i am a file\n');
  const data = projectsManifest(c, { contextFiles: [], projects: { proj: [] } });
  refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
    'project that is not a directory must refuse');
});

test('projects: tracked path that is a directory preflights, nothing written', () => {
  const c = freshCase('projects-b-md-dir');
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
  mkdirSync(join(c.dir, 'ws', 'proj', 'b.md'), { recursive: true });
  const data = projectsManifest(c, { contextFiles: ['a.txt', 'b.md'], projects: { proj: [] } });
  refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
    'directory where a tracked file belongs must refuse up front');
  absent(join(data, 'projects', 'proj', 'a.txt')); // no partial snapshot
});

test('projects: project junction escaping the workspace root refuses', () => {
  const c = freshCase('projects-src-junction');
  const real = join(c.out, 'canaryproj');
  writeF(join(real, 'a.txt'), 'outside\n');
  mkdirSync(join(c.dir, 'ws'), { recursive: true });
  linkDir(real, join(c.dir, 'ws', 'proj'));
  const data = projectsManifest(c, { contextFiles: ['a.txt'], projects: { proj: [] } });
  refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
    'project junction pointing outside root must refuse');
  absent(join(data, 'projects', 'proj'));
});

test('projects: snapshot destination junction refuses, outside untouched', () => {
  const c = freshCase('projects-dest-junction');
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
  const data = projectsManifest(c, { contextFiles: ['a.txt'], projects: { proj: [] } });
  const outside = join(c.out, 'snapoutside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(data, 'projects'), { recursive: true });
  linkDir(outside, join(data, 'projects', 'proj'));
  refused(runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]),
    'destination junction below the data dir must refuse');
  absent(join(outside, 'a.txt'));
});

test('projects: valid "..notes.md" child name syncs, no traversal overreach', () => {
  const c = freshCase('projects-dotdot-name');
  writeF(join(c.dir, 'ws', 'proj', '..notes.md'), 'notes\n');
  writeF(join(c.dir, 'ws', 'proj', 'a.txt'), 'alpha\n');
  const data = projectsManifest(c, { contextFiles: ['a.txt', '..notes.md'], projects: { proj: [] } });
  const r = runCli(c, 'sync-projects.mjs', ['--root', join(c.dir, 'ws'), '--data', data]);
  assert.strictEqual(r.status, 0, `legitimate ..notes.md child must sync: ${r.stderr}`);
  sameBytes(join(c.dir, 'ws', 'proj', '..notes.md'), join(data, 'projects', 'proj', '..notes.md'), 'dotdot-named snapshot');
  absent(join(data, 'notes')); // nothing escaped the projects dir
});

test('restore: without --skip-plugins, a capture without plugin manifests installs without running bun', () => {
  const c = freshCase('restore-plugins-absent');
  const { args, data, cfg } = installFixture(c);
  const noSkip = args.filter(a => a !== '--skip-plugins');
  const r = runCli(c, 'install-user.mjs', noSkip); // no --skip-plugins
  assert.strictEqual(r.status, 0, r.stderr);
  sameBytes(join(data, 'user/omp/agent/config.yml'), cfg, 'restored without plugin manifests');
});

test('restore: plugin snapshot without bun on PATH fails explicitly', () => {
  const c = freshCase('restore-plugins-no-bun');
  const home = join(c.dir, 'home-restore');
  mkdirSync(home, { recursive: true });
  const data = join(c.dir, 'data');
  // neutral zero-dependency snapshot: no network, no real install even if bun existed
  writeF(join(data, 'user', 'omp', 'plugins', 'package.json'), '{"name":"neutral","private":true}\n');
  writeF(join(data, 'user', 'omp', 'plugins', 'bun.lock'), '');
  const env = cliEnv(c);
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.PATH = ''; // bun must be unfindable; node still runs via absolute process.execPath
  const r = spawnSync(process.execPath, [join(TOOL, 'install-user.mjs'),
    '--data', data, '--home', home], { cwd: c.dir, env, encoding: 'utf8' });
  refused(r, 'missing bun runtime must fail the install');
  const skippedHome = join(c.dir, 'home-skipped');
  const skipped = spawnSync(process.execPath, [join(TOOL, 'install-user.mjs'),
    '--data', data, '--home', skippedHome, '--skip-plugins'], { cwd: c.dir, env, encoding: 'utf8' });
  assert.strictEqual(skipped.status, 0, skipped.stderr);
  sameBytes(join(data, 'user/omp/plugins/package.json'), join(skippedHome, '.omp/plugins/package.json'), 'restored with plugins skipped');
});

// -- user capture (sync-user.mjs) --

test('capture: valid env references capture, idempotent, CRLF-stable, keeps stale, skill link inside home works', () => {
  const c = freshCase('capture-valid');
  mkUserHome(c);
  writeF(join(c.home, '.agents', 'skills', 'skill.md'), 'skill body\n');
  // link between two allowlisted roots: .omp/agent/skills -> .agents/skills (never arbitrary home paths)
  linkDir(join(c.home, '.agents', 'skills'), join(c.home, '.omp', 'agent', 'skills'));
  const data = projectsManifest(c, {});
  writeF(join(data, 'user', 'omp', 'extra.yml'), 'stale\n');
  let r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  sameBytes(join(c.home, '.omp/agent/config.yml'), join(data, 'user/omp/agent/config.yml'), 'captured config');
  present(join(data, 'user/omp/agent/skills/skill.md'));
  r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* (added|updated)/.test(r.stdout), `not idempotent: ${r.stdout}`);
  writeF(join(c.home, '.omp/agent/config.yml'), USER_CONFIG.replaceAll('\n', '\r\n'));
  r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* (added|updated)/.test(r.stdout), `CRLF churned: ${r.stdout}`);
  present(join(data, 'user', 'omp', 'extra.yml'));
  assert(r.stdout.includes('extra.yml'), `stale not reported: ${r.stdout}`);
});

test('capture: secret-named literals refuse without leaking values', () => {
  const shortVal = `${FRAGS[0].slice(0, 3)}-42`;
  const numVal = '1234567890123';
  const shapes = [
    ['short', `apiKey: ${shortVal}\n`, shortVal],
    ['numeric', `apiKey: ${numVal}\n`, numVal],
    ['yaml-block', `apiKey: |\n  ${dummy}\n`, dummy],
    ['json-escaped-key', `{"api\\u005Fkey":"${dummy}"}\n`, dummy],
  ];
  for (const [name, content, value] of shapes) {
    const c = freshCase(`capture-secret-${name}`);
    const isJson = name === 'json-escaped-key';
    mkUserHome(withSkillsDir(c), isJson ? { mcp: content } : { config: content });
    const data = projectsManifest(c, {});
    const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
    refused(r, `secret-shaped ${name} literal must refuse`);
    const out = r.stdout + r.stderr;
    assert(!out.includes(value), `${name}: dummy value leaked into output`);
    for (const f of FRAGS) assert(!out.includes(f), `${name}: dummy fragment leaked: ${f}`);
    absent(join(data, 'user', 'omp', 'agent', isJson ? 'mcp.json' : 'config.yml'));
  }
});

test('capture: skill junction escaping home refuses', () => {
  const c = freshCase('capture-skill-escape');
  mkUserHome(c);
  const outside = join(c.out, 'canaryskills');
  writeF(join(outside, 'skill.md'), 'outside\n');
  linkDir(outside, join(c.home, '.omp', 'agent', 'skills'));
  const data = projectsManifest(c, {});
  refused(runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]),
    'skill source junction outside home must refuse');
  absent(join(data, 'user', 'omp', 'agent', 'skills'));
});

test('capture: destination junction below the data dir refuses, outside untouched', () => {
  const c = freshCase('capture-dest-junction');
  mkUserHome(withSkillsDir(c));
  const data = projectsManifest(c, {});
  const outside = join(c.out, 'useroutside');
  mkdirSync(join(outside, 'agent'), { recursive: true });
  mkdirSync(join(data, 'user'), { recursive: true });
  linkDir(outside, join(data, 'user', 'omp'));
  refused(runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]),
    'capture destination junction must refuse');
  absent(join(outside, 'agent', 'config.yml'));
});

test('capture: multiply-linked destination file refuses, alias intact', () => {
  const c = freshCase('capture-dest-hardlink');
  mkUserHome(withSkillsDir(c));
  const data = projectsManifest(c, {});
  writeF(join(data, 'user', 'omp', 'agent', 'config.yml'), 'older capture\n');
  const sentinel = join(c.out, 'sentinel.txt');
  linkSync(join(data, 'user', 'omp', 'agent', 'config.yml'), sentinel);
  refused(runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]),
    'hardlinked capture destination must refuse');
  assert.strictEqual(text(sentinel), 'older capture\n', 'hardlink alias was overwritten');
});

test('capture: directory at mcp.json destination preflights, prior config stays unchanged', () => {
  const c = freshCase('capture-dest-dir');
  mkUserHome(withSkillsDir(c));
  const data = projectsManifest(c, {});
  writeF(join(data, 'user', 'omp', 'agent', 'config.yml'), 'old\n');
  mkdirSync(join(data, 'user', 'omp', 'agent', 'mcp.json'), { recursive: true });
  refused(runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]),
    'directory at mcp.json destination must refuse up front');
  assert.strictEqual(text(join(data, 'user', 'omp', 'agent', 'config.yml')), 'old\n',
    'earlier planned write landed despite the failure');
});

test('capture: junction cycle inside a skill root terminates explicitly', () => {
  const c = freshCase('capture-cycle');
  mkUserHome(withSkillsDir(c));
  // self-parenting junction: .agents/skills/sub -> .agents/skills (no deletion needed to build it)
  const a = join(c.home, '.agents', 'skills');
  linkDir(a, join(a, 'sub'));
  const data = projectsManifest(c, {});
  // no timeout configured: the cycle must end on its own (native path-length limits
  // on the original, explicit refusal on the fixed traversal guard)
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  refused(r, 'skill link cycle must fail explicitly, not loop or silently skip');
  absent(join(data, 'user', 'omp', 'agent', 'skills'));
});

// -- user capture: secret-scan and link-bridge additions --

test('capture: nested indented credential with a complete env ref plus trailing comment captures', () => {
  const c = freshCase('capture-nested-envref');
  const config = 'model: glm\nprovider:\n  api_key: ${HARBOR_TOKEN}  # rotate quarterly\nmaxTokens: 4096\n';
  mkUserHome(c, { config });
  withSkillsDir(c);
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = text(join(data, 'user/omp/agent/config.yml'));
  assert(got.includes('api_key: ${HARBOR_TOKEN}'), `env ref with comment lost: ${got}`);
  assert(got.includes('maxTokens: 4096'), `metadata key lost: ${got}`);
});

test('capture: unmatched brace env references refuse', () => {
  for (const [name, value] of [['open-only', '${HARBOR_TOKEN'], ['close-only', '$HARBOR_TOKEN}']]) {
    const c = freshCase(`capture-envref-${name}`);
    mkUserHome(c, { config: `model: glm\napiKey: ${value}\n` });
    withSkillsDir(c);
    const data = projectsManifest(c, {});
    const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
    refused(r, `unmatched brace env ref (${name}) must refuse`);
    const out = r.stdout + r.stderr;
    assert(!/HARBOR_TOKEN/.test(out), `${name}: var name echoed in output`);
    absent(join(data, 'user'));
  }
});

test('capture: maxPassword and maxSecret literals refuse, numeric maxTokens is metadata', () => {
  for (const [key, value] of [['maxPassword', dummy], ['maxSecret', dummy], ['max-password', dummy], ['max_secret', dummy], ['maxPassword', '1234567890123']]) {
    const c = freshCase(`capture-max-${key.replace(/\W/g, '')}`);
    mkUserHome(c, { config: `model: glm\napiKey: $HARBOR_TOKEN\n${key}: ${value}\n` });
    withSkillsDir(c);
    const data = projectsManifest(c, {});
    const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
    refused(r, `${key} literal must refuse`);
    const out = r.stdout + r.stderr;
    assert(!out.includes(value), `${key}: dummy value leaked into output`);
    for (const f of FRAGS) assert(!out.includes(f), `${key}: dummy fragment leaked: ${f}`);
    absent(join(data, 'user'));
  }
  // positive: a numeric max-tokens value is metadata, not a credential, and captures
  const c = freshCase('capture-max-tokens-ok');
  mkUserHome(c);
  withSkillsDir(c);
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(text(join(data, 'user/omp/agent/config.yml')).includes('maxTokens: 4096'));
});

test('capture: plain multiline credential literal refuses without leaking lines', () => {
  const line1 = `${FRAGS[0]} ${FRAGS[1]}`;
  const line2 = `${FRAGS[2]} 42`;
  const variants = [
    ['block', `model: glm\napiKey: |\n  ${line1}\n  ${line2}\nstrict: true\n`],
    ['continuation', `model: glm\napiKey:\n  ${line1}\n  ${line2}\nstrict: true\n`],
  ];
  for (const [name, config] of variants) {
    const c = freshCase(`capture-multiline-${name}`);
    mkUserHome(c, { config });
    withSkillsDir(c);
    const data = projectsManifest(c, {});
    const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
    refused(r, `multiline credential literal (${name}) must refuse`);
    const out = r.stdout + r.stderr;
    for (const f of FRAGS) assert(!out.includes(f), `${name}: literal line leaked into output: ${f}`);
    absent(join(data, 'user'));
  }
});

test('capture: skills junctions targeting home .omp/oauth refuse and never capture the marker', () => {
  const c = freshCase('capture-oauth-dual');
  // BOTH skills roots link to ~/.omp/oauth at once, so one link can never qualify the other.
  const oauth = join(c.home, '.omp', 'oauth');
  mkdirSync(oauth, { recursive: true });
  writeF(join(oauth, 'marker.txt'), 'neutral marker\n');
  mkdirSync(join(c.home, '.omp', 'agent'), { recursive: true });
  mkdirSync(join(c.home, '.agents'), { recursive: true });
  linkDir(oauth, join(c.home, '.omp', 'agent', 'skills'));
  linkDir(oauth, join(c.home, '.agents', 'skills'));
  mkUserHome(c); // mkdirSync(recursive) on the existing .agents/skills junction is a no-op
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  refused(r, 'skills junctions targeting ~/.omp/oauth must refuse');
  const out = r.stdout + r.stderr;
  assert(!/marker\.txt|neutral marker/.test(out), 'marker leaked into output');
  absent(join(data, 'user')); // marker bytes never captured anywhere
});

test('capture: empty external skill junction refuses', () => {
  const c = freshCase('capture-empty-external-skills');
  mkUserHome(c); // intentionally leaves .omp/agent/skills absent for the junction
  const external = join(c.dir, 'external-skills'); // outside the home entirely, empty
  mkdirSync(external, { recursive: true });
  linkDir(external, join(c.home, '.omp', 'agent', 'skills'));
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  refused(r, 'skills junction to an empty directory outside home must refuse');
  absent(join(data, 'user'));
});

test('capture: stale subtree junction cycle fails before an earlier changed config is written', () => {
  const c = freshCase('capture-cycle-before-write');
  mkUserHome(c);
  withSkillsDir(c);
  const data = projectsManifest(c, {});
  const captured = join(data, 'user', 'omp', 'agent', 'config.yml');
  writeF(captured, 'model: old-capture\napiKey: $HARBOR_TOKEN\n');
  // the machine config changed since that capture...
  writeF(join(c.home, '.omp', 'agent', 'config.yml'), 'model: glm\napiKey: $HARBOR_TOKEN\nchanged: true\n');
  // ...but a stale junction cycle now sits inside a skill subtree
  const a = join(c.home, '.agents', 'skills');
  linkDir(a, join(a, 'loop'));
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  refused(r, 'stale subtree junction cycle must fail the capture');
  assert.strictEqual(text(captured), 'model: old-capture\napiKey: $HARBOR_TOKEN\n',
    'earlier captured config must stay byte-identical when the capture refuses');
  assert(!/changed: true/.test(text(captured)), 'changed config was written despite the refusal');
});

test('capture: inert scalars stay inert, quoted or string-typed variants refuse', () => {
  // YAML: unquoted null/true/~, empty-with-comment, and numeric maxTokens are inert; JSON typed values too
  const c = freshCase('capture-inert-ok');
  mkUserHome(c, {
    config: 'apiKey: # note\npassword: null\nauthorization: ~\nsecret: true\nmaxTokens: 4096\n',
    mcp: '{"server":{"secret":null,"token":true,"maxTokens":4096}}\n',
  });
  withSkillsDir(c);
  const data = projectsManifest(c, {});
  let r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(text(join(data, 'user/omp/agent/config.yml')).includes('secret: true'), 'inert values must capture as-is');
  // Quoted inert spellings and Bearer null are literal credentials, not inert scalars.
  const yamlRefusals = [
    ['quoted-null', 'password: "null"'],
    ['quoted-true', "secret: 'true'"],
    ['bearer-null', 'Authorization: Bearer null'],
  ];
  for (const [name, line] of yamlRefusals) {
    const bad = freshCase(`capture-inert-${name}`);
    mkUserHome(bad, { config: `apiKey: $HARBOR_TOKEN\n${line}\n` });
    withSkillsDir(bad);
    const badData = projectsManifest(bad, {});
    r = runCli(bad, 'sync-user.mjs', ['--home', bad.home, '--data', badData]);
    refused(r, `YAML ${name} must refuse`);
    const out = r.stdout + r.stderr;
    assert(!/\b(null|true|Bearer)\b/.test(out), `YAML ${name}: literal value leaked into output:\n${out}`);
    absent(join(badData, 'user'));
  }
  // JSON string credentials, nested values, and malformed JSON must refuse.
  for (const [name, mcp] of [
    ['json-string-true', '{"server":{"secret":"true"}}\n'],
    ['json-bearer-null', '{"authorization":"Bearer null"}\n'],
    ['json-nested', '{"secret":{"inner":1}}\n'],
    ['json-invalid', '{"server":\n'],
  ]) {
    const bad = freshCase(`capture-inert-${name}`);
    mkUserHome(bad, { mcp });
    withSkillsDir(bad);
    const badData = projectsManifest(bad, {});
    r = runCli(bad, 'sync-user.mjs', ['--home', bad.home, '--data', badData]);
    refused(r, `JSON ${name} must refuse`);
    const out = r.stdout + r.stderr;
    assert(!/Bearer/.test(out), `JSON ${name}: literal value leaked into output:\n${out}`);
    absent(join(badData, 'user'));
  }
});

test('capture: stale link under data/user refuses before any write', () => {
  const c = freshCase('capture-stale-output');
  mkUserHome(withSkillsDir(c));
  const data = projectsManifest(c, {});
  const captured = join(data, 'user', 'omp', 'agent', 'config.yml');
  writeF(captured, 'model: old-capture\napiKey: $HARBOR_TOKEN\n');
  // a write WOULD happen (config changed), but a stale link sits anywhere under data/user
  writeF(join(c.home, '.omp', 'agent', 'config.yml'), 'model: glm\napiKey: $HARBOR_TOKEN\nchanged: true\n');
  const external = join(c.dir, 'elsewhere');
  mkdirSync(external, { recursive: true });
  linkDir(external, join(data, 'user', 'stale-link'));
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  refused(r, 'stale link under data/user must refuse before any write');
  assert.strictEqual(text(captured), 'model: old-capture\napiKey: $HARBOR_TOKEN\n',
    'prior snapshot must stay byte-identical');
  assert(!/changed: true/.test(text(captured)), 'changed config was written despite the refusal');
});

test('capture: dangling skill link refuses without snapshot writes', () => {
  const c = freshCase('capture-dangling-link');
  mkUserHome(c);
  withSkillsDir(c);
  linkDir(join(c.home, '.omp', 'missing-target'), join(c.home, '.omp', 'agent', 'skills', 'dangling'));
  const data = projectsManifest(c, {});
  const r = runCli(c, 'sync-user.mjs', ['--home', c.home, '--data', data]);
  refused(r, 'dangling skill link must refuse');
  absent(join(data, 'user'));
});

// -- user restore (install-user.mjs) --

const installFixture = c => {
  const home = join(c.dir, 'home-restore');
  mkdirSync(home, { recursive: true });
  writeF(join(c.dir, 'data', 'user', 'omp', 'agent', 'config.yml'), 'captured-value\n');
  writeF(join(c.dir, 'data', 'user', 'omp', 'agent', 'other.json'), '{}\n');
  return { home, data: join(c.dir, 'data'), cfg: join(home, '.omp', 'agent', 'config.yml'),
    args: ['--data', join(c.dir, 'data'), '--home', home, '--skip-plugins'] };
};

test('restore: fresh home installs exact bytes, idempotent, CRLF-equal stays, --skip-plugins works', () => {
  const c = freshCase('restore-valid');
  const { home, data, cfg, args } = installFixture(c);
  let r = runCli(c, 'install-user.mjs', args);
  assert.strictEqual(r.status, 0, r.stderr);
  sameBytes(join(data, 'user/omp/agent/config.yml'), cfg, 'restored bytes');
  r = runCli(c, 'install-user.mjs', args);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* installed/.test(r.stdout), `not idempotent: ${r.stdout}`);
  writeF(cfg, 'captured-value\r\n');
  r = runCli(c, 'install-user.mjs', args);
  assert.strictEqual(r.status, 0, r.stderr);
  assert(!/[1-9]\d* installed/.test(r.stdout), `CRLF churned: ${r.stdout}`);
  assert.strictEqual(text(cfg), 'captured-value\r\n', 'CRLF bytes rewritten');
});

test('restore: conflicting file refuses without --force, machine bytes intact', () => {
  const c = freshCase('restore-conflict');
  const { cfg, args } = installFixture(c);
  writeF(cfg, 'machine-value\n');
  refused(runCli(c, 'install-user.mjs', args), 'conflict must refuse without --force');
  assert.strictEqual(text(cfg), 'machine-value\n', 'machine file was touched');
});

test('restore: --force deliberately refreshes a conflicting file', () => {
  const c = freshCase('restore-force');
  const { cfg, args } = installFixture(c);
  writeF(cfg, 'machine-value\n');
  const r = runCli(c, 'install-user.mjs', ['--force', ...args]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(text(cfg), 'captured-value\n', '--force did not refresh');
});

test('restore: hardlinked destination refuses with and without --force, sentinel intact', () => {
  const c = freshCase('restore-hardlink');
  const { cfg, args } = installFixture(c);
  writeF(cfg, 'machine-value\n');
  const sentinel = join(c.out, 'sentinel.txt');
  linkSync(cfg, sentinel);
  refused(runCli(c, 'install-user.mjs', args), 'hardlinked destination must refuse');
  refused(runCli(c, 'install-user.mjs', ['--force', ...args]), 'hardlinked destination must refuse even with --force');
  assert.strictEqual(text(sentinel), 'machine-value\n', 'hardlink alias was overwritten');
});

test('restore: home .omp junction escaping home refuses, outside untouched', () => {
  const c = freshCase('restore-junction');
  const { home, args } = installFixture(c);
  const outside = join(c.out, 'homeoutside');
  mkdirSync(outside, { recursive: true });
  linkDir(outside, join(home, '.omp'));
  refused(runCli(c, 'install-user.mjs', args), 'destination junction outside home must refuse');
  absent(join(outside, 'agent'));
});

test('restore: user/ source junction outside the data dir refuses, outside untouched', () => {
  const c = freshCase('restore-src-junction');
  const home = join(c.dir, 'home-restore');
  mkdirSync(home, { recursive: true });
  const outside = join(c.out, 'useroutside');
  writeF(join(outside, 'omp', 'agent', 'config.yml'), 'outside-capture\n');
  mkdirSync(join(c.dir, 'data'), { recursive: true });
  linkDir(outside, join(c.dir, 'data', 'user'));
  const r = runCli(c, 'install-user.mjs', ['--data', join(c.dir, 'data'), '--home', home, '--skip-plugins']);
  refused(r, 'capture source junction escaping the data dir must refuse');
  absent(join(home, '.omp'));
  assert.strictEqual(text(join(outside, 'omp', 'agent', 'config.yml')), 'outside-capture\n', 'outside source modified');
});

test('restore: directory at destination refuses, nothing else installed', () => {
  const c = freshCase('restore-dest-dir');
  const { home, args } = installFixture(c);
  mkdirSync(join(home, '.omp', 'agent', 'config.yml'), { recursive: true });
  refused(runCli(c, 'install-user.mjs', args), 'directory at destination must refuse');
  absent(join(home, '.omp', 'agent', 'other.json')); // preflight: no partial restore
});

// ---- harness --------------------------------------------------------------

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${String(err.message).split('\n').join('\n     ')}`);
  }
}
console.log(failed ? `\n${failed} of ${cases.length} cases FAILED` : `\nall ${cases.length} cases passed`);
process.exitCode = failed ? 1 : 0;
