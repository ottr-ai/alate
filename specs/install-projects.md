# Project file provisioning (install-projects.mjs)

Alate's provision pipeline runs `sync.mjs` (data-root rules) and `install-user.mjs`
(user layer, workers). No step installs the per-project snapshots that
`projects/projects.json` lists into the workspace project checkouts. The only
snapshot-to-checkout path is the refresh branch of `sync-projects.mjs`, and the board
never runs that script. So a snapshot commit that changes a listed file (agent-data
`80cc2a4`, card AGEN-67: `projects/velvarr/scripts/release.mjs`) never reaches the
board checkout, and a release in that checkout runs stale bytes.

## Behavior

A third provision script, `install-projects.mjs`, installs listed project files from
the imported snapshot into the workspace checkouts. The server runs it last:

```
SCRIPTS = ['sync.mjs', 'install-user.mjs', 'install-projects.mjs']
```

CLI: `node install-projects.mjs --data <dir> --root <workspaceDir>`

- `--data` is the snapshot dir the server passes today (a materialized copy; the
  script never reads or writes the real data repo).
- `--root` is the workspace that holds the project checkouts. The server passes it
  when it knows one; without it the script prints
  `install-projects: no --root; project files not provisioned` and exits 0. This is
  the "reports why it did not" path.

Item set per project `<name>`: the manifest's `contextFiles` plus the project's
extras, deduplicated, order-stable. A path dropped from the manifest stops being
installed; its files stay untouched (never deleted) — the same rule capture uses.

Per listed file `<name>/<rel>` (the snapshot-relative key format of
`sync-projects.mjs`, so both scripts share one baseline record):

1. Source `<data>/projects/<name>/<rel>` missing: note
   `projects/<name>/<rel> is not in the snapshot; skipped`. No item result.
   (`contextFiles` names are alternatives; a missing one is normal.)
2. Checkout dir `<root>/<name>` missing: note `projects/<name>: no checkout at <path>; skipped`.
3. Path guards (refusal class, whole run, nothing written, exit 1, fatal results):
   a source that escapes the snapshot (`assertSourceInside`), a destination that
   escapes the checkout, a symlink component below the checkout root, a directory
   or multiply-linked file at the destination (`checkDestination`).
4. Decision with `fingerprint()` (CRLF-normalized sha256; `M` = machine bytes,
   `S` = snapshot bytes, `B` = baseline fingerprint from
   `<root>/.alate/captured-projects.json`):
   - `fp(M) == fp(S)`: `unchanged`. Seed `B` when it differs. Never rewrite.
   - destination missing: write `S` verbatim. Status `added`, log
     `added projects/<key> into <dest>`.
   - `fp(M) == B`: the snapshot moved elsewhere and the machine holds the captured
     state. Write `S`. Status `updated`, log `refreshed projects/<key> into <dest>
     (the snapshot changed elsewhere; the machine copy held the captured state)`.
   - `fp(M) != B` (or no baseline): the machine copy differs from both the captured
     state and the snapshot. Per the accepted gate decision, the snapshot wins: write
     `S`. Status `updated`, log `replaced projects/<key> into <dest> (the machine
     copy changed since the last capture; its local changes were replaced)` and, when
     no baseline exists, `(no capture baseline exists; the machine copy differed from
     the snapshot)`. The log names both paths.
5. After every write and every unchanged seeding: `B := fp(S)` for that key, written
   to the shared baseline record (same file, same key format as `sync-projects.mjs`).
   A corrupt record: one note, the run treats every file as having no baseline, and
   the record is never rewritten (same as capture).

A missing `projects/projects.json` in the snapshot: note `projects/projects.json is
missing in the snapshot; nothing to install`, exit 0. An invalid one (bad JSON, bad
shape, unsafe path): refuse the whole run, fatal, exit 1, nothing written.

Results file: one item per installed or unchanged file, key `projects/<name>/<rel>`,
statuses `added`/`updated`/`unchanged` (installed rank). Written through
`writeProvisionResults` when `ALATE_PROVISION_RESULTS` is set. Exit 0 when every
item installed or was unchanged; exit 1 only on a refusal.

## Server wiring

- `Config` gains `projectsRoot: string | null` (default null; persisted by
  `saveConfig`; `selectSource` leaves it alone).
- `POST /config` accepts an optional `projectsRoot`: `null` clears it, a string must
  be an existing directory (`isDir`) or the answer is `400 invalid projectsRoot`. It
  may be sent together with `repo`/`path` or alone (the source stays as it is); the
  exactly-one rule for the source itself stays.
- `GET /config` returns `projectsRoot`.
- `provision()` passes `--root` to `install-projects.mjs` only:
  `config.projectsRoot ?? (dashState.source?.kind === 'path' ? dirname(dashState.source.name) : null)`.
  A path source needs no configuration: the projects live beside the data repo.
  A repo source needs `projectsRoot` set once, because the server's clone is temporary.

## Acceptance checks (tests that fail before the change)

a. Temp data repo + temp checkout: a changed listed file is written by
   `node install-projects.mjs --data <repo> --root <ws>` (the provision step), and a
   second run is idempotent (no rewrite, exit 0).
b. The same through the server: `POST /config {path}` + `POST /provision` on a
   fixture snapshot with `projects/` content updates the checkout file, `ok: true`,
   results codes `[0, 0, 0]`.
c. Machine edit with a baseline: the snapshot replaces it, the log names the
   replacement, `B` becomes `fp(S)`, and a following `sync-projects.mjs` capture
   reports no change and does not clobber the snapshot.
d. File in the snapshot, missing in the checkout: created (parents included).
e. Listed file absent from the snapshot: skipped with the note, exit 0.
f. Checkout dir missing: skipped with the note, exit 0.
g. `projects.json` invalid: refusal, exit 1, fatal results, nothing written.
h. Destination symlink below the checkout root: refusal, nothing written.
i. Manifest path `../outside`: refusal.
j. No `--root`: the note, exit 0.
k. Baseline record is written with the shared key format and the shared state file.

## Alternatives considered

- Run `sync-projects.mjs` in the provision pipeline. Rejected: its direction is
  capture; with no baseline record (the board's real state) it would capture the
  stale machine bytes over the newer snapshot, and a conflict refuses with exit 1,
  which would fail provisions.
- Refresh only in `sync-projects.mjs` (status quo). Rejected: the board never runs
  that script; the incident happened exactly because of this gap.
- Copy the files board-side (ottr). Rejected: provisioning is alate's contract, and
  the board has no snapshot reader.

## Risks

- An uncaptured local edit is overwritten. Mitigation: the log line names the file
  and the replacement; the capture flow (pre-push hook) records machine edits before
  a push. Accepted per the gate decision for this task.
- A provision during an active turn swaps a file under that turn. Layer mode covers
  only the home; project checkouts have no layering. Accepted: listed files are
  project infra, and the capture flow keeps the snapshot the source of truth.
- A repo-source deployment without `projectsRoot` silently skips. Mitigation: the
  loud note in the provision output and the documented config field.

## Non-goals

- No dashboard UI changes for the new config field.
- No deletion of files dropped from the manifest.
- No layer-mode variant for project checkouts.
- No change to capture semantics in `sync-projects.mjs`.
