// Self-check for sync-projects.mjs: node sync-projects.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, forAll, keepTemp, safeRel } from './lib/data.mjs';

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
  const alphaV0 = '# alpha rules v0\n';
  put(data, 'projects/alpha/AGENTS.md', alphaV0); // stale -> updated
  put(data, 'projects/alpha/OLD.md', '# stale\n'); // gone in project -> note only
  // The snapshot predates the record: seed its baseline, because a first sight of a
  // differing committed snapshot now refuses the file (a stale checkout copy must
  // never capture over a newer commit).
  mkdirSync(join(tmp, '.alate'), { recursive: true });
  writeFileSync(join(tmp, '.alate', 'captured-projects.json'), JSON.stringify({ 'alpha/AGENTS.md': fingerprint('alpha/AGENTS.md', Buffer.from(alphaV0)) }));

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

  // Object project values (specs/bundles.md): extras capture exactly like the array form,
  // and bundles is never read here (it drives install-user only; bundles/core does not exist).
  manifest({ contextFiles: ['AGENTS.md'], projects: { alpha: [], beta: { extras: ['scripts/tool.mjs'], bundles: ['core'] } } });
  put(tmp, 'beta/scripts/tool.mjs', '// helper v3\n');
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated\s+projects.beta.scripts.tool\.mjs/, r.stdout);
  assert.equal(snap('beta', 'scripts/tool.mjs'), '// helper v3\n', 'the object form captures extras like the array form');
  assert.match(r.stdout, /0 added, 1 updated, 2 unchanged/, r.stdout);

  // --- capture baseline (ALAT-154): the capture never overwrites a newer committed snapshot ---
  // The state file records, per machine and per file, the snapshot bytes the last capture
  // wrote or adopted; a one-sided snapshot change refreshes the machine copy, a two-sided
  // change is a conflict that writes nothing.
  {
    const data3 = join(tmp, 'data3');
    const ws3 = join(tmp, 'ws3');
    mkdirSync(join(data3, 'projects'), { recursive: true });
    mkdirSync(join(ws3, 'delta'), { recursive: true });
    writeFileSync(join(data3, 'projects/projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { delta: [] } }, null, 2) + '\n');
    const run3 = (...extra) => spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--root', ws3, '--data', data3, ...extra], { encoding: 'utf8' });
    const state3 = join(ws3, '.alate', 'captured-projects.json');
    const machine3 = join(ws3, 'delta', 'AGENTS.md');
    const snap3 = join(data3, 'projects', 'delta', 'AGENTS.md');
    const base3 = text => fingerprint('delta/AGENTS.md', Buffer.from(text));
    const state = () => JSON.parse(readFileSync(state3, 'utf8'));

    writeFileSync(machine3, '# delta v1\n');
    let r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /1 added, 0 updated, 0 unchanged/);
    assert.match(r3.stdout, /projects\/delta\/AGENTS\.md has no capture baseline; captured the machine copy/);
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v1\n'), 'the first capture records its baseline');

    // (b) machine edit, snapshot unchanged -> capture as today.
    writeFileSync(machine3, '# delta v2\n');
    r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /updated\s+projects.delta.AGENTS\.md/);
    assert.equal(readFileSync(snap3, 'utf8'), '# delta v2\n');
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v2\n'));

    // (a) snapshot changed elsewhere, machine copy unchanged -> the machine copy takes the
    // snapshot, and the data repo stays clean.
    writeFileSync(snap3, '# delta v3 board\n');
    r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /refreshed projects\/delta\/AGENTS\.md into .+ \(the snapshot changed elsewhere; the machine copy was unchanged\)/);
    assert.equal(readFileSync(machine3, 'utf8'), '# delta v3 board\n', 'the machine copy took the committed snapshot');
    assert.equal(readFileSync(snap3, 'utf8'), '# delta v3 board\n', 'the data repo stays clean');
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v3 board\n'), 'the baseline adopts the snapshot');
    r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /0 added, 0 updated, 1 unchanged/);

    // (c) both changed -> exit non-zero, and nothing is written anywhere.
    writeFileSync(snap3, '# delta v4 board\n');
    writeFileSync(machine3, '# delta v5 local\n');
    r3 = run3();
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /conflict: the snapshot .+projects.delta.AGENTS\.md and the machine file .+delta.AGENTS\.md both changed since the last capture; resolve by hand/);
    assert.equal(readFileSync(machine3, 'utf8'), '# delta v5 local\n', 'a conflict leaves the machine copy alone');
    assert.equal(readFileSync(snap3, 'utf8'), '# delta v4 board\n', 'a conflict leaves the snapshot alone');
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v3 board\n'), 'a conflict leaves the baseline alone');

    // (d0) --first: the starter-template escape hatch. The first capture of a fresh
    // data repo adopts the machine copies and seeds the baselines (specs/capture-baseline.md).
    rmSync(state3);
    writeFileSync(snap3, '# delta v4 board\n');
    r3 = run3('--first');
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /projects\/delta\/AGENTS\.md has no capture baseline; captured the machine copy/);
    assert.equal(readFileSync(snap3, 'utf8'), '# delta v5 local\n', '--first adopts the machine copy');
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v5 local\n'), '--first seeds the baseline');

    // (d) no record, machine copy differs from the snapshot -> refuse this file:
    // a capture cannot tell a machine edit from a stale checkout copy that never
    // provisioned, and the stale case would overwrite a newer committed file.
    rmSync(state3);
    writeFileSync(snap3, '# delta v4 board\n');
    r3 = run3();
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /no baseline: the snapshot .+projects.delta.AGENTS\.md and the machine file .+delta.AGENTS\.md differ and no capture baseline exists; wrote nothing for it \(machine sha256 [0-9a-f]{64}, snapshot sha256 [0-9a-f]{64}\)/);
    assert.equal(readFileSync(machine3, 'utf8'), '# delta v5 local\n', 'the refusal leaves the machine copy alone');
    assert.equal(readFileSync(snap3, 'utf8'), '# delta v4 board\n', 'the refusal leaves the snapshot alone');
    assert.equal(existsSync(state3), false, 'the refused file writes no baseline record');
    assert.doesNotMatch(r3.stdout, /has no capture baseline/);

    // (d2) a provision ends the refusal: the machine copy takes the snapshot, and the
    // next capture seeds the baseline.
    writeFileSync(machine3, '# delta v4 board\n');
    r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /0 added, 0 updated, 1 unchanged/);
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v4 board\n'));

    // (d3) no record, machine copy equals the snapshot: seeds the baseline, exits 0.
    writeFileSync(machine3, '# delta v7 board\n');
    writeFileSync(snap3, '# delta v7 board\n');
    rmSync(state3);
    r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /0 added, 0 updated, 1 unchanged/);
    assert.doesNotMatch(r3.stdout, /has no capture baseline/);
    assert.equal(state()['delta/AGENTS.md'], base3('# delta v7 board\n'));

    // A corrupt baseline file is named, never silently discarded: the run proceeds without
    // baselines and leaves the file as it is. Every file counts as having no baseline,
    // so a differing machine copy is refused instead of captured.
    writeFileSync(state3, 'not json');
    writeFileSync(machine3, '# delta v6 local\n');
    r3 = run3();
    assert.equal(r3.status, 1);
    assert.match(r3.stdout, /is not a valid capture baseline/);
    assert.match(r3.stderr, /no baseline: the snapshot .* and the machine file .* differ/);
    assert.equal(readFileSync(state3, 'utf8'), 'not json', 'a corrupt baseline file is left as-is');
    assert.equal(readFileSync(snap3, 'utf8'), '# delta v7 board\n');
    // Equal bytes need no baseline judgment: the run exits 0 and the corrupt file
    // stays as it is.
    writeFileSync(machine3, '# delta v7 board\n');
    r3 = run3();
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(readFileSync(state3, 'utf8'), 'not json', 'a corrupt baseline file is left as-is');
  }

  // ALAT-228: the refresh path writes committed snapshot bytes into the project checkout,
  // where omp loads them as always-on context, so it passes the same hidden-character
  // gate install-projects.mjs applies to .md/.mdc items: a laced snapshot is refused,
  // the machine copy stays byte-identical, and the run exits 1.
  {
    const dataH = join(tmp, 'dataH');
    const wsH = join(tmp, 'wsH');
    mkdirSync(join(dataH, 'projects'), { recursive: true });
    mkdirSync(join(wsH, 'eta'), { recursive: true });
    mkdirSync(join(dataH, 'projects', 'eta'), { recursive: true });
    writeFileSync(join(dataH, 'projects/projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { eta: [] } }, null, 2) + '\n');
    const runH = () => spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--root', wsH, '--data', dataH], { encoding: 'utf8' });
    const machineH = join(wsH, 'eta', 'AGENTS.md');
    const snapH = join(dataH, 'projects', 'eta', 'AGENTS.md');
    const stateH = join(wsH, '.alate', 'captured-projects.json');
    const fpH = text => fingerprint('eta/AGENTS.md', Buffer.from(text));
    const v1 = '# eta v1\n';
    writeFileSync(machineH, v1);
    mkdirSync(join(wsH, '.alate'), { recursive: true });
    writeFileSync(stateH, JSON.stringify({ 'eta/AGENTS.md': fpH(v1) })); // seeded baseline
    writeFileSync(snapH, '# eta v2 board\u200b\n'); // laced snapshot changed elsewhere
    const before = readFileSync(machineH);
    let rH = runH();
    assert.equal(rH.status, 1, `a laced refresh must exit 1: ${rH.stdout}`);
    assert.match(rH.stderr, /hidden characters: the snapshot projects\/eta\/AGENTS\.md fails the \.md\/\.mdc gate for .+eta.AGENTS\.md; kept the machine copy, wrote nothing for it \(hidden character U\+200B at eta\/AGENTS\.md:1:15\)/);
    assert.ok(readFileSync(machineH).equals(before), 'the refused refresh leaves the machine copy byte-identical');
    assert.equal(readFileSync(snapH, 'utf8'), '# eta v2 board\u200b\n', 'the refusal leaves the snapshot alone');
    assert.equal(JSON.parse(readFileSync(stateH, 'utf8'))['eta/AGENTS.md'], fpH(v1), 'a refused refresh leaves the baseline alone');
    assert.doesNotMatch(rH.stdout, /refreshed/, 'the refused refresh is not counted or logged as one');
    // The same refresh succeeds once the snapshot is clean: the refusal is content-gated.
    writeFileSync(snapH, '# eta v2 board\n');
    rH = runH();
    assert.equal(rH.status, 0, rH.stderr);
    assert.match(rH.stdout, /refreshed projects\/eta\/AGENTS\.md into .+ \(the snapshot changed elsewhere; the machine copy was unchanged\)/);
    assert.equal(readFileSync(machineH, 'utf8'), '# eta v2 board\n');
    assert.equal(JSON.parse(readFileSync(stateH, 'utf8'))['eta/AGENTS.md'], fpH('# eta v2 board\n'), 'the baseline adopts the clean snapshot');
  }

  // Canonical capture (specs/canonical-form.md): CRLF machine text lands as LF in the data
  // repo with a note line, a .cmd captures LF too (install renders CRLF for it), binary
  // bytes pass through identically, and a re-capture of canonical output is unchanged.
  {
    const dataC = join(tmp, 'dataC');
    const wsC = join(tmp, 'wsC');
    mkdirSync(join(dataC, 'projects'), { recursive: true });
    mkdirSync(join(wsC, 'epsilon'), { recursive: true });
    writeFileSync(join(dataC, 'projects/projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { epsilon: ['run.cmd', 'blob.bin'] } }, null, 2) + '\n');
    const runC = () => spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--root', wsC, '--data', dataC], { encoding: 'utf8' });
    put(wsC, 'epsilon/AGENTS.md', '# epsilon\r\nrules\r\n');
    put(wsC, 'epsilon/run.cmd', '@echo off\r\necho hi\r\n');
    const bin = Buffer.from([0x4f, 0x00, 0xde, 0xad, 0x0d, 0x0a, 0x0d, 0x0a, 0xbe, 0xef]); // NUL: binary, holds CRLF
    put(wsC, 'epsilon/blob.bin', bin);
    let rC = runC();
    assert.equal(rC.status, 0, rC.stderr);
    assert.match(rC.stdout, /note: projects\/epsilon\/AGENTS\.md: normalized CRLF line endings to LF/);
    assert.match(rC.stdout, /note: projects\/epsilon\/run\.cmd: normalized CRLF line endings to LF/);
    assert.equal(readFileSync(join(dataC, 'projects', 'epsilon', 'AGENTS.md'), 'utf8'), '# epsilon\nrules\n');
    assert.equal(readFileSync(join(dataC, 'projects', 'epsilon', 'run.cmd'), 'utf8'), '@echo off\necho hi\n', 'a .cmd snapshot holds LF in the data repo');
    assert.ok(readFileSync(join(dataC, 'projects', 'epsilon', 'blob.bin')).equals(bin), 'a binary file captures byte-identical');
    rC = runC();
    assert.equal(rC.status, 0, rC.stderr);
    assert.match(rC.stdout, /0 added, 0 updated, 3 unchanged/, `canonical output churned a re-capture: ${rC.stdout}`);
    // The machine copy still holds CRLF (capture never rewrites machine files), so every
    // capture normalizes it again and the note is honest on each run.
    assert.match(rC.stdout, /note: projects\/epsilon\/AGENTS\.md: normalized CRLF line endings to LF/);
    assert.ok(readFileSync(join(dataC, 'projects', 'epsilon', 'blob.bin')).equals(bin), 'a binary re-capture stays byte-identical');
    // Once the machine copies themselves hold canonical bytes, the notes go away.
    put(wsC, 'epsilon/AGENTS.md', '# epsilon\nrules\n');
    put(wsC, 'epsilon/run.cmd', '@echo off\necho hi\n');
    rC = runC();
    assert.equal(rC.status, 0, rC.stderr);
    assert.doesNotMatch(rC.stdout, /normalized CRLF line endings/, 'a canonical machine copy emits no normalization note');
    assert.match(rC.stdout, /0 added, 0 updated, 3 unchanged/);
  }

  // Credential refusal (codeguard-1-hardcoded-credentials): a token-shaped value in a
  // listed project file refuses the whole capture before any write, like the user capture;
  // the report names file, line and shape, never the value.
  {
    const dataS = join(tmp, 'dataS');
    const wsS = join(tmp, 'wsS');
    mkdirSync(join(dataS, 'projects'), { recursive: true });
    writeFileSync(join(dataS, 'projects/projects.json'), JSON.stringify({ contextFiles: ['AGENTS.md'], projects: { proj: [] } }, null, 2) + '\n');
    mkdirSync(join(wsS, 'proj'), { recursive: true });
    const token = 'ghp_' + 'A'.repeat(36); // built at run time, never a literal fixture value
    writeFileSync(join(wsS, 'proj', 'AGENTS.md'), `Staging token: ${token}\n# proj rules\n`);
    const rS = spawnSync(process.execPath, [join(repo, 'sync-projects.mjs'), '--root', wsS, '--data', dataS], { encoding: 'utf8' });
    assert.equal(rS.status, 1);
    assert.match(rS.stderr, /Nothing synced/);
    assert.match(rS.stderr, /proj\/AGENTS\.md:1: possible GitHub token/);
    assert.ok(!rS.stderr.includes(token) && !rS.stdout.includes(token), 'the refusal names the shape, never the value');
    assert.ok(!existsSync(join(dataS, 'projects', 'proj')), 'a refused capture writes nothing into the data repo');
    assert.ok(!existsSync(join(wsS, '.alate', 'captured-projects.json')), 'the refusal writes no baseline record');
  }

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
