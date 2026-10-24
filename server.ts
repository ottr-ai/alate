// alate server: provisioning API + inventory dashboard UI (single server; the standalone dashboard server was folded in).
// Run directly: node server.ts (Node type stripping, no build step).
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import fastify from 'fastify'
import { cleanupData, parseDataSpec, redactSecrets } from './lib/data.mjs'
import { applyFileEdit, importSource, listStoredFiles, loadState, readStoredFile, remoteHead, snapshotData } from './web/dashboard.mjs'
import { checkUpdates, initUpdates, loadUpdates } from './lib/updates.mjs'

const repoRoot = import.meta.dirname
const CONFIG_FILE = flagValue('--config') ?? join(repoRoot, 'server-config.json')
const CAP = 200000
const SCRIPTS = ['sync.mjs', 'install-user.mjs']
const KNOWN_ROUTES = ['/health', '/config', '/provision', '/api/updates', '/api/files', '/api/file']

interface UpdateState { lastChecked: string | null; remoteSha: string; provisionedSha: string }
interface Config {
  apiKey: string | null
  repo: string | null
  path: string | null
  token: string | null
  autoUpdate: boolean
  update: UpdateState
}
interface ProvisionResult { script: string; code: number | null; output: string; truncated: boolean }

function loadConfig(): Config {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
    cfg.autoUpdate ??= false
    cfg.update ??= { lastChecked: null, remoteSha: '', provisionedSha: '' }
    return cfg
  } catch {
    const cfg: Config = { apiKey: null, repo: null, path: null, token: null, autoUpdate: false, update: { lastChecked: null, remoteSha: '', provisionedSha: '' } }
    saveConfig(cfg)
    return cfg
  }
}

function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(CONFIG_FILE, 0o600) } catch {}
}

const config = loadConfig()
if (!config.apiKey) {
  config.apiKey = randomBytes(32).toString('base64url')
  saveConfig(config)
  console.log(`alate API key: ${config.apiKey}`)
}

const dbFile = flagValue('--db') ?? join(dirname(CONFIG_FILE), 'alate.db')
mkdirSync(dirname(dbFile), { recursive: true })
const db = new DatabaseSync(dbFile)
if (process.platform !== 'win32') chmodSync(dbFile, 0o600)
db.exec(`
  CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content BLOB NOT NULL);
`)
initUpdates(db)

let running = false
// One file edit at a time, and never during a provision. In-process edits run synchronously,
// so `writing` is preventive only; `running` (provision) is the check tests can reach.
let writing = false


async function provision(): Promise<ProvisionResult[]> {
  const data = snapshotData(db)
  try {
    const results: ProvisionResult[] = []
    for (const script of SCRIPTS) {
      const child = spawn(process.execPath, [join(repoRoot, script), '--data', data.dir], {
        cwd: repoRoot,
        env: process.env,
      })
      let output = ''
      child.stdout.on('data', (d: Buffer) => { if (output.length < CAP + 1000) output += d })
      child.stderr.on('data', (d: Buffer) => { if (output.length < CAP + 1000) output += d })
      const { promise: closed, resolve, reject } = Promise.withResolvers<number | null>()
      child.on('close', code => resolve(code))
      child.on('error', reject)
      const code = await closed
      const truncated = output.length > CAP
      const raw = truncated ? output.slice(0, CAP) : output
      results.push({ script, code, output: redactSecrets(raw, dashToken()), truncated })
    }
    return results
  } finally {
    cleanupData(data)
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function repoValid(repo: string): boolean {
  return isDir(repo) || parseDataSpec(repo) !== null
}

const app = fastify({ bodyLimit: 1024 * 1024, logger: false })

function keyMatch(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function authorized(req: FastifyRequest): boolean {
  const m = /^Bearer (.+)$/s.exec(req.headers.authorization ?? '')
  return !!m && keyMatch(m[1], config.apiKey ?? '')
}

// Dashboard session cookie: a hash of the provisioning key, so the key itself never
// reaches the browser and a rotation (POST /api/key) ends every session at once.
const sessionToken = (): string => createHash('sha256').update(`alate-session:${config.apiKey ?? ''}`).digest('hex')

function sameOrigin(req: FastifyRequest): boolean {
  const raw = req.headers.origin ?? req.headers.referer
  if (typeof raw !== 'string' || !req.headers.host) return false
  try { return new URL(raw).host === req.headers.host } catch { return false }
}

function cookieAuthed(req: FastifyRequest): boolean {
  const m = /(?:^|;\s*)alate_session=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')
  if (!m) return false
  // CSRF: a browser attaches the cookie to cross-site POSTs too, so a cookie write must
  // carry a same-origin Origin header (browsers send it on every non-GET request).
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return false
  return keyMatch(m[1], sessionToken())
}

// Non-loopback binds (--host 0.0.0.0, Docker, NAS) expose the dashboard to the network:
// dashboard routes that read or change repo state then need the provisioning key, as a
// Bearer token or a login cookie. Loopback-only binds stay key-free.
async function dashGuard(req: FastifyRequest, reply: FastifyReply): Promise<void | FastifyReply> {
  if (loopbackBind || authorized(req) || cookieAuthed(req)) return
  return reply.code(401).send({ error: 'unauthorized' })
}

// Auth model: the provisioning API (/config, /provision, /api/updates) always needs
// the key. Dashboard routes use dashGuard: key-free on a loopback bind, Bearer token
// or login cookie on any other bind. The static shell and /theme.js stay public so a
// browser can load the page and then ask for the key once (web/app.js).
app.setErrorHandler((err: FastifyError, _req, reply) => {
  if (typeof err.code === 'string' && err.code.startsWith('FST_ERR_CTP')) {
    return reply.code(err.statusCode ?? 400).send({ error: 'invalid JSON body' })
  }
  return reply.code(err.statusCode ?? 500).send({ error: err.message })
})

app.setNotFoundHandler((req, reply) => {
  const route = new URL(req.url, 'http://x').pathname
  if (KNOWN_ROUTES.includes(route)) return reply.code(405).send({ error: 'method not allowed' })
  return reply.code(404).send({ error: 'not found' })
})

app.get('/health', async () => ({
  ok: true,
  running,
  apiKeySet: !!config.apiKey,
  repo: config.repo,
  path: config.path,
  tokenSet: !!config.token,
  pending: !!(dashState.source?.importedSha && dashState.source.importedSha !== config.update.provisionedSha),
  update: {
    enabled: !!config.repo,
    lastChecked: config.update.lastChecked,
    behind: !!config.update.provisionedSha && config.update.remoteSha !== config.update.provisionedSha,
  },
}))

app.get('/config', async () => ({ repo: config.repo, path: config.path, tokenSet: !!config.token }))

interface ConfigBody { repo?: unknown; path?: unknown; token?: unknown }

app.post<{ Body: ConfigBody | undefined }>('/config', {
  preHandler: async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' })
  },
}, async (req, reply) => {
  const body = req.body ?? {}
  if (running) return reply.code(409).send({ error: 'provision already running' })
  const { repo, path, token } = body
  if ((repo != null) === (path != null)) return reply.code(400).send({ error: 'exactly one of repo or path required' })
  if (repo != null && (typeof repo !== 'string' || !repoValid(repo))) return reply.code(400).send({ error: 'invalid repo' })
  if (path != null && (typeof path !== 'string' || !isDir(path))) return reply.code(400).send({ error: 'invalid path' })
  if (token !== undefined && typeof token !== 'string') return reply.code(400).send({ error: 'invalid token' })
  const nextToken = token === undefined ? config.token : token || null
  try {
    selectSource((repo ?? path) as string, repo != null ? 'repo' : 'path', nextToken ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)
  } catch (err) {
    const e = err as { status?: number; message: string }
    return reply.code(e.status ?? 500).send({ error: e.message })
  }
  config.token = nextToken
  saveConfig(config)
  void updateCheck()
  return { repo: config.repo, path: config.path, tokenSet: !!config.token }
})

app.post('/provision', {
  preHandler: async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' })
  },
}, async (_req, reply) => {
  if (running) return reply.code(409).send({ error: 'provision already running' })
  if (!config.repo && !config.path) return reply.code(400).send({ error: 'no data source configured' })
  running = true
  try {
    // Test-only file gate: the client controls overlap, not a timer.
    while (process.env.ALATE_TEST_PROVISION_GATE && existsSync(process.env.ALATE_TEST_PROVISION_GATE)) {
      await delay(10)
    }
    const results = await provision()
    const ok = results.every(r => r.code === 0)
    if (ok && config.repo) {
      config.update.provisionedSha = dashState.source.importedSha
      saveConfig(config)
    }
    return { ok, results }
  } finally {
    running = false
  }
})

// Dashboard (folded from the former standalone dashboard server): static UI, inventory state, import API.
let dashState = loadState(db)

// Dev-only allowance so impeccable live mode can load. Guarded by ALATE_LIVE;
// production builds never set it, so the served CSP stays unchanged.
const liveDev = process.env.ALATE_LIVE ? " http://localhost:8400" : ""
const DASH_HEADERS = {
  'Content-Security-Policy': `default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'${liveDev}; font-src 'self'; connect-src 'self'${liveDev}; manifest-src 'self'`,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
}
app.addHook('onSend', async (_req, reply, payload) => {
  for (const [name, value] of Object.entries(DASH_HEADERS)) reply.header(name, value)
  return payload
})

// Repo assets, read once at startup; null when the file is missing (route answers 404).
const DASH_STATIC: Record<string, { data: Buffer | null; type: string }> = {}
for (const [route, file, type] of [
  ['/', join(repoRoot, 'web', 'index.html'), 'text/html; charset=utf-8'],
  ['/style.css', join(repoRoot, 'web', 'style.css'), 'text/css; charset=utf-8'],
  ['/app.js', join(repoRoot, 'web', 'app.js'), 'text/javascript; charset=utf-8'],
  ['/theme.js', join(repoRoot, 'web', 'theme.js'), 'text/javascript; charset=utf-8'],
  ['/diff.mjs', join(repoRoot, 'web', 'diff.mjs'), 'text/javascript; charset=utf-8'],
  ['/logo.png', join(repoRoot, 'logo.png'), 'image/png'],
  ['/manifest.webmanifest', join(repoRoot, 'web', 'manifest.webmanifest'), 'application/manifest+json'],
  ['/sw.js', join(repoRoot, 'web', 'sw.js'), 'text/javascript; charset=utf-8'],
  ['/icons/icon-192.png', join(repoRoot, 'web', 'icons', 'icon-192.png'), 'image/png'],
  ['/icons/icon-512.png', join(repoRoot, 'web', 'icons', 'icon-512.png'), 'image/png'],
  ['/icons/maskable-512.png', join(repoRoot, 'web', 'icons', 'maskable-512.png'), 'image/png'],
  ['/fonts/source-serif-4.woff2', join(repoRoot, 'node_modules', '@fontsource-variable', 'source-serif-4', 'files', 'source-serif-4-latin-opsz-normal.woff2'), 'font/woff2'],
  ['/fonts/jetbrains-mono.woff2', join(repoRoot, 'node_modules', '@fontsource-variable', 'jetbrains-mono', 'files', 'jetbrains-mono-latin-wght-normal.woff2'), 'font/woff2'],
] as const) {
  let data: Buffer | null = null
  try { data = readFileSync(file) } catch {}
  DASH_STATIC[route] = { data, type }
}

function sendStatic(route: string, reply: FastifyReply): FastifyReply {
  const entry = DASH_STATIC[route]
  if (!entry || !entry.data) return reply.code(404).send({ error: 'not found' })
  return reply.code(200).type(entry.type).send(entry.data)
}
app.get('/', async (_req, reply) => sendStatic('/', reply))
app.get('/style.css', async (_req, reply) => sendStatic('/style.css', reply))
app.get('/app.js', async (_req, reply) => sendStatic('/app.js', reply))
app.get('/theme.js', async (_req, reply) => sendStatic('/theme.js', reply))
app.get('/diff.mjs', async (_req, reply) => sendStatic('/diff.mjs', reply))
app.get('/logo.png', async (_req, reply) => sendStatic('/logo.png', reply))
app.get('/manifest.webmanifest', async (_req, reply) => sendStatic('/manifest.webmanifest', reply))
app.get('/sw.js', async (_req, reply) => sendStatic('/sw.js', reply))
app.get('/icons/icon-192.png', async (_req, reply) => sendStatic('/icons/icon-192.png', reply))
app.get('/icons/icon-512.png', async (_req, reply) => sendStatic('/icons/icon-512.png', reply))
app.get('/icons/maskable-512.png', async (_req, reply) => sendStatic('/icons/maskable-512.png', reply))
app.get('/fonts/source-serif-4.woff2', async (_req, reply) => sendStatic('/fonts/source-serif-4.woff2', reply))
app.get('/fonts/jetbrains-mono.woff2', async (_req, reply) => sendStatic('/fonts/jetbrains-mono.woff2', reply))

function persistDash(): void {
  db.prepare('UPDATE state SET value = ? WHERE id = 1').run(JSON.stringify(dashState))
}

// Dashboard git calls trust the stored key first, then the process environment.
const dashToken = (): string | undefined => config.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN

function selectSource(spec: string, kind?: string, token = dashToken()): void {
  const next = importSource(dashState, spec, kind, token, db)
  const changed = dashState.source?.spec !== next.source.spec || dashState.source?.kind !== next.source.kind
  dashState = next
  const isRepo = next.source.kind === 'repo'
  config.repo = isRepo ? next.source.spec : null
  config.path = isRepo ? null : next.source.name
  config.update = {
    lastChecked: isRepo ? next.source.importedAt : null,
    remoteSha: next.source.importedSha ?? '',
    provisionedSha: changed ? '' : config.update.provisionedSha,
  }
  dashState.update = isRepo ? { checkedAt: next.source.importedAt, remoteSha: next.source.importedSha, available: false } : null
  persistDash()
  saveConfig(config)
}

// Periodic remote check for a repo source: refresh update state, optionally auto re-import.
function dashCheck(): void {
  if (running || dashState.source?.kind !== 'repo') return
  const sha = remoteHead(dashState.source.name, dashState.source.ref, dashToken())
  dashState.update = { checkedAt: new Date().toISOString(), remoteSha: sha, available: sha !== '' && sha !== dashState.source.importedSha }
  if (sha) config.update.remoteSha = sha
  config.update.lastChecked = dashState.update.checkedAt
  saveConfig(config)
  persistDash()
  if (config.autoUpdate && dashState.update.available) {
    try {
      selectSource(dashState.source.spec, 'repo')
    } catch (err) {
      console.error(`snapshot refresh failed: ${redactSecrets((err as Error).message, dashToken())}`)
    }
    persistDash()
  }
}

let updateRunning = false
async function updateCheck(): Promise<void> {
  if (updateRunning) return
  updateRunning = true
  try {
    await checkUpdates(db, { token: dashToken(), dataRepo: dashState.source ? (dashState.source.kind === 'repo' ? dashState.source.name : dashState.source.spec) : null })
  } catch (err) {
    console.error(`update check failed: ${redactSecrets((err as Error).message, dashToken())}`)
  } finally { updateRunning = false }
}

app.get('/api/state', { preHandler: dashGuard }, async () => ({ ...dashState, updates: loadUpdates(db) }))

app.get('/api/updates', {
  preHandler: async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' })
  },
}, async () => loadUpdates(db))

// Dashboard login: exchange the provisioning key for a session cookie, because phone
// browsers cannot set an Authorization header. The key never returns in a response
// body and never rides the cookie in plaintext. No Secure flag: the NAS serves plain
// HTTP on the LAN; SameSite=Strict plus the Origin check in cookieAuthed cover CSRF.
app.post<{ Body: { key?: unknown } | undefined }>('/api/login', { bodyLimit: 64 * 1024 }, async (req, reply) => {
  const key = (req.body ?? {}).key
  if (typeof key !== 'string' || !keyMatch(key, config.apiKey ?? '')) return reply.code(401).send({ error: 'unauthorized' })
  reply.header('set-cookie', `alate_session=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`)
  return { ok: true }
})

// Issue a fresh API key for callers such as Ottr. Returned once, like the boot-time
// generation; the previous key stops working immediately. No read endpoint: GET would
// hand the provision credential to every local process for as long as the server runs.
app.post('/api/key', { preHandler: dashGuard }, async () => {
  config.apiKey = randomBytes(32).toString('base64url')
  saveConfig(config)
  return { key: config.apiKey }
})

interface ImportBody { source?: unknown; kind?: unknown }

app.post<{ Body: ImportBody | undefined }>('/api/import', { bodyLimit: 64 * 1024, preHandler: dashGuard }, async (req, reply) => {
  const body = req.body ?? ({} as ImportBody)
  if (running) return reply.code(409).send({ error: 'provision already running' })
  if (typeof body.source !== 'string' || body.source === '') return reply.code(400).send({ error: 'source required' })
  if (body.kind !== undefined && body.kind !== 'path' && body.kind !== 'repo') return reply.code(400).send({ error: 'kind must be "path" or "repo"' })
  try {
    selectSource(body.source, body.kind as string | undefined)
  } catch (err) {
    const e = err as { status?: number; message?: string } // dashboard.mjs throws Error with a client-safe message and .status
    return reply.code(e.status ?? 500).send({ error: e.message })
  }
  void updateCheck()
  return { ok: true, state: dashState }
})

// File editor: snapshot reads, plus writes that commit and push. Guarded like /api/import.
app.get('/api/files', { preHandler: dashGuard }, async () => ({ files: listStoredFiles(db) }))

interface FileQuery { path?: unknown }

app.get('/api/file', { preHandler: dashGuard }, async (req, reply) => {
  const query = (req.query ?? {}) as FileQuery
  const rel = typeof query.path === 'string' ? query.path : ''
  try {
    const file = readStoredFile(db, rel)
    if (!file) return reply.code(404).send({ error: `no stored file at ${rel.slice(0, 200)}` })
    return file
  } catch (err) {
    const e = err as { status?: number; message?: string } // dashboard.mjs throws Error with a client-safe message and .status
    return reply.code(e.status ?? 500).send({ error: e.message })
  }
})

interface FileEditBody { path?: unknown; content?: unknown; base?: unknown; message?: unknown }

async function fileEdit(req: FastifyRequest, reply: FastifyReply, del: boolean) {
  if (running || writing) return reply.code(409).send({ error: running ? 'provision already running' : 'another file write is running' })
  const body = (req.body ?? {}) as FileEditBody
  writing = true
  try {
    const res = applyFileEdit(dashState, db, { ...body, delete: del }, dashToken())
    dashState = res.state
    // Same refresh selectSource does after an import: the repo source now sits on the new commit.
    dashState.update = dashState.source.kind === 'repo'
      ? { checkedAt: new Date().toISOString(), remoteSha: dashState.source.importedSha, available: false }
      : null
    persistDash()
    return {
      ok: true,
      commit: res.commit,
      pushed: res.pushed,
      ...(res.warning ? { warning: res.warning } : {}),
      state: { ...dashState, updates: loadUpdates(db) },
    }
  } catch (err) {
    const e = err as { status?: number; message?: string }
    return reply.code(e.status ?? 500).send({ error: e.message })
  } finally { writing = false }
}

app.put('/api/file', { bodyLimit: 2 * 1024 * 1024, preHandler: dashGuard }, async (req, reply) => fileEdit(req, reply, false))
app.delete('/api/file', { bodyLimit: 2 * 1024 * 1024, preHandler: dashGuard }, async (req, reply) => fileEdit(req, reply, true))

// Dashboard settings: stored GitHub key (write-only) and auto-update opt-in. Guarded like /api/import.
app.get('/api/settings', { preHandler: dashGuard }, async () => ({ tokenSet: !!config.token, autoUpdate: config.autoUpdate }))

interface SettingsBody { token?: unknown; autoUpdate?: unknown }

app.post<{ Body: SettingsBody | undefined }>('/api/settings', { bodyLimit: 64 * 1024, preHandler: dashGuard }, async (req, reply) => {
  const body = req.body ?? {}
  if (body.token !== undefined && typeof body.token !== 'string') return reply.code(400).send({ error: 'invalid token' })
  if (body.autoUpdate !== undefined && typeof body.autoUpdate !== 'boolean') return reply.code(400).send({ error: 'invalid autoUpdate' })
  if (body.token !== undefined) config.token = (body.token as string) || null
  if (body.autoUpdate !== undefined) config.autoUpdate = body.autoUpdate as boolean
  saveConfig(config)
  return { tokenSet: !!config.token, autoUpdate: config.autoUpdate }
})

// CLI flags
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
const port = +(flagValue('--port') ?? process.env.PORT ?? 4570)
const host = flagValue('--host') ?? process.env.ALATE_HOST ?? '127.0.0.1'
// Loopback binds keep the dashboard key-free; anything else (0.0.0.0, ::, a LAN IP) arms dashGuard.
const loopbackBind = host === 'localhost' || host.startsWith('127.') || host === '::1'

const intervalSec = +(flagValue('--interval') ?? 900)
// A locked database (an import's write transaction) must not kill the timer: skip the
// tick and let the next one rewrite the state row, like updateCheck skips failed ticks.
const timer = setInterval(() => {
  try {
    dashCheck()
  } catch (err) {
    console.error(`dashboard check failed: ${redactSecrets((err as Error).message, dashToken())}`)
  }
}, intervalSec * 1000)
timer.unref()

const updateIntervalSec = +(flagValue('--update-interval') ?? 86400)
const updateTimer = setInterval(updateCheck, updateIntervalSec * 1000)
updateTimer.unref()

// A persisted database is the source of truth and also permits offline startup.
if (dashState.source) {
  config.repo = dashState.source.kind === 'repo' ? dashState.source.spec : null
  config.path = dashState.source.kind === 'path' ? dashState.source.name : null
  saveConfig(config)
} else {
  const source = flagValue('--repo') ?? config.repo ?? flagValue('--data') ?? config.path
  if (source) selectSource(source, flagValue('--repo') || config.repo ? 'repo' : undefined)
}
dashCheck()
void updateCheck()

const address = await app.listen({ port, host })
console.log(`alate server on ${address}`)
