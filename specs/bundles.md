# Bundles: per-project skills, plugins and worker lists

Status: draft. Research evidence holds for omp 18.15.0 and the Ottr
board of 2026-11-16.

## Problem

`install-user.mjs` installs every skill of the data repo into the shared home, so
every project loads all of them. A game skill loads in a web project. The user
cannot keep a skill for later without loading it everywhere.

## Goal

A bundle is a named folder `bundles/<name>/` in the data repo. `projects.json`
gives each project a `bundles` name list. A bundle named `core` applies to every
project. A project gets core, then its bundles, then its own `workers/<p>/`
lists. A skill or plugin that no bundle of a project names does not load for that
project. Items that no bundle names stay in the repo, are scanned like today, and
load nowhere (the shelf). The dashboard shows them as "on the shelf".

## Research: how a turn loads skills

Facts, each checked on this machine on 2026-11-16 against the installed omp
18.15.0 bundle (`dist/cli.js`) and live probes, or against the Ottr checkout at
`/workspace/ottr` (commit fde43dc):

1. **omp skill roots.** omp loads skills from
   - user roots: `<agentDir>/skills`, `<agentDir>/managed-skills`,
     `~/.agents/skills`, `~/.agent/skills`, `~/.claude/skills`;
   - project roots: `.omp/skills`, `.agents/skills`, `.agent/skills`,
     `.claude/skills` at the cwd and its parents up to the repo root, plus
     `.codex/skills`, `.opencode/skills`, `.github/skills` at the cwd only.
   Evidence: `src/discovery/builtin.ts:68-76,309-367` in the installed package.
2. **`skills.customDirectories`.** A config array of directories whose immediate
   child folders (each with a `SKILL.md`) load as skills at user level. It needs
   a frontmatter description, expands `~`, ignores a missing directory, and runs
   after the ordinary roots. Evidence: live probe plus
   `src/extensibility/skills.ts:485-493`. Ottr already uses this key for the
   skills of enabled plugins (`/workspace/ottr/src/pluginSkills.ts`, spec
   `docs/specs/turn-home-plugin-skills.md`), verified live on this stack.
3. **Project-level skill roots are pinned off on board turns.** Ottr passes a
   `--config` overlay on every board-side run that sets
   `skills.enableAgentsProject`, `skills.enableClaudeProject` and
   `skills.enablePiProject` to `false`, so a worker-planted `.agents/skills/` in
   the run cwd never loads. Evidence: `pluginSkillsOverlayYaml` in
   `pluginSkills.ts`; the pin exists because the run cwd is a worker-writable
   worktree and nothing from it may steer a run.
4. **The project config layer is cwd-exact.** omp reads `<cwd>/.omp/config.yml`
   as the project settings layer (live probe: `omp config list --scope=project`).
   It does not walk parents, so a turn in a worktree sees no main-checkout
   project layer. Array values replace across layers (live probe: a project
   `customDirectories` replaced the global list; no merge).
5. **How Ottr starts a turn.** `src/runner.ts:startRun` pins the alate layer and
   spawns with `HOME=<layer dir>` and `PI_CODING_AGENT_DIR=<layer>/.omp/agent`;
   cwd is `<project>/.worktrees/<id>` (main checkout for interview, grill and
   scout cards). `PI_CODING_AGENT_DIR` moves the whole agent dir (skills,
   managed-skills, sessions, agent.db); `plugins/` and `marketplaces.json` stay
   at `<HOME>/.omp`, and `HOME` is the layer dir, so they ride the layer too.
   Evidence: `src/runner.ts:1803-1829,2275-2301`; `src/workers.ts:423-455`.
6. **What is per project today.** Ottr reads `.ottr/workers/<project>/` lists
   per turn (`<project>` is the workspace folder name, `basename(projectPath)`)
   and sets `OTTR_PROJECT` in the turn env. Skills come from the home and are the
   same for every project. Evidence: `src/login.ts:353-374`, `src/store.ts`,
   `src/turn.ts:5941`.
7. **Filters exist but run at spawn time.** `skills.includeSkills`,
   `skills.ignoredSkills`, `disabledExtensions` entries `skill:<name>`, and
   frontmatter `enabled: false` filter by name. The argv and the config overlays
   are built by Ottr, so per-project filtering through them needs an Ottr change.
8. **Profiles** (`OMP_PROFILE`) isolate the agent dir as `~/.omp/profiles/<name>/agent`
   but ignore `PI_CODING_AGENT_DIR`, which the layer setup pins. Unusable here.

### Chosen mechanism

The shared home layer is per data-repo commit, not per project, and every turn
reads it. A turn's skill set can therefore differ per project only when the spawn
side (Ottr) passes a per-project value. The one verified per-project config
channel is `skills.customDirectories`. So:

- alate installs the project's non-core bundle skills into a per-project folder
  in the same provisioned home: `<home>/.ottr/project-skills/<project>/<name>/`.
  The root is not named `skills` on purpose: alate's own skill-root walk
  (`collectSkillDirs`) treats every directory named `skills/` or
  `managed-skills/` as a flat skill folder, and omp's custom-directory scan
  reads only the folder's children, never its name;
- alate writes the project's merged plugin name list to
  `<home>/.ottr/plugins/<project>.txt`;
- an Ottr change (a separate card in the ottr project) adds these two to the
  per-run overlay: the per-project folder as one more `customDirectories`
  entry, and the plugin list as the project's plugin-skill filter. Without that
  card the data plane ships but no turn consumes it; with it, core skills load
  from the home roots as today, bundle skills load only for their projects, and
  a shelf skill or plugin loads for no project.

Live proof of the mechanism on omp 18.15.0, 2026-11-16, in temp homes: two
skill folders with distinct body lines, one per project, and a `--config`
overlay per project that lists only that project's folder. A turn with
project A's overlay printed A's body line; a turn with project B's overlay
printed B's; a turn with no overlay printed neither. The argv matched the
board's shape (`--no-extensions --no-lsp` plus the overlay). Two incidental
findings for the consumer card: `--no-tools` disables skill loading, so it
must stay out of the argv; and a shared home accumulates a
`skill-descriptions.db` cache across runs, so a listing can name a skill from
an earlier run's overlay even when its body is gone (the body isolation above
always held; fresh homes per run give clean listings).

This card ships the alate side: resolution, install, dashboard, docs, and the
spec. The acceptance tests judge the installed trees, not a live session.

### Alternatives considered

- **Checkout `.agents/skills` with a git exclude.** Rejected: Ottr pins
  `enableAgentsProject: false` on every board run (research fact 3), so board
  and worker turns never load it; a git-excluded folder also stays out of new
  worktrees, and the checkout is worker-writable, the exact vector the pin
  closes.
- **`<cwd>/.omp/config.yml` project config layer.** Rejected: cwd-exact, so
  worktree turns never see the main checkout's layer; array values replace, so
  Ottr's overlay would drop the project list; same worker-writable trust hole.
- **Per-project layer or profile plus `PI_CODING_AGENT_DIR` per project.**
  Rejected for this card: the spawn env is Ottr's; profiles ignore
  `PI_CODING_AGENT_DIR`; a second layer per project re-derives the shared-state
  link set that `specs/agent-layer-switch.md` owns. The `.ottr/project-skills/<project>`
  folder rides the existing layer switch instead.
- **`--skills` glob filters per project.** Rejected: argv is Ottr's, and a name
  filter keeps every skill's bytes in every home; the card wants unused items
  off the shelf and out of the install.

## Data repo format

- `bundles/<name>/` holds any of six list files: `apt.txt`, `tools.json`,
  `env.txt`, `requirements.txt`, `skills.txt`, `plugins.txt`. The first four
  follow the existing `workers/<p>/` formats and validators. `skills.txt` and
  `plugins.txt` list item names, one per line, `#` comments and blank lines.
  A skill name matches `[a-z0-9][a-z0-9-]*` (the skill structure gate's rule).
  A plugin name matches that rule per segment, with one optional scope prefix:
  `name` or `@scope/name`, where scope follows the same rule (npm package
  names, as the plugin manifests spell them). A bundle folder holds no other
  files; an unexpected file is a whole-run refusal that names the bundle and
  the file.
- `projects/projects.json` gains an optional `"bundles": ["<name>", ...]` per
  project. A project value keeps its legacy form, an extras array, or takes an
  object form with optional `extras` and `bundles` arrays. A `bundles` entry
  that names no folder under `bundles/` is an unknown name (below).
  `sync-projects.mjs` never rewrites the manifest, so the key survives capture
  untouched.
- A bundle named `core`, when the folder `bundles/core/` exists, applies to
  every project.

## Mode and migration

- Bundles mode is active when `bundles/` exists as a directory in the data
  repo. Git tracks no empty folders, so a repo that wants bundles mode commits
  at least one bundle folder.
- Without `bundles/`, today's behavior stays exactly: every skill installs into
  the home roots for every project, worker lists install verbatim, no
  `.ottr/project-skills/` or `.ottr/plugins/` appears. A `workers/<p>/skills.txt` or
  `plugins.txt` outside bundles mode stays ignored, as today.
- A project without a `bundles` key in bundles mode gets core plus its own
  `workers/<p>/` lists. With no `core` bundle, such a project gets only its own
  lists; every skill sits on the shelf for it. A `workers/<dir>/` folder with no
  `projects.json` entry is a project with no `bundles` key.
- The dashboard's "Turn on bundles" action (below) creates `bundles/core/` on a
  repo that holds no bundles, so the user can start bundles mode from the UI
  without unloading any skill.

## Merge order

For each project, the lists merge in this order; an item named twice counts
once, at its first name:

1. `bundles/core/` (when the folder exists),
2. the project's `bundles` array, in array order,
3. the project's own `workers/<p>/` lists.

Per file type:

- `apt.txt`: line list; the first line of a package name wins; dedup keys on
  the package name (the first token). `requirements.txt` dedups on the package
  name before `==`, lowercased exactly like the requirements validator's
  duplicate rule, and the first pin wins: a later list cannot move an
  already-planned pin. `skills.txt` and `plugins.txt`: name lists; the first
  occurrence wins.
- `tools.json`: JSON arrays of tool entries; dedup on the entry `name`; the
  first occurrence in merge order wins whole. The merged array re-validates
  with the existing `tools.json` validator.
- `env.txt`: name lists, each optionally with the `plain` modifier. The later
  list wins per name: a name seen again in a later list replaces the earlier
  line, keeping the earlier line's position, so the later form (modifier
  included) survives.
- Merged worker lists install to `.ottr/workers/<project>/<file>` as today, so
  Ottr's turn readers need no change. The fleet folder `workers/_all/` keeps
  today's behavior: Ottr merges it at turn time, outside this merge.

## Skills and plugins: what installs where

- **Home roots (global).** In bundles mode the snapshot skills named by `core`
  install into the home skill roots (`omp/agent/skills`, `omp/agent/managed-skills`,
  `agents/skills`) exactly as snapshot skills install today. A skill named by
  core and also by a bundle installs once, globally; the bundle entries drop.
  The vendored shipped skills install globally as today and stay out of bundle
  scope.
- **Per-project skills.** A skill named by a project's bundles or its own
  `workers/<p>/skills.txt`, and not named by core, installs into
  `<home>/.ottr/project-skills/<project>/<name>/`. The folder's immediate children are
  skill folders, the shape `skills.customDirectories` scans. A project with no
  non-core skills gets no per-project folder.
- **Shelf.** A snapshot skill that no bundle and no `workers/<p>/skills.txt`
  names installs nowhere. It still passes the origin, structure, and scan gates
  like today, and a rejection still fails the run with that item, so the repo
  stays visible and honest.
- **Plugins.** `plugins.txt` names plugins the data repo already holds (names in
  `user/omp/plugins/package.json` dependencies, `omp-plugins.lock.json`, or
  `installed_plugins.json`). The merged per-project name list installs to
  `<home>/.ottr/plugins/<project>.txt`. The file exists for every project in
  bundles mode; an empty merged set installs an empty file, because the
  consumer scopes a project's plugins only when the file exists — a missing
  file would fall back to every plugin of the home, other bundles' plugins
  included. The home plugin install from the captured lockfile stays as today
  (no lockfile surgery); scoping happens because the Ottr overlay lists only
  the project's plugins when the file exists. Boundary: an interactive omp run
  outside Ottr has no project, so it keeps loading the home's plugins; this
  card scopes Ottr turns.
- The existing shipped-skill suppression stays: a snapshot skill of a shipped
  name (anywhere in the repo, shelf included) still skips the shipped copy.

## Refusals before any write

Each refusal is whole-run, names its source, and fires in the plan phase before
the first write, the scan gate, and any layer creation:

- an unknown skill or plugin name in a `bundles/<name>/` list: the message
  names the bundle and the item;
- an unknown skill or plugin name in a `workers/<p>/skills.txt` or
  `plugins.txt`: names the project and the item;
- a `bundles` entry in `projects.json` that names no folder under `bundles/`:
  names the project and the bundle;
- a malformed or misplaced file in `bundles/<name>/`: names the bundle and the
  file, with the validator's first rule.

## Gates and deletions

- The SkillSpector scan rules do not change. Every snapshot skill dir is scanned
  like today, shelf included, in both install modes; a scan rejection is a
  failed item as today.
- Per-project skills ride the same gates (origin, structure, hidden characters,
  scan) as the snapshot skills they are; a gate-rejected skill installs nowhere
  and fails its item.
- The manifest records per-project rels (`ottr/project-skills/<project>/<name>/...`) the
  same way it records home rels, so a skill that leaves core or a bundle is
  deleted from the home roots or the per-project folder when the copy still
  matches the record. A project folder that no longer plans any skill is pruned.
- Merged worker lists follow the existing worker-list delete rule: a merged
  result the repo no longer plans is deleted when it matches what alate wrote.
- Layer mode installs the per-project folders and lists into the fresh layer, so
  the atomic switch carries them; the post-write layer scan covers them like
  every installed skill.

## Dashboard

- The inventory scans `bundles/` and reports, per bundle, its present list files
  and the names in `skills.txt`/`plugins.txt`, with a warning per unknown name
  (the dashboard warns, the install refuses).
- Each project row shows its `bundles` list. Each skill and plugin row shows
  the bundles that name it, or an "in no bundle" marker (the shelf). The counts
  row gains the bundle count.

### Editing (ALAT-180)

The overview gains three editing surfaces: the Bundles section, the project
blocks, and the Shelf section. Every action writes through the file editor's
save path: it verifies each touched file against the base hash the caller
read, writes the tree, makes one commit for the one save, and pushes with the
same git and writable rules as a file edit. The answer carries the editor's
result shape (`commit`, `pushed`, `warning`, the new state), so the press-bar
notes and the refresh behave as for a file edit.

- `POST /api/bundle` serves every action. It runs serialized with the import
  chain and the editor, and answers 409 while another write runs.
- `create` (`{ action, name }`): the name must match the bundle folder rule
  (`[a-z0-9][a-z0-9-]*`), and `bundles/<name>/` must hold no list file, so the
  action refuses a bundle that only `plugins.txt`, `apt.txt`, `tools.json`,
  `env.txt` or `requirements.txt` exists under. The action creates
  `bundles/<name>/skills.txt` with a two-line comment header, because git
  tracks no empty folder.
- `add` and `remove`: structured item edits cover all six kinds. `kind` is one of
  `skill`, `plugin`, `apt`, `env`, `requirements`, `tools`; the payload field is
  `name` for the two name lists and `item` for the four worker lists. For
  `apt`, `env` and `requirements`, `item` is the whole line. For `tools`, an
  `add` carries the whole entry as JSON text, while a `remove` carries only the
  entry name, because the inventory rows hold names, not entries. A list file
  that does not exist yet starts with a `# <kind> of bundle <name>` comment
  header; a new `tools.json` starts as a JSON array holding the one entry. The
  server keeps the file's line-ending style and its comment and blank lines.
  Adding an item the file already lists under the same dedup key is a refusal,
  so a save never makes an empty commit.
- Dedup keys follow the merge-order section: the first token for apt and env
  lines, the package name before `==` lowercased for requirements, the entry
  `name` for tools, the name itself for skills and plugins. A new apt line is
  one Debian package name per line. The composed file must pass the rules the
  install applies to that file: `tools.json` entries are declarative objects
  (`name`, `url`, `sha256`, `unpack`, `bin`), `env.txt` lines are one name plus
  the optional word `plain`, `requirements.txt` lines are pinned and hashed.
  `lib/worker-lists.mjs` mirrors those rules; its header names the installer
  functions it must stay in sync with.
- `move` (`{ action, kind, name | item, from, to }`): `item` names the entry
  (the tool name for `tools`). `from` is a bundle that lists the item under its
  dedup key; `to` is a bundle name or `shelf`. A move between bundles writes
  both files in the one save, and the stored entry travels to the target file,
  so the body never needs the full entry. A move to the shelf removes the
  item, by its dedup key, from every bundle of that kind that lists it. The
  action refuses when `from` does not list the item, and when `to` is a bundle
  that already lists it.
- `assign` and `unassign` (`{ action, project, bundle }`): the server parses
  the stored `projects/projects.json`, changes only that project's `bundles`
  array, and writes the whole manifest back as JSON with two-space indent and
  a trailing newline. A legacy array value becomes the object form with
  `extras`. Assigning refuses an unknown bundle with the install's message,
  and a name the project already carries; unassigning refuses a name the
  project does not carry.
- The known skill and plugin universe comes from the stored snapshot the same
  way the inventory scan derives it. An unknown name is refused with the same
  message the install throws: the list path, the kind, the name. Every
  refusal is a 4xx before any write. A file that changed since the caller
  read it fails with the editor's 409.
- The four worker lists take the same controls as the name lists: their items
  carry remove and move controls, and the bundle's add form takes their lines
  and tool entries. The install still owns the validators' source of truth;
  `lib/worker-lists.mjs` mirrors it and names the functions it follows.
- A move to the shelf does not touch `workers/<p>/` lists. A name that a
  project's own list still holds stays off the shelf for it, and the row says
  so.
- `turn-on` (`{ action: 'turn-on' }`): the migration action for a repo with no
  bundles. With no `bundles/` content in the stored snapshot, the Bundles
  section shows a short note on what bundles mode does and one "Turn on
  bundles" button instead of the board. The press reveals a confirm step that
  names the commit subject and says that nothing changes until items move out
  of core; Cancel hides it and writes nothing. The confirmed action creates
  `bundles/core/` in one commit through the same save path as every other
  action: `skills.txt` and `plugins.txt` with the standard two-line header and
  every skill and plugin that installs today (the inventory's known universe),
  one name per line, sorted.
  The action copies no worker list. Core merges first for every project and the
  first pin or tool wins, so a fleet list copied into core would let a fleet
  entry beat a project's own entry — today the project wins (`mergeRequirements`
  reads `[...project, ...all]`, and the tools readers put the project's tools
  before `_all`). `workers/_all/apt.txt` has no consumer today ("there is no
  aptAll"), so a copy would add installs that never happened. With no worker
  files in core, every project's merged worker lists are its own lists, the
  fleet folder keeps its verbatim install, and the turn-time merge keeps
  today's precedence — every project's items stay exactly the list before.
  After the action, the computed effective item list of every project equals
  the list before: every skill and plugin stays global through core, and each
  project's worker items are its own lists, with the fleet lists still merged
  at turn time as today. A `turn-on` on a repo that already holds `bundles/`
  content refuses with 409 and writes nothing, so a second click does nothing.
  The commit subject is `alate: turn on bundles with core`; the confirm text
  quotes it.
- Display (project first): the Projects section comes before the Bundles
  section, because assigning a bundle to a project is the main action. Each
  project block shows its bundles as a row of chips: `core` first, marked
  "every project" and not removable, then each carried bundle with a remove
  control (unassign), then an "Add bundle" picker with its button for the
  bundles the project does not carry yet. The block's effective item list
  per kind, with the source of each item (`core`, the bundle name, or
  `workers/<p>`), sits in a closed disclosure that names the item count. The
  merge follows the merge-order section (first name wins, env later wins per
  name, the first pin wins, the first tool wins); core items show too, because
  the effective list is the merge order made visible. The Bundles section
  holds the create form and one line per bundle: its name, its item count,
  the projects that use it ("every project" for `core`), and its list files
  as links into the file editor. The Overview has no per-item controls:
  skills and plugins of a bundle are edited on the Checklist tab of its
  `skills.txt` or `plugins.txt`, and the four worker lists in their files.
  The `add`, `remove` and `move` actions stay in the API. The section "Not in
  any bundle" lists the shelf skills and plugins, each with an "Add to
  bundle" picker. Without `bundles/` in the data repo these surfaces render
  nothing; the Bundles section then shows only the turn-on note, the confirm
  step, and its button (above), and today's read-only overview stays for
  every other section.
- Accessibility stays at the dashboard's level: a visible label per control,
  keyboard operation, visible focus, state in text rather than color alone.
  At 900 px and below the new blocks stack per the design's responsive rules.

## Acceptance checks

Tests use a temp data repo and a temp home, and each fails before the change:

1. Project A with `bundles: ["gamedev-2d"]` gets the bundle skill under
   `.ottr/project-skills/a/`; project B without it does not.
2. A core skill installs into the home root for every project; a bundle skill
   absent from the home roots; a shelf skill absent everywhere but scanned.
3. An unknown skill name in a bundle refuses before any write: exit 1, the
   message names the bundle and the item, the home gains nothing.
4. A repo without `bundles/` installs as today: all skills global, no
   `.ottr/project-skills/`, no `.ottr/plugins/`.
5. Merged worker lists land in `.ottr/workers/<project>/` in merge order with
   dedup; the per-project plugin list merges core, bundles, and own.
6. A `plugins.txt` name that the data repo does not hold refuses, naming the
   source and the item.
7. The dashboard creates a bundle, adds a skill, and assigns the bundle to a
   project: `projects.json` and the bundle file change as the Editing section
   says, and the project's effective list shows the skill with its source.
8. A move to the shelf removes the name from the bundles that hold it; the
   item shows on the shelf and in no effective list.
9. An add of an unknown skill or plugin name refuses with the install's
   message and writes nothing.
10. The dashboard adds an apt line and a tool entry to a bundle, moves the apt
   line to another bundle in one save, and removes both; a broken
   requirements pin and a bundle folder that holds only `apt.txt` refuse as
   this section says.
11. With no `bundles/`, the dashboard shows the turn-on note and button, and
   the confirm names the commit subject and the "nothing changes until items
   move out of core" sentence (a DOM test). Cancel writes nothing.
12. The turn-on action creates `bundles/core/` with only `skills.txt` and
   `plugins.txt` in one commit; after it, the computed effective list of each
   project equals the list before, with a project entry that shares a fleet
   entry's name keeping the project's own line; a second click refuses with
   409 and no new commit.
13. A repo turned on this way installs like the repo before the action: every
   skill global, no shelf, each project's merged worker lists hold its own
   entries only (a project pin keeps beating a fleet pin of the same name at
   turn time, `workers/_all/` untouched, no fleet apt package joins a project
   that never installed it).

The repo check and test commands (the verified chain in `AGENTS.md`, `npm test`)
exit 0 with the new test files joined into the chain, `package.json`, and
`.github/workflows/sync.yml`.

## Non-goals

- No change to the SkillSpector scan rules, the baseline severity cap, or the
  scanner trust contract.
- The data repo content (which bundles exist, which skill goes where) is the
  user's decision, not part of this card; the examples fixture gains no bundles.
- No lockfile surgery on `user/omp/plugins/`: the home plugin install stays the
  captured snapshot; plugin scoping happens at turn time through the Ottr card.
- No scoping of interactive omp runs outside Ottr, of `workers/_all/`, of
  context files, or of rules.
- No `env.txt` value forms beyond the existing names-only validator.
- No change to `sync.mjs` (rules) or to the capture file formats: the manifest's
  `bundles` key rides along untouched. `sync-projects.mjs` and
  `install-projects.mjs` learn the object value form, so a manifest that uses
  `bundles` still captures and installs the project's context files; the two
  scripts never read `bundles` themselves.

## Risks

- **The data plane ships before the consumer.** Until the Ottr card lands,
  bundle skills install into `.ottr/project-skills/<project>/` but no turn reads them;
  core and migration behavior are unaffected. The Ottr card is filed from this
  task and named in its report.
- **Name clashes between a per-project skill and a home skill.** omp gives the
  custom-directory skill the bare name and namespaces the home copy with a
  warning. Core-first merge keeps shared names global; a bundle name that also
  sits in core drops from the per-project folder, so the common case does not
  warn.
- **Accidental bundles mode.** A stray `bundles/` folder turns every unnamed
  skill into shelf items that load nowhere. The refusal messages, the shelf
  visibility in the dashboard, and the migration test keep the state obvious.
- **Worktree deletion races.** Per-project folders ride the layer and its
  manifest, so they switch and clean up with everything else; no new deletion
  path touches the workspace checkouts.
