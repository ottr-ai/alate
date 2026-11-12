// env-proxy: fetch honors HTTP(S)_PROXY only when NODE_USE_ENV_PROXY=1 is set before Node
// starts, so the server re-spawns itself with the flag when a proxy is configured. Run:
// node lib/env-proxy.test.mjs
// The mock servers live in a spawned sibling child ("mockbox") because this sandbox blackholes
// child-to-parent loopback TCP; the fixture is the server stand-in whose first life re-spawns
// through ensureEnvProxy and whose second life fetches a name that resolves only via the proxy.
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

// Server stand-in: the first life awaits ensureEnvProxy (a supervisor once it re-spawns), the
// second life carries NODE_USE_ENV_PROXY=1 and fetches http://example.invalid/ping, a name
// that fails on DNS unless the proxy routes it. Markers share one stdout pipe across lives.
const fixtureSource = `import { ensureEnvProxy } from ${JSON.stringify(repoModuleUrl)};
await ensureEnvProxy();
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

const runFixture = async envOverrides => {
  const child = spawn(process.execPath, [fixturePath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...childEnv, ...envOverrides } });
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

// a. green: proxy configured, flag unset — the fixture re-spawns, the second life carries
// NODE_USE_ENV_PROXY=1, and the fetch returns the origin body through the mock proxy.
{
  const label = 'a. proxy set, flag unset';
  await withMockbox(async (ports, mockboxOut) => {
    const attempt = () => runFixture({ HTTP_PROXY: 'http://127.0.0.1:' + ports.proxy });
    let { code, out } = await attempt();
    // One retry for a sandbox flake: a fetch timeout with no mockbox hit means the proxied
    // exchange never arrived.
    if (!/FETCH\/ok 200/.test(out) && !/HIT (request|connect|origin)/.test(mockboxOut())) {
      ({ code, out } = await attempt());
    }
    assert.match(out, /RESPAWN\/second-life VAR=1\n/, `${label}: the second life runs with NODE_USE_ENV_PROXY=1; output:\n${out}`);
    assert.match(out, /FETCH\/ok 200 pong/, `${label}: the proxied fetch returns the origin body; output:\n${out}`);
    assert.match(mockboxOut(), /HIT (request|connect|origin)/, `${label}: the mockbox saw the proxied exchange; output:\n${mockboxOut()}`);
    assert.equal([...out.matchAll(/RESPAWN\/second-life/g)].length, 1, `${label}: exactly one respawn, the supervisor life prints no marker; output:\n${out}`);
    assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
  });
}

// b. no proxy vars: a single life, no respawn, and the direct fetch fails fast on DNS.
{
  const label = 'b. no proxy vars';
  const { code, out } = await runFixture({});
  assert.match(out, /RESPAWN\/second-life VAR=undefined\n/, `${label}: a single life, the flag stays unset; output:\n${out}`);
  assert.match(out, /FETCH\/err TypeError ENOTFOUND/, `${label}: the direct fetch fails on DNS; output:\n${out}`);
  assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
}

// c. opt-out: NODE_USE_ENV_PROXY=0 plus a proxy var keeps a single life with no proxy routing.
{
  const label = 'c. opt-out';
  const { code, out } = await runFixture({ NODE_USE_ENV_PROXY: '0', HTTP_PROXY: 'http://127.0.0.1:9' });
  assert.match(out, /RESPAWN\/second-life VAR=0\n/, `${label}: NODE_USE_ENV_PROXY=0 keeps a single life; output:\n${out}`);
  assert.match(out, /FETCH\/err TypeError ENOTFOUND/, `${label}: no proxy routing happens; output:\n${out}`);
  assert.equal(code, 0, `${label}: fixture exits clean; output:\n${out}`);
}

// d. unit truth table for shouldSpawnEnvProxy: the node major is an internal default
// parameter, so tests pass 23/24 explicitly.
assert.equal(shouldSpawnEnvProxy({}, 24), false, 'd. no proxy vars means no respawn');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: 'http://p' }, 24), true, 'd. HTTP_PROXY set with the flag unset respawns');
assert.equal(shouldSpawnEnvProxy({ HTTPS_PROXY: 'http://p' }, 24), true, 'd. HTTPS_PROXY counts as set');
assert.equal(shouldSpawnEnvProxy({ http_proxy: 'http://p' }, 24), true, 'd. lowercase http_proxy counts as set');
assert.equal(shouldSpawnEnvProxy({ https_proxy: 'http://p' }, 24), true, 'd. lowercase https_proxy counts as set');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: '' }, 24), false, 'd. an empty proxy value means unset');
assert.equal(shouldSpawnEnvProxy({ NODE_USE_ENV_PROXY: '0', HTTP_PROXY: 'http://p' }, 24), false, 'd. NODE_USE_ENV_PROXY=0 opts out');
assert.equal(shouldSpawnEnvProxy({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://p' }, 24), false, 'd. an explicit flag means no respawn');
assert.equal(shouldSpawnEnvProxy({ HTTP_PROXY: 'http://p' }, 23), false, 'd. Node 23 fetch has no env-proxy support, so no respawn');

rmSync(fixtureDir, { recursive: true, force: true });
console.log('env-proxy tests: all green');
