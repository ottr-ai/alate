// Self-check for sync-user.mjs: node sync-user.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forAll, keepTemp, withoutMemoryBackend, yamlProblems } from './lib/data.mjs';

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

  // The memory backend is a deployment choice (OTTR-453): the board injects it at spawn with
  // a --config overlay, so capture drops it like the deployment blocks. The BOM rides with
  // the dropped first lines; the portable keys after the blocks stay.
  const portable = 'composer:\n  alate: keep\nmodelRoles:\n  default: zai/glm\n';
  for (const key of ['hindsight', '"hindsight"', "'hindsight'"]) {
    put('.omp/agent/config.yml', `\uFEFFmemory:\n  backend: hindsight\n${key}:\n  apiKey: ${FAKES['GitHub token']}\n\n# Deployment details\n  nested:\n    apiUrl: https://local.example\n"alate":\n  url: https://provision.example\n  apiKey: local-only\ncomposer:\n  alate: keep\nmodelRoles:\n  default: zai/glm\n`);
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(snap('omp/agent/config.yml'), portable, 'capture omits deployment blocks and the memory backend, and preserves the portable keys');
    assert.ok(!r.stdout.includes(FAKES['GitHub token']) && !r.stderr.includes(FAKES['GitHub token']), 'excluded credentials are never printed');
  }
  put('.omp/agent/config.yml', good);

  // Only the backend entry goes: other keys under memory: are agent-layer content and stay,
  // and a deeper backend: is not the deployment entry.
  for (const [yml, out, why] of [
    ['memory:\n  backend: hindsight\n  autoRecall: true\ntheme:\n  dark: amethyst\n',
     'memory:\n  autoRecall: true\ntheme:\n  dark: amethyst\n',
     'only the backend entry is dropped; the rest of memory: stays'],
    ['memory:\n  recall:\n    backend: mnemopi\ntheme:\n  dark: amethyst\n',
     'memory:\n  recall:\n    backend: mnemopi\ntheme:\n  dark: amethyst\n',
     'a deeper backend: is not the deployment entry'],
    ['"memory":\n  backend: hindsight\ntheme:\n  dark: amethyst\n',
     'theme:\n  dark: amethyst\n',
     'a quoted memory key strips the same way'],
    ['theme:\n  dark: amethyst\n\nmemory:\n  # omp chose this\n  backend: hindsight\n\nmodel:\n  x: y\n',
     'theme:\n  dark: amethyst\n\nmodel:\n  x: y\n',
     'an emptied memory mapping goes with its interior comments and blanks'],
  ]) {
    put('.omp/agent/config.yml', yml);
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(snap('omp/agent/config.yml'), out, why);
  }
  put('.omp/agent/config.yml', good);

  // A link inside an item may alias a CONFIG file: its canonical target is an item anchor,
  // so the walk allows it. The aliased copy must pass the same deployment-strip and secret
  // gates as the canonical capture, or the strip's credential control never runs on the
  // alias and the deployment credentials reach the repo under the link's name.
  const aliasPlain = 'user:pass' + 'w0rd'; // assembled: no credential-shaped or import-shaped source text
  const aliasCred = Buffer.from(aliasPlain, 'latin1').toString('base64');
  put('.omp/agent/config.yml',
    `hindsight:\n  apiUrl: https://nas.internal\n  basic: ${aliasCred}\n  cookie_jar: ${aliasCred}\n` +
    'alate:\n  url: https://provision.example\n  apiKey: local-only\nmodelRoles:\n  default: zai/glm\n');
  symlinkSync(join(home, '.omp/agent/config.yml'), join(home, '.agents/skills/leaked-config.md'));
  r = run();
  assert.equal(r.status, 0, r.stderr);
  const portableConfig = snap('omp/agent/config.yml');
  assert.equal(snap('agents/skills/leaked-config.md'), portableConfig,
    'an aliased CONFIG copy is captured through the same gates as the canonical one');
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const f of walk(join(data, 'user')))
    assert.ok(!readFileSync(f, 'utf8').includes(aliasCred) && !readFileSync(f, 'utf8').includes('hindsight:'),
      `deployment bytes leaked into ${f}`);
  rmSync(join(home, '.agents/skills/leaked-config.md'));
  put('.omp/agent/config.yml', good);

  // The same alias through a hard link: the copy shares the CONFIG file's identity
  // (dev:ino) instead of resolving to its path, so the origin-keyed gates must fire on
  // the aliased copy too, or the deployment blocks reach the repo under the link's name.
  put('.omp/agent/config.yml',
    `hindsight:\n  apiUrl: https://nas.internal\n  basic: ${aliasCred}\n  cookie_jar: ${aliasCred}\n` +
      'alate:\n  url: https://provision.example\n  apiKey: local-only\nmodelRoles:\n  default: zai/glm\n');
  linkSync(join(home, '.omp/agent/config.yml'), join(home, '.agents/skills/leaked-config-hard.md'));
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snap('agents/skills/leaked-config-hard.md'), snap('omp/agent/config.yml'),
    'a hard-linked CONFIG copy is captured through the same gates as the canonical one');
  for (const f of walk(join(data, 'user')))
    assert.ok(!readFileSync(f, 'utf8').includes(aliasCred) && !readFileSync(f, 'utf8').includes('hindsight:'),
      `deployment bytes leaked into ${f}`);
  rmSync(join(home, '.agents/skills/leaked-config-hard.md'));
  put('.omp/agent/config.yml', good);

  // The JSON gate keys on the canonical origin too: an aliased mcp.json copy captured
  // under another item's name must pass jsonProblems like the canonical file, or a
  // link's copy escapes the credential scan under its own name.
  put('.omp/agent/mcp.json', '{\n  "mcpServers": {\n    "s": {\n      "command": "npx",\n      "args": ["-y", "@scope/mcp"],\n      "apiKey": "placeholder"\n    }\n  }\n}\n');
  symlinkSync(join(home, '.omp/agent/mcp.json'), join(home, '.agents/skills/leaked-mcp.json'));
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /~\/\.agents\/skills\/leaked-mcp\.json: "apiKey" holds a literal value/,
    'the aliased mcp.json copy is gated like the canonical one');
  rmSync(join(home, '.agents/skills/leaked-mcp.json'));
  put('.omp/agent/mcp.json', '{}\n');

  // An item root that links OUTSIDE the home refuses before the anchor check: the shared
  // source guard reports its own refusal, and the catch prefixes the item to the message.
  const outside = join(tmp, 'outside');
  mkdirSync(outside);
  const extensions = join(home, '.omp/agent/extensions');
  rmSync(extensions, { recursive: true });
  symlinkSync(outside, extensions);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`~/.omp/agent/extensions: Source ${extensions} is outside ${home}`), r.stderr);
  rmSync(extensions);
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, 'mine.ts'), 'export default {};\n');

  // A link to a path inside the home but outside every item root (~/.omp/oauth is
  // deliberately not an item) passes the source guard and still refuses on the anchor.
  mkdirSync(join(home, '.omp/oauth'));
  rmSync(extensions, { recursive: true });
  symlinkSync(join(home, '.omp/oauth'), extensions);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('~/.omp/agent/extensions: resolves outside the allowlisted capture roots through a link; fix or remove the link'), r.stderr);
  rmSync(extensions);
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, 'mine.ts'), 'export default {};\n');

  // An item root that is neither a directory nor a regular file (a leftover unix socket;
  // Windows named pipes do not stat as sockets) refuses instead of being read.
  if (process.platform !== 'win32') {
    const optimizer = join(home, '.omp/agent/optimizer.json');
    rmSync(optimizer);
    const srv = createServer();
    await new Promise(resolve => srv.listen(optimizer, resolve));
    srv.unref();
    r = run();
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('~/.omp/agent/optimizer.json: is not a regular file'), r.stderr);
    srv.close();
    rmSync(optimizer, { force: true });
    writeFileSync(optimizer, '{"ponytail":"full"}\n');
  }

  // The hand-edited YAML config gets the per-key scan on the raw line text: a
  // credential-named key holding a literal refuses, naming the key and the line only.
  put('.omp/agent/config.yml', `deploy_token: plainliteral\n${good}`);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('~/.omp/agent/config.yml:1: deploy_token holds a literal value; reference an env var instead'), r.stderr);
  put('.omp/agent/config.yml', good);

  // A key with no value on its line receives the literal from a deeper line below it,
  // so the scan follows the continuation and refuses.
  put('.omp/agent/config.yml', `credentials:\n    deploy_token:\n        plainliteral\n${good}`);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('~/.omp/agent/config.yml:2: deploy_token holds an indented multiline value; reference an env var instead'), r.stderr);
  put('.omp/agent/config.yml', good);

  // A nested credential key holding a literal value is refused by the per-line scan
  // itself; the &&-guard must not let a continuation call clear an already-bad value.
  put('.omp/agent/config.yml', `credentials:\n  apiKey: secretliteral\n${good}`);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('apiKey holds a literal value'), r.stderr);
  put('.omp/agent/config.yml', good);

  // The only exemption is a numeric value on exactly a maxTokens-style key: decimals and
  // negatives pass, a value with a non-numeric suffix refuses, and the same number on
  // any other key is a literal like any other.
  put('.omp/agent/config.yml', `maxTokens: 12.5\nmax_tokens: -5\napiKey: \${ZAI_API_KEY}\n${good}`);
  r = run();
  assert.equal(r.status, 0, r.stderr);
  put('.omp/agent/config.yml', `maxTokens: 128abc\n${good}`);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('~/.omp/agent/config.yml:1: maxTokens holds a literal value; reference an env var instead'), r.stderr);
  // The exemption anchors both ends: a value that merely ends in digits still refuses,
  // and a value with two decimal digits still passes.
  put('.omp/agent/config.yml', `max_tokens: x-5\n${good}`);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('~/.omp/agent/config.yml:1: max_tokens holds a literal value; reference an env var instead'), r.stderr);
  put('.omp/agent/config.yml', `max_tokens: 12.55\n${good}`);
  r = run();
  assert.equal(r.status, 0, r.stderr);
  put('.omp/agent/config.yml', good);
  put('.omp/agent/config.yml', `apiKey: 42\n${good}`);
  r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('~/.omp/agent/config.yml:1: apiKey holds a literal value; reference an env var instead'), r.stderr);
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
  // this roundtrip hermetic, and it answers --version with the pin because the gate
  // refuses a scanner that does not identify as the pinned build. Windows cannot exec an
  // extensionless stub through spawnSync: there the run needs a real skillspector on
  // PATH (the gate fails closed without one).
  const stub = join(tmp, 'skillspector-stub');
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, 'skillspector'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "SkillSpector v2.13.0"; exit 0; fi\nexit 0\n');
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

    // The memory-backend strip is idempotent, and a config without a top-level memory key
    // stays byte for byte (a BOM can only sit ahead of the text's first key).
    const MEM_LINES = ['a: v', 'memory:', '"memory":', "'memory':", '  backend: hindsight', '  backend: mnemopi',
      '  other: keep', '    deeper: backend: x', '  # note', '', 'b: w', 'theme:', '  dark: x'];
    forAll((rand, size) => {
      const lines = Array.from({ length: Math.floor(rand() * (size + 4)) }, () => MEM_LINES[Math.floor(rand() * MEM_LINES.length)]);
      const text = lines.join('\n') + (rand() < 0.5 ? '\n' : '');
      return rand() < 0.2 ? `\uFEFF${text}` : text;
    }, text => {
      const out = withoutMemoryBackend(text);
      assert.equal(withoutMemoryBackend(out), out, `the strip is idempotent: ${JSON.stringify(text)}`);
      if (!/^(?:\uFEFF)?(?:memory|"(?:memory)"|'(?:memory)')[ \t]*:/m.test(text))
        assert.equal(out, text, `no top-level memory key, no change: ${JSON.stringify(text)}`);
    });
  }

  console.log('sync-user.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
