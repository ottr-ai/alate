// One bounded worker thread for the heavy dashboard snapshot work: imports, provision
// snapshots and their cleanup run off the server event loop, so GET /health keeps
// answering while a multi-second import or snapshot copy runs (OTTR-807). One worker,
// one op at a time; the client serializes every call through a promise chain.
// Dual mode: imported on the main thread this file exports the client API; run as a
// worker entry it runs the op loop.
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { importSource, snapshotData } from '../web/dashboard.mjs';

// Test seam: a positive integer delays each op, so a test can hold the worker while it
// probes the server. worker_threads inherit process.env.
const testDelay = async () => {
  const ms = Number(process.env.ALATE_TEST_WORKER_DELAY_MS);
  if (Number.isInteger(ms) && ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
};

const runOp = async op => {
  await testDelay();
  if (op.op === 'import') {
    const db = new DatabaseSync(op.dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const next = importSource(op.state, op.spec, op.kind, op.token, db, op.resolvedIn);
      return { ok: true, state: next };
    } finally {
      db.close();
    }
  }
  if (op.op === 'snapshot') {
    const db = new DatabaseSync(op.dbFile, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      return { ok: true, dir: snapshotData(db).dir };
    } finally {
      db.close();
    }
  }
  if (op.op === 'cleanup') {
    rmSync(op.dir, { recursive: true, force: true });
    return { ok: true };
  }
  throw new Error(`unknown worker op: ${op.op}`);
};

if (!isMainThread) {
  parentPort.on('message', async op => {
    let reply;
    try {
      reply = await runOp(op);
    } catch (err) {
      // Structured clone drops custom Error properties: carry status and snapshotChanged
      // as plain fields, so the main side can rebuild the client-safe error.
      reply = { ok: false, message: err?.message ?? String(err), status: err?.status, snapshotChanged: err?.snapshotChanged };
    }
    parentPort.postMessage({ id: op.id, ...reply });
  });
}

// ---- Main-side client ----
let worker = null;
let chain = Promise.resolve();
const pending = new Map();
let nextId = 0;

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
      if (msg.snapshotChanged !== undefined) err.snapshotChanged = msg.snapshotChanged;
      entry.reject(err);
    }
  });
  // A crashed worker rejects the op it held and is rebuilt for the next op.
  w.on('error', err => {
    worker = null;
    failPending(err);
  });
  w.on('exit', () => {
    if (worker === w) worker = null;
    failPending(new Error('worker exited before replying'));
  });
  return w;
};

const callWorker = op => {
  const run = chain.then(() => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    (worker ?? newWorker()).postMessage({ ...op, id });
  }));
  chain = run.then(() => undefined, () => undefined);
  return run;
};

export const runImport = args => callWorker({ op: 'import', dbFile: args.dbFile, state: args.state, spec: args.spec, kind: args.kind, token: args.token, resolvedIn: args.resolvedIn }).then(msg => msg.state);
export const runSnapshot = args => callWorker({ op: 'snapshot', dbFile: args.dbFile }).then(msg => msg.dir);
export const runCleanup = dir => callWorker({ op: 'cleanup', dir }).then(() => undefined);
