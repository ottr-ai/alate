# alate

Generic provisioning tool for omp agent setups: it reads all content from an
external data repo and installs it. **No personal data lives in this repo** —
rules, user-layer snapshots, and project snapshots come from the data repo.
The data repo lives beside this checkout (`../agent-data`) by default; override
with `--data`. `examples/data` is a neutral fixture used by tests and CI.

## Layout

- `lib/data.mjs`: shared data-repo plumbing (`resolveDataDir`, `cleanupData`, arg parsing).
- `sync.mjs`: install the data repo's rules into omp's rules dir.
- `install-user.mjs`: restore the data repo's `user/` snapshot onto this machine. Before any write it scans every skill snapshot (`skills/`, `managed-skills/`) with the pinned SkillSpector build (`--no-llm --fail-on-findings --use-shipped-baseline`, static only; the snapshot's shipped `.skillspector-baseline.yaml` supplies its accepted findings), findings, a missing scanner, or a crashed scan abort the run with a non-zero exit and leave the home untouched. The scanner needs Python 3.12+ where it runs: the server image carries the pinned build (`Dockerfile`, `SKILLSPECTOR_REF` — the test suite checks that it matches the script's pin), and a host that runs the script outside the image installs it by hand (pin and bootstrap command live in the script).
- `sync-user.mjs`: capture this machine's omp user layer into the data repo.
- `sync-projects.mjs`: refresh project agent-context snapshots into the data repo.
- `*.test.mjs`: plain-node self-checks, one per script; `zero-deps.test.mjs` is the dependency gate, not tied to a script.
- `web/index.html`/`style.css`/`app.js`/`diff.mjs`: the dashboard's static assets (Galley Proof world, see `DESIGN.md`; `diff.mjs` is the editor's line diff for proof marks; `manifest.webmanifest`, `sw.js`, and `icons/` make the dashboard installable as a PWA — `sw.js` is a network-first offline shell, and its precache list mirrors the static table in `server.ts`), and `web/dashboard.mjs` its inventory and file-edit logic, served by `server.ts` on the same loopback port as the provisioning API; the dashboard's self-check lives in `server.test.mjs`.
- `server.ts` (+ `server.test.mjs`): long-running loopback provisioning server (key-authenticated provision API, server-side config, periodic data-repo update checks), built on Fastify and run via `node server.ts` type stripping — no build step; it also serves the dashboard UI, its inventory API (`GET /api/state`, `POST /api/import`) and its file editor API (`GET /api/files`, `GET`/`PUT`/`DELETE /api/file`: snapshot reads plus edits that verify a base hash, commit and push) with `--db <file>` (SQLite snapshot of source files and inventory, default `alate.db` beside the config file) and `--data <dir>` (import at startup) flags; `server.test.mjs` is its self-check.
- `package.json` + `package-lock.json` + `tsconfig.json`: the only manifest, lockfile, and TS config; `dependencies` holds the server's runtime deps (`fastify`) and the two self-hosted dashboard fonts (`@fontsource-variable/source-serif-4`, `@fontsource-variable/jetbrains-mono`, served as woff2 from `/fonts/`), `devDependencies` the tooling (`typescript`, `@types/node`, `@stryker-mutator/core`). Everything else stays plain node with no third-party imports.
- `stryker.config.mjs`: mutation testing config, run via `npm run test:mutation`.
- `examples/data/`: starter data repo and CI fixture.
- `compose.yaml`: Docker Compose for the prepared run path (service `alate`, `ghcr.io/ottr-ai/alate:latest`, `state` and `home` volumes).
- `.github/workflows/install.yml`: installs from `examples/data` on a fresh runner; `.github/workflows/sync.yml` runs the self-checks; `.github/workflows/release.yml` pushes the Docker image to ghcr.io on each GitHub release.

## Commands

Every script needs a data repo, passed with `--data <dir>` (`examples/data`
works for a dry run):

- `node sync.mjs --data ../agent-data`
- `node install-user.mjs --data ../agent-data`
- `node sync-user.mjs --data ../agent-data`
- `node sync-projects.mjs --data ../agent-data`
- "Verified" means this exact chain passes from the repo root (the same chain
  `.github/workflows/sync.yml` runs):
  `npm ci && node zero-deps.test.mjs && node sync.mjs "$(mktemp -d)" --data examples/data && node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node architecture.test.mjs && node clone.test.mjs && npx tsc --noEmit && node server.test.mjs`
  The smoke sync passes a throwaway target dir, so the chain never writes the example rule
  into the rules dir of the home that runs it (agents share one live home).
  `npm run test:mutation` is the StrykerJS mutation gate for server logic
  changes; it is slow, so it is not part of the
  fast chain.
  Reviews additionally run the property deep tier once, as a source of findings, never
  as a gate (the gate tier runs inside the chain above at the fixed seed 42, 200 runs):
  `PROP_RUNS=20000 node server.test.mjs && PROP_RUNS=20000 node sync-projects.test.mjs && PROP_RUNS=20000 node sync-user.test.mjs && PROP_RUNS=20000 node clone.test.mjs`.
  A failure there becomes a finding with the seed and the failing input; triage decides whether the code or the property is wrong.

## Releases and versions

This repo has none: no tags, no changelog, no release script (the single
`package.json` is private and unversioned — it exists only to pin the
provisioning server's dependencies). A person cuts a release when one is
needed; the notes come from commit messages, and a merge pushes with
`git push origin main` only. The first public release goes to a new GitHub
repository that holds one squashed root commit of the clean tree. Never make
the current repository public: a force-pushed squash does not remove old
commits, which stay reachable by SHA and in GitHub's cached views.
The pinned omp version in
`.github/workflows/install.yml` changes through an ordinary commit.

## Commits

One-line conventional `type: summary`, matching the existing log: `sync:`,
`test:`, `ci:`, `docs:`, `fix:`, `chore:`. No changelog entries and no
version bumps; release notes come from commit messages when a person cuts a
release.

## Merging task branches

Integration runs one task branch at a time.
Integration rules: linear history, never a merge commit.

1. `git fetch origin`, then rebase the task branch onto `origin/main`.
2. Resolve conflicts keeping both intents. If the two intents genuinely cannot
   coexist, stop and ask which wins.
3. No snapshot-refresh chore in this repo: this checkout holds no snapshots.
   (The data repo refreshes itself via its own pre-push hook.)
4. Re-run the full verified chain from Commands on the rebased branch; all
   must pass.
5. Integrate with `git merge --ff-only <branch>`: main gains exactly the task's
   work commits. `--ff-only` fails loudly instead of creating a merge commit; if
   it fails because `main` moved meanwhile, redo step 1 and retry.
6. `git push origin main` right after a successful merge, then
   `git worktree remove .worktrees/<id>` and `git branch -d <branch>`.
7. If the push still fails after one rebase-and-retry, stop and ask the user;
   never force-push.
