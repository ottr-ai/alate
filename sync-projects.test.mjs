// Self-check for sync-projects.mjs: node sync-projects.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  console.log('sync-projects.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
