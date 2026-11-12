# 0001. Alate keeps Node and JavaScript

Date: 2026-11-12

## Status

accepted — the stack decision is in force. The gate thresholds in the
Decision follow the confirmed workloads in the Ottr repo's
`docs/specs/rust-decision-gates.md` (OTTR-865). A threshold change there
updates the gate numbers; it does not reopen this decision.

## Context

Task OTTR-807 evaluated a full or partial Rust rewrite of Ottr and Alate.
Ottr records the shared decision as ADR-0012
(`docs/adr/0012-ottr-keeps-typescript-and-bun.md`). This repo records its own
half. The evaluation measured Alate locally and read its failure history:

- A synthetic large data-repo import stopped `/health` for 2,939 ms. The
  import reads every rule and skill file and replaces every snapshot row in
  one synchronous transaction (`importSource` in `web/dashboard.mjs`), and a
  provision writes every stored file to disk synchronously before the child
  scripts start (`snapshotData`). All of that work sits on the server event
  loop.
- `strict: true` coexists with `checkJs: false`, so the runtime `.mjs` files
  (`lib/`, `web/dashboard.mjs`, and the CLI scripts) have no type-check
  coverage.
- The evaluation's provision measurements used a scanner stub and
  `--skip-plugins`, so the real scanner, plugin-install and network costs
  were unknown at decision time.
- A large fresh install spends most of its sampled time in synchronous
  filesystem calls. The failure history holds no GC-pause, runtime-crash or
  server-OOM incident. The recorded fixes need explicit domain rules —
  canonical paths, scanner trust, atomic layer publication — not a different
  language.

The evaluation concludes that the costs follow the amount of work: walking,
checking, hashing and materializing files, plus the external tools (Python
SkillSpector, git, Bun), which a Rust port keeps. Design changes remove the
design costs; a language change does not.

## Decision

1. Alate stays on Node and JavaScript/TypeScript. No Rust prototype starts
   now. This decision changes no deployment.
2. Design work comes first, along the report's cheaper choices: isolate the
   blocking server work in a bounded worker so `/health` stays responsive
   during imports and provisions, and add type checks to the unchecked
   runtime JavaScript through `checkJs` or typed boundaries. Every change
   keeps the security gates: canonical path checks, symlink and hard-link
   rejection, content hashes, secret rejection, trusted scanner paths, child
   environment filtering, lockfiles, and atomic layer publication.
3. Rust returns to consideration only through the two Alate gates, measured
   with the same safe inputs on repeated, alternating runs:

   | Gate | Measurement | What reopens Rust |
   | --- | --- | --- |
   | Alate 1 | Real cold and warm provisions with the trusted scanner, plugins and network, split into scanner, package install, network, snapshot, file guards, and own CPU | remaining own CPU above one second and above 30% of repeated provision wall time after safe design changes |
   | Alate 2 | `/health` p99 and memory peaks during imports and provisions at about 1 GB snapshots and up to three concurrent runs | health p99 of 100 ms or more, or a host-limit breach; then compare one Rust worker if bounded Node isolation still fails |

   A failed gate permits one bounded-component prototype comparison. It
   never approves a rewrite by itself. A passed gate keeps the current
   stack.

## Consequences

- The full-rewrite, FFI and Rust-service options stay rejected until a gate
  fails after the design work.
- The measured numbers for both gates and their verdicts are recorded in
  `docs/measurements/rust-decision-gates.md`; later measurement
  cards update that file.
- A decision to port any component supersedes this ADR with a new one.
