// Self-check for skills/create-data-repo/scan-secrets.mjs: node skills/create-data-repo/scan-secrets.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepTemp } from '../../lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-scan-'));
const folder = join(tmp, 'data');
cpSync(fileURLToPath(new URL('../../examples/data', import.meta.url)), folder, { recursive: true });
const script = fileURLToPath(new URL('./scan-secrets.mjs', import.meta.url));
const run = () => spawnSync(process.execPath, [script, folder], { encoding: 'utf8' });
const put = (rel, text) => { mkdirSync(join(folder, rel, '..'), { recursive: true }); writeFileSync(join(folder, rel), text); };
// Assembled at runtime so this file never holds a credential-shaped literal.
const FAKE_TOKEN = 'ghp_' + 'a1'.repeat(18);
const FAKE_KEY = 'sk-' + 'proj-' + 'b2'.repeat(10);

try {
  // The untouched starter is clean: full file list, correct summary, exit 0.
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['README.md', 'coding-basics.md', 'git-safety.md', 'upstreams.json', 'projects/projects.json', 'user/omp/agent/config.yml',
    ...['interrogate', 'blast-radius', 'correct', 'benchmark-checklist', 'code-simplifier'].flatMap(s => [`user/omp/agent/skills/${s}/SKILL.md`, `user/omp/agent/skills/${s}/.skillspector-baseline.yaml`])])
    assert.ok(r.stdout.includes(`file ${f}\n`), `file list misses ${f}:\n${r.stdout}`);
  assert.match(r.stdout, /summary: 2 rules, 5 skills, 0 plugins, 11 captured user files/);
  assert.match(r.stdout, /^projects: none$/m);
  assert.match(r.stdout, /clean: yes/);
  assert.ok(!r.stdout.includes('finding '), `clean scan reports findings:\n${r.stdout}`);

  // Captured layer: counts move with the content.
  put('user/omp/agent/skills/mine/SKILL.md', '# mine\n');
  put('user/omp/agent/managed-skills/learned/SKILL.md', '# learned\n');
  put('user/omp/plugins/package.json', '{"dependencies":{"a":"1","b":"2"}}\n');
  put('projects/projects.json', '{"contextFiles":["AGENTS.md"],"projects":{"alate":["notes.md"]}}\n');
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /summary: 2 rules, 7 skills, 2 plugins, 14 captured user files/);
  assert.match(r.stdout, /^projects: alate$/m);

  // A fake token in a captured file is a finding with a position, never the value.
  put('user/omp/agent/skills/mine/SKILL.md', `# mine v2\n\nexample: ${FAKE_TOKEN}\n`);
  r = run();
  assert.equal(r.status, 1, `fake token must be refused:\n${r.stdout}`);
  assert.match(r.stdout, /finding user\/omp\/agent\/skills\/mine\/SKILL\.md:3: possible GitHub token/);
  assert.ok(!r.stdout.includes(FAKE_TOKEN) && !r.stderr.includes(FAKE_TOKEN), 'scanner prints the secret');
  assert.ok(!existsSync(join(folder, '.git')), 'a refused scan must leave no commit behind');

  // A second shape in the same file also reports (one finding per shape).
  put('user/omp/agent/skills/mine/SKILL.md', `# mine v2\n\nexample: ${FAKE_KEY}\n`);
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /possible API key/);

  // Secret-shaped file names are findings on their own.
  put('user/.env.local', 'TOKEN=placeholder\n');
  put('user/omp/agent/agent.db', 'sqlite');
  mkdirSync(join(folder, 'user/omp/oauth'));
  put('user/omp/oauth/store.json', '{}\n');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /finding user\/\.env\.local: env file/);
  assert.match(r.stdout, /finding user\/omp\/agent\/agent\.db: auth database file/);
  assert.match(r.stdout, /finding user\/omp\/oauth: oauth folder/);
  assert.ok(!existsSync(join(folder, '.git')), 'a refused scan must leave no commit behind');

  // Usage and IO errors exit 2, not 0.
  r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  r = spawnSync(process.execPath, [script, join(tmp, 'missing')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /scan failed/);

  console.log('scan-secrets ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
