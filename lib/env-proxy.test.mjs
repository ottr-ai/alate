// env-proxy: fetch honors HTTP(S)_PROXY only when proxy support is enabled. On Node 24.14+
// the built-in http.setGlobalProxyFromEnv() applies the current proxy env in-process; on
// Node 24.12-24.13 the only mechanism is the startup-parsed NODE_USE_ENV_PROXY=1, so the
// server re-spawns itself with the flag. Run: node lib/env-proxy.test.mjs
// The mock servers live in a spawned sibling child ("mockbox") because this sandbox blackholes
// child-to-parent loopback TCP; the fixture is the server stand-in whose entry exercises
// ensureEnvProxy and then fetches a name that resolves only via the proxy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldSpawnEnvProxy } from './env-proxy.mjs';

const fixtureDir = mkdtempSync(join(tmpdir(), 'env-proxy-test-'));
// Absolute file URL of the repo module under test, embedded into the fixture source.
const repoModuleUrl = new URL('./env-proxy.mjs', import.meta.url).href;

// One process hosts the origin (replies 'pong') and the CONNECT-capable proxy. It prints
// PORTS=<origin>:<proxy> once both listen, one HIT line per proxied exchange, and exits on
// DONE on stdin, on stdin close, or at the hard timer.
const mockboxSource = `import http from 'node:http';
import net from 'node:net';
let originPort = 0;
const origin = http.createServer((req, res) => {
  console.log('HIT origin');
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('pong');
});
origin.listen(0, '127.0.0.1', () => {
  originPort = origin.address().port;
  proxy.listen(0, '127.0.0.1', () => {
    console.log('PORTS=' + originPort + ':' + proxy.address().port);
  });
});
const proxy = http.createServer((req, res) => {
  console.log('HIT request');
  const url = new URL(req.url, 'http://fixture.invalid');
  const up = http.request({
    host: '127.0.0.1',
    port: originPort,
    path: url.pathname + url.search,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + originPort }),
  }, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
  req.pipe(up);
});
proxy.on('connect', (req, socket, head) => {
  console.log('HIT connect');
  const up = net.connect({ host: '127.0.0.1', port: originPort });
  up.on('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (chunk.trim() === 'DONE') process.exit(0); });
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
setTimeout(() => process.exit(1), 60_000);
`;

// Server stand-in: the entry mirrors server.ts. FIXTURE_RUNTIME_PROXY sets the proxy env at
// runtime (proving the built-in API reads env at call time); FIXTURE_FORCE_RESPAWN drives the
// re-spawn branch even where the built-in API exists. Both lives share one stdout pipe.
const fixtureSource = `import { ensureEnvProxy } from ${JSON.stringify(repoModuleUrl)};
if (process.env.FIXTURE_RUNTIME_PROXY) process.env.HTTP_PROXY = process.env.FIXTURE_RUNTIME_PROXY;
console.log('ENTRY/VAR=' + String(process.env.NODE_USE_ENV_PROXY));
console.log('EXECARGV=' + JSON.stringify(process.execArgv));
const opts = process.env.FIXTURE_FORCE_RESPAWN ? { builtInProxy: false } : {};
await ensureEnvProxy(opts);
console.log('RESPAWN/second-life VAR=' + String(process.env.NODE_USE_ENV_PROXY));
try {
  const r = await fetch('http://example.invalid/ping', { signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  console.log('FETCH/ok ' + r.status + ' ' + text);
} catch (err) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  console.log('FETCH/err ' + ((err && err.name) || 'Error') + ' ' + code);
}
`;

const mockboxPath = join(fixtureDir, 'mockbox.mjs');
const fixturePath = join(fixtureDir, 'fixture.mjs');
writeFileSync(mockboxPath, mockboxSource);
writeFileSync(fixturePath, fixtureSource);

const childEnv = { PATH: process.env.PATH ?? '', HOME: fixtureDir };

const runFixture = async (envOverrides, nodeArgs = []) => {
  const child = spawn(process.execPath, [...nodeArgs, fixturePath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...childEnv, ...envOverrides } });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    setTimeout(() => reject(new Error('fixture did not exit; output so far:\n' + out)), 30_000).unref();
  });
  return { code, out };
};

const withMockbox = async fn => {
  const box = spawn(process.execPath, [mockboxPath], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  box.stdin.on('error', () => {});
  let out = '';
  box.stdout.on('data', chunk => { out += chunk; });
  box.stderr.on('data', chunk => { out += chunk; });
  const ports = await new Promise((resolve, reject) => {
    const scan = () => {
      const m = /PORTS=(\d+):(\d+)/.exec(out);
      if (m) resolve({ origin: Number(m[1]), proxy: Number(m[2]) });
      return Boolean(m);
    };
    if (!scan()) {
      box.stdout.on('data', scan);
      setTimeout(() => reject(new Error('mockbox did not report PORTS; output so far:\n' + out)), 10_000).unref();
    }
  });
  try {
    return await fn(ports, () => out);
  } finally {
    box.stdin.end('DONE\n'); // self-termination request; the mockbox hard timer is the backstop
  }
};

// a. built-in path: the proxy env is set at runtime, and ensureEnvProxy applies it in-process:
// one life, no re-spawn, the flag set afterwards for children, and the proxied fetch returns
// the origin body.
{
  const label = 'a. built-in in-process apply';
  await withMockbox(async (ports, mockboxOut) => {
    const attempt = () => runFixture({ FIXTURE_RUNTIME_PROXY: 'http://127.0.0.1:' + ports.proxy });
    let { code, out } = await attempt();
    // One retry for a sandbox flake: a fetch timeout with no mockbox hit means the proxied
    // exchange never arrived.
    if (!/FETCH\/ok 200/.test(out) && !/HIT (request|connect|origin)/.test(mockboxOut())) {
      ({ code, out } = await attempt());
    }
    const entryLines = [...out.matchAll(/ENTRY\/VAR=(.*)/g)].map(m => m[1]);
    assert.deepEqual(entryLines, ['undefined'], `${label}: one life only, no re-spawn happened, flag unset at entry; output:\n${out}`);
    assert.match(out, /RESPAWN\/second-life VAR=1\n/, `${label}: the flag is set afterwards so children inherit it; output:\n${out}`);
    assert.match(out, /FETCH\/ok 200 pong/, `${label}: the proxied fetch returns the origin body; output:\n${out}`);
    assert.match(mockboxOut(), /HIT (request|connect|origin)/, `${label}: the mockbox saw the proxied exchange; output:\n${mockboxOut()}`);
    assert.equal([...out.matchAll(/RESPAWN\/second-life/g)].length, 1, `${label}: exactly one life printed the marker; output:\n${out}`);
    assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
  });
}

// b. no proxy vars: a single life, no respawn, and the direct fetch fails fast on DNS.
{
  const label = 'b. no proxy vars';
  const { code, out } = await runFixture({});
  assert.match(out, /ENTRY\/VAR=undefined\n/, `${label}: a single life, the flag stays unset; output:\n${out}`);
  assert.match(out, /RESPAWN\/second-life VAR=undefined\n/, `${label}: the flag stays unset; output:\n${out}`);
  assert.match(out, /FETCH\/err TypeError ENOTFOUND/, `${label}: the direct fetch fails on DNS; output:\n${out}`);
  assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
}

// c. opt-out: NODE_USE_ENV_PROXY=0 plus a proxy var keeps a single life with no proxy routing.
{
  const label = 'c. opt-out';
  const { code, out } = await runFixture({ NODE_USE_ENV_PROXY: '0', HTTP_PROXY: 'http://127.0.0.1:9' });
  assert.match(out, /ENTRY\/VAR=0\n/, `${label}: NODE_USE_ENV_PROXY=0 keeps a single life; output:\n${out}`);
  assert.match(out, /FETCH\/err TypeError ENOTFOUND/, `${label}: no proxy routing happens; output:\n${out}`);
  assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
}

// r. re-spawn fallback (forced): on a runtime without the built-in API the first life becomes
// a supervisor, the second life boots with the flag, and the proxied fetch succeeds.
{
  const label = 'r. re-spawn fallback';
  await withMockbox(async (ports, mockboxOut) => {
    const attempt = () => runFixture({ HTTP_PROXY: 'http://127.0.0.1:' + ports.proxy, FIXTURE_FORCE_RESPAWN: '1' });
    let { code, out } = await attempt();
    if (!/FETCH\/ok 200/.test(out) && !/HIT (request|connect|origin)/.test(mockboxOut())) {
      ({ code, out } = await attempt());
    }
    assert.match(out, /ENTRY\/VAR=1\n/, `${label}: the second life boots with the flag set; output:\n${out}`);
    assert.match(out, /FETCH\/ok 200 pong/, `${label}: the proxied fetch returns the origin body; output:\n${out}`);
    assert.match(mockboxOut(), /HIT (request|connect|origin)/, `${label}: the mockbox saw the proxied exchange; output:\n${mockboxOut()}`);
    assert.equal([...out.matchAll(/RESPAWN\/second-life/g)].length, 1, `${label}: exactly one re-spawned life; output:\n${out}`);
    assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
  });
}

// e. re-spawn carries the first life's Node CLI flags: a runtime without the built-in API must
// not lose --use-system-ca or friends across the re-spawn.
{
  const label = 'e. re-spawn carries execArgv';
  await withMockbox(async (ports, mockboxOut) => {
    const attempt = () => runFixture({ HTTP_PROXY: 'http://127.0.0.1:' + ports.proxy, FIXTURE_FORCE_RESPAWN: '1' }, ['--max-old-space-size=64']);
    let { code, out } = await attempt();
    if (!/FETCH\/ok 200/.test(out) && !/HIT (request|connect|origin)/.test(mockboxOut())) {
      ({ code, out } = await attempt());
    }
    const argvLines = [...out.matchAll(/EXECARGV=(.*)/g)].map(m => m[1]);
    assert.ok(argvLines.length >= 2, `${label}: both lives report execArgv; output:\n${out}`);
    assert.equal(argvLines.at(-1), JSON.stringify(['--max-old-space-size=64']), `${label}: the re-spawned life keeps the Node CLI flags; output:\n${out}`);
    assert.match(out, /FETCH\/ok 200 pong/, `${label}: the proxied fetch still returns the origin body; output:\n${out}`);
    assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
  });
}

// d. unit truth table for shouldSpawnEnvProxy: the re-spawn is the fallback for runtimes
// without the built-in API; the built-in path never re-spawns. The node major is an internal
// default parameter, so tests pass 23/24 explicitly.
assert.equal(shouldSpawnEnvProxy({}, 24, false), false, 'd. no proxy vars means no respawn');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: 'http://p' }, 24, false), true, 'd. proxy var without the built-in API respawns');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: 'http://p' }, 24, true), false, 'd. the built-in API applies in-process, so no respawn');
assert.equal(shouldSpawnEnvProxy({ HTTPS_PROXY: 'http://p' }, 24, false), true, 'd. HTTPS_PROXY counts as set');
assert.equal(shouldSpawnEnvProxy({ http_proxy: 'http://p' }, 24, false), true, 'd. lowercase http_proxy counts as set');
assert.equal(shouldSpawnEnvProxy({ https_proxy: 'http://p' }, 24, false), true, 'd. lowercase https_proxy counts as set');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: '' }, 24, false), false, 'd. an empty proxy value means unset');
assert.equal(shouldSpawnEnvProxy({ NODE_USE_ENV_PROXY: '0', HTTP_PROXY: 'http://p' }, 24, false), false, 'd. NODE_USE_ENV_PROXY=0 opts out');
assert.equal(shouldSpawnEnvProxy({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://p' }, 24, false), false, 'd. an explicit flag means no respawn');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: 'http://p' }, 23, false), false, 'd. Node 23 fetch has no env-proxy support, so no respawn');

rmSync(fixtureDir, { recursive: true, force: true });
console.log('env-proxy tests: all green');
