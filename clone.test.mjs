// Self-check for lib/data.mjs --repo cloning: node clone.test.mjs
// Hermetic: fixture git repos live in a temp dir; no network is touched.
// Covers: unambiguous spec parsing (path with '@', ref containing '@'),
// credential-free argv/env, redaction of raw/encoded/base64 credentials,
// and failure cleanup without data loss.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDestination, cleanupData, cloneCommand, forAll, keepTemp, parseDataSpec, redactSecrets, resolveDataDir } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-clone-'));
const TOKEN = 'ghp_abc123/+=XYZ'; // fake: '/' '+' '=' stress the encoded/base64 shapes
const encoded = encodeURIComponent(TOKEN);
const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const git = args => spawnSync('git', args, { encoding: 'utf8' });
const initRepo = (dir, marker) => {
  mkdirSync(dir, { recursive: true });
  assert.equal(git(['init', '-q', '-b', 'main', dir]).status, 0);
  git(['-C', dir, 'config', 'user.name', 't']);
  git(['-C', dir, 'config', 'user.email', 't@t']);
  writeFileSync(join(dir, 'marker.txt'), marker);
  git(['-C', dir, 'add', '-A']);
  assert.equal(git(['-C', dir, 'commit', '-qm', 'fixture']).status, 0);
};
const marker = (dir, name = 'marker.txt') => readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n');
const scanForToken = root => {
  const hits = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else for (const [label, shape] of [['raw', TOKEN], ['encoded', encoded], ['basic', basic]]) {
        if (readFileSync(p).includes(shape)) hits.push(`${label} in ${p}`);
      }
    }
  })(root);
  return hits;
};

try {
  // Fixtures: default branch, a branch whose name contains '@', and a path with '@'.
  const repo = join(tmp, 'repo');
  initRepo(repo, 'main\n');
  assert.equal(git(['-C', repo, 'checkout', '-qb', 'feature@draft']).status, 0);
  writeFileSync(join(repo, 'marker.txt'), 'draft\n');
  git(['-C', repo, 'commit', '-qam', 'draft']);
  git(['-C', repo, 'checkout', '-q', 'main']);
  const odd = join(tmp, 'odd@name');
  initRepo(odd, 'odd\n');
  const plain = join(tmp, 'plain'); // exists but not a repo -> clone must fail
  mkdirSync(plain);

  // --- parseDataSpec: existing path wins whole; ref is the entire first-@ suffix.
  assert.deepEqual(parseDataSpec('owner/repo'), { name: 'owner/repo', ref: '' });
  assert.deepEqual(parseDataSpec('owner/repo@feature@draft'), { name: 'owner/repo', ref: 'feature@draft' });
  assert.deepEqual(parseDataSpec('owner/repo@v1.2'), { name: 'owner/repo', ref: 'v1.2' });
  assert.deepEqual(parseDataSpec('owner/repo@'), { name: 'owner/repo', ref: '' });
  assert.deepEqual(parseDataSpec(odd), { name: odd, ref: '' }, 'existing path with @ stays whole');
  assert.equal(parseDataSpec('no-slash-here'), null);
  assert.equal(parseDataSpec('bad@name'), null);
  for (const url of ['https://github.com/owner/repo', 'https://github.com/owner/repo.git/']) {
    assert.deepEqual(parseDataSpec(url), { name: 'owner/repo', ref: '' });
  }
  assert.deepEqual(parseDataSpec('https://github.com/owner/repo.git@feature@draft'), { name: 'owner/repo', ref: 'feature@draft' });
  for (const spec of ['https://github.com.evil/owner/repo', 'https://user:password@github.com/owner/repo', 'https://github.com/../repo', 'https://github.com/owner/..', '-owner/repo']) {
    assert.equal(parseDataSpec(spec), null);
  }

  // --- redactSecrets: raw, URL-encoded and base64 credential shapes.
  assert.equal(redactSecrets('x ghp_abc123/+=XYZ y', TOKEN), 'x *** y');
  assert.equal(redactSecrets(`u:${encoded}@host`, TOKEN), 'u:***@host');
  assert.equal(redactSecrets(`AUTHORIZATION: basic ${basic}`, TOKEN), 'AUTHORIZATION: basic ***');
  assert.equal(redactSecrets(`basic ${basic} enc ${encoded} raw ${TOKEN}`, TOKEN), 'basic *** enc *** raw ***');
  assert.equal(redactSecrets('unchanged', ''), 'unchanged');

  // --- cloneCommand: token never reaches argv; auth rides in per-process env config.
  const dir = join(tmp, 'dst');
  let cmd = cloneCommand('https://github.com/owner/repo', 'feature@draft', TOKEN, dir);
  assert.deepEqual(cmd.args, ['clone', '--quiet', '--depth', '1', '--branch', 'feature@draft', 'https://github.com/owner/repo', dir]);
  assert.equal(cmd.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(cmd.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${basic}`);
  assert.equal(cmd.env.GIT_TERMINAL_PROMPT, '0');
  for (const shape of [TOKEN, encoded, basic]) assert.ok(!cmd.args.join(' ').includes(shape), 'token shape in argv');
  cmd = cloneCommand('https://github.com/owner/repo', '', undefined, dir);
  assert.ok(!('GIT_CONFIG_COUNT' in cmd.env), 'no auth config without a token');
  cmd = cloneCommand(odd, '', TOKEN, dir);
  assert.ok(!('GIT_CONFIG_COUNT' in cmd.env), 'local path needs no auth config');

  // --- Integration: ref containing '@' clones for real; then a whole path containing '@'.
  const refDst = join(tmp, 'dst-ref');
  cmd = cloneCommand(repo, 'feature@draft', TOKEN, refDst);
  const real = spawnSync('git', cmd.args, { encoding: 'utf8', env: cmd.env });
  assert.equal(real.status, 0, real.stderr);
  assert.equal(marker(refDst), 'draft\n', 'branch feature@draft checked out');
  assert.deepEqual(scanForToken(refDst), [], 'token leaked into clone');

  let data = resolveDataDir({ values: { '--repo': odd }, flags: new Set() }, { allowClone: true });
  assert.equal(marker(data.dir), 'odd\n');
  const url = git(['-C', data.dir, 'config', '--get', 'remote.origin.url']).stdout.trim();
  assert.equal(url, odd, 'remote URL is the plain path, credentials never included');
  assert.deepEqual(scanForToken(data.dir), [], 'token leaked into clone or .git/config');
  cleanupData(data);
  if (!keepTemp()) assert.ok(!existsSync(data.dir), 'cleanupData removes the temp clone');

  // --- Failure paths via the real CLI: unusable spec, and failed clone with token set.
  const scriptDir = join(tmp, 'tool');
  mkdirSync(join(scriptDir, 'lib'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./sync.mjs', import.meta.url)), join(scriptDir, 'sync.mjs'));
  copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(scriptDir, 'lib', 'data.mjs'));
  const runSync = (repoSpec, env = {}) => spawnSync(process.execPath, [join(scriptDir, 'sync.mjs'), join(tmp, 'target'), '--repo', repoSpec], { encoding: 'utf8', env: { ...process.env, ...env } });

  let r = runSync('no-slash-here');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--repo must be <owner\/name\[@ref\]> or an existing path/);

  const tempBefore = readdirSync(tmpdir()).filter(n => n.startsWith('alate-data-'));
  r = runSync(plain, { GH_TOKEN: TOKEN });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git clone failed for .+plain\b/);
  for (const shape of [TOKEN, encoded, basic]) assert.ok(!r.stderr.includes(shape), 'token shape in clone error');
  const leftover = readdirSync(tmpdir()).filter(n => n.startsWith('alate-data-') && !tempBefore.includes(n));
  assert.deepEqual(leftover, [], 'failed clone leaves no temp dir behind');

  // Property checks (fuzz tier via forAll in lib/data.mjs). Gate: 200 runs, fixed seed
  // 42; PROP_RUNS=<n> re-seeds randomly for the review deep tier.
  {
    const ident = (rand, size) => {
      const head = 'abcdefgh0123456789';
      let s = head[Math.floor(rand() * head.length)];
      for (let i = 0, n = Math.floor(rand() * (size + 2)); i < n; i++) s += (head + '-._')[Math.floor(rand() * 19)];
      return s;
    };

    // checkDestination: acceptance implies the destination resolves inside the root, and
    // every refusal names one of its documented reasons. NUL stays out of scope: names
    // below a root come from the OS (readdir), which cannot produce one.
    const destRoot = join(tmp, 'prop-dest');
    mkdirSync(join(destRoot, 'sub'), { recursive: true });
    writeFileSync(join(destRoot, 'file.txt'), 'x');
    const REFUSES = /outside|symbolic link below|is not a directory|is not a regular file|hard links/;
    const PIECES = ['file.txt', 'sub', 'new.txt', 'dir2', '..', '.', '', 'x y'];
    forAll((rand, size) => {
      let s = rand() < 0.15 ? join(tmpdir(), 'elsewhere') : rand() < 0.1 ? '/' : '';
      for (let i = 0, n = 1 + Math.floor(rand() * (size + 1)); i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)] + (rand() < 0.85 ? '/' : '');
      return s;
    }, dest => {
      let ok = false;
      try { checkDestination(destRoot, dest); ok = true; }
      catch (e) { assert.match(e.message, REFUSES, `documented refusal for ${JSON.stringify(dest)}`); }
      if (ok) {
        const r = resolve(destRoot);
        assert.ok(resolve(destRoot, dest) === r || resolve(destRoot, dest).startsWith(r + sep), `accepted destination stays inside the root: ${JSON.stringify(dest)}`);
      }
    });

    // parseDataSpec: never throws, whatever the string.
    forAll((rand, size) => {
      const junk = ['', '@', '@@', 'abc@', '/abs/path', './own/nm', 'own//nm', '-own/nm', 'own/..', 'https://github.com/own/nm.git/', `${ident(rand, 3)}@${ident(rand, 3)}@${ident(rand, 3)}`];
      return junk[Math.floor(rand() * junk.length)];
    }, spec => { parseDataSpec(spec); });

    // parseDataSpec: canonical owner/name[@ref] specs parse exactly once and round trip.
    forAll(rand => {
      const spec = `${ident(rand, 5)}/${ident(rand, 5)}`;
      return rand() < 0.5 ? spec : `${spec}@${ident(rand, 5)}`;
    }, spec => {
      const p = parseDataSpec(spec);
      assert.deepEqual(p, { name: spec.split('@')[0], ref: spec.includes('@') ? spec.slice(spec.indexOf('@') + 1) : '' }, `canonical parse: ${spec}`);
      assert.deepEqual(parseDataSpec(p.ref ? `${p.name}@${p.ref}` : p.name), p, `round trip: ${spec}`);
    });
    // An existing local path wins whole, including one that contains '@'.
    writeFileSync(join(tmp, 'at@path'), 'x');
    assert.deepEqual(parseDataSpec(join(tmp, 'at@path')), { name: join(tmp, 'at@path'), ref: '' }, 'a local path containing @ wins whole');
  }

  console.log('clone.test.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
