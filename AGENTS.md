# alate

Generic provisioning tool for omp agent setups: it reads all content from an
external data repo and installs it. **No personal data lives in this repo** —
rules, user-layer snapshots, and project snapshots come from the data repo.
The data repo lives beside this checkout (`../agent-data`) by default; override
with `--data`. `examples/data` is a neutral fixture used by tests and CI.

## Layout

- `lib/data.mjs`: shared data-repo plumbing (`resolveDataDir`, `cleanupData`, arg parsing).
- `sync.mjs`: install the data repo's rules into omp's rules dir.
- `install-user.mjs`: restore the data repo's `user/` snapshot onto this machine. Before any write it scans every skill snapshot (`skills/`, `managed-skills/`) with the pinned SkillSpector build (`--no-llm --fail-on-findings --use-shipped-baseline --show-suppressed --format json`, static only; the snapshot's shipped `.skillspector-baseline.yaml` may accept LOW and MEDIUM findings, and each accepted finding of another severity needs an entry in a review file outside the skill folders — `<data repo>/skillspector-reviews.json`, or `shipped/skillspector-reviews.json` for the vendored skills — else the skill is rejected with rule `unreviewed baseline acceptance`; an invalid review file refuses the run; contract in `specs/skillspector-reviewed-acceptances.md`); findings and scan errors reject that one skill, and a scanner that cannot run at all aborts the run with a non-zero exit and leaves the home untouched. The scans run in parallel (at most `min(8, availableParallelism())` child processes, reports buffered per scan) and re-scan only what changed: each skill folder's content hash, the scanner pin and probed version, the scan arguments, and the skill's review entry keys key a passed verdict in `<home>/.alate/skillspector-pass.json` (written atomically; a rejection is never cached). A snapshot entry `user/alate` (any case) refuses the run before any scan or write: it would land in `~/.alate`, which holds that cache and the install record. The scanner needs Python 3.12+ where it runs: the server image carries the pinned build (`Dockerfile`, `SKILLSPECTOR_REF` — the test suite checks that it matches the script's pin), and a host that runs the script outside the image installs it by hand (pin and bootstrap command live in the script).
- `sync-user.mjs`: capture this machine's omp user layer into the data repo.
- `sync-projects.mjs`: refresh project agent-context snapshots into the data repo.
- `install-projects.mjs` (+ `install-projects.test.mjs`): install the per-project snapshot files that `projects/projects.json` lists into the workspace project checkouts (`--root <workspaceDir>`; the server passes it from the `projectsRoot` config value, else a path source's parent folder). The snapshot wins over a changed machine copy; every write is logged; shares the capture baseline record (`<workspace-root>/.alate/captured-projects.json`) and its key format with `sync-projects.mjs`; contract in `specs/install-projects.md`.
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
  stores under `.omp` — context-mode, custom-session-files, snapcompact — the cache
  and session stores of the browser profiles under `.omp/browser-profiles` (the
  `Cache`, `Code Cache` and the GPU shader cache trees (`GPUCache`, `GPUPersistentCache`,
  `GrShaderCache`, `ShaderCache`, `GraphiteDawnCache`, `DawnGraphiteCache`,
  `DawnWebGPUCache`) plus the
  `Cookies` and `History` stores with their `-wal` and `-journal` files; the rest of
  each profile stays watched), the agent
  blob cache `agent/blobs`, the plugin download cache `plugins/cache` (anything
  else under `plugins/` stays checked), the live worker's `memories` store and its
  memory backend store `agent/memories` (under `.omp` and, through the layer ignore
  set, under each layer's `.omp`), `oauth`,
  `install-id`, `marketplaces.json` and `natives` files, the live worker's
  `.omp/autoqa.db` runtime database with its `-wal` and `-journal` files, the alate rules
  install record `.omp/agent/rules/.alate-installed.json` (a sibling session's `sync.mjs`
  run rewrites it mid-chain; the rule files beside it stay watched), the live worker's layer
  runtime under `.alate/layers/<id>/.omp` (the same ignore set as `.omp`, plus the
  layer's `puppeteer` browser-tooling install; the layer's other files stay watched),
  and the two bookkeeping files under `.alate`): a live worker writes them during any chain.
  A directory mtime diff is dropped when no checked direct child has a diff of its own:
  the memory backend can create `agent/memories` mid-chain, which moves the `agent`
  mtime alone. A checked child diff keeps the parent mtime diff.
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
  `npm ci && npm audit --omit=dev --audit-level=low && node license-gate.mjs && node zero-deps.test.mjs && node license-gate.test.mjs && node crlf.test.mjs && node home-guard.test.mjs && node home-guard.test.mjs record && node sync.mjs "$(mktemp -d)" --data examples/data && node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node install-projects.test.mjs && node lib/bundles.test.mjs && node lib/canonical.test.mjs && node install-bundles.test.mjs && node canonical-form.test.mjs && node architecture.test.mjs && node clone.test.mjs && node skills/create-data-repo/scan-secrets.test.mjs && node scripts/mutant-run.test.mjs && npx tsc --noEmit && node lib/env-proxy.test.mjs && node server.test.mjs && node home-guard.test.mjs check`
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
- A new test file joins `npm test`, the verified chain above, and `.github/workflows/sync.yml` in the commit that adds it. A test file that no chain entry runs is not verification.
- Every mutant declared equivalent in a stryker config comment must cite its proof: a command with its output, or a pinned example input. Prose alone is not a proof.
- When a change gates a credential by host, enumerate every route that sends it (clone auth header, API bearer, periodic checks, subagent jobs) and every host state it can meet (unset, configured GitHub host, foreign host, per-repo spec host, failed or refused import), and ship a fail-before test for each route and state in the first commit.
- If a gate fails only sometimes on the same tree, suspect residue from sibling omp sessions on this machine (for example a `home-guard.test.mjs check` mtime line or a `/tmp` dir that the `server.test.mjs` leak watcher flags). Read the tracker grievance rows for the failure time. Check the owner of the flagged `/tmp` path. Run `file` on the flagged path. After you identify the writer, flag the finding as out of scope. Do not classify with repeated HEAD baseline runs.
- A containment fix ships its attack-move tests in the first commit. List the moves that keep the pinned property: a move keeps the inode, a symlink swap keeps the path, a planted name keeps the path. Give each move a test that fails before the fix.

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

## Acceptance decisions

- Before implementation, enumerate every acceptance decision that only the user can settle (a proof route, a pin source, a policy exception), probe each against the reachable environment, and ask the unsettled ones in one ask round. Ask for an approval only after the evidence it names exists (ALAT-175: five needs_you rounds, $11.01).

## Ready reports

- Before a ready report, check the diff against every acceptance clause of the card, one clause at a time. List each clause with its evidence in the report.
- A ready report states every deviation from the card or steer text, with the reason. The implementation ships the mechanism the card or steer names unless the ready report gives that reason.
- When a change touches a failure path, test each point where the failure can fire in the first commit. One fixture covers one point. A fetch timeout fires at connect, at the response headers, and at the body read (ALAT-103, ALAT-113, ALAT-131). When a change keeps, restores, or resurrects state that a deletion or cleanup loop would otherwise remove, derive the kept set from the durable record, not from a walk of the new source tree (ALAT-178). Test each disagreement class between the record and each source tree (changed, dropped, added) in the first commit.
- When an acceptance clause covers a merge order, a mode difference, or a key that another module also normalizes, test the clause's edge forms (a missing list file, a duplicate name with different case, the precedence direction) and name the pinning test as the clause's evidence in the ready report.
- If the card lists a closed set, implement and test every element in the first commit. A closed set is a listed group of item kinds, entry paths, or states. Each element's test drives the payload shape that its real caller sends. A test that hand-builds the payload proves only one half. A refuse check keys on the whole entity (for a bundle folder, any list file), never on one representative file. Name the per-element evidence in the ready report.
- A chain-green claim in a ready report cites one run of the verified-chain command copied verbatim from Commands. A reassembled command that drops any chain entry makes the claim false.
- When a change adds or moves a check that more than one code path performs, put the card's rule before any mode branch. Give each entry path a fail-before test in the first commit.
- A ready report states the exact observed result of each red-before check: the command, and each new test's fail or pass. It names any new test that passes before the fix, with the reason the test still pins the behavior.
- When a change classifies scanner, model, or ledger reports for a gate, list in the ready report every report shape that must still reject — a flag without its diagnostic line, an unknown phase or reason code, a report that carries both verdict classes, a degraded re-scan — and name each shape's fail-before test.

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
