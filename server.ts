// alate server: provisioning API + inventory dashboard UI (single server; the standalone dashboard server was folded in).
// Run directly: node server.ts (Node type stripping, no build step).
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import fastify from 'fastify'
import { cleanupData, parseDataSpec, PROVISION_ENV, redactSecrets } from './lib/data.mjs'
import { applyFileEdit, importSource, isGitWorkTree, isWritableDir, listStoredFiles, loadState, readStoredFile, remoteHead, snapshotData } from './web/dashboard.mjs'
import { checkUpdates, initUpdates, isValidUpdateRecord, loadUpdates } from './lib/updates.mjs'
import { ensureEnvProxy } from './lib/env-proxy.mjs'

// Node honors proxy env vars for fetch only with proxy support enabled: the built-in
// http.setGlobalProxyFromEnv() (Node 24.14+) applies them in-process, and on 24.12-24.13
// lib/env-proxy.mjs re-spawns once with NODE_USE_ENV_PROXY=1 (the image sets it).
await ensureEnvProxy()

const repoRoot = import.meta.dirname
const CONFIG_FILE = flagValue('--config') ?? join(repoRoot, 'server-config.json')
const CAP = 200000
const SCRIPTS = ['sync.mjs', 'install-user.mjs']
// Allowlisted child environment: keeps ALATE_API_KEY and every other secret inside the server
// process. Children and their children never see it. NODE_USE_ENV_PROXY crosses so provision
// children inherit the flag and their fetches honor the proxy too.
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PI_CODING_AGENT_DIR', 'ALATE_LAYER', 'ALATE_DATA', 'ALATE_KEEP_TEMP', 'SKILLSPECTOR_BIN', 'SKILLSPECTOR_VENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ALATE_TEST_')) env[key] = process.env[key]
  }
  return env
}
const KNOWN_ROUTES = ['/health', '/config', '/provision', '/api/updates', '/api/updates/check', '/api/files', '/api/file']
const testChildEnvCapture = process.env.ALATE_TEST_CHILD_ENV
// Test hook: a server that ignores SIGTERM exercises the test suite's teardown escalation;
// only the process-group SIGKILL fallback stops it.
if (process.env.ALATE_TEST_SIGTERM === 'ignore') process.on('SIGTERM', () => {})

interface UpdateState { lastChecked: string | null; remoteSha: string; provisionedSha: string }
interface Config {
  apiKey: string | null
  repo: string | null
  path: string | null
  token: string | null
  autoUpdate: boolean
  securityFastPath: boolean
  update: UpdateState
}
interface ProvisionResult { script: string; code: number | null; output: string; truncated: boolean }
// One provisioning item's per-item outcome, as written to the results file by the script
// (specs/provision-item-by-item.md). rule/at name the first finding for a failed item.
interface ProvisionItem { item: string; status: 'installed' | 'unchanged' | 'rejected' | 'no-origin'; rule: string | null; at: string | null; report?: string }
// Stored on the dashboard state after every provision run; served by GET /api/state. sha pins
// the results to the imported snapshot, so a stale set is never shown for a newer snapshot.
// failures holds the scripts of a whole-run failure (non-zero exit or null code) with their
// captured output, so a refusal or a crashed child is visible when items alone show nothing.
interface ProvisionState { at: string; sha: string | null; ok: boolean; items: ProvisionItem[]; failures: ProvisionResult[] }

function loadConfig(): Config {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
    cfg.autoUpdate ??= false
    cfg.securityFastPath ??= true
    cfg.update ??= { lastChecked: null, remoteSha: '', provisionedSha: '' }
    return cfg
  } catch {
    const cfg: Config = { apiKey: null, repo: null, path: null, token: null, autoUpdate: false, securityFastPath: true, update: { lastChecked: null, remoteSha: '', provisionedSha: '' } }
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
  const envKey = process.env.ALATE_API_KEY
  if (envKey !== undefined && envKey.length < 32) {
    console.error('ALATE_API_KEY is set but shorter than 32 characters; refusing to start, because the paired board would then fail silently')
    process.exit(1)
  }
  if (envKey !== undefined) {
    config.apiKey = envKey
    saveConfig(config)
    console.log('alate API key: taken from ALATE_API_KEY')
  } else {
    config.apiKey = randomBytes(32).toString('base64url')
    saveConfig(config)
    console.log(`alate API key: ${config.apiKey}`)
  }
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


// Worse status wins when both scripts report the same item key.
const STATUS_RANK: Record<ProvisionItem['status'], number> = { unchanged: 0, installed: 1, 'no-origin': 2, rejected: 3 }
const REPORT_CAP = 4000

// Read one child's results file (specs/provision-item-by-item.md). A missing or unparseable
// file means no data; the caller fails closed on it.
function readProvisionResults(file: string): { fatal: boolean; items: { item: string; status: ProvisionItem['status']; rule?: unknown; at?: unknown; report?: unknown }[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed.fatal !== 'boolean' || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

async function provision(): Promise<ProvisionResult[]> {
  const data = snapshotData(db)
  const tmp = mkdtempSync(join(tmpdir(), 'alate-provision-'))
  try {
    const results: ProvisionResult[] = []
    const merged = new Map<string, ProvisionItem>()
    for (const script of SCRIPTS) {
      const resultsFile = join(tmp, `${script}.results.json`)
      const env = childEnv()
      // Test seam: while the gate file exists, drop the results-file path so a child can
      // exit non-zero with no results file, exercising the pipeline's fail-closed branch.
      const noResultsGate = process.env.ALATE_TEST_NO_RESULTS_FILE
      if (!(noResultsGate && existsSync(noResultsGate))) env[PROVISION_ENV] = resultsFile
      // The snapshot dir has no .git, so install-user.mjs cannot read the imported commit
      // itself: the server passes it for a repo source, and a layer id then carries it
      // instead of "nogit" (specs/agent-layer-switch.md). A path source gets no --commit,
      // so the git probe in install-user.mjs keeps its nogit fallback.
      const importedSha = dashState.source?.kind === 'repo' ? dashState.source.importedSha ?? '' : ''
      const commitArg = script === 'install-user.mjs' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(importedSha) ? ['--commit', importedSha] : []
      const child = spawn(process.execPath, [join(repoRoot, script), '--data', data.dir, ...commitArg], {
        cwd: repoRoot,
        env,
      })
      if (testChildEnvCapture) writeFileSync(testChildEnvCapture, JSON.stringify(childEnv()))
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
      // Merge per-item results by stable key; the worse status wins, and reports join.
      const parsed = readProvisionResults(resultsFile)
      if (parsed) {
        for (const entry of parsed.items) {
          if (!entry || typeof entry.item !== 'string' || !(entry.status in STATUS_RANK)) continue
          const status = entry.status
          const rule = typeof entry.rule === 'string' ? entry.rule : null
          const at = typeof entry.at === 'string' ? entry.at : null
          const report = typeof entry.report === 'string' && entry.report
            ? entry.report.length > REPORT_CAP ? redactSecrets(entry.report.slice(0, REPORT_CAP) + '…', dashToken()) : redactSecrets(entry.report, dashToken())
            : undefined
          const prev = merged.get(entry.item)
          if (!prev) {
            merged.set(entry.item, { item: entry.item, status, rule, at, ...(report ? { report } : {}) })
            continue
          }
          const joined = [prev.report, report].filter(Boolean).join('\n')
          if (joined) prev.report = joined.length > REPORT_CAP ? joined.slice(0, REPORT_CAP) + '…' : joined
          if (STATUS_RANK[status] > STATUS_RANK[prev.status]) Object.assign(prev, { status, rule, at })
        }
      }
      // Fail closed only on true refusals: a killed child, or a non-zero exit whose results
      // file is missing or says the whole run was refused. A per-item failure (non-zero exit
      // with fatal: false) never stops the pipeline (specs/provision-item-by-item.md).
      if (code === null || (code !== 0 && (parsed === null || parsed.fatal))) break
    }
    dashState.provision = {
      at: new Date().toISOString(),
      sha: dashState.source?.importedSha || null,
      ok: results.every(r => r.code === 0),
      items: [...merged.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0)),
      failures: results.filter(r => r.code !== 0),
    } satisfies ProvisionState
    persistDash()
    return results
  } finally {
    rmSync(tmp, { recursive: true, force: true })
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

// The provisioning API (/config, /provision, /api/updates) always needs the key, on every
// bind: one shared guard so the three routes cannot drift apart.
async function keyGuard(req: FastifyRequest, reply: FastifyReply): Promise<void | FastifyReply> {
  if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' })
}

// Dashboard handlers map a thrown Error to its client-safe message and optional status,
// so the response shape cannot drift between them.
function clientError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as { status?: number; message?: string } // dashboard.mjs throws Error with a client-safe message and .status
  return reply.code(e.status ?? 500).send({ error: e.message })
}

// Dashboard session cookie: a hash of the provisioning key, so the key never
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
  if (authorized(req) || cookieAuthed(req)) return
  if (!loopbackBind) return reply.code(401).send({ error: 'unauthorized' })
  // The loopback bind is key-free, but a browser write carries no key: without the
  // sameOrigin check, any web page could ride this shortcut with a bodyless no-cors
  // POST (no preflight; POST /api/key reads no body) and rotate the provisioning key.
  // Browsers send Origin on every non-GET request, and the dashboard's own requests
  // are same-origin; scripts keep using the Bearer path above. DNS rebinding makes a
  // hostile page's Origin equal its Host, so that check alone passes; the loopback
  // Host gate registered near listen() covers that case.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return reply.code(401).send({ error: 'unauthorized' })
}

// Fastify's default JSON parser refuses a request that carries a JSON content type
// with no body (FST_ERR_CTP_EMPTY_JSON_BODY), and board clients send exactly that to
// POST /provision. Parse an empty or whitespace-only JSON body as {} instead:
// /provision reads no fields, and every other route treats a missing field as absent.
// A malformed non-empty body fails as FST_ERR_CTP_INVALID_JSON, so the error handler
// below keeps its 400 `invalid JSON body` answer.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
  if (body.trim() === '') return done(null, {})
  try {
    return done(null, JSON.parse(body) as unknown)
  } catch {
    return done(Object.assign(new Error('invalid JSON body'), { code: 'FST_ERR_CTP_INVALID_JSON', statusCode: 400 }), undefined)
  }
})

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

app.get('/health', async () => {
  // Path-source write flags (specs/source-write-flags.md): git says whether a path PUT
  // commits, writable whether the folder accepts writes, so a client can disable its
  // save before the first refused write. Computed per request, never stored; null for a
  // repo source (a repo PUT always commits on a fresh clone). writable can over-report
  // (read-only bind mount, root) — see isWritableDir in web/dashboard.mjs.
  const src = dashState.source
  const writeFlags = src && src.kind === 'path'
    ? { git: isGitWorkTree(src.name), writable: isWritableDir(src.name) }
    : { git: null, writable: null }
  return {
    ok: true,
    running,
    // Ottr's provisioning gate reads this flag: it skips its idle wait only when it
    // matches the layer mode the spawned install-user.mjs inherits (ALATE_LAYER=1).
    layers: process.env.ALATE_LAYER === '1',
    apiKeySet: !!config.apiKey,
    repo: config.repo,
    path: config.path,
    ...writeFlags,
    tokenSet: !!config.token,
    pending: !!(dashState.source?.importedSha && dashState.source.importedSha !== config.update.provisionedSha),
    update: {
      enabled: !!config.repo,
      lastChecked: config.update.lastChecked,
      behind: !!config.update.provisionedSha && config.update.remoteSha !== config.update.provisionedSha,
    },
  }
})

app.get('/config', async () => ({ repo: config.repo, path: config.path, tokenSet: !!config.token }))

interface ConfigBody { repo?: unknown; path?: unknown; token?: unknown }

app.post<{ Body: ConfigBody | undefined }>('/config', {
  preHandler: keyGuard,
}, async (req, reply) => {
  const body = req.body ?? {}
  if (running) return reply.code(409).send({ error: 'provision already running' })
  const { repo, path, token } = body
  if ((repo != null) === (path != null)) return reply.code(400).send({ error: 'exactly one of repo or path required' })
  if (repo != null && (typeof repo !== 'string' || !repoValid(repo))) return reply.code(400).send({ error: 'invalid repo' })
  if (path != null && (typeof path !== 'string' || !isDir(path))) return reply.code(400).send({ error: 'invalid path' })
  if (token !== undefined && typeof token !== 'string') return reply.code(400).send({ error: 'invalid token' })
  const nextToken = token === undefined ? config.token : token || null
  // selectSource queues the first update check for a fresh snapshot, and that check
  // reads the token from config: set the new token first, so the check authenticates
  // with it. selectSource persists config on every success path; a failed source
  // switch restores the previous token and persists that.
  const prevToken = config.token
  config.token = nextToken
  let queuedCheck = false
  try {
    queuedCheck = selectSource((repo ?? path) as string, repo != null ? 'repo' : 'path', nextToken ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)
  } catch (err) {
    config.token = prevToken
    saveConfig(config)
    return clientError(reply, err)
  }
  if (!queuedCheck) void updateCheckAfterChange()
  return { repo: config.repo, path: config.path, tokenSet: !!config.token }
})

app.post('/provision', {
  preHandler: keyGuard,
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
    // An applied update leaves the list at once, not at the next timer tick.
    if (ok) void updateCheckAfterChange()
    return { ok, results }
  } finally {
    running = false
  }
})

// Dashboard (folded from the former standalone dashboard server): static UI, inventory state, import API.
let dashState = loadState(db)

// Dev-only allowance so a live-reload dev server can load. Guarded by ALATE_LIVE;
// production builds never set it, so the served CSP stays unchanged.
const liveDev = process.env.ALATE_LIVE ? " http://localhost:8400" : ""
const DASH_HEADERS = {
  // frame-ancestors 'none' (plus X-Frame-Options for older engines) blocks clickjacking:
  // on a loopback bind the dashboard is key-free, so one click in a framed page can
  // import a source or store a key (validated in the ALAT-49 browser run).
  'Content-Security-Policy': `default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'${liveDev}; font-src 'self'; connect-src 'self'${liveDev}; manifest-src 'self'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
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

function selectSource(spec: string, kind?: string, token = dashToken()): boolean {
  const next = importSource(dashState, spec, kind, token, db)
  const changed = dashState.source?.spec !== next.source.spec || dashState.source?.kind !== next.source.kind
  const newCommit = next.source.kind === 'repo' && !!next.source.importedSha && next.source.importedSha !== dashState.source?.importedSha
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
  // A fresh snapshot invalidates the stored update rows at once, not at the next timer tick.
  // The return value tells route callers whether the check is already queued, so one
  // snapshot change queues exactly one trigger.
  if (newCommit) {
    void updateCheckAfterChange()
    return true
  }
  return false
}

// Periodic remote check for a repo source: refresh update state, optionally auto re-import.
function dashCheck(): void {
  if (running || dashState.source?.kind !== 'repo') return
  const sha = remoteHead(dashState.source.name, dashState.source.ref, dashToken(), dashState.source.host ?? '')
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
let updatePromise: Promise<void> = Promise.resolve()
let rerunNeeded = false
// Single-flight: one checkUpdates at a time. A plain caller that arrives during a
// run joins it; a snapshot-change caller marks the run stale (it read an older
// snapshot), and exactly one more check follows when it ends, so a snapshot change
// never waits for the next timer tick. The promise never rejects, so the
// fire-and-forget callers stay safe.
function updateCheck(): Promise<void> {
  if (updateRunning) return updatePromise
  updateRunning = true
  updatePromise = (async () => {
    for (;;) {
      rerunNeeded = false
      try {
        await checkUpdates(db, { token: dashToken(), securityFastPath: config.securityFastPath, dataRepo: dashState.source ? (dashState.source.kind === 'repo' ? dashState.source.name : dashState.source.spec) : null, dataHost: dashState.source && dashState.source.kind === 'repo' ? (dashState.source.host ?? '') : undefined })
      } catch (err) {
        console.error(`update check failed: ${redactSecrets((err as Error).message, dashToken())}`)
      }
      if (!rerunNeeded) break
    }
    updateRunning = false
  })()
  return updatePromise
}

// For the sites that just changed the snapshot (imports, edits, provisions): a
// check that is already running read the older snapshot, so queue one more.
function updateCheckAfterChange(): Promise<void> {
  if (updateRunning) rerunNeeded = true
  return updateCheck()
}

app.get('/api/state', { preHandler: dashGuard }, async () => ({ ...dashState, updates: loadUpdates(db) }))

// The provider payload keeps only records the board accepts (isValidUpdateRecord mirrors
// the board's record() checks), so a pull never logs dropped records; /api/state keeps all.
const boardUpdates = () => {
  const u = loadUpdates(db)
  return { checkedAt: u.checkedAt, updates: u.updates.filter(isValidUpdateRecord) }
}

app.get('/api/updates', {
  preHandler: keyGuard,
}, async () => boardUpdates())

// Run a check now for callers such as the board's refresh button, then serve the fresh list.
app.post('/api/updates/check', {
  preHandler: keyGuard,
}, async () => {
  await updateCheck()
  return boardUpdates()
})

// Dashboard login: exchange the provisioning key for a session cookie, because phone
// browsers cannot set an Authorization header. The key never returns in a response
// body and never rides the cookie in plaintext. No Secure flag: a non-loopback
// bind serves plain HTTP; SameSite=Strict plus the Origin check in cookieAuthed cover CSRF.
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
  let queuedCheck = false
  try {
    queuedCheck = selectSource(body.source, body.kind as string | undefined)
  } catch (err) {
    return clientError(reply, err)
  }
  if (!queuedCheck) void updateCheckAfterChange()
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
    return clientError(reply, err)
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
    // Every committed edit changed the stored snapshot, path edits included; the
    // stored update rows follow at once, never at the next timer tick.
    void updateCheckAfterChange()
    return {
      ok: true,
      commit: res.commit,
      pushed: res.pushed,
      ...(res.warning ? { warning: res.warning } : {}),
      state: { ...dashState, updates: loadUpdates(db) },
    }
  } catch (err) {
    // editPathSource re-imports the user's tree before it throws, so a failed
    // commit or push still changed the stored snapshot.
    if (err && typeof err === 'object' && 'snapshotChanged' in err && err.snapshotChanged === true) void updateCheckAfterChange()
    return clientError(reply, err)
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

// A rebound page resolves its own hostname to 127.0.0.1, so its Origin equals the
// request Host and sameOrigin passes; on a key-free loopback bind only the Host
// header itself proves the request names this server.
const boundPort = (): string => String(port || (app.server.address() as AddressInfo).port)
function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false
  let u: URL
  try { u = new URL(`http://${host}`) } catch { return false }
  const name = u.hostname
  const okName = name === 'localhost' || name === '[::1]' ||
    /^127\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(name)
  return okName && (u.port === '' || u.port === boundPort())
}
if (loopbackBind) {
  app.addHook('onRequest', async (req, reply) => {
    if (!hostIsLoopback(req.headers.host)) return reply.code(421).send({ error: 'misdirected host' })
  })
}

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

await app.listen({ port, host })
// Fastify's listen() return maps a wildcard bind back to 127.0.0.1 (the compose image
// binds 0.0.0.0 so a published port can reach it); print what the socket actually holds.
const bound = app.server.address() as AddressInfo
const bindAddr = bound.family === 'IPv6' ? `[${bound.address}]` : bound.address
console.log(`alate server on http://${bindAddr}:${bound.port}`)
