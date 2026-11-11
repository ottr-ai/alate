// Self-check for sync-user.mjs: node sync-user.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forAll, keepTemp, withoutHostPaths, withoutMemoryBackend, yamlProblems } from './lib/data.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'alate-user-'));
const repo = join(tmp, 'repo');
const data = join(tmp, 'data');
const home = join(tmp, 'home');
// install-user children below get a scratch HOME distinct from their --home target: a
// dropped --home (the mutant class behind ALAT-79) installs into the sandbox and fails
// the assertions instead of touching the machine home.
const childHome = join(tmp, 'child-home');
mkdirSync(childHome);
mkdirSync(join(repo, 'lib'), { recursive: true });
mkdirSync(data);
copyFileSync(fileURLToPath(new URL('./sync-user.mjs', import.meta.url)), join(repo, 'sync-user.mjs'));
copyFileSync(fileURLToPath(new URL('./lib/data.mjs', import.meta.url)), join(repo, 'lib/data.mjs'));
// install-user's shipped-skill install reads the pin module and the vendored tree from the
// tool root, so the sandbox provisions the real vendored skills like a real checkout does.
copyFileSync(fileURLToPath(new URL('./lib/shipped.mjs', import.meta.url)), join(repo, 'lib/shipped.mjs'));
cpSync(fileURLToPath(new URL('./shipped/ottr', import.meta.url)), join(repo, 'shipped/ottr'), { recursive: true });
const put = (rel, text) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), text); };
const run = () => spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', home, '--data', data], { encoding: 'utf8' });
const snap = rel => readFileSync(join(data, 'user', rel), 'utf8');
const skillText = (name, body = `# ${name}\n`) => `---\nname: ${name}\ndescription: Test skill.\n---\n${body}`;
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
  put('.omp/agent/skills/mine/SKILL.md', skillText('mine', '# mine\nKeys look like sk-..., ghp_... or AKIA...; use https://user:${PASS}@host.\napiKey: your-key-goes-here\n'));
  put('.omp/agent/skills/mine/__pycache__/x.pyc', 'cache');
  put('.omp/agent/managed-skills/learned/SKILL.md', skillText('learned'));
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
  put('.agents/skills/theirs/SKILL.md', skillText('theirs'));
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

  writeFileSync(join(data, 'user/agents/skills/theirs/SKILL.md'), skillText('theirs').replaceAll('\n', '\r\n')); // line endings only -> not churned
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
    assert.equal(snap('agents/skills/theirs/SKILL.md'), skillText('theirs').replaceAll('\n', '\r\n'), 'a refused run syncs nothing');
  }
  put('.agents/skills/theirs/SKILL.md', skillText('theirs'));

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
  assert.ok(r.stderr.includes('~/.omp/agent/mcp.json: "apiKey" holds a literal value; use "$VAR" in mcp.json, put the value in workers/<project>/env.txt, and set it in Ottr Settings -> Env'), r.stderr);
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
  assert.ok(!r.stderr.includes('use "$VAR" in mcp.json'), 'the YAML refusal keeps its own env-var advice, not the mcp.json fix');
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

  // The credential scalar scanners (scalarProblem/yamlScalar/yamlValueProblem/
  // continuationProblem) judge every secret-named key in the hand-edited YAML config.
  // One packed refusal run names each offending key at its exact line; the companion
  // acceptance runs hold every shape that must stay valid, so a mutated scanner flips
  // one of the two outcomes.
  {
    const rel = '.omp/agent/config.yml';
    const restore = () => put(rel, good);
    // [line, exact problem message]: every refusal edge of the credential scanners,
    // each pinned to its own line so a flipped message can never hide behind a sibling.
    const LIT = 'holds a literal value; reference an env var instead';
    const BLK = 'holds a YAML block; reference an env var instead';
    const bad = [
      ['api_key: "quoted literal"', LIT],   // quoted string is still a literal
      ["secret2: 'Bearer abc'", LIT],       // quoted Bearer prefix, literal token
      ['password: Basic abc', LIT],         // bare Basic prefix, literal token
      ['credential: |', BLK],               // block indicator
      ['private_key: >2', BLK],             // block indicator with chomping digit
      ['token: "true"', LIT],               // quoted boolean spelling is a string
      ['authorization: ${VAR}x', LIT],      // env ref with trailing junk
      ['api_key2: $V#tail', LIT],           // '#' needs whitespace to be a comment
      ['api_key3: "halfopen', LIT],         // unbalanced quote is not a quoted scalar
      ['token2: $V extra', LIT],            // env ref with a second word
      ['secret3: ${VAR', LIT],              // unclosed brace is not a reference
      ['private_key2: $1BAD', LIT],         // reference must start with a letter/underscore
      ['authorization2: ${A B}', LIT],      // brace form allows word characters only
      ['api_key4: $', LIT],                 // a bare '$' is not a reference
      ['api_key5: $ $V', LIT],              // a reference must start the value
      ['api_key6: |x', LIT],                // '|' followed by text is a literal, not a block
      ['api_key9: x|2', LIT],               // a trailing block indicator is still a literal
      ['private_key3: xtrue', LIT],         // a boolean spelling must be the whole value
      ['private_key4: trueX', LIT],         // ...anchored at both ends, case-insensitively
    ];
    put(rel, bad.map(([line]) => line).join('\n') + '\n');
    r = run();
    assert.equal(r.status, 1, r.stderr);
    for (let i = 0; i < bad.length; i++) {
      const key = bad[i][0].slice(0, bad[i][0].indexOf(':'));
      assert.ok(r.stderr.includes(`~/${rel}:${i + 1}: ${key} ${bad[i][1]}`), `line ${i + 1} (${bad[i][0]}): ${r.stderr}`);
    }
    restore();

    // Quoted env references and Bearer/Basic prefixes stay valid: the quotes and the
    // case-insensitive prefix must be stripped before the reference check, any amount
    // of prefix whitespace included, and whitespace inside the quotes trimmed away.
    put(rel, [
      'api_key: "$V"',
      "secret: '$W'",
      'password: "Bearer $T"',
      "token: 'Basic $T2'",
      'password2: Bearer  $T3', // double space after the prefix
      'token4: BASIC $B',       // uppercase prefix
      'apiKey: " $V"',          // padding inside the quotes
    ].join('\n') + '\n');
    r = run();
    assert.equal(r.status, 0, r.stderr);
    restore();

    // Unquoted true/false/null/~ are real scalars and stay inert where the same
    // spellings quoted refuse; comment tails and comment-only values are prose;
    // an empty value with no deeper continuation line is nothing to judge; a
    // continuation skips comments and blanks, and `key:` at the very end holds nothing.
    put(rel, [
      'token: true',
      'password: False',
      'credential: ~',
      'private_key: null',
      'secret2: $OK',
      'apiKey:   $SPACED', // surrounding whitespace
      'apiKey6: $T3   ',   // trailing whitespace after the reference
      'token3: $V # trailing comment',
      'authorization: # only a comment',
      'credentials:',
      'apiKey2:',
      'apiKey4: ""',
      'apiKey7:',
      '  # note',
      'sib2: ${V}',
      'apiKey8:',
      '    # deep note',
      'sib3: ${V}',
      'last: ${W}',
      'apiKey5:',
    ].join('\n') + '\n');
    r = run();
    assert.equal(r.status, 0, r.stderr);
    restore();

    // A `key:` with no value receives the first meaningful line below it: blank lines
    // and comments are skipped, and an indented literal deeper than the key refuses.
    put(rel, 'apiKey:\n\n  # note\n  deeperliteral\n');
    r = run();
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(`~/${rel}:1: apiKey holds an indented multiline value; reference an env var instead`), r.stderr);
    restore();

    // A continuation line at the same indent as the key is a sibling, not a literal.
    put(rel, 'credentials:\nsibling: ${V}\n');
    r = run();
    assert.equal(r.status, 0, r.stderr);
    restore();
  }

  // The mcp.json scan parses before matching, so scalarProblem judges the raw JSON
  // string: a lone quote character is not a quoted scalar, and a quoted Bearer value
  // that trims to nothing still refuses.
  {
    put('.omp/agent/config.yml', good);
    const rel = '.omp/agent/mcp.json';
    put(rel, JSON.stringify({ mcpServers: { gh: { env: { API_KEY2: '"', TOKEN2: 'Bearer ', PASSWORD2: '"$V$' } } } }, null, 2));
    r = run();
    assert.equal(r.status, 1, r.stderr);
    // The literal-value tail is the mcp.json fix this branch added; the scalar edges
    // under it are the pulled pins, kept verbatim.
    const jsonFix = 'use "$VAR" in mcp.json, put the value in workers/<project>/env.txt, and set it in Ottr Settings -> Env';
    assert.ok(r.stderr.includes(`~/${rel}: "API_KEY2" holds a literal value; ${jsonFix}`), r.stderr);
    assert.ok(r.stderr.includes(`~/${rel}: "TOKEN2" holds a literal value; ${jsonFix}`), r.stderr);
    assert.ok(r.stderr.includes(`~/${rel}: "PASSWORD2" holds a literal value; ${jsonFix}`), r.stderr);
    // A JSON env reference keeps the surrounding whitespace of the raw string, and a
    // quoted reference with interior padding still resolves to an env var.
    put(rel, JSON.stringify({ mcpServers: { gh: { env: { API_KEY: ' $V ', SECRET: '" $V"' } } } }, null, 2));
    r = run();
    assert.equal(r.status, 0, r.stderr);
    put('.omp/agent/mcp.json', JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }, headers: { Authorization: 'Bearer ${GH_PAT}' } } } }, null, 2));
    put('.omp/agent/config.yml', good);
  }

  // The exported YAML syntax gate refuses exactly the constructs it cannot decode;
  // these unit cases pin every documented refusal and acceptance edge of yamlProblems.
  {
    const issues = text => yamlProblems(text, 'c.yml');
    const ok = (text, why) => assert.deepEqual(issues(text), [], `${why ?? 'accepted'}: ${JSON.stringify(text)}`);
    const bad = (text, why) => assert.ok(issues(text).some(s => s.includes(`unsupported YAML syntax (${why})`)), `${why}: ${JSON.stringify(text)}`);

    // Acceptance edges: one-line block style in all its shapes.
    ok('k: v\n', 'plain scalar');
    ok('---\nk: v\n', 'leading document marker');
    ok(' ---\nk: v\n', 'indented document marker');
    ok('---\t\nk: v\n', 'tab after the document marker');
    ok("k: 'it''s'\n", "'' escape in a single-quoted scalar");
    ok('k: "open" tail\n', 'closed double quote');
    ok('"key": v\n', 'double-quoted key');
    ok("'key': v\n", 'single-quoted key');
    ok('# whole line\nk: v # tail\n', 'comments');
    ok('k: v#nospace\n', "'#' glued to the value is not a comment");
    ok('- a\n- b: c\n', 'sequence entries');
    ok('parent:\n  child: v\n  list:\n    - x\n', 'nested mappings and sequences');
    ok('k: v\r\nj: w\r\n', 'CRLF line endings');
    ok('a:b\n', "colon without a following space is not a key separator");
    ok('k:\n\n\n', 'empty value');
    ok('k: ${V} # x\n', 'env reference with a comment tail');

    // Refusal edges, one per documented construct.
    bad('%X 1.2\n', 'directive');
    bad('  %X\n', 'directive');
    bad('k: v\n...\n', 'end-of-document marker');
    bad('...\n', 'end-of-document marker');
    bad('---\nk: v\n---\nj: w\n', 'multi-document file');
    bad('k: v\n---\n', 'multi-document file');
    bad('---\n---\n', 'multi-document file');
    bad(' --- "open\n', 'quoted scalar spans lines'); // a marker-prefix match must not skip the scan
    bad('x " ---\n', 'quoted scalar spans lines');    // '---' mid-line is not a document marker
    ok('-* x\n');                          // '-' only starts a marker before a space
    bad('- &x\n', 'node indicator "&"');   // ...and the next node may still be anchored
    ok('#x: &y\n');                        // a whole-line comment hides everything after it
    ok('"k"&x\n', 'a closed quote leaves the rest of the line inert');
    ok("'k'&x\n");
    bad('k: v#x: &y\n', 'node indicator "&"'); // '#' glued to a value does not comment out the tail
    bad('k: v# x: &y\n', 'node indicator "&"'); // ...and the break looks behind, not ahead
    ok('x:y:&\n');                         // a colon without a trailing space never restarts a key
    ok('k: <x\n');                         // a lone '<' is not a merge key
    ok('k: v<x\n');                        // nor is any node character before one
    bad('k: "a\\nb"\n', 'escape in a double-quoted scalar');
    bad('"k\\t": v\n', 'escape in a double-quoted scalar');
    bad('k: "open\nnever\n', 'quoted scalar spans lines');
    bad("k: 'open\nnever\n", 'quoted scalar spans lines');
    bad('<<: *base\n', 'merge key');
    bad('k:\n  <<: *base\n', 'merge key');
    for (const ch of ['&', '*', '!', '%', '@', '?', '[', ']', '{', '}', ',', '|', '>', '`']) {
      const line = ch === '%' ? 'k: %v\n' : `${ch} x\n`;
      bad(line, `node indicator "${ch}"`);
    }

    // The refusal message names the file, the line, and the construct.
    assert.deepEqual(issues('k: &a v\n'),
      ['~/c.yml:1: unsupported YAML syntax (node indicator "&"); keep c.yml one-line block style']);
  }

  rmSync(join(home, '.omp/plugins/bun.lock'));
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('~/.omp/plugins/bun.lock: not present'), r.stdout);
  assert.ok(r.stdout.includes('note: user/omp/plugins/bun.lock is gone from this machine'), r.stdout);
  assert.ok(existsSync(join(data, 'user/omp/plugins/bun.lock')), 'stale copies are never deleted');

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
  // The pinned version travels with install-user.mjs: parsing it here keeps stub and gate
  // from drifting, and the nonexistent venv path makes the run resolve the PATH stub.
  const pin = readFileSync(join(repo, 'install-user.mjs'), 'utf8').match(/^const SKILLSPECTOR_REF = '([^']+)';$/m)?.[1];
  assert.ok(pin, 'install-user.mjs must pin SKILLSPECTOR_REF');
  writeFileSync(join(stub, 'skillspector'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "SkillSpector ${pin}"; exit 0; fi\nexit 0\n`);
  chmodSync(join(stub, 'skillspector'), 0o755);
  const stubEnv = { ...process.env, HOME: childHome, USERPROFILE: childHome, SKILLSPECTOR_VENV: join(tmp, 'no-venv') };
  delete stubEnv.PI_CODING_AGENT_DIR;
  if (process.platform !== 'win32') stubEnv.PATH = `${stub}${delimiter}${stubEnv.PATH ?? ''}`;
  put('.omp/plugins/bun.lock', '{}'); // restore the fixture the removal above deleted
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
  // A home without patches/ still captures: no ITEMS entry is required any more.
  const plainHome = name => {
    const h = join(tmp, name);
    for (const it of ['.omp/agent/config.yml', '.omp/agent/mcp.json', '.omp/agent/optimizer.json',
      '.pi/agent/pix.json', '.omp/marketplaces.json', '.omp/plugins/package.json',
      '.omp/plugins/bun.lock', '.omp/plugins/omp-plugins.lock.json',
      '.omp/plugins/installed_plugins.json', '.agents/.skill-lock.json']) {
      mkdirSync(join(h, it, '..'), { recursive: true });
      writeFileSync(join(h, it), it.endsWith('.json') || it.endsWith('.lock') ? '{}' : 'k: ${V}\n');
    }
    for (const d of ['.omp/agent/extensions', '.omp/agent/skills', '.omp/agent/managed-skills', '.agents/skills'])
      mkdirSync(join(h, d), { recursive: true });
    return h;
  };
  const nopatch = plainHome('home-nopatch');
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', nopatch, '--data', data], { encoding: 'utf8' });
  assert.equal(r2.status, 0, `a home without patches/ must still capture: ${r2.stderr}`);

  // A normal fresh Windows omp home misses all four state files. Their absence is never
  // an error: each is one 'not present' line, and the present items still capture.
  const winhome = plainHome('home-windows-missing');
  const WIN_MISSING = ['.pi/agent/pix.json', '.omp/agent/skills', '.omp/marketplaces.json', '.omp/plugins/installed_plugins.json'];
  for (const it of WIN_MISSING) rmSync(join(winhome, it), { recursive: true });
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', winhome, '--data', data], { encoding: 'utf8' });
  assert.equal(r2.status, 0, `a fresh Windows home must capture: ${r2.stderr}`);
  for (const it of WIN_MISSING)
    assert.ok(r2.stdout.includes(`~/${it}: not present`), `no 'not present' line for ${it}: ${r2.stdout}`);
  assert.ok(r2.stdout.includes('~/.omp/agent/config.yml: captured'), r2.stdout);
  assert.ok(!r2.stderr, `an absence must not refuse: ${r2.stderr}`);

  // A partial home: the present items capture, the absent ones are 'not present', and
  // nothing refuses. A fresh data dir proves exactly what the run writes.
  const partHome = join(tmp, 'home-partial');
  mkdirSync(join(partHome, '.omp/agent'), { recursive: true });
  writeFileSync(join(partHome, '.omp/agent/config.yml'), 'modelRoles:\n  default: zai/glm\n');
  mkdirSync(join(partHome, '.agents'), { recursive: true });
  writeFileSync(join(partHome, '.agents/.skill-lock.json'), '{"skills":{}}\n');
  const partData = join(tmp, 'data-partial');
  mkdirSync(partData);
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', partHome, '--data', partData], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes('~/.omp/agent/config.yml: captured'), r2.stdout);
  assert.ok(r2.stdout.includes('~/.agents/.skill-lock.json: captured'), r2.stdout);
  assert.ok(r2.stdout.includes('~/.pi/agent/pix.json: not present'), r2.stdout);
  assert.ok(r2.stdout.includes('~/.omp/agent/skills: not present'), r2.stdout);
  assert.match(r2.stdout, /2 added, 0 updated, 0 unchanged/);
  assert.equal(readFileSync(join(partData, 'user/omp/agent/config.yml'), 'utf8'), 'modelRoles:\n  default: zai/glm\n');
  assert.ok(!existsSync(join(partData, 'user/pi')), 'an absent item writes nothing');

  // A secret in a present item still refuses, even with most of the home absent.
  writeFileSync(join(partHome, '.omp/agent/config.yml'), `apiKey: ${FAKES['GitHub token']}\n`);
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', partHome, '--data', partData], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Nothing synced/);
  assert.ok(r2.stderr.includes('~/.omp/agent/config.yml:1: possible GitHub token'), r2.stderr);
  assert.equal(readFileSync(join(partData, 'user/omp/agent/config.yml'), 'utf8'), 'modelRoles:\n  default: zai/glm\n', 'a refused run syncs nothing');

  // An empty home: exit 0, no item captured, nothing written to the data repo.
  const emptyHome = join(tmp, 'home-empty');
  mkdirSync(emptyHome);
  const emptyData = join(tmp, 'data-empty');
  mkdirSync(emptyData);
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', emptyHome, '--data', emptyData], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes('nothing to capture'), r2.stdout);
  assert.ok(!r2.stdout.includes(': captured'), r2.stdout);
  assert.ok(!existsSync(join(emptyData, 'user')), 'an empty home writes nothing to the data repo');

  // The machine shell setup never rides the snapshot: a top-level shellPath: and the
  // skills.customDirectories entries name absolute paths of the capture host, and the
  // worker that installs the snapshot cannot use them. Capture strips both and says so;
  // the rest of the config stays byte for byte.
  const shellhome = plainHome('home-shell-setup');
  // The card's shape: a YAML flow list. The strip runs before the fail-closed syntax gate,
  // so the machine-only entry leaves before the gate judges the portable text — a flow list
  // in a portable key (the gate refuses those) must not take the capture down with it.
  writeFileSync(join(shellhome, '.omp/agent/config.yml'),
    'modelRoles:\n  default: zai/glm\nshellPath: C:\\Program Files\\PowerShell\\7\\pwsh.exe\n' +
    'skills:\n  customDirectories: [C:/Users/dev/omp-skills]\n  theme: portable\n');
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', shellhome, '--data', data], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes('note: user/omp/agent/config.yml: dropped the machine shell setup (shellPath, skills.customDirectories)'), r2.stdout);
  const clean = snap('omp/agent/config.yml');
  assert.ok(!/(?:shellPath|customDirectories|[A-Za-z]:[\\/])/.test(clean), `host paths survived the capture: ${clean}`);
  assert.equal(clean, 'modelRoles:\n  default: zai/glm\nskills:\n  theme: portable\n', clean);
  // The block style captures clean the same way.
  writeFileSync(join(shellhome, '.omp/agent/config.yml'),
    'modelRoles:\n  default: zai/glm\nshellPath: C:\\Program Files\\PowerShell\\7\\pwsh.exe\n' +
    'skills:\n  customDirectories:\n    - C:/Users/dev/omp-skills\n  theme: portable\n');
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', shellhome, '--data', data], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(snap('omp/agent/config.yml'), clean, 'block style strips to the same portable text');
  // A CRLF config (the Windows norm) strips too: kept lines keep their '\r', host keys leave.
  // A fresh data dir, so the snapshot bytes are written from this run: the shared data dir
  // would count the CRLF text as unchanged (normText is CRLF-stable) and keep the LF copy.
  const dataCrlf = join(tmp, 'data-crlf');
  mkdirSync(dataCrlf);
  writeFileSync(join(shellhome, '.omp/agent/config.yml'),
    'modelRoles:\r\n  default: zai/glm\r\nshellPath: C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n' +
    'skills:\r\n  customDirectories: [C:/Users/dev/omp-skills]\r\n  theme: portable\r\n');
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', shellhome, '--data', dataCrlf], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(dataCrlf, 'user/omp/agent/config.yml'), 'utf8'), clean.replaceAll('\n', '\r\n'), 'CRLF strips to the CRLF portable text');
  // The gate still judges the portable text: syntax the strip does not remove refuses, and
  // the machine shell entry next to it cannot smuggle the capture past the scan.
  writeFileSync(join(shellhome, '.omp/agent/config.yml'),
    'shellPath: C:\\x\\pwsh.exe\nnote: "pa\\u0073sword123"\n');
  r2 = spawnSync(process.execPath, [join(repo, 'sync-user.mjs'), '--home', shellhome, '--data', data], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /escape in a double-quoted scalar/);

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

    // The host-path strip: exact shapes, then the same two properties as the memory
    // backend over a line soup (flow and block customDirectories values, shellPath entries,
    // sequence items at the parent key's indent, comments, blanks, quoted keys, a BOM).
    const HOST_CASES = [
      ['a: v\nskills:\n  customDirectories: [C:/u/one, C:/u/two]\n  other: keep\nb: w\n', 'a: v\nskills:\n  other: keep\nb: w\n'],
      ['skills:\n  customDirectories:\n    - C:/a\n    - C:/b\n  other: keep\n', 'skills:\n  other: keep\n'],
      ['skills:\n  customDirectories:\n  - C:/a\n  - C:/b\n  other: keep\n', 'skills:\n  other: keep\n'],
      ['a: v\nskills:\n  customDirectories:\n  - C:/a\nb: w\n', 'a: v\nb: w\n'],
      ['shellPath: C:\\Prog\\pwsh.exe\na: v\n', 'a: v\n'],
      ['a: v\nshellPath: C:\\x', 'a: v\n'], // a dropped tail gets the terminator back
      ['"shellPath": C:\\x\n\'skills\':\n  "customDirectories": [C:/a]\n', ''],
      ['\uFEFFshellPath: C:\\x\na: v\n', 'a: v\n'],
      ['skills:\n  custom:\n    customDirectories: [C:/a]\n', 'skills:\n  custom:\n    customDirectories: [C:/a]\n'], // deeper than a direct child: stays
      ['shell: x\nshellPathX: y\nskills2:\n  customDirectoriesX: [C:/a]\n', 'shell: x\nshellPathX: y\nskills2:\n  customDirectoriesX: [C:/a]\n'],
      ['skills:\n  customDirectories: [C:/a]\n  # about otherDirs\n  otherDirs: [D:/b]\n', 'skills:\n  # about otherDirs\n  otherDirs: [D:/b]\n'], // a flow entry ends on its key line: the comment stays
      ['skills:\n  customDirectories:\n  - C:/a\n  # about otherDirs\n  otherDirs: [D:/b]\n', 'skills:\n  otherDirs: [D:/b]\n'], // a block entry's region ends at the next sibling: the comment between goes with it
      ['theme:\n  dark: x\n', 'theme:\n  dark: x\n'],
      ['a: v', 'a: v'], // no final newline, nothing dropped: byte for byte
      ['skills:', 'skills:'],
      // A CRLF config (the Windows norm) strips identically: every kept line keeps its '\r'.
      ['a: v\r\nskills:\r\n  customDirectories: [C:/a]\r\n  other: keep\r\n', 'a: v\r\nskills:\r\n  other: keep\r\n'],
      ['shellPath: C:\\x\r\na: v\r\n', 'a: v\r\n'],
      ['skills:\r\n  customDirectories:\r\n    - C:/a\r\nb: w\r\n', 'b: w\r\n'],
    ];
    for (const [input, want] of HOST_CASES)
      assert.equal(withoutHostPaths(input), want, `strip of ${JSON.stringify(input)}`);

    const HOST_LINES = ['a: v', 'shellPath: C:\\x\\pwsh.exe', '"shellPath": C:\\x', "'shellPath': C:\\x",
      'skills:', '"skills":', "'skills':", '  customDirectories: [C:/u]', '  customDirectories:',
      '  - C:/a', '    - C:/d', '  other: keep', '    deeper: x', '  # note', '', 'b: w', 'theme:', '  dark: x', '- C:/top'];
    const PLAIN_LINES = HOST_LINES.filter(l => !/shellPath|[Cc]ustomDirectories|skills/.test(l));
    forAll((rand, size) => {
      const lines = Array.from({ length: Math.floor(rand() * (size + 4)) }, () => HOST_LINES[Math.floor(rand() * HOST_LINES.length)]);
      const text = lines.join('\n') + (rand() < 0.5 ? '\n' : '');
      return rand() < 0.2 ? `\uFEFF${text}` : text;
    }, text => {
      const out = withoutHostPaths(text);
      assert.equal(withoutHostPaths(out), out, `the strip is idempotent: ${JSON.stringify(text)}`);
    });
    forAll((rand, size) => {
      const lines = Array.from({ length: Math.floor(rand() * (size + 4)) }, () => PLAIN_LINES[Math.floor(rand() * PLAIN_LINES.length)]);
      return lines.join('\n') + (rand() < 0.5 ? '\n' : '');
    }, text => {
      assert.equal(withoutHostPaths(text), text, `no host keys, no change: ${JSON.stringify(text)}`);
    });
  }

  console.log('sync-user.mjs ok');
} finally {
  if (!keepTemp()) rmSync(tmp, { recursive: true, force: true });
}
