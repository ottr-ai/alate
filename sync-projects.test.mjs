// Self-check for sync-projects.mjs: node sync-projects.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forAll, keepTemp, safeRel } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-projects-'));
const repo = join(tmp, 'repo');
const data = join(tmp, 'data');
const ws = join(tmp, 'ws');
mkdirSync(join(repo, 'lib'), { recursive: true });
mkdirSync(join(data, 'projects'), { recursive: true });
copyFileSync(fileURLToPath(new URL('./sync-projects.mjs', import.meta.url)), join(repo, 'sync-projects.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(repo, 'lib/data.mjs'));
const put = (base, rel, text) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), text); };
const manifest = o => put(data, 'projects/projects.json', JSON.stringify(o, null, 2) + '\n');
// Default root is the parent of the data dir (projects are siblings of the data repo).
const run = root => spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), ...(root ? ['--root', root] : []), '--data', data], { encoding: 'utf8' });
const snap = (name, rel) => readFileSync(join(data, 'projects', name, rel), 'utf8');

try {
  // Fixtures live in tmp = parent of the data dir, exercising the default root.
  put(tmp, 'alpha/AGENTS.md', '# alpha rules v1\n');
  put(tmp, 'alpha/CLAUDE.md', '@AGENTS.md\n');
  put(tmp, 'beta/AGENTS.md', '# beta rules\n');
  put(tmp, 'beta/scripts/tool.mjs', '// helper\n');
  put(tmp, 'gamma/.keep', '');
  manifest({ contextFiles: ['AGENTS.md', 'CLAUDE.md'], projects: { alpha: [], beta: ['scripts/tool.mjs'] } });
  put(data, 'projects/alpha/AGENTS.md', '# alpha rules v0\n'); // stale -> updated
  put(data, 'projects/alpha/OLD.md', '# stale\n'); // gone in project -> note only

  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated\s+projects.alpha.AGENTS\.md/);
  assert.match(r.stdout, /added\s+projects.alpha.CLAUDE\.md/);
  assert.match(r.stdout, /added\s+projects.beta.scripts.tool\.mjs/);
  assert.match(r.stdout, /gone in alpha; delete projects\/alpha\/OLD\.md/);
  assert.equal(snap('alpha', 'AGENTS.md'), '# alpha rules v1\n');
  assert.ok(!existsSync(join(data, 'projects', 'beta', 'CLAUDE.md')), 'context files are sparse per project');
  assert.match(r.stdout, /3 added, 1 updated, 0 unchanged/);

  put(data, 'projects/beta/AGENTS.md', '# beta rules\r\n'); // line-endings only -> not churned
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 added, 0 updated, 4 unchanged/);
  assert.equal(snap('alpha', 'AGENTS.md'), '# alpha rules v1\n');

  // An explicit --root overrides the parent-of-data default.
  manifest({ contextFiles: ['AGENTS.md'], projects: { gamma: [] } });
  put(ws, 'gamma/AGENTS.md', '# gamma rules\n');
  r = run(ws);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snap('gamma', 'AGENTS.md'), '# gamma rules\n');

  // A missing data dir dies before touching anything.
  const missing = spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--root', ws, '--data', join(tmp, 'nope')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No data dir/);

  // --repo without a real data dir is refused: capture runs against a local checkout only.
  const repoOnly = spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--repo', repo, '--root', ws], { encoding: 'utf8' });
  assert.equal(repoOnly.status, 1);
  assert.match(repoOnly.stderr, /--repo needs a git clone/);

  manifest({ contextFiles: ['AGENTS.md'], projects: { alpha: [], ghost: [] } });
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ghost: no directory/);
  assert.match(r.stderr, /Nothing synced/);
  assert.equal(snap('alpha', 'AGENTS.md'), '# alpha rules v1\n', 'a failed check syncs nothing');

  manifest({ contextFiles: ['AGENTS.md'], projects: { alpha: ['nope.md'] } });
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /alpha: listed extra nope\.md is missing/);
  assert.equal(snap('alpha', 'AGENTS.md'), '# alpha rules v1\n', 'a failed check syncs nothing');

  // Deselection wins: paths dropped from the manifest stop refreshing; snapshots stay intact.
  put(tmp, 'beta/scripts/tool.mjs', '// helper v2\n'); // source churns while deselected
  put(data, 'projects/alpha/CLAUDE.md', '# hand-edited\n'); // deselected context file churns in the snapshot
  manifest({ contextFiles: ['AGENTS.md'], projects: { alpha: [], beta: [] } });
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snap('beta', 'scripts/tool.mjs'), '// helper\n', 'a deselected extra keeps its last captured bytes');
  assert.equal(snap('alpha', 'CLAUDE.md'), '# hand-edited\n', 'a deselected context file keeps its bytes');
  assert.match(r.stdout, /0 added, 0 updated, 2 unchanged/);

  manifest({ contextFiles: ['AGENTS.md'], projects: { alpha: [], beta: ['scripts/tool.mjs'] } });
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snap('beta', 'scripts/tool.mjs'), '// helper v2\n', 're-listing an extra resumes refreshing it');

  // safeRel pins: separator normalization, and every refusal with its exact label prefix.
  assert.equal(safeRel('a\\b.txt', 'L'), 'a/b.txt', 'backslashes normalize to /');
  assert.equal(safeRel('a b:c/d.txt', 'L'), 'a b:c/d.txt', 'a drive-like pair past the start is plain text');
  assert.throws(() => safeRel('', 'L'), e => e.message === 'L: empty path', 'empty paths are refused');
  assert.throws(() => safeRel('C:\\x', 'L'), e => e.message === 'L: absolute path C:\\x', 'drive paths are refused');
  assert.throws(() => safeRel('a//', 'L'), e => e.message === 'L: invalid segment in a//', 'a trailing double slash is a segment problem, not an absolute path');
  assert.throws(() => safeRel('a/./b', 'L'), e => e.message === 'L: invalid segment in a/./b', 'dot segments are refused');

  // Property check (fuzz tier via forAll in lib/data.mjs): safeRel accepts exactly the
  // relative manifest paths, keeps every accepted result inside the root, and is
  // idempotent; every refusal names one of its three documented reasons.
  // Gate: 200 runs, fixed seed 42; PROP_RUNS=<n> re-seeds randomly for the review deep tier.
  {
    const SEGS = ['a', 'bb.txt', 'Dir', 'x y', '..', '.', '', "q'z"];
    const rawPath = (rand, size) => {
      const seg = () => SEGS[Math.floor(rand() * SEGS.length)];
      const sepCh = () => (rand() < 0.7 ? '/' : '\\');
      let s = rand() < 0.2 ? '/' : rand() < 0.1 ? 'C:\\' : rand() < 0.1 ? 'C:/' : rand() < 0.05 ? '//' : '';
      for (let i = 0, n = 1 + Math.floor(rand() * (size + 1)); i < n; i++) s += seg() + (rand() < 0.85 ? sepCh() : '');
      return s;
    };
    const root = resolve('/data-root');
    forAll(rand => rawPath(rand, 4), raw => {
      let out;
      try { out = safeRel(raw, 'projects.json: fuzz'); }
      catch (e) {
        assert.match(e.message, /^projects\.json: fuzz: (empty path|absolute path|invalid segment)/, `documented refusal for ${JSON.stringify(raw)}`);
        return;
      }
      assert.ok(!isAbsolute(out) && !/^[a-zA-Z]:/.test(out) && !out.startsWith('//'), `accepted path stays relative: ${JSON.stringify(raw)} -> ${out}`);
      assert.ok(out.split('/').every(p => p !== '' && p !== '.' && p !== '..'), `accepted path has no escape segments: ${JSON.stringify(raw)} -> ${out}`);
      assert.ok(resolve(root, out).startsWith(root + sep), `accepted path stays inside the root: ${out}`);
      assert.equal(safeRel(out, 'again'), out, `idempotent: ${JSON.stringify(raw)} -> ${out}`);
    });
  }

  // --- manifest validation and snapshot-walk exactness on a second data dir ---
  const data2 = join(tmp, 'data2');
  mkdirSync(join(data2, 'projects'), { recursive: true });
  const ws2 = join(tmp, 'ws2');
  mkdirSync(ws2, { recursive: true });
  const run2 = () => spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--root', ws2, '--data', data2], { encoding: 'utf8' });
  const bad2 = (raw, msg) => {
    writeFileSync(join(data2, 'projects/projects.json'), raw);
    const r = run2();
    assert.equal(r.status, 1);
    // bad() throws, so stderr carries a node stack; pin the exact error line inside it.
    assert.match(r.stderr, new RegExp(`^Error: projects\\.json: ${msg.replace(/[^A-Za-z0-9 ._-]/g, ch => '\\' + ch)}$`, 'm'));
  };

  // Every manifest-shape guard with its exact message: non-object, null and array manifests,
  // non-string contextFiles entries, array and null projects, and the safeRel label prefixes.
  bad2('"nope"', 'manifest must be an object');
  bad2('null', 'manifest must be an object');
  bad2('[]', 'manifest must be an object');
  bad2('5', 'projects must be an object'.replace('projects', 'manifest'));
  bad2(JSON.stringify({ contextFiles: ['AGENTS.md', 5], projects: {} }), 'contextFiles must be an array of strings');
  bad2(JSON.stringify({ contextFiles: 'AGENTS.md', projects: {} }), 'contextFiles must be an array of strings');
  bad2(JSON.stringify({ contextFiles: ['/etc'], projects: {} }), 'contextFiles: absolute path /etc');
  bad2(JSON.stringify({ contextFiles: [], projects: [] }), 'projects must be an object');
  bad2(JSON.stringify({ contextFiles: [], projects: 'x' }), 'projects must be an object');
  bad2(JSON.stringify({ contextFiles: [], projects: null }), 'projects must be an object');
  bad2(JSON.stringify({ contextFiles: [], projects: { 'C:\\x': [] } }), 'project name: absolute path C:\\x');
  bad2(JSON.stringify({ contextFiles: [], projects: { 'a/b': [] } }), 'project name a/b must be one directory segment');
  bad2(JSON.stringify({ contextFiles: [], projects: { pa: [5] } }), 'pa: extras must be an array of strings');
  bad2(JSON.stringify({ contextFiles: [], projects: { pa: ['/abs'] } }), 'project pa: absolute path /abs');

  // Snapshot-walk refusals: a symlink and a fifo inside the snapshot dir are named exactly.
  mkdirSync(join(data2, 'projects', 'a2'), { recursive: true });
  put(ws2, 'a2/AGENTS.md', '# a2\n');
  writeFileSync(join(data2, 'projects/projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { a2: [] } }));
  symlinkSync(join(ws2, 'a2', 'AGENTS.md'), join(data2, 'projects', 'a2', 'dangling'));
  let r2 = run2();
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /snapshot dir .* contains a symlink dangling; remove it by hand/);
  rmSync(join(data2, 'projects', 'a2', 'dangling'));
  const fifo = join(data2, 'projects', 'a2', 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo is required for the non-regular-entry case');
  r2 = run2();
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /contains a non-regular entry pipe; remove it by hand/);
  rmSync(fifo);

  // The `have` walk is recursive, normalizes backslashes, and prints the exact gone-notes
  // (sorted here because readdir order is not); nothing else may appear in the output.
  mkdirSync(join(data2, 'projects', 'a2', 'nested'), { recursive: true });
  writeFileSync(join(data2, 'projects', 'a2', 'a\\b.md'), 'x\n');
  writeFileSync(join(data2, 'projects', 'a2', 'nested', 'old.md'), 'x\n');
  rmSync(join(ws2, 'a2', 'AGENTS.md')); // context file gone in the project -> note, never an error
  writeFileSync(join(data2, 'projects/projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { a2: [] } }));
  r2 = run2();
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(r2.stdout.split('\n').filter(l => l.startsWith('note: ')).sort(), [
    'note: a/b.md is gone in a2; delete projects/a2/a/b.md by hand if stale',
    'note: nested/old.md is gone in a2; delete projects/a2/nested/old.md by hand if stale',
  ]);
  assert.match(r2.stdout, /0 added, 0 updated, 0 unchanged from /);

  console.log('sync-projects.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
