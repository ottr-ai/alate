# Agent layer switch: install into a new layer, switch atomically

Alate-side contract for card ALAT-63. The ottr card OTTR-451 owns the runner-side spec
(`docs/specs/agent-layer-switch.md` in the ottr repo); this file records the shared read
paths and the alate decisions. If the two specs disagree, the ottr spec wins and this file
gets the change.

## Why

`install-user.mjs` writes the agent layer in place into the shared home volume (`/root`,
shared by the ottr server and both workers). A provision must wait for an idle board, and a
busy board waits for hours. With layers, a provision never waits and never touches a file a
running turn reads: it installs into a new folder, then one atomic rename makes it live.

## Layout in the shared home

- Base: `<home>/.alate`
- Layer mode resolves the home once to its real path (through the longest existing
  prefix, so a fresh home still resolves): a `--home` given relative or through a symlink
  behaves exactly like the path it resolves to — the switch link and the shared-state
  links carry absolute targets under the resolved home, and clean-up keys its keep set by
  layer id. Non-layer mode keeps the home as given.
- Layers: `<home>/.alate/layers/<id>`
- Layer id: `<commit>-<n>`. `<commit>` is the first 12 hex characters of `git -C <data-dir>
  rev-parse HEAD`; a data dir without git uses `nogit`. `<n>` continues the highest counter
  already on disk for that commit, starting at 1.
- Switch link: `<home>/.alate/current`, a symlink with an absolute target. It exists only as
  absent or as a symlink; anything else refuses the run before any write.
- In-use record: `<home>/.alate/in-use.json`, shape `{"layers": ["<id>", ...]}`. The turn
  runner maintains it (see "Turn pinning").

## Layer contents (the allowlist)

A layer holds exactly what a provision ships today:

- the `sync-user.mjs` ITEMS snapshot (`.omp/agent` config, skills, managed-skills,
  extensions, plugins manifests, `.omp/marketplaces.json`, `.agents`, `.pi/agent/pix.json`),
- the data-root rules, installed by `sync.mjs` into `<layer>/.omp/agent/rules`,
- the per-project worker lists (`workers/<project>/{apt.txt,tools.json,env.txt,requirements.txt}` →
  `<layer>/.ottr/workers/<project>/`).

Per-layer records: `<layer>/.alate/installed.json` (user snapshot fingerprints) and
`<layer>/.omp/agent/rules/.alate-installed.json` (rule fingerprints). Each layer starts
fresh from the snapshot, so its records start empty and describe only that layer.

## Shared state: the link set

State that is not part of the layer stays in the shared home and is shared by every layer.
Each new layer gets symlinks back to the shared paths, so a turn that runs with
`HOME=<layer>` reads and writes the same state as today:

- File links: `.omp/agent/agent.db` (worker credential store), `.gitconfig`,
  `.pi/agent/optimizer.json` (pix machine-local runtime toggle).
- Directory links: `.omp/oauth`, `.omp/sessions`, `.omp/agent/sessions`,
  `.omp/agent/memories`, `.omp/memories`, `.config` (gh config), `.cache`, `.bun`.

Rules for the links:

- Targets are absolute paths under `<home>`. Missing parents of a target are created.
- A missing target stays a dangling link; the first write through it creates the target, the
  same as a fresh home today.
- A layer path the snapshot itself ships is left as snapshot content (no link) and reported
  in the run output, so a future allowlist change cannot silently drop shared state.
- The sessions and memories lists carry both known spellings on purpose; trim the list when
  the ottr side pins the real omp layout.

## Install order (layer mode)

1. Preflight: `current` must be absent or a symlink; otherwise refuse before any write.
2. Plan from the snapshot. The content gates (Markdown rule gate, worker list validation)
   run before any write, exactly as today.
3. Create `<home>/.alate/layers/<id>`.
4. Rules: spawn `node sync.mjs <layer>/.omp/agent/rules --data <dir>`. Its gates stay
   fail-closed; a failure surfaces its error text, deletes the layer folder, and exits
   non-zero with `current` unchanged.
5. Write the user snapshot and the worker lists into the layer (conflict rule below).
6. SkillSpector scan of the skills inside the installed layer, same pin, same flags
   (`--no-llm --fail-on-findings --use-shipped-baseline`). A failed scan deletes the layer
   folder and leaves `current` unchanged.
7. Plugins: `bun install --frozen-lockfile --backend copyfile` with cwd `<layer>/.omp/plugins`,
   so `node_modules` of a running turn never change (unless `--skip-plugins`). The install
   runs with `--ignore-scripts` unless the data repo ships a `plugins-allow-scripts` marker
   at its root, and the spawn environment is an explicit allowlist, so server secrets never
   reach bun or a lifecycle script. The copyfile backend keeps every snapshot file
   single-linked, so the alias guards on machine reads never refuse a link the provisioner
   created itself. A failure deletes the layer folder and leaves `current` unchanged.
8. Create the link set in the layer.
9. Switch: create a temporary symlink in the base dir, then `rename()` it over `current`.
   POSIX rename is atomic; a reader sees either the old or the new target, never a gap.
10. Clean-up (below).

Any failure before step 9: the new layer folder is deleted, `current` is unchanged, exit is
non-zero. A failure after the switch changes nothing about the switch itself.

## Machine part of config.yml, and machine changes

- The current layer's top-level `hindsight:`/`alate:` blocks ride onto the new layer's
  `config.yml` (the same `splitDeploymentBlocks` merge the in-place mode does). A first
  layer with no current layer gets none, like a fresh home — unless the home holds an
  in-place install: the first layer over an in-place home reads the machine part of
  `config.yml` from the home itself, so the blocks and the machine edits of `config.yml`
  survive the migration to layers. Every other file starts from the snapshot in that
  case. The home's `installed.json` is the migration baseline for `config.yml`: a home
  `config.yml` that still holds what the in-place install wrote — compared modulo the
  deployment blocks and the memory backend entry — takes the snapshot, so a stale
  pre-layer config never freezes. A machine edit still wins, and its kept bytes lose
  the backend entry like any kept `config.yml`.
- A machine change in the current layer that goes beyond the deployment blocks: machine
  state wins. The new layer keeps the machine bytes for that file, and the run reports each
  kept path. `--force` takes the snapshot instead; the deployment blocks still ride along.
  This is how a machine edit such as the entry script's top-level `memoryBackend:` key
  survives every switch, wherever in the file it sits. The memory backend itself is a
  deployment choice (OTTR-453): the board injects it at spawn time. Capture strips the
  `backend:` entry under the top-level `memory:` key, install drops the entry from the
  snapshot, a kept `config.yml` loses the entry the same way, and the layer comparison
  of the machine file ignores the entry, so it never rides along with the machine part.
- Plugin install files are the exception: a machine change to `omp/plugins/package.json`,
  `omp/plugins/bun.lock`, or anything under `omp/plugins/patches/` never rides into the
  new layer. The provisioner itself runs `bun install` over these files, so the snapshot
  always wins and a note names each file. A deliberate change goes through a data-repo
  commit.
- A machine-kept JSON/YAML file can hold absolute paths that were re-rooted into the live
  layer at its install. The copy re-roots them into the new layer, so clean-up can delete
  the live layer; paths into the shared home stay shared.
- A path the snapshot dropped is simply absent from the new layer. Nothing is deleted from
  the current layer; a pinned turn keeps reading it.
- Machine-side reads in layer mode never follow an alias out of the live layer. An agent
  turn runs with `HOME=<live layer>` on the shared home volume, so it can replace a
  snapshot path, or the layer's own install record, with a symlink, hard link, or special
  file whose target the layer must not read (`/state`, `/proc`). Before any machine-side
  read, the same `checkDestination` guard the write side applies runs against the read
  path, and a violation refuses the whole run before any write, exactly like an alias at
  a destination. A first layer over an in-place home applies the same guard to the home's
  `config.yml` before the migration reads it.

## Captured absolute paths

Captured JSON/YAML config can hold absolute paths into the capture home: `catalogPath` in
`.omp/marketplaces.json`, MCP args, plugin paths. Layer mode re-roots every occurrence that
starts at `<home>/` to `<layer>/` while installing `.json`, `.yml`, and `.yaml` files. The
rewrite fires only behind a boundary (a JSON string start, whitespace, or `:`), so a path
fragment inside a longer word never changes. A pinned turn then reads its own layer's file
under the path it expects; a test proves it with `marketplaces.json`. Non-layer installs
keep the bytes exactly as today. Captures must not run with `HOME` inside a layer: a
capture that reads layer files would ship layer-prefixed absolute paths into the snapshot,
and no re-root can repair a foreign layer id.

## Turn pinning (ottr side)

- At turn start the runner resolves `realpath(<home>/.alate/current)` once and passes that
  absolute path as the turn's `HOME` for the whole turn (`PI_CODING_AGENT_DIR` derives from
  it). It never re-reads `current`, so a later switch never touches the turn.
- Before it spawns the turn, the runner adds the layer id to `in-use.json`; when the turn
  ends, it removes the id again. This record is what makes clean-up safe. A runner that
  does not record must not run turns against `current`.

## Clean-up

After a successful switch, delete `<home>/.alate/layers/<name>` only when all of these hold:

- `<name>` matches the layer-id shape (`<12-hex|nogit>-<digits>`),
- it is not the new layer, not the realpath of `current`, and not the previous target,
- it is not listed in `in-use.json`.

`current` and the one before it are always kept. If `in-use.json` exists but is unreadable,
delete nothing and say so. If it is absent, no runner has recorded a pin yet, so no turn can
hold a layer, and deletion proceeds. Stale entries only cost disk space; the runner prunes
them at turn end.

## Activation

- `install-user.mjs`: the `--layer` flag, or `ALATE_LAYER=1` in the environment. The server
  passes its environment to the scripts it spawns, so compose turns layer mode on without a
  server change.
- `compose.yaml` sets `ALATE_LAYER=1` on the `alate` service.
- `GET /health` reports layer mode in its body: `layers` is `true` only when
  `ALATE_LAYER=1` is set in the server environment, `false` otherwise. The field is the
  contract with Ottr: the board provisions without its idle wait only when the health
  body carries `layers: true` (see Ottr's `docs/specs/agent-layer-switch.md`).
- The server's provision pipeline is unchanged: `sync.mjs` still installs the data-root
  rules into the real home (the fallback for runners that do not pin), and
  `install-user.mjs` additionally builds and switches the layer.
- Non-layer mode stays byte-for-byte today's behavior, including every error message.

## Acceptance checks

- Happy path: a layer-mode provision creates `layers/<commit>-1`, switches `current` to it
  by symlink, writes the per-layer records, installs rules through `sync.mjs`, and creates
  the link set.
- A failed scan (findings or missing scanner) keeps `current` on the old layer, deletes the
  failed layer folder, and exits non-zero.
- A failed rules install (bad data-root rule) behaves the same.
- A second provision switches to `<commit>-2` and keeps the previous layer; a third deletes
  the oldest one.
- Clean-up protects a layer listed in `in-use.json`; an unreadable `in-use.json` stops
  deletion.
- A pinned turn: resolve `current` before the provision, snapshot the tree, provision, the
  pinned tree is byte-identical and still resolves.
- Machine part: a machine-edited `config.yml` with deployment blocks carries the blocks and
  keeps the machine bytes in the new layer; `--force` takes the snapshot and still carries
  the blocks; block content never reaches the output.
- Migration: the first layer over an in-place home keeps the home's deployment blocks and
  the machine edits of `config.yml` in the new layer.
- Plugins: a turn-edited plugins/package.json with a planted postinstall keeps the snapshot
  bytes in the new layer, and the postinstall never runs; the run notes each ignored file.
  The plugins install runs `--ignore-scripts` with an allowlisted environment unless the
  data repo ships `plugins-allow-scripts`; the marker opts in, the allowlist stays.
- A machine-kept file holding a re-rooted path lands pointing into the new layer, never
  into the live one that clean-up deletes.
- Captured paths: a `catalogPath` under the home prefix lands re-rooted into the new layer.
- A symlink planted on a snapshot path, or on `<live>/.alate/installed.json`, in the live
  layer refuses the run before any write, keeps the old current, and never copies the
  target's bytes into the new layer.
- `current` as a real directory refuses the run before any write.
- The non-layer suite (`install-user.test.mjs`) passes unchanged.

## Non-goals

- No change to the SkillSpector gate or its pin.
- No change to the data repo layout or the capture allowlist.
- No migration of an existing real `current` directory.
- The ottr side (idle-gate removal in `alateProvisionTick`, the board seed of
  `OTTR_BOARD_OMP_HOME`, the entry script, turn pinning) is owned by OTTR-451.
