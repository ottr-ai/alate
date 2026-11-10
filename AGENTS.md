# alate

Generic provisioning tool for omp agent setups: it reads all content from an
external data repo and installs it. **No personal data lives in this repo** —
rules, user-layer snapshots, and project snapshots come from the data repo.
The data repo lives beside this checkout (`../agent-data`) by default; override
with `--data`. `examples/data` is a neutral fixture used by tests and CI.

## Layout

- `lib/data.mjs`: shared data-repo plumbing (`resolveDataDir`, `cleanupData`, arg parsing).
- `sync.mjs`: install the data repo's rules into omp's rules dir.
- `install-user.mjs`: restore the data repo's `user/` snapshot onto this machine. Before any write it scans every skill snapshot (`skills/`, `managed-skills/`) with the pinned SkillSpector build (`--no-llm --fail-on-findings --use-shipped-baseline`, static only; the snapshot's shipped `.skillspector-baseline.yaml` supplies its accepted findings); findings and scan errors reject that one skill, and a scanner that cannot run at all aborts the run with a non-zero exit and leaves the home untouched. The scans run in parallel (at most `min(8, availableParallelism())` child processes, reports buffered per scan) and re-scan only what changed: each skill folder's content hash, the scanner pin and probed version, and the scan arguments key a passed verdict in `<home>/.alate/skillspector-pass.json` (written atomically; a rejection is never cached). The scanner needs Python 3.12+ where it runs: the server image carries the pinned build (`Dockerfile`, `SKILLSPECTOR_REF` — the test suite checks that it matches the script's pin), and a host that runs the script outside the image installs it by hand (pin and bootstrap command live in the script).
- `sync-user.mjs`: capture this machine's omp user layer into the data repo.
- `sync-projects.mjs`: refresh project agent-context snapshots into the data repo.
- `scripts/mutant-run.mjs` (+ `mutant-run.test.mjs`): per-file test selection for both Stryker configs' command runner: stage 1 runs the chain files that reach the mutated file, stage 2 runs the rest, so each mutant still faces the whole chain. A map miss runs the whole chain: slower, never wrong.
- `license-gate.mjs` (+ `license-gate.test.mjs`): license gate over the npm tree; every
  `package-lock.json` entry's `license` field must be an allowlisted SPDX expression.
- `*.test.mjs`: plain-node self-checks, one per script; `zero-deps.test.mjs` is the dependency gate, not tied to a script.
- `home-guard.test.mjs`: brackets the chain. `record` snapshots the real HOME's
  `.alate`, `.agents` and `.omp` before the tests run; the final `check` fails the
  chain when a path or an mtime there changed. A run with no argument is the guard's
  own self-check against fake homes. Chain runs that share one machine set
  `ALATE_HOME_GUARD_SNAPSHOT` to separate snapshot paths. The guard ignores the
  platform's own runtime files (the omp databases, logs, cache, run, the session
  stores under `.omp` — context-mode, custom-session-files, snapcompact — and the two
  bookkeeping files under `.alate`): a live worker writes them during any chain.
- `web/index.html`/`style.css`/`app.js`/`diff.mjs`: the dashboard's static assets (Galley Proof world, see `DESIGN.md`; `diff.mjs` is the editor's line diff for proof marks; `manifest.webmanifest`, `sw.js`, and `icons/` make the dashboard installable as a PWA — `sw.js` is a network-first offline shell, and its precache list mirrors the static table in `server.ts`), and `web/dashboard.mjs` its inventory and file-edit logic, served by `server.ts` on the same loopback port as the provisioning API; the dashboard's self-check lives in `server.test.mjs`.
- `server.ts` (+ `server.test.mjs`): long-running loopback provisioning server (key-authenticated provision API, server-side config, periodic data-repo update checks), built on Fastify and run via `node server.ts` type stripping — no build step; it also serves the dashboard UI, its inventory API (`GET /api/state`, `POST /api/import`) and its file editor API (`GET /api/files`, `GET`/`PUT`/`DELETE /api/file`: snapshot reads plus edits that verify a base hash, commit and push) with `--db <file>` (SQLite snapshot of source files and inventory, default `alate.db` beside the config file) and `--data <dir>` (import at startup) flags; `server.test.mjs` is its self-check.
- `package.json` + `package-lock.json` + `tsconfig.json`: the only manifest, lockfile, and TS config; `dependencies` holds the server's runtime deps (`fastify`) and the two self-hosted dashboard fonts (`@fontsource-variable/source-serif-4`, `@fontsource-variable/jetbrains-mono`, served as woff2 from `/fonts/`), `devDependencies` the tooling (`typescript`, `@types/node`, `@stryker-mutator/core`). Everything else stays plain node with no third-party imports.
- `stryker.config.mjs`: mutation testing config for the server half (`server.ts`, `web/dashboard.mjs`, `lib/updates.mjs`), run via `npm run test:mutation`.
- `stryker.cli.config.mjs`: second mutation config chained by `npm run test:mutation`; mutates `lib/data.mjs` and the four CLI scripts with the CLI test files as the runner.
- `examples/data/`: starter data repo and CI fixture.
- `compose.yaml`: Docker Compose for the prepared run path (service `alate`, `ghcr.io/ottr-ai/alate:latest`, `state` and `home` volumes).
- `.github/workflows/install.yml`: installs from `examples/data` on a fresh runner; `.github/workflows/sync.yml` runs the self-checks; `.github/workflows/release.yml` pushes the Docker image to ghcr.io on each GitHub release.

## Commands

Every script needs a data repo, passed with `--data <dir>` (`examples/data`
works for a dry run).
- "Verified" means this exact chain passes from the repo root (the same chain
  `.github/workflows/sync.yml` runs):
  `npm ci && npm audit --omit=dev --audit-level=low && node license-gate.mjs && node zero-deps.test.mjs && node license-gate.test.mjs && node home-guard.test.mjs && node home-guard.test.mjs record && node sync.mjs "$(mktemp -d)" --data examples/data && node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node architecture.test.mjs && node clone.test.mjs && node skills/create-data-repo/scan-secrets.test.mjs && node scripts/mutant-run.test.mjs && npx tsc --noEmit && node server.test.mjs && node home-guard.test.mjs check`
  The smoke sync passes a throwaway target dir, so the chain never writes the example rule
  into the rules dir of the home that runs it. Each install or sync child in the
  self-checks gets HOME and USERPROFILE of a scratch dir beside the fixtures, and the
  suite drops PI_CODING_AGENT_DIR from the child env. A dropped `--home` or target — the
  mutant class of the 2026-11-06 incident — writes into the sandbox and fails a test, not
  the machine home.
  `npm run test:mutation` is the StrykerJS mutation gate for server and CLI
  logic changes (it runs both mutation configs). It is slow, so it is not
  part of the fast chain.
  Work turns skip `npm run test:mutation` and say so in their report.
  Only reviews (the Review button and every release) and explicit architecture
  work run it. Architecture work asks to review the architecture or test
  quality, or uses the codebase-design or ponytail-audit skill.
  A gate-restoration card states the measured score, the target, and the kill gap. The turn confirms the target with the user before the first full batch run.
  Run one full foreground `npx stryker run` for each batch of survivor clusters (a full server run takes about 4 h). The final acceptance run covers the whole tree.
  `thresholds.break` never goes above 90. A measured score above 90 may be set to 90.
  Reviews additionally run the property deep tier once, as a source of findings, never
  as a gate (the gate tier runs inside the chain above at the fixed seed 42, 200 runs):
  `PROP_RUNS=20000 node server.test.mjs && PROP_RUNS=20000 node sync-projects.test.mjs && PROP_RUNS=20000 node sync-user.test.mjs && PROP_RUNS=20000 node clone.test.mjs && PROP_RUNS=20000 node zero-deps.test.mjs && PROP_RUNS=20000 node license-gate.test.mjs`.
  A failure there becomes a finding with the seed and the failing input; triage decides whether the code or the property is wrong.
- Every mutant declared equivalent in a stryker config comment must cite its proof: a command with its output, or a pinned example input. Prose alone is not a proof.

## Releases and versions

This repo has none: no tags, no changelog, no release script (the single
`package.json` is private and unversioned — it exists only to pin the
provisioning server's dependencies). Release notes come from commit messages
when a person cuts a release. The pinned omp version in
`.github/workflows/install.yml` changes through an ordinary commit.

## Commits

One-line conventional `type: summary`, matching the existing log: `sync:`,
`test:`, `ci:`, `docs:`, `fix:`, `chore:`. No changelog entries and no
version bumps; release notes come from commit messages when a person cuts a
release.

## Merging changes

Integration keeps linear history; never a merge commit.

1. `git fetch origin`, then rebase the branch onto `origin/main`.
2. Resolve conflicts keeping both intents. If the two intents genuinely cannot
   coexist, stop and ask which wins.
3. Re-run the full verified chain from Commands on the rebased branch; it must pass.
4. Integrate with `git merge --ff-only <branch>`. If it fails because `main`
   moved meanwhile, redo step 1 and retry.
5. Never force-push. If a push keeps failing after one rebase-and-retry, stop
   and ask the user.
