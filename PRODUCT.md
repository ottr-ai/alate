# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The repo allows only dependencies in the root `package.json` (`zero-deps.test.mjs`
and the dependency gates): Fastify for the server, and two
font packages (Source Serif 4, JetBrains Mono) that the server serves as
self-hosted woff2 files. The UI is static HTML/CSS and plain browser JS
modules with relative imports only. No framework and no build step.

## Users

The machine's owner provisioning or auditing their own omp agent setup
(inferred from the brief and README: alate reads the owner's private data
repo). Single operator, desktop or phone browser,
often on a NAS where this UI is the only way to change agent-data. Success:
they see everything the data repo provisions — and where it comes from — and
they can change any file without other git access.

## Product Purpose

The web dashboard, editor, and settings site for alate, the omp agent
provisioning tool. Onboarding: choose the data repo (a local checkout path, or
`owner/name[@ref]` cloned like the CLI does) and import it. Then: an overview
of every imported piece (rules, user layer, skills, plugins, projects, repo
files, updates), a file index of every file, and an editor that creates,
changes, and deletes files and commits and pushes each change to the data
repo. Success means: first run onboards without reading docs; every file is
reachable in two clicks; a change reaches agent-data without a git client.

## Positioning

The only face of the data repo: alate's CLI installs content blindly; the
dashboard is where the owner sees and changes what they carry.

## Operating Context

- Runs locally beside the alate checkout; data source resolution mirrors the
  CLI: `--data <dir>`, `--repo <owner/name[@ref]>` (shallow clone via
  `lib/data.mjs`), `$ALATE_DATA`, then `../agent-data` beside the checkout.
- The data repo is trusted-but-reviewed content: rules change agent behavior;
  restored skills/plugins can run code. The owner edits every file here,
  config.yml and mcp.json included by design;
  the capture already strips deployment credential blocks from config.yml.
- Session facts: `GH_TOKEN`/`GITHUB_TOKEN` may clone private repos; tokens
  must never reach the UI, argv, or logs (reuse `redactSecrets`).

## Capabilities and Constraints

- Onboarding: pick data source (local path or GitHub spec), import, see the
  inventory; the chosen source persists locally for the next visit.
- Overview sections mirror the data-repo contract: rules (root `*.md`/`*.mdc`
  with `description:` frontmatter), user layer (config.yml, mcp.json,
  optimizer.json, extensions, skills, managed-skills, marketplaces.json,
  plugin manifests + lockfiles, .skill-lock.json, .agents/skills), projects
  (projects.json manifest: contextFiles + named projects with extras, plus
  snapshot file counts).
- Editor: one file per commit; the base hash guards against overwriting a
  newer version (409), and the client keeps the draft and re-marks it against
  the new version. CRLF files keep CRLF on save.
- Settings: current source, re-import, change source, GitHub key, auto-update,
  app key.
- Hard constraint: dependencies only through the root manifest; client JS has
  relative imports only; key-free only on a loopback bind — a non-loopback
  `--host` requires the app key (Bearer or `POST /api/login` cookie, with an
  Origin check on cookie writes) on every route that reads or changes state.

## Brand Commitments

- Name: alate; smiling winged-ant logo (`logo.png`); the ant/colony metaphor
  ("spreads its wings, sets up new colonies") is the product's own voice.
- Tone: precise, dry, safety-aware (README voice). Copy names actions and
  errors plainly, never markets.

## Evidence on Hand

- `examples/data/` — starter data repo and CI fixture (two starter rules, a
  config stub, a projects manifest) usable as demo/import target.
- `logo.png` — the only visual asset. No screenshots, no testimonials; do
  not fabricate any.

## Product Principles

1. Inventory first: the whole provisioning payload legible in one screen.
2. Mirror the CLI: same source resolution, same validation, same vocabulary
   as sync.mjs / install-user.mjs / sync-user.mjs / sync-projects.mjs.
3. Trust boundaries visible: show where data came from; tokens never reach the
   UI; every write names its commit; key-free on loopback, key-guarded on a
   non-loopback bind.
4. Dependencies only through the root manifest, boring code, plain node.

## Accessibility & Inclusion

Standard baseline assumed: keyboard-operable controls, visible focus, ≥4.5:1
body contrast, semantic landmarks. No product-specific requirement confirmed.
