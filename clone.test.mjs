// Self-check for lib/data.mjs --repo cloning: node clone.test.mjs
// Hermetic: fixture git repos live in a temp dir; no network is touched.
// Covers: unambiguous spec parsing (path with '@', ref containing '@'),
// credential-free argv/env, redaction of raw/encoded/base64 credentials,
// and failure cleanup without data loss.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceInside, checkDestination, cleanupData, cloneCommand, descriptionText, forAll, keepTemp, parseDataSpec, redactSecrets, resolveDataDir, ruleProblems } from './lib/data.mjs';

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
  assert.deepEqual(cmd.args, ['clone', '--quiet', '--depth', '1', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', '--branch', 'feature@draft', 'https://github.com/owner/repo', dir]);
  assert.equal(cmd.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(cmd.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${basic}`);
  assert.equal(cmd.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(cmd.env.GIT_CONFIG_COUNT, '1', 'exactly one injected config entry');
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

  // --- A host-wide core.autocrlf=true (Windows default) must not turn the clone's LF into CRLF.
  const crlfConfig = join(tmp, 'crlf.gitconfig');
  writeFileSync(crlfConfig, '[core]\n\tautocrlf = true\n\teol = crlf\n');
  const lfDst = join(tmp, 'dst-lf');
  cmd = cloneCommand(repo, '', undefined, lfDst);
  const lf = spawnSync('git', cmd.args, { encoding: 'utf8', env: { ...cmd.env, GIT_CONFIG_GLOBAL: crlfConfig } });
  assert.equal(lf.status, 0, lf.stderr);
  assert.equal(readFileSync(join(lfDst, 'marker.txt'), 'latin1'), 'main\n', 'clone keeps LF under autocrlf=true');

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
  // The child's HOME is a scratch dir distinct from the target: a dropped positional or
  // default (a Stryker mutant) writes into the sandbox, never the machine home.
  const childHome = join(tmp, 'child-home');
  mkdirSync(childHome, { recursive: true });
  const runSync = (repoSpec, env = {}) => {
    const child = { ...process.env, ...env, HOME: childHome, USERPROFILE: childHome, ALATE_DATA: join(tmp, 'no-aldata') };
    delete child.PI_CODING_AGENT_DIR; // sync.mjs prefers it over HOME; an inherited value could be a real agent dir
    return spawnSync(process.execPath, [join(scriptDir, 'sync.mjs'), join(tmp, 'target'), '--repo', repoSpec], { encoding: 'utf8', env: child });
  };

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

  // A spec that parses as owner/name[@ref] is cloned from the github URL template, and
  // the failure message carries git's own stderr through redactSecrets. A stub git makes
  // the failure deterministic without a network.
  if (process.platform !== 'win32') {
    const stubDir = join(tmp, 'git-stub');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, 'git'), '#!/bin/sh\necho "fatal: stub clone failure: $*" >&2\nexit 128\n');
    chmodSync(join(stubDir, 'git'), 0o755);
    r = runSync('no-such-owner/no-such-repo@v9', { PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /git clone failed for no-such-owner\/no-such-repo@v9:\nfatal: stub clone failure: clone .* https:\/\/github\.com\/no-such-owner\/no-such-repo/);
  }

  // --- checkDestination: every documented refusal, by its exact message.
  const gateRoot = join(tmp, 'gate-root');
  mkdirSync(join(gateRoot, 'dir'), { recursive: true });
  writeFileSync(join(gateRoot, 'file.txt'), 'x');
  const refusesDest = (dest, message) => assert.throws(() => checkDestination(gateRoot, dest), e => e.message === message, message);
  assert.doesNotThrow(() => checkDestination(gateRoot, join(gateRoot, 'dir', 'new.txt')), 'a fresh nested path is fine');
  assert.doesNotThrow(() => checkDestination(gateRoot, join(gateRoot, 'file.txt')), 'an existing single-link file is fine');
  refusesDest(gateRoot, `Destination ${gateRoot} is outside ${gateRoot}`);
  refusesDest(join(gateRoot, '..'), `Destination ${join(gateRoot, '..')} is outside ${gateRoot}`);
  refusesDest(join(tmp, 'elsewhere.txt'), `Destination ${join(tmp, 'elsewhere.txt')} is outside ${gateRoot}`);
  if (process.platform !== 'win32') {
    const outsideDir = join(tmp, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(gateRoot, 'link'), 'dir');
    refusesDest(join(gateRoot, 'link', 'f.txt'), `${join(gateRoot, 'link')} is a symbolic link below the chosen root ${gateRoot}`);
  }
  refusesDest(join(gateRoot, 'file.txt', 'sub', 'x.txt'), `${join(gateRoot, 'file.txt')} is not a directory`);
  refusesDest(join(gateRoot, 'dir'), `${join(gateRoot, 'dir')} exists and is not a regular file`);
  writeFileSync(join(gateRoot, 'one.txt'), 'x');
  linkSync(join(gateRoot, 'one.txt'), join(gateRoot, 'two.txt'));
  refusesDest(join(gateRoot, 'two.txt'), `${join(gateRoot, 'two.txt')} has 2 hard links; refusing to write it`);

  // --- assertSourceInside: realpath-based guard, the root itself allowed.
  const srcRoot = join(tmp, 'src-root');
  mkdirSync(srcRoot, { recursive: true });
  writeFileSync(join(srcRoot, 'f.txt'), 'x');
  const outsideFile = join(tmp, 'outside.txt');
  writeFileSync(outsideFile, 'x');
  assert.doesNotThrow(() => assertSourceInside(srcRoot, srcRoot), 'the root itself is allowed');
  assert.doesNotThrow(() => assertSourceInside(srcRoot, join(srcRoot, 'f.txt')), 'a file inside is allowed');
  const refusesSrc = (path, message) => assert.throws(() => assertSourceInside(srcRoot, path), e => e.message === message, message);
  refusesSrc(outsideFile, `Source ${outsideFile} is outside ${srcRoot}`);
  refusesSrc(join(srcRoot, '..'), `Source ${join(srcRoot, '..')} is outside ${srcRoot}`);

  // --- parseDataSpec: dot segments and extra segments are refused.
  assert.equal(parseDataSpec('x/.'), null, 'a single-dot segment is refused');
  assert.equal(parseDataSpec('x/..'), null, 'a parent segment is refused');
  assert.equal(parseDataSpec('owner/repo/extra'), null, 'a third path segment is refused');

  // --- descriptionText: the YAML-free description reader the frontmatter gate relies on.
  assert.equal(descriptionText('title: x'), null, 'no description key');
  assert.equal(descriptionText('mydescription: hi'), null, 'only a line-start description key counts');
  assert.equal(descriptionText('description:x'), 'x', 'the value needs no space');
  assert.equal(descriptionText('description: plain # trailing'), 'plain', 'a comment needs whitespace before #');
  assert.equal(descriptionText('description: C# tips'), 'C# tips', 'no whitespace before # keeps the value');
  assert.equal(descriptionText('description: x#y'), 'x#y');
  assert.equal(descriptionText('description:   # only a comment'), null, 'a comment-only value is blank');
  assert.equal(descriptionText('description: "dq # kept"'), 'dq # kept', 'a quoted value keeps its #');
  assert.equal(descriptionText('description: " x "'), 'x', 'a quoted value is trimmed');
  assert.equal(descriptionText('description: "a\\b"'), 'ab', 'double-quote escapes are unwrapped');
  assert.equal(descriptionText('description: "x" # c'), 'x', 'a comment after a quote goes');
  assert.equal(descriptionText('description: "x" junk'), '"x" junk', 'an unterminated quote stays raw text');
  assert.equal(descriptionText('description: "ab"'), 'ab');
  assert.equal(descriptionText("description: 'sq'"), 'sq');
  assert.equal(descriptionText("description: 'it''s fine'"), "it's fine", "'' escapes a quote");
  assert.equal(descriptionText("description: 'sq' # c"), 'sq', 'a comment after a single quote goes');
  assert.equal(descriptionText("description: junk 'x'"), "junk 'x'", 'an unterminated single quote stays raw text');
  assert.equal(descriptionText("description: 'sq' junk"), "'sq' junk", 'a single quote must close before the value ends');
  assert.equal(descriptionText('description: a|'), 'a|', 'a mid-value pipe is plain text');
  assert.equal(descriptionText('description: |x'), '|x', 'a block indicator must end the value');
  assert.equal(descriptionText('description: x'), 'x', 'a plain word is no block');
  assert.equal(descriptionText('description: |'), null, 'an empty block is no description');
  assert.equal(descriptionText('description: |   '), null, 'trailing spaces keep the block indicator');
  assert.equal(descriptionText('description: |-'), null);
  assert.equal(descriptionText('description: >'), null);
  assert.equal(descriptionText('description: |\n  a\n  b'), 'a b', 'block lines join with spaces');
  assert.equal(descriptionText('description: |\n  a\n\n  b'), 'a b', 'blank block lines vanish');
  assert.equal(descriptionText('description: |\n  a\nnext: 1'), 'a', 'a dedented line ends the block');
  assert.equal(descriptionText('description: >\n  wrapped\n  text'), 'wrapped text');
  assert.equal(descriptionText('title: t\ndescription: |\n  a\n  b'), 'a b', 'block lines collect only after the description line, not from the frontmatter start');
  assert.equal(descriptionText('description: |\n   \n   '), null, 'whitespace-only block lines are blank');
  assert.equal(descriptionText('description: "x"  # c'), 'x', 'a comment may follow any whitespace run after the quote');

  // --- ruleProblems: hidden characters plus the frontmatter gate.
  assert.deepEqual(ruleProblems('r.md', 'no frontmatter here\n'), ['r.md: needs frontmatter with a description']);
  assert.deepEqual(ruleProblems('r.md', 'intro\n---\ndescription: x\n---\nbody\n'), ['r.md: needs frontmatter with a description'], 'frontmatter must open the file');
  assert.deepEqual(ruleProblems('r.md', '---\r\ndescription: CRLF\r\n---\nbody\n'), [], 'CRLF frontmatter is accepted');
  assert.deepEqual(ruleProblems('r.md', '---\n\n---\ndescription: real\n---\nbody\n'), ['r.md: needs frontmatter with a description'], 'the first frontmatter block decides');
  assert.deepEqual(ruleProblems('r.md', '---\ndescription: ok\n---\ntext \u0007 bell\n'), ['r.md:4:6: hidden character U+0007']);
  assert.deepEqual(ruleProblems('ctx.md', 'text \u200B zwsp\n', { frontmatter: false }), ['ctx.md:1:6: hidden character U+200B'], 'agent-context files scan hidden characters only');
  // Emoji text passes: a text/emoji-style selector (U+FE0E/U+FE0F) right after an emoji or
  // symbol code point, and a ZWJ (U+200D) joining two emoji with a skin-tone modifier
  // between. An upstream skill bump carrying these must not stop every provision.
  assert.deepEqual(
    ruleProblems('r.md', '---\ndescription: ok\n---\n\u26A0\uFE0F \u2733\uFE0E \u{1F469}\u{1F3FD}\u200D\u{1F4BB}\n'),
    [],
    'emoji selector and ZWJ sequences are accepted'
  );
  // Every other hit stays fatal: zero-width space, a bidi override, a selector with no emoji
  // or symbol before it, and a ZWJ outside an emoji run.
  assert.deepEqual(ruleProblems('r.md', '---\ndescription: ok\n---\ntext \u200B here\n'), ['r.md:4:6: hidden character U+200B'], 'zero-width space stays fatal');
  assert.deepEqual(ruleProblems('r.md', '---\ndescription: ok\n---\ntext \u202E here\n'), ['r.md:4:6: hidden character U+202E'], 'a bidi override stays fatal');
  assert.deepEqual(ruleProblems('r.md', '---\ndescription: ok\n---\n\uFE0F leading\n'), ['r.md:4:1: hidden character U+FE0F'], 'a selector with no emoji or symbol before it stays fatal');
  assert.deepEqual(ruleProblems('r.md', '---\ndescription: ok\n---\na\u200Db\n'), ['r.md:4:2: hidden character U+200D'], 'a ZWJ outside an emoji run stays fatal');

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
