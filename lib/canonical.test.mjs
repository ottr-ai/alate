// Self-check for the canonical-form helpers (specs/canonical-form.md):
// node lib/canonical.test.mjs
// Hermetic: every fixture lives in a temp dir; nothing outside it is read or written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRLF_SUFFIXES, canonicalizeBytes, forAll, indexExecPaths, isBinaryBytes, renderForTarget, writeFileInside } from './data.mjs';
import { renderToolsJson, resolveBundlePlan } from './bundles.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-canonical-test-'));
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
/** @param {number} mode The mode a created file lands on under the current umask. */
const modeUnderUmask = mode => mode & ~process.umask();

try {
  // CRLF_SUFFIXES pins the contract the .gitattributes ruleset mirrors
  // (`*.cmd text eol=crlf`, `*.bat text eol=crlf`); keep in sync.
  assert.deepEqual(CRLF_SUFFIXES, ['.cmd', '.bat']);

  // isBinaryBytes: git's heuristic, a NUL byte in the first 8000 bytes.
  assert.equal(isBinaryBytes(bytes('\0')), true, 'NUL at 0 is binary');
  const late = Buffer.alloc(8001, 0x41);
  late[7999] = 0;
  assert.equal(isBinaryBytes(late), true, 'NUL at 7999 is binary');
  const edge = Buffer.alloc(8001, 0x41);
  edge[8000] = 0;
  assert.equal(isBinaryBytes(edge), false, 'NUL at 8000 is past the window');
  assert.equal(isBinaryBytes(bytes('plain text\n')), false);

  // canonicalizeBytes: CRLF -> LF only, a lone CR stays, binary passes through.
  const crlf = canonicalizeBytes('x.txt', bytes('a\r\nb\r\nc'));
  assert.equal(crlf.changed, true);
  assert.ok(crlf.bytes.equals(bytes('a\nb\nc')));
  const lone = canonicalizeBytes('x.txt', bytes('a\nb\rc\n'));
  assert.equal(lone.changed, false);
  assert.ok(lone.bytes.equals(bytes('a\nb\rc\n')), 'a lone CR stays (git parity)');
  const lf = canonicalizeBytes('x.txt', bytes('a\nb\n'));
  assert.equal(lf.changed, false);
  const bin = canonicalizeBytes('x.bin', bytes('bin\0ary\r\ntext'));
  assert.equal(bin.changed, false);
  assert.ok(bin.bytes.equals(bytes('bin\0ary\r\ntext')), 'binary passes through byte for byte');
  const input = bytes('a\r\nb');
  canonicalizeBytes('x.txt', input);
  assert.ok(input.equals(bytes('a\r\nb')), 'canonicalizeBytes never mutates the input');

  // renderForTarget: CRLF for .cmd/.bat (suffix test is case-insensitive), LF for
  // other text, binary passthrough, and a lone CR stays everywhere.
  assert.ok(renderForTarget('x.txt', bytes('a\r\nb\n')).equals(bytes('a\nb\n')));
  assert.ok(renderForTarget('run.cmd', bytes('a\nb\r\n')).equals(bytes('a\r\nb\r\n')));
  assert.ok(renderForTarget('RUN.CMD', bytes('a\nb')).equals(bytes('a\r\nb')), 'a trailing line without LF stays bare');
  assert.ok(renderForTarget('x.BAT', bytes('a\n')).equals(bytes('a\r\n')));
  assert.ok(renderForTarget('x.txt', bytes('a\rb\n')).equals(bytes('a\rb\n')));
  assert.ok(renderForTarget('x.bin', bytes('a\0b\r\n')).equals(bytes('a\0b\r\n')), 'binary renders untouched');
  assert.ok(renderForTarget('x.cmd', bytes('a\rb\n')).equals(bytes('a\rb\r\n')), 'a lone CR stays in a CRLF render');

  // Properties over generated names (built from CRLF_SUFFIXES) and byte strings:
  // the install render is idempotent, and canonicalizing the rendered bytes returns
  // the canonical form of the source — the two directions stay inverse for text.
  forAll((rand, size) => {
    const suffix = CRLF_SUFFIXES[Math.floor(rand() * CRLF_SUFFIXES.length)];
    const names = [`run${suffix}`, `RUN${suffix.toUpperCase()}`, 'x.txt', 'notes.md', `v${size}.json`];
    const pieces = ['a', '\n', '\r\n', '\r', 'b'];
    let text = '';
    const n = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) text += pieces[Math.floor(rand() * pieces.length)];
    return { rel: names[Math.floor(rand() * names.length)], text, binary: rand() < 0.15 };
  }, /** @param {unknown} input */ input => {
    const { rel, text, binary } = /** @type {{ rel: string, text: string, binary: boolean }} */ (input);
    const x = binary ? bytes(`${text}\0`) : bytes(text);
    const once = renderForTarget(rel, x);
    assert.ok(renderForTarget(rel, once).equals(once), `${rel}: the render is idempotent`);
    assert.ok(canonicalizeBytes(rel, once).bytes.equals(canonicalizeBytes(rel, x).bytes),
      `${rel}: canonicalize undoes the render`);
  });

  // indexExecPaths against a real git index: 100755 wins, 100644 does not, a
  // non-work-tree directory returns null.
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'a.sh'), '#!/bin/sh\n');
  writeFileSync(join(repo, 'b.txt'), 'x\n');
  writeFileSync(join(repo, 'sub', 'c.sh'), '#!/bin/sh\n');
  const git = (/** @type {string[]} */ args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['update-index', '--chmod=+x', 'a.sh', 'sub/c.sh']);
  const exec = indexExecPaths(repo);
  assert.ok(exec instanceof Set, 'a work tree yields a Set');
  assert.deepEqual(exec, new Set(['a.sh', 'sub/c.sh']), 'index modes, forward slashes, nested paths');
  mkdirSync(join(tmp, 'plain'));
  assert.equal(indexExecPaths(join(tmp, 'plain')), null, 'a non-work-tree dir yields null');

  // writeFileInside: the mode parameter lands on the created file (under the
  // process umask), the default stays 0644, and the guard order still makes dirs.
  const root = join(tmp, 'home');
  writeFileInside(root, join(root, 'bin', 'tool'), bytes('#!/bin/sh\nexec x\n'), false, null, 0o755);
  assert.equal(statSync(join(root, 'bin', 'tool')).mode & 0o777, modeUnderUmask(0o755), 'index-exec write');
  writeFileInside(root, join(root, 'doc.txt'), bytes('x\n'));
  assert.equal(statSync(join(root, 'doc.txt')).mode & 0o777, modeUnderUmask(0o644), 'default write stays 0644');

  // renderToolsJson: per-OS resolution for one file.
  const tools = bytes(JSON.stringify([
    { name: 'rg', url: { linux: 'https://l/rg', win32: 'https://w/rg.zip' }, bin: 'rg' },
    { name: 'wonly', os: ['win32'], cmd: 'w.exe' },
    { name: 'lnx', os: ['linux'], cmd: 'l' },
    { name: 'plain', args: ['-v'] },
  ]));
  /** @param {Buffer | null} rendered @returns {Record<string, unknown>[]} */
  const parsed = rendered => JSON.parse(/** @type {Buffer} */ (rendered).toString());
  const linux = renderToolsJson(tools, 'linux');
  assert.deepEqual(parsed(linux), [
    { name: 'rg', url: 'https://l/rg', bin: 'rg' },
    { name: 'lnx', cmd: 'l' },
    { name: 'plain', args: ['-v'] },
  ], 'os filter drops for the target, markers resolve, the os field never survives');
  assert.equal(linux?.toString(), `${JSON.stringify(parsed(linux), null, 2)}\n`, 'merged serialization');
  assert.deepEqual(parsed(renderToolsJson(tools, 'win32')), [
    { name: 'rg', url: 'https://w/rg.zip', bin: 'rg' },
    { name: 'wonly', cmd: 'w.exe' },
    { name: 'plain', args: ['-v'] },
  ]);
  assert.equal(renderToolsJson(bytes('[{"name":"wonly","os":["win32"]}]'), 'linux'), null, 'every entry drops -> null');
  // An empty plain object value is not a marker (a marker needs at least one
  // platform key) and stays verbatim.
  assert.deepEqual(parsed(renderToolsJson(bytes('[{"name":"x","cfg":{}}]'), 'linux')), [{ name: 'x', cfg: {} }]);

  // renderToolsJson refusals, each naming the file and the entry.
  throws(() => renderToolsJson(bytes('[{"name":"x","cmd":{"linux":"a","darwin":"b"}}]'), 'win32'),
    'tools.json: entry "x": "cmd" has no value for platform "win32"');
  throws(() => renderToolsJson(bytes('[{"name":"x","cmd":{"linux":"a","sunos":"b"}}]'), 'linux'),
    'tools.json: entry "x": unknown platform "sunos" in "cmd"');
  throws(() => renderToolsJson(bytes('[{"name":"x","os":["sunos"]}]'), 'linux'),
    'tools.json: entry "x": os must be an array of platform names');
  throws(() => renderToolsJson(bytes('[{"name":"x","os":"linux"}]'), 'linux'),
    'tools.json: entry "x": os must be an array of platform names');
  throws(() => renderToolsJson(bytes('{}'), 'linux'), 'tools.json must be a JSON array');
  throws(() => renderToolsJson(bytes('{ not json'), 'linux'), 'tools.json:');
  throws(() => renderToolsJson(bytes('[{"name":""}]'), 'linux'), 'every tools.json entry needs a string name');

  // mergeToolsFiles through resolveBundlePlan: entries resolve per platform before
  // the name dedup, so first wins applies to the resolved entries.
  const planDir = join(tmp, 'plan');
  mkdirSync(join(planDir, 'bundles', 'core'), { recursive: true });
  mkdirSync(join(planDir, 'workers', 'p'), { recursive: true });
  writeFileSync(join(planDir, 'bundles', 'core', 'tools.json'), JSON.stringify([
    { name: 'rg', bin: { linux: 'rg', win32: 'rg.exe' } },
    { name: 'lnx', os: ['linux'], cmd: 'l' },
  ]));
  writeFileSync(join(planDir, 'workers', 'p', 'tools.json'), JSON.stringify([
    { name: 'rg', bin: 'plain-rg' },
    { name: 'own', url: 'u' },
  ]));
  /** @param {string | undefined} platform @returns {Record<string, unknown>[]} */
  const merged = platform => JSON.parse(/** @type {Buffer} */ (resolveBundlePlan({
    dataDir: planDir,
    projects: [{ name: 'p', extras: [], bundles: [] }],
    knownSkills: new Set(),
    knownPlugins: new Set(),
    ...(platform === undefined ? {} : { platform }),
  }).projects[0].workerFiles.get('tools.json')).toString());
  assert.deepEqual(merged('linux'), [
    { name: 'rg', bin: 'rg' },
    { name: 'lnx', cmd: 'l' },
    { name: 'own', url: 'u' },
  ], 'merge order core then own, first wins over the resolved entries');
  assert.deepEqual(merged('win32'), [
    { name: 'rg', bin: 'rg.exe' },
    { name: 'own', url: 'u' },
  ], 'an os-filtered entry drops from a platform it excludes');
  assert.deepEqual(merged(undefined), merged(process.platform), 'platform defaults to process.platform');

  console.log('lib/canonical.test.mjs: all checks passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
