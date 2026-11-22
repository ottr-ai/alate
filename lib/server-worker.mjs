// One bounded worker thread for the heavy dashboard snapshot work: imports, provision
// snapshots and their cleanup run off the server event loop, so GET /health keeps
// answering while a multi-second import or snapshot copy runs (OTTR-807). One worker,
// one op at a time; the client serializes every call through a promise chain.
// Dual mode: imported on the main thread this file exports the client API; run as a
// worker entry it runs the op loop.
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { applyBundleAction, applyEntryAction, applyFileEdit, importSource, setCountTokenHost, setTrustedPathSource, snapshotData } from '../web/dashboard.mjs';

/** @typedef {import('../web/dashboard.mjs').StateDef} DashState */
/** @typedef {import('../web/dashboard.mjs').ResolvedSource} ResolvedSource */
/** @typedef {{ op: 'import', id: number, dbFile: string, state: DashState, spec: string, kind: string | undefined, token: string | undefined, tokenHost: string | null, resolvedIn?: ResolvedSource | null }} ImportOp */
/** @typedef {{ op: 'snapshot', id: number, dbFile: string }} SnapshotOp */
/** @typedef {{ op: 'cleanup', id: number, dir: string }} CleanupOp */
/** @typedef {{ op: 'edit', id: number, dbFile: string, state: DashState, edit: { path?: unknown, base?: unknown, content?: unknown, message?: unknown, delete: boolean }, token: string | undefined, tokenHost: string | null, trustedDir: string | null }} EditWorkerOp */
/** @typedef {{ op: 'bundleAction' | 'entryAction', id: number, dbFile: string, state: DashState, body: Record<string, unknown>, token: string | undefined, tokenHost: string | null, trustedDir: string | null, known: { skills: Set<string>, plugins: Set<string> } }} BundleActionWorkerOp */
/** @typedef {ImportOp | SnapshotOp | CleanupOp | EditWorkerOp | BundleActionWorkerOp} WorkerOp */
/** @typedef {Omit<ImportOp, 'id'> | Omit<SnapshotOp, 'id'> | Omit<CleanupOp, 'id'> | Omit<EditWorkerOp, 'id'> | Omit<BundleActionWorkerOp, 'id'>} WorkerRequest */
/** @typedef {Error & { status?: number, snapshotChanged?: boolean }} StatusedError */
/** @typedef {{ ok: boolean, state?: DashState, dir?: string, commit?: string, pushed?: boolean, warning?: string, message?: string, status?: number, snapshotChanged?: boolean }} WorkerReply */

// Test seam: a positive integer delays each op, so a test can hold the worker while it
// probes the server. worker_threads inherit process.env.
const testDelay = async () => {
  const ms = Number(process.env.ALATE_TEST_WORKER_DELAY_MS);
  if (Number.isInteger(ms) && ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
};

/** @param {WorkerOp} op @returns {Promise<WorkerReply>} */
const runOp = async op => {
  await testDelay();
  if (op.op === 'import') {
    const db = new DatabaseSync(op.dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      // Keep the -wal file bounded: journal_size_limit caps it after checkpoints, and
      // the TRUNCATE checkpoint below copies it back into the database after the import.
      db.exec('PRAGMA journal_size_limit = 67108864');
      setCountTokenHost(op.tokenHost);
      const next = await importSource(op.state, op.spec, op.kind, op.token, db, op.resolvedIn);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return { ok: true, state: next };
    } finally {
      db.close();
    }
  }
  if (op.op === 'edit' || op.op === 'bundleAction' || op.op === 'entryAction') {
    const db = new DatabaseSync(op.dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      // The operator-configured source dir rides every edit op: this thread holds its own
      // module copy, and one worker runs one op at a time, so the per-op set cannot race.
      setTrustedPathSource(op.trustedDir);
      setCountTokenHost(op.tokenHost);
      const res = op.op === 'edit'
        ? await applyFileEdit(op.state, db, op.edit, op.token)
        : op.op === 'entryAction'
          ? await applyEntryAction(op.state, db, op.body, op.token, op.known)
          : await applyBundleAction(op.state, db, op.body, op.token, op.known);
      return { ok: true, state: res.state, commit: res.commit, pushed: res.pushed, ...(res.warning !== undefined ? { warning: res.warning } : {}) };
    } finally {
      db.close();
    }
  }
  if (op.op === 'snapshot') {
    const db = new DatabaseSync(op.dbFile, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_size_limit = 67108864');
      return { ok: true, dir: snapshotData(db).dir };
    } finally {
      db.close();
    }
  }
  if (op.op === 'cleanup') {
    rmSync(op.dir, { recursive: true, force: true });
    return { ok: true };
  }
  throw new Error(`unknown worker op: ${(/** @type {WorkerOp} */ (op)).op}`);
};

if (!isMainThread) {
  (/** @type {import('node:worker_threads').MessagePort} */ (parentPort)).on('message', async op => {
    let reply;
    try {
      reply = await runOp(op);
    } catch (err) {
      // Structured clone drops custom Error properties: carry status and snapshotChanged
      // as plain fields, so the main side can rebuild the client-safe error.
      reply = { ok: false, message: (/** @type {StatusedError} */ (err))?.message ?? String(err), status: (/** @type {StatusedError} */ (err))?.status, snapshotChanged: (/** @type {StatusedError} */ (err))?.snapshotChanged };
    }
    (/** @type {import('node:worker_threads').MessagePort} */ (parentPort)).postMessage({ id: op.id, ...reply });
  });
}

// ---- Main-side client ----
/** @type {Worker | null} */
let worker = null;
let chain = Promise.resolve();
/** @type {Map<number, { resolve: (value: WorkerReply) => void, reject: (reason?: Error) => void }>} */
const pending = new Map();
let nextId = 0;

/** @param {Error} err */
const failPending = err => {
  const waiting = [...pending.values()];
  pending.clear();
  for (const entry of waiting) entry.reject(err);
};

const newWorker = () => {
  const w = new Worker(new URL('./server-worker.mjs', import.meta.url));
  w.unref(); // a CLI caller must still exit while an op runs
  w.on('message', msg => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else {
      const err = Object.assign(new Error(msg.message), { status: msg.status });
      if (msg.snapshotChanged !== undefined) (/** @type {StatusedError} */ (err)).snapshotChanged = msg.snapshotChanged;
      entry.reject(err);
    }
  });
  // A crashed worker rejects the op it held and is rebuilt for the next op.
  w.on('error', (/** @type {Error} */ err) => {
    worker = null;
    failPending(err);
  });
  w.on('exit', () => {
    if (worker === w) worker = null;
    failPending(new Error('worker exited before replying'));
  });
  return w;
};

/** @param {WorkerRequest} op */
const callWorker = op => {
  const run = chain.then(/** @type {() => Promise<WorkerReply>} */ (() => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker = worker ?? newWorker();
    worker.postMessage({ ...op, id });
  })));
  chain = run.then(() => undefined, () => undefined);
  return run;
};

/**
 * @param {{ dbFile: string, state: DashState, spec: string, kind: string | undefined, token: string | undefined, tokenHost: string | null, resolvedIn?: ResolvedSource | null }} args
 * @returns {Promise<DashState>}
 */
export const runImport = args => callWorker({ op: 'import', dbFile: args.dbFile, state: args.state, spec: args.spec, kind: args.kind, token: args.token, tokenHost: args.tokenHost, resolvedIn: args.resolvedIn }).then(msg => /** @type {DashState} */ (msg.state));
/**
 * @param {{ dbFile: string, state: DashState, edit: { path?: unknown, base?: unknown, content?: unknown, message?: unknown, delete: boolean }, token: string | undefined, tokenHost: string | null, trustedDir: string | null }} args
 * @returns {Promise<{ state: DashState, commit: string, pushed: boolean, warning?: string }>}
 */
export const runEdit = args => callWorker({ op: 'edit', dbFile: args.dbFile, state: args.state, edit: args.edit, token: args.token, tokenHost: args.tokenHost, trustedDir: args.trustedDir }).then(msg => ({ state: /** @type {DashState} */ (msg.state), commit: /** @type {string} */ (msg.commit), pushed: msg.pushed === true, warning: msg.warning }));
/**
 * @param {{ dbFile: string, state: DashState, body: Record<string, unknown>, token: string | undefined, tokenHost: string | null, trustedDir: string | null, known: { skills: Set<string>, plugins: Set<string> } }} args
 * @returns {Promise<{ state: DashState, commit: string, pushed: boolean, warning?: string }>}
 */
export const runBundleAction = args => callWorker({ op: 'bundleAction', dbFile: args.dbFile, state: args.state, body: args.body, token: args.token, tokenHost: args.tokenHost, trustedDir: args.trustedDir, known: args.known }).then(msg => ({ state: /** @type {DashState} */ (msg.state), commit: /** @type {string} */ (msg.commit), pushed: msg.pushed === true, warning: msg.warning }));
/** Index create and delete (specs/index-create-delete.md); same shape as runBundleAction. @param {Parameters<typeof runBundleAction>[0]} args */
export const runEntryAction = args => callWorker({ op: 'entryAction', dbFile: args.dbFile, state: args.state, body: args.body, token: args.token, tokenHost: args.tokenHost, trustedDir: args.trustedDir, known: args.known }).then(msg => ({ state: /** @type {DashState} */ (msg.state), commit: /** @type {string} */ (msg.commit), pushed: msg.pushed === true, warning: msg.warning }));
/** @param {{ dbFile: string }} args @returns {Promise<string>} */
export const runSnapshot = args => callWorker({ op: 'snapshot', dbFile: args.dbFile }).then(msg => /** @type {string} */ (msg.dir));
/** @param {string} dir */
export const runCleanup = dir => callWorker({ op: 'cleanup', dir }).then(() => undefined);
