# Alate gate measurements (ADR-0001)

Date: 2026-11-12

This file holds the measured numbers for the two Alate decision gates of
ADR-0001 (`docs/adr/0001-alate-keeps-node-and-javascript.md`), with the
thresholds confirmed in the Ottr repo's `docs/specs/rust-decision-gates.md`
(OTTR-865). These numbers are decision inputs for a new Rust discussion. They
are not product requirements and set no service-level target.

## Verdicts

| Gate | Threshold | Measured | Verdict |
| --- | --- | --- | --- |
| Alate 2 — responsiveness after work isolation | health p99 below 100 ms and no host-limit breach during imports and provisions | health p99 10.5–26.3 ms, max 52–327 ms (one 624 ms outlier) across cold, warm, and three-concurrent runs at about 1 GB on the final tree; peak process-tree RSS 1.2–2.2 GiB against the 8 GiB compose cap; `-wal` sidecar bounded at 0.1–0.7 MiB | **pass** — bounded Node isolation holds |
| Alate 1 — provision cost | after safe design changes: own CPU above 1 s and above 30% of repeated provision wall time reopens native planning | warm repeated provision: own CPU 5.4–5.7 s of an 8.7–8.8 s wall (about 64%); cold provision: 3.7 s of 12.7 s (29%) — measured **before** any provision design change | **not evaluable yet** — this card changed no provision-path design, so the gate's precondition is unmet; the numbers are the before-design baseline for the design work first |

A failed gate permits one bounded-component prototype comparison. It never
approves a rewrite by itself. A passed gate keeps the current stack. The
Alate 1 numbers above do not fail the gate: the gate measures own CPU after
the safe design changes of ADR-0001 (decision 2), and no such change has
landed in the provision path yet.

## Method

- Workload: the confirmed about-1-GB snapshot shape, generated once and
  reused byte-for-byte (960 rules, 3,000 × 256 KiB user files, 5 skill
  snapshots, 2 real npm plugins via `bun.lock`, no upstreams.json). A small
  realistic-shape fixture (about 316 KiB, 60 rules) ran as a control.
- Inputs are safe and fixed: synthetic content only, no secrets, plugin
  lifecycle scripts off (no `plugins-allow-scripts` marker).
- Real provision pipeline, exactly the server's: `sync.mjs` then
  `install-user.mjs` with the allowlisted child environment,
  `ALATE_LAYER=1`, and the pinned SkillSpector v2.13.0 scanner from a
  dedicated venv (`SKILLSPECTOR_BIN`). Plugin install ran `bun install
  --frozen-lockfile` against the real npm registry (about 2 tiny packages).
  Seven vendored shipped skills scan on every cold provision, like any
  provision.
- Phase timing: a preload hook wraps `child_process` and logs every child
  span plus the process's own CPU at exit; process-tree wall and CPU come
  from `wait4` rusage. Phases: scanner = SkillSpector spans (trust probe and
  scans); package install = bun spans; network = the registry traffic inside
  the cold bun span (data source was a local path, so git carried no network
  traffic); file guards = install wall minus the scan window, bun, and git
  spans; own CPU = the self CPU of the two node scripts.
- Server responsiveness: the real `server.ts` on an ephemeral loopback port;
  a driver imports the fixture, provisions, and probes `GET /health` every
  10 ms throughout; a sampler reads `/proc` every 25 ms for the process-tree
  RSS peak. Concurrency scenario: three imports queued, then three
  provisions.
- Repetition: 3 cold and 3 warm CLI provisions per fixture; serial
  cold/warm and two three-concurrent server runs on the final code. Cold and
  warm alternate; each cold run gets a fresh home, database, and config; the
  warm pair reuses the home (scan verdict cache and bun cache hot) and
  database.
- Isolation under test: imports, provision snapshots, and snapshot cleanup
  run in one worker client thread (`lib/server-worker.mjs`), with the
  main-thread database lock wait bounded at 50 ms and update checks deferred
  while worker ops run or are queued. The store runs in WAL mode with
  `journal_size_limit` at 64 MiB, and the import op runs a TRUNCATE
  checkpoint when it commits, so the `-wal` sidecar stays small (measured
  0.1–0.7 MiB) instead of growing with the snapshot. The server numbers
  below were re-measured on this exact final tree, after the WAL and
  worker-client changes.

## Alate 1 — provision cost (final code, about 1 GB fixture)

| Phase | Cold (median, 3 runs) | Warm repeated (2 runs) |
| --- | --- | --- |
| sync.mjs wall | 0.20 s | 0.12 s |
| install-user.mjs wall | 12.51 s | 8.59–8.72 s |
| scanner (window) | 8.8 s | 2.5 s (trust probe only; scans cached) |
| package install (bun, registry network on cold) | 180 ms | 37 ms |
| git | 3 ms | 3 ms |
| file guards (residual) | 3.5 s | 5.8–6.2 s |
| own CPU (two node scripts, self) | 3.73 s | 5.4–5.7 s |
| provision wall (sync + install) | 12.71 s | 8.7–8.8 s |
| own CPU share | 29% | about 64% |
| tree CPU (incl. scanner children) | 47.4 s | 8.3–8.7 s |

Reads: on repeated (warm) provisions Alate's own CPU is above both numeric
thresholds, but this is the before-design-work number. The residual CPU
walks, hashes and compares the whole 754 MiB snapshot on every run — the
repeated-work design cost that ADR-0001 (decision 2) and the report's
cheaper choices name for the provision path (for example, avoiding duplicate
layer-rule installation and repeated inventory scans). The gate runs after
that design work lands; until then these numbers are its baseline, and they
open no prototype discussion. Scanner and security behavior stayed
identical throughout.

## Alate 2 — responsiveness after work isolation (final tree, WAL store)

| Scenario | Import wall | Provision wall | health p50 | health p99 | health max | peak tree RSS | `-wal` after import |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold serial, run 1 | 22.1 s | 26.7 s | 1.1 ms | 26.3 ms | 327.1 ms | 2.21 GiB | 0.1 MiB |
| cold serial, run 2 | 24.7 s | 19.8 s | 0.9 ms | 13.5 ms | 66.7 ms | 2.22 GiB | 0.1 MiB |
| cold serial, run 3 | 15.2 s | 18.1 s | 1.0 ms | 16.0 ms | 52.0 ms | 2.22 GiB | 0.1 MiB |
| warm serial | 19.4 s | 13.1 s | 7.7 ms | 11.6 ms | 623.9 ms | 1.24 GiB | 0.2 MiB |
| 3-concurrent imports, run 1 | 34.5 s (3 imports) | 13.2 s | 7.5 ms | 10.5 ms | 50.8 ms | 1.26 GiB | — |
| 3-concurrent imports, run 2 | 28.2 s (3 imports) | 11.1 s | 8.2 ms | 14.1 ms | 52.0 ms | 1.80 GiB | — |

No host-limit breach: the highest process-tree RSS peak was 2.22 GiB against
the 8 GiB compose memory cap, no OOM kill, and no error responses in the
measured windows. The `-wal` sidecar stayed at 0.1–0.7 MiB after imports and
provisions — the 64 MiB `journal_size_limit` and the TRUNCATE checkpoint
after each import keep it from growing with the snapshot. Concurrent
provisions serialize on the pre-existing one-provision-at-a-time guard (the
second and third attempt answer 409 `provision already running`); the three
imports themselves ran concurrently. One warm run saw a single 624 ms health
probe (p99 unaffected) while the import's TRUNCATE checkpoint was syncing
the store. Before the isolation, the same fixtures blocked `/health` for
2,571–2,710 ms on a cold import and 29,674 ms on a warm re-import, and the
provision snapshot alone blocked the loop for about 1.6–1.8 s; those
baseline numbers are the fail-before evidence for the isolation change.

Cost note: on the WAL store a cold import writes the snapshot to the `-wal`
file and the TRUNCATE checkpoint copies it into the database, so the import
wall rose from about 2–3 s (rollback journal, before the isolation work) to
15–25 s at the 1 GB workload. That is a throughput cost of the readable
store, not a responsiveness cost: health p99 stayed between 10.5 and
26.3 ms in every scenario.

## Limits

- One shared workstation (24 logical CPUs, 32 GiB RAM, WSL2), not an
  isolated host; absolute walls carry IO variance, and one mid-battery
  disk-full incident invalidated earlier runs until the state moved to
  larger storage. The CPU shares, latency percentiles, and RSS peaks above
  all come from the clean-storage runs on the final code.
- The registry download measured two tiny packages; a real data repo with
  more plugins scales that phase, not the verdict method.
- Scanner cost scales with skill count and size; this fixture carries five
  snapshot skills plus the seven vendored ones.
- `/health` for a path source spawns one `git rev-parse` per request (about
  5–15 ms); that cost is inside the p50 numbers above.
- Raw logs and drivers lived in temporary scratch directories and were not
  committed; the method section above is the reproduction contract.
