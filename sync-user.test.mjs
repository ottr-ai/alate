// Self-check for sync-user.mjs: node sync-user.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forAll, keepTemp, yamlProblems } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-user-'));
const repo = join(tmp, 'repo');
const data = join(tmp, 'data');
const home = join(tmp, 'home');
mkdirSync(join(repo, 'lib'), { recursive: true });
mkdirSync(data);
copyFileSync(fileURLToPath(new URL('./sync-user.mjs', import.meta.url)), join(repo, 'sync-user.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(repo, 'lib/data.mjs'));
const put = (rel, text) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), text); };
const run = () => spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', home, '--data', data], { encoding: 'utf8' });
const snap = rel => readFileSync(join(data, 'user', rel), 'utf8');
// Assembled at runtime so this file never holds a credential-shaped literal.
const FAKES = {
  'AWS access key': 'AKIA' + 'Z7'.repeat(8),
  'GitHub token': 'ghp_' + 'a1'.repeat(18),
  'API key': 'sk-' + 'proj-' + 'b2'.repeat(10),
  'Google API key': 'AIza' + 'c3'.repeat(17) + 'd',
  'Slack token': 'xoxb-' + '1234567890-abc',
  JWT: ['eyJ' + 'h'.repeat(12), 'eyJ' + 'p'.repeat(12), 's'.repeat(12)].join('.'),
  'private key': '-----BEGIN ' + 'PRIVATE KEY-----\n' + 'M'.repeat(64),
  'password in a URL': 'postgres://' + 'app:hunter2@db/x',
};

try {
  put('.omp/agent/config.yml', 'modelRoles:\n  default: zai/glm\nmaxTokens: 128000000\napiKey: ${ZAI_API_KEY}\n');
  put('.omp/agent/mcp.json', JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }, headers: { Authorization: 'Bearer ${GH_PAT}' } } } }, null, 2));
  // Docs that only mention keys, and secret-named keys outside the hand-edited config, still sync.
  put('.omp/agent/skills/mine/SKILL.md', '# mine\nKeys look like sk-..., ghp_... or AKIA...; use https://user:${PASS}@host.\napiKey: your-key-goes-here\n');
  put('.omp/agent/skills/mine/__pycache__/x.pyc', 'cache');
  put('.omp/agent/managed-skills/learned/SKILL.md', '# learned\n');
  put('.omp/agent/optimizer.json', '{"ponytail":"full"}\n');
  const PIX = '{"optimizer":true,"pretty":true,"gate":true}\n';
  put('.pi/agent/pix.json', PIX);
  put('.pi/agent/optimizer.json', '{"rtk":false}\n'); // runtime state: never captured
  put('.omp/agent/extensions/mine.ts', 'export default {};\n');
  put('.omp/marketplaces.json', '{"version":1,"marketplaces":[]}\n');
  put('.omp/plugins/package.json', '{"dependencies":{"@aws-sdk/credential-provider-env":"^3.972.0"}}\n');
  put('.omp/plugins/bun.lock', '{}\n');
  put('.omp/plugins/omp-plugins.lock.json', '{}\n');
  put('.omp/plugins/installed_plugins.json', '{"version":2,"plugins":{}}\n');
  put('.agents/.skill-lock.json', '{"skills":{}}\n');
  put('.agents/skills/theirs/SKILL.md', '# theirs\n');
  put('.agents/skills/theirs/node_modules/dep/index.js', '');

  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added {4}user\/omp\/agent\/config\.yml/);
  assert.equal(snap('agents/.skill-lock.json'), '{"skills":{}}\n', 'only the first dot is dropped');
  assert.ok(!existsSync(join(data, 'user/omp/agent/skills/mine/__pycache__')), 'caches stay out');
  assert.ok(!existsSync(join(data, 'user/agents/skills/theirs/node_modules')), 'dependencies stay out');
  assert.equal(snap('pi/agent/pix.json'), PIX, 'pix initial values are captured');
  assert.ok(!existsSync(join(data, 'user/pi/agent/optimizer.json')), 'pix runtime state stays machine-local');
  assert.match(r.stdout, /14 added, 0 updated, 0 unchanged/);

  writeFileSync(join(data, 'user/agents/skills/theirs/SKILL.md'), '# theirs\r\n'); // line endings only -> not churned
  rmSync(join(home, '.omp/agent/managed-skills/learned'), { recursive: true });
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: user\/omp\/agent\/managed-skills\/learned\/SKILL\.md is gone/);
  assert.ok(existsSync(join(data, 'user/omp/agent/managed-skills/learned/SKILL.md')), 'stale copies are never deleted');
  assert.match(r.stdout, /0 added, 0 updated, 13 unchanged/);

  for (const [name, fake] of Object.entries(FAKES)) {
    put('.agents/skills/theirs/SKILL.md', `# theirs v2\n\nexample: ${fake}\n`);
    r = run();
    assert.equal(r.status, 1, `${name} must be refused`);
    assert.ok(r.stderr.includes(`~/.agents/skills/theirs/SKILL.md:3: possible ${name}`), r.stderr);
    assert.ok(!r.stderr.includes(fake), 'never prints the secret');
    assert.equal(snap('agents/skills/theirs/SKILL.md'), '# theirs\r\n', 'a refused run syncs nothing');
  }
  put('.agents/skills/theirs/SKILL.md', '# theirs\n');

  // The new pix.json item goes through the same credential shape scan as any other item.
  put('.pi/agent/pix.json', `{"gate":"${FAKES['GitHub token']}"}\n`);
  r = run();
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('~/.pi/agent/pix.json:1: possible GitHub token'), r.stderr);
  assert.equal(snap('pi/agent/pix.json'), PIX, 'a refused run syncs nothing');
  put('.pi/agent/pix.json', PIX);

  const literal = { TAVILY_API_KEY: 'tvly-' + '0123456789abcdef' };
  const bearer = 'Bearer ' + 'abcdef0123456789';
  const beforeMcp = snap('omp/agent/mcp.json');
  put('.omp/agent/mcp.json', JSON.stringify({ mcpServers: { s: { env: literal, headers: { Authorization: bearer } } } }, null, 2));
  r = run();
  assert.equal(r.status, 1);
  assert.equal(snap('omp/agent/mcp.json'), beforeMcp, 'literal credentials leave the snapshot unchanged');
  assert.ok(!r.stderr.includes(literal.TAVILY_API_KEY) && !r.stderr.includes(bearer), 'never prints the secret');
  put('.omp/agent/mcp.json', '{}\n');

  // JSON parity: escaped keys decode before the scan (parse-based jsonProblems), so JSON has no
  // raw-spelling bypass either; invalid JSON refuses instead of being scanned raw.
  put('.omp/agent/mcp.json', '{\n  "mcpServers": {\n    "s": {\n      "env": {\n        "api\\u004bey": "placeholder"\n      }\n    }\n  }\n}\n');
  r = run();
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('~/.omp/agent/mcp.json: "apiKey" holds a literal value'), r.stderr);
  put('.omp/agent/mcp.json', '{oops\n');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mcp\.json: is not valid JSON/);
  assert.match(r.stderr, /Nothing synced/);
  put('.omp/agent/mcp.json', '{}\n');

  // YAML contract: a spelling YAML decodes but the raw bytes lack ("api\u004bey" is the key apiKey)
  // is refused fail-closed, and a refused run never touches the previous snapshot.
  const good = snap('omp/agent/config.yml');
  const refused = [
    ['"api\\u004bey": placeholder\n', /escape in a double-quoted scalar/],
    ['note: "pa\\u0073sword123"\n', /escape in a double-quoted scalar/],
    ['repo: *alias\n', /node indicator "\*"/],
    ['*alias: placeholder\n', /node indicator "\*"/],
    ['note: &anchor placeholder\n', /node indicator "&"/],
    ['? api\n: placeholder\n', /node indicator "\?"/],
    ['<<: *a\n', /merge key/],
    ['env: {API_KEY: placeholder}\n', /node indicator "\{"/],
    ['tags: [a, b]\n', /node indicator "\["/],
    ['prompt: |\n  text\n', /node indicator "\|"/],
    ['n: !!str placeholder\n', /node indicator "!"/],
    ['%YAML 1.2\n', /directive/],
    ['a: 1\n---\nb: 2\n', /multi-document/],
    ['a: 1\n...\n', /end-of-document marker/],
    ['k: "open\n', /spans lines/],
  ];
  for (const [yml, why] of refused) {
    put('.omp/agent/config.yml', yml);
    r = run();
    assert.equal(r.status, 1, yml);
    assert.match(r.stderr, /unsupported YAML syntax/);
    assert.match(r.stderr, why);
    assert.ok(!r.stderr.includes('placeholder'), 'never prints the literal');
  }
  assert.equal(snap('omp/agent/config.yml'), good, 'a refused run syncs nothing');

  // Supported syntax keeps syncing: quoted values, single-quote doubling, nesting, sequences,
  // empty values, numbers, booleans, env refs, comments; indicators mid-token are plain content.
  const rich = [
    '# comment',
    'theme: "dark"',
    "greeting: 'it''s ok'",
    'modelRoles:',
    '  default: zai/glm',
    'list:',
    '  - one',
    'empty:',
    'num: 512',
    'flag: true',
    'ref: ${MY_VAR}',
    'url: https://x/*?a=b',
    '',
  ].join('\n');
  put('.omp/agent/config.yml', rich);
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated {2}user\/omp\/agent\/config\.yml/);
  assert.equal(snap('omp/agent/config.yml'), rich);
  put('.omp/agent/config.yml', good);

  const portable = 'memory:\n  backend: hindsight\ncomposer:\n  alate: keep\nmodelRoles:\n  default: zai/glm\n';
  for (const key of ['hindsight', '"hindsight"', "'hindsight'"]) {
    put('.omp/agent/config.yml', `\uFEFFmemory:\n  backend: hindsight\n${key}:\n  apiKey: ${FAKES['GitHub token']}\n\n# Deployment details\n  nested:\n    apiUrl: https://local.example\n"alate":\n  url: https://provision.example\n  apiKey: local-only\ncomposer:\n  alate: keep\nmodelRoles:\n  default: zai/glm\n`);
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(snap('omp/agent/config.yml'), portable, 'capture omits deployment blocks but preserves nested names and the selected backend');
    assert.ok(!r.stdout.includes(FAKES['GitHub token']) && !r.stderr.includes(FAKES['GitHub token']), 'excluded credentials are never printed');
  }
  put('.omp/agent/config.yml', good);

  rmSync(join(home, '.omp/plugins/bun.lock'));
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /~\/\.omp\/plugins\/bun\.lock is missing/);
  assert.match(r.stderr, /Nothing synced/);

  // A missing data dir dies before touching anything.
  const missing = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', home, '--data', join(tmp, 'nope')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No data dir/);

  // A config.yml that ends in a deployment block: capture and install must agree, so the
  // deployment-free text keeps the line end of its last kept line. Fails while capture drops
  // the terminator that install puts back: install then refuses the machine file, because the
  // captured snapshot is one terminator short of the machine text minus its blocks.
  copyFileSync(fileURLToPath(new URL('./install-user.mjs', import.meta.url)), join(repo, 'install-user.mjs'));
  // install-user now scans skill snapshots before installing; an exit-0 stub keeps
  // this roundtrip hermetic. Windows cannot exec an extensionless stub through spawnSync:
  // there the run needs a real skillspector on PATH (the gate fails closed without one).
  const stub = join(tmp, 'skillspector-stub');
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, 'skillspector'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stub, 'skillspector'), 0o755);
  const stubEnv = process.platform === 'win32' ? undefined : { ...process.env, PATH: `${stub}${delimiter}${process.env.PATH ?? ''}` };
  put('.omp/plugins/bun.lock', '{}'); // the missing-item refusal above removed it
  const blockText = 'hindsight:\n  apiUrl: http://nas\n  apiToken: $HINDSIGHT_TOKEN';
  const eol = (s, crlf) => (crlf ? s.replaceAll('\n', '\r\n') : s);
  for (const crlf of [false, true]) {
    for (const [where, lines] of [
      ['start', [blockText, 'user: y', 'z: w']],
      ['middle', ['user: y', blockText, 'z: w']],
      ['end', ['user: y', 'z: w', blockText]],
    ]) {
      for (const fin of ['', '\n']) {
        const tag = `${where}/${crlf ? 'crlf' : 'lf'}/final-newline=${fin !== ''}`;
        const machine = eol(lines.join('\n'), crlf) + (fin ? eol('\n', crlf) : '');
        // The snapshot is the source with the block lines removed: the last kept line keeps
        // its own line end, so only a trailing block that ate it gets a terminator back.
        const keepTerminator = where === 'end' || fin !== '';
        put('.omp/agent/config.yml', machine);
        let r2 = run();
        assert.equal(r2.status, 0, `${tag}: ${r2.stderr}`);
        assert.equal(snap('omp/agent/config.yml'), eol(`user: y\nz: w${keepTerminator ? '\n' : ''}`, crlf),
          `${tag}: capture keeps the last kept line's terminator`);
        // A machine that holds exactly that file installs the snapshot as unchanged.
        const target = join(tmp, `home-${where}-${crlf ? 'crlf' : 'lf'}-${fin ? 'nl' : 'nonl'}`);
        mkdirSync(join(target, '.omp/agent'), { recursive: true });
        writeFileSync(join(target, '.omp/agent/config.yml'), machine);
        r2 = spawnSync(process.execPath,
          [join(repo, 'install-user.mjs'), '--home', target, '--skip-plugins', '--data', data],
          { encoding: 'utf8', env: stubEnv });
        assert.equal(r2.status, 0, `${tag}: install refuses the machine file: ${r2.stderr}`);
        assert.match(r2.stdout, /1 unchanged/, `${tag}: config.yml counts as unchanged`);
        assert.equal(readFileSync(join(target, '.omp/agent/config.yml'), 'utf8'), machine,
          `${tag}: an unchanged file stays byte for byte`);
      }
    }
  }

  // A patched plugin's patch file travels with the plugins layer, and a home without
  // patches/ still captures. Fails while ITEMS has no patches entry: agent-data's copy is
  // never matched, so the capture reports it stale and drops it from the snapshot.
  const patchPath = 'omp/plugins/patches/@xynogen%2Fpix-optimizer@1.2.0.patch';
  const patch = '--- a/plugin.js\n+++ b/plugin.js\n@@ -1 +1 @@\n-ok\n+patched\n';
  mkdirSync(join(data, 'user', patchPath, '..'), { recursive: true });
  writeFileSync(join(data, 'user', patchPath), patch); // agent-data already holds a copy
  put('.omp/plugins/package.json', '{"patchedDependencies":{"@xynogen/pix-optimizer":"patches/@xynogen%2Fpix-optimizer@1.2.0.patch"}}\n');
  put('.omp/plugins/patches/@xynogen%2Fpix-optimizer@1.2.0.patch', patch);
  let r2 = run();
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!r2.stdout.includes('patches/@xynogen'), r2.stdout); // never reported stale
  assert.equal(snap(patchPath), patch, 'the patch file is captured with the plugins layer');
  // A home without patches/ still captures: every other item stays required.
  const nopatch = join(tmp, 'home-nopatch');
  for (const it of ['.omp/agent/config.yml', '.omp/agent/mcp.json', '.omp/agent/optimizer.json',
    '.pi/agent/pix.json', '.omp/marketplaces.json', '.omp/plugins/package.json',
    '.omp/plugins/bun.lock', '.omp/plugins/omp-plugins.lock.json',
    '.omp/plugins/installed_plugins.json', '.agents/.skill-lock.json']) {
    mkdirSync(join(nopatch, it, '..'), { recursive: true });
    writeFileSync(join(nopatch, it), it.endsWith('.json') || it.endsWith('.lock') ? '{}' : 'k: ${V}\n');
  }
  for (const d of ['.omp/agent/extensions', '.omp/agent/skills', '.omp/agent/managed-skills', '.agents/skills'])
    mkdirSync(join(nopatch, d), { recursive: true });
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', nopatch, '--data', data], { encoding: 'utf8' });
  assert.equal(r2.status, 0, `a home without patches/ must still capture: ${r2.stderr}`);

  // Property checks (fuzz tier via forAll in lib/data.mjs). Gate: 200 runs, fixed seed
  // 42; PROP_RUNS=<n> re-seeds randomly for the review deep tier.
  {
    // The YAML syntax gate never throws on any input and always returns issue strings.
    forAll((rand, size) => {
      const chars = ['a', 'Z', '0', ':', ' ', '  ', '"', "'", '#', '-', '|', '>', '&', '*', '!', '%', '@', '?', '[', ']', '{', '}', ',', '`', '\\', '\t', 'k: v', '\n'];
      let s = '';
      for (let i = 0, n = 1 + Math.floor(rand() * (size + 2)); i < n; i++) s += chars[Math.floor(rand() * chars.length)];
      return s;
    }, text => {
      const issues = yamlProblems(text, 'c.yml');
      assert.ok(Array.isArray(issues) && issues.every(x => typeof x === 'string'), `issue list for ${JSON.stringify(text.slice(0, 30))}`);
    });

    // Fail closed: a secret-named key embedded in a construct the scanner cannot decode
    // exactly never passes clean (the capture refuses, so the per-key value scan in
    // sync-user.mjs never has to judge undecodable syntax).
    const HIDDEN = [
      t => `opts: {${t}}\n`,                                   // flow mapping
      t => `${t.slice(0, t.indexOf(':'))}: "a\\\\b"\n`,        // escape in a double-quoted scalar
      t => `&anchor ${t}\n`,                                   // anchor
      t => `*alias ${t}\n`,                                    // alias
      t => `!!str ${t}\n`,                                     // tag
      t => `<<: ${t}\n`,                                       // merge key
      t => `%TAG !e! tag:x\n${t}\n`,                           // directive
      t => `---\n${t}\n---\n${t}\n`,                           // multi-document file
      t => `block: |\n  ${t}\n`,                               // block scalar
      t => `${t.slice(0, t.indexOf(':'))}: "open\nnever closed\n`, // scalar spans lines
    ];
    forAll(rand => {
      const key = ['apiKey', 'secret_token', 'myPassword', 'private_key', 'AUTHORIZATION', 'credential'][Math.floor(rand() * 6)];
      return HIDDEN[Math.floor(rand() * HIDDEN.length)](`${key}: sk-test-literal`);
    }, text => {
      assert.ok(yamlProblems(text, 'c.yml').length > 0, `hidden credential pair must not scan clean: ${JSON.stringify(text)}`);
    });
  }

  console.log('sync-user.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
