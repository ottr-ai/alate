// Node parses HTTP(S)_PROXY for fetch at startup only, and only when NODE_USE_ENV_PROXY=1 is
// set before bootstrap. The Docker image sets it; host runs do not, and setting the variable
// in-process has no effect — so when a proxy is configured and the flag is missing, the server
// re-spawns itself with the flag added. The first life becomes a supervisor (forwards
// SIGTERM/SIGINT, mirrors the exit code) and never starts a second server; the spawned life
// runs with proxy-aware fetch, and children inherit the flag via CHILD_ENV_KEYS. Set
// NODE_USE_ENV_PROXY=0 explicitly to opt out.
import { spawn } from 'node:child_process'

export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

function nodeMajorVersion() {
  return Number(process.versions.node.split('.')[0])
}

export function shouldSpawnEnvProxy(env = process.env, nodeMajor = nodeMajorVersion()) {
  if (env.NODE_USE_ENV_PROXY !== undefined) return false
  // An empty string means unset.
  if (!PROXY_ENV_KEYS.some(key => env[key])) return false
  return nodeMajor >= 24
}

export async function ensureEnvProxy() {
  if (!shouldSpawnEnvProxy()) return false
  return new Promise(resolve => {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      execArgv: process.execArgv,
    })
    const forward = signal => { child.kill(signal) }
    const mirror = code => { process.exit(typeof code === 'number' ? code : 1) }
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, forward)
    child.on('exit', mirror)
    child.on('error', err => {
      for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, forward)
      console.error(`env-proxy: respawn failed (${err?.message ?? err}); continuing without NODE_USE_ENV_PROXY`)
      resolve(false)
    })
    // Never resolves while the child runs: the supervisor life must not start a second server.
  })
}
