// Node honors HTTP(S)_PROXY for fetch only when proxy support is enabled, and it reads the
// proxy env at startup. Since Node v24.14 the built-in API http.setGlobalProxyFromEnv()
// applies the current proxy env in-process; on Node 24.12-24.13 the only mechanism is the
// startup-parsed NODE_USE_ENV_PROXY=1, so the server re-spawns itself with the variable
// added (the Docker image sets it). The first life of a re-spawn is a supervisor: it
// forwards SIGTERM/SIGINT, mirrors the exit code, and never starts a second server. The
// re-spawn carries the first life's Node CLI flags (--use-system-ca and friends). Either
// path leaves NODE_USE_ENV_PROXY=1 in the environment, so spawned children inherit
// proxy-aware fetch. Set NODE_USE_ENV_PROXY=0 explicitly to opt out.
import { spawn } from 'node:child_process'
import http from 'node:http'

export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

export function hasBuiltInEnvProxy() {
  return typeof http.setGlobalProxyFromEnv === 'function'
}

function nodeMajorVersion() {
  return Number(process.versions.node.split('.')[0])
}

// True exactly when a runtime without the built-in API needs the re-spawn fallback.
export function shouldSpawnEnvProxy(env = process.env, nodeMajor = nodeMajorVersion(), builtIn = hasBuiltInEnvProxy()) {
  if (env.NODE_USE_ENV_PROXY !== undefined) return false
  // An empty string means unset.
  if (!PROXY_ENV_KEYS.some(key => env[key])) return false
  if (builtIn) return false
  return nodeMajor >= 24
}

// Applies proxy support for this process. Returns false when nothing was re-spawned (the
// caller keeps running); the promise never resolves while a re-spawned child runs, because
// the supervisor life must not start a second server.
export async function ensureEnvProxy(opts = {}) {
  const env = process.env
  if (env.NODE_USE_ENV_PROXY !== undefined) return false
  if (!PROXY_ENV_KEYS.some(key => env[key])) return false
  const builtIn = opts.builtInProxy ?? hasBuiltInEnvProxy()
  if (builtIn) {
    // The built-in API reads the current env at call time.
    http.setGlobalProxyFromEnv()
    // Children spawn fresh and parse the env at startup, so hand them the flag.
    env.NODE_USE_ENV_PROXY = '1'
    return false
  }
  if (!shouldSpawnEnvProxy(env, nodeMajorVersion(), builtIn)) return false
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...env, NODE_USE_ENV_PROXY: '1' },
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
  })
}
