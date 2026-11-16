# Provision item by item

One rejected item or one uncovered origin must not stop the whole provision. The
provisioner scans and checks every item first, installs every item that passed, and
leaves out only the failed items. `sync.mjs` (data-root rules) and `install-user.mjs`
(user/ snapshot) both follow this contract.

## Items and keys

An item is one installable unit. The item key is stable across both scripts, so the
server can merge results by key:

- data-root rule: the file name, for example `a.md`.
- snapshot file: the `user/`-prefixed snapshot path, for example
  `user/omp/agent/config.yml`. A Markdown file inside a skill folder is never a
  snapshot-file item: it belongs to that skill's item.
- skill: the `user/`-prefixed skill dir, for example `user/omp/agent/skills/demo`;
  `user/omp/agent/managed-skills/m1`; `user/agents/skills/locked`.
- skill root case variant: the `user/`-prefixed folder, for example
  `user/omp/agent/Skills`.
- skill root 8.3 short name: the `user/`-prefixed folder, for example
  `user/omp/agent/MANAGE~1`.
- skill root ignorable code point variant: the `user/`-prefixed folder, for example
  `user/omp/agent/skil\u200Cls`.
- MCP server: `user/omp/agent/mcp.json "<name>"`.
- worker list: `workers/<project>/<file>`.

## Per-item result

Every item gets exactly one result:

- `installed` — the item was written (or a worker list was refreshed).
- `unchanged` — the item already held the exact target bytes.
- `rejected: <rule> at <file:line>` — the item failed a content gate or the scan gate.
  It is never installed. A content-gate rejection (skill root alias, no origin,
  structure, hidden characters) deletes a previously installed, record-matching copy,
  the same deletion rule as a snapshot-dropped path. A scan-gate rejection keeps the
  previously installed, record-matching copy in place, keeps its record, and prints a
  warning note: the installed bytes passed the scan gate when they installed, and an
  environment artifact such as CRLF working-tree bytes against LF baseline
  fingerprints must never delete a good install (ALAT-178). A copy that changed on
  the machine stays with the existing note and loses its record, in both cases.
- `no origin` — the origin gate has no recorded origin for the item. Same handling as
  `rejected`: left out, stale record-matching copy deleted. An uncovered MCP server is
  reported but does not exclude the `mcp.json` file itself, so one uncovered server
  never disconnects the other servers on the machine.

`rejected` carries the first finding as `rule` and `at`, plus the full report text
(scan reports capped at 4000 characters). A scan gate error carries
`rule: "scan error"` and no position; its report starts with the failure line and
carries the scanner output.

## Exit codes and output

- Exit `0`: every item installed or unchanged.
- Exit `1`: any item failed (`rejected`, `no origin`) or the run was refused.
- The failed items are printed to stdout as one block at the end, so the deploy-log
  tail names every failure:
  ```
  Failed items:
    user/omp/agent/skills/bad — rejected: SC2 at SKILL.md:7
    user/agents/skills/orphan — no origin
  ```

## Machine-readable results file

When `ALATE_PROVISION_RESULTS` holds an absolute path, each script writes one JSON
file there, atomically, mode 0600, at the end of every run (success, item failures,
and refusals). Unwritable path: warn on stderr, continue; the server then reads no
results and fails closed.

```json
{
  "fatal": false,
  "error": null,
  "items": [
    { "item": "user/omp/agent/skills/demo", "status": "installed", "rule": null, "at": null },
    { "item": "user/omp/agent/skills/bad", "status": "rejected", "rule": "SC2", "at": "SKILL.md:7", "report": "..." },
    { "item": "user/agents/skills/orphan", "status": "no-origin", "rule": null, "at": null }
  ]
}
```

- `status`: `installed` | `unchanged` | `added` | `updated` | `rejected` | `no-origin`.
  `added` and `updated` replace `installed` in layer mode, where every item is compared
  with the live layer instead of the empty new layer: `added` when the live layer lacks
  the file, `updated` when its bytes differ, `unchanged` when they are equal. `sync.mjs`
  reports the same labels when install-user.mjs calls it with `--compare <dir>`.
- `fatal: true` + `error`: the run was refused as a whole (see below). `items` may
  still hold results gathered before the refusal.

## Global refusals stay all-or-nothing

A refusal is per script; nothing is written by that script when it refuses:

- missing scanner, wrong scanner version, `SKILLSPECTOR_BIN` inside the home;
- a scanner that cannot run at all (spawn error, probe failure) — no verdict is
  possible, so the run refuses;
- invalid `tools.json`, `env.txt`, `requirements.txt`;
- a CR byte in a text file under a surviving snapshot skill dir that ships
  `.skillspector-baseline.yaml` (a stale or CRLF-committed checkout would corrupt
  every baseline-keyed verdict);
- unreadable or structurally broken `upstreams.json` (the coverage gate itself is
  broken, so no origin verdict is possible);
- destination alias guards, machine-changed copies (conflicts), unreadable source
  aliases inside the snapshot.

A scan failure of one skill folder (an exit other than 0/1, or a killed scan — for
example an unparseable `.skillspector-baseline.yaml`) is a per-item rejection, not a
refusal: the skill gets rule `scan error` and the failure line plus scanner output as
its report, and the remaining skills still install. A negative verdict is never
cached, so a scan-error skill is rescanned on the next run.

In the server pipeline (`server.ts` `provision()`), both scripts always run in order;
the pipeline stops early only when a script exited `null` (killed) or exited non-zero
without a results file saying `fatal: false`. A per-item failure (`fatal: false`,
non-zero exit) never stops the pipeline. `ok` in the `POST /provision` response stays
`results.every(r => r.code === 0)`, so the board and the update flow still see the
failure; `provisionedSha` still moves only on `ok`.

## Gate order per script

`sync.mjs`:
1. content gate per root Markdown item: a rule with problems is `rejected` and
   excluded; `AGENTS.md`/`README.md` are not installed by this script, so a problem
   there is a `rejected` report only;
2. origin gate (`originGate` in `lib/data.mjs`): fatal problems refuse the run; an
   uncovered rule is excluded and reported `no origin`; other uncovered paths are
   reported `no origin`;
3. install, delete, record as before over the surviving rules only.

`install-user.mjs`:
0. skill root alias: a folder whose name matches `skills` or `managed-skills` only
   after case folding (`Skills`, `MANAGED-SKILLS`, `ſskills`), only after removing
   the Unicode default-ignorable code points (`skil\u200Cls`), only after stripping
   the trailing dots and spaces Win32 removes from a path element (`Skills.`,
   `MANAGE~1 `), or whose name is an 8.3 short-name shape (`MANAGE~1`) of one is
   `rejected` with rule `<reason> of skill root "<root>"` and excluded whole. NTFS
   resolves 8.3 short names into the long folder (creation is on by default on the
   Windows system volume), case-insensitive filesystems resolve case variants,
   case-insensitive HFS+ name comparison ignores the default-ignorable code points,
   and Win32 path normalization writes `Skills.` into the real root — omp loads the
   folder's skills either way, but the skill gates check only the exact names;
1. origin gate: fatal problems refuse; uncovered skill dirs are `no origin` items,
   excluded before the walk; uncovered MCP servers are `no origin` reports;
2. skill structure gate per skill (`skillProblems`): a failing skill is `rejected`,
   excluded, and never scanned;
3. hidden-character gate over each surviving skill folder: a failing `.md`/`.mdc`
   file in any letter case (the `SKILL.md` entrypoint belongs to step 2) fails that whole skill
   under its skill key, before the walk; then walk and plan over the surviving
   files only; a Markdown item outside a skill folder whose content gate fails
   is `rejected` and excluded;
4. worker-list validation (fatal as before), conflicts (fatal as before);
5. CRLF source guard before the scan, in both modes and before any write: a text
   file (no NUL byte) under a surviving skill dir that ships
   `.skillspector-baseline.yaml` must hold no CR byte. One hit refuses the whole run
   (fatal, exit 1, nothing written or deleted), names up to 10 files, and prints the
   fix: rewrite the files from HEAD in the data repo, or set `core.autocrlf=false`
   there. A stale checkout (made before the repo's `.gitattributes`, with
   `core.autocrlf=true`) holds CRLF working-tree bytes while `git status` is clean;
   the shipped baselines fingerprint LF bytes, so every finding key would miss and
   the gate would reject whole skills that are fine;
6. scan gate over the surviving skills: findings (exit 1) make that skill
   `rejected`; a scan error (any other non-zero exit or a killed scan) makes that
   skill `rejected` with rule `scan error`; excluded skills are dropped from the
   plan, the manifest, and `conflicts` before any write, except that a
   record-matching file of a scan-rejected skill keeps its record entry and stays
   untouched with the warning note from the per-item result above. Its own snapshot
   bytes never install. Layer mode is unchanged: the fresh layer drops a rejected
   skill before the switch, and the live layer keeps running;
7. writes, deletions, manifest; layer mode scans the fresh layer before the manifest
   is written, removes rejected skill dirs from the layer, and drops them from the
   manifest;
8. the nested `sync.mjs` in layer mode gets `ALATE_PROVISION_RESULTS` pointing at
   `<results>.rules.json`; a fatal nested refusal aborts the layer; per-item nested
   failures merge into this run's items and keep the run failed.

## Server and UI

- `dashState.provision` = `{ at, sha, ok, items, failures }`, persisted with the dashboard
  state, served by `GET /api/state`. `sha` is the imported snapshot sha, so a stale
  result set is never shown for a newer snapshot. Items are merged by key from both
  scripts; the worse status wins (`rejected` > `no-origin` > `installed` = `added` =
  `updated` > `unchanged`; `added`/`updated` are the layer-mode labels of `installed`).
- `failures` lists the scripts that exited non-zero or closed with a null code, in
  run order, with their captured (redacted, truncated) output.
- The dashboard shows each item's status next to it in the Rules, Skills, and User
  layer sections, alert-styled for failures, with the report in a details block.
  When `ok` is false the overview also shows the danger line "Provision failed"
  with the failing scripts, each output in a details block under the meta line.
- A per-server MCP item (`user/omp/agent/mcp.json "<name>"`) shows on the `mcp.json`
  row of the User layer section, with each server's status and report. Every item
  whose key matches no row above (a worker list, the `user/omp/plugins` item, or a
  per-server key with no `mcp.json` row) is listed with its status under "Items not
  shown above" — failed ones alert-styled, with the report in a details block — so
  no item is invisible.

## Acceptance checks (tests that fail before the change)

a. One bad skill among good ones: the good skills install, the bad one is reported
   with its rule and file, exit 1.
b. An installed copy of a skill the scan rejects keeps its record-matching files,
   its record, and a warning note; a machine-changed copy stays with the existing
   note and loses its record. A skill a content gate rejects still loses its
   installed record-matching copy.
c. One uncovered origin does not stop the other items: the covered rule installs,
   the uncovered item is reported, exit 1.
d. A missing scanner refuses the whole install-user run; nothing is written.
e. A scan error (exit 2, for example an unparseable `.skillspector-baseline.yaml`)
   rejects only that skill: the clean skills install, the broken skill is reported
   `rejected: scan error` with the scanner message, the results file keeps
   `fatal: false` (so the server's `ok` stays false), and the run exits 1. The
   scan-error skill is rescanned on the next run. A scanner that cannot run at all
   (spawn error, missing binary) still refuses the whole run.
f. `upstreams.json` that is not JSON refuses the whole run; a structurally broken
   entry refuses the whole run.
g. The server pipeline continues past a per-item failure and stops on a killed
   child; `ok` stays false; `GET /api/state` carries the per-item results.
h. A fatal refusal or a killed child stores the failing script and its output on
   `GET /api/state`.
i. The overview renders the "Provision failed" line and per-script output
   disclosures for a failed run, and nothing for a clean run.
j. A case variant (`Skills/`), an 8.3 short name (`MANAGE~1/`), an ignorable-code-point
   variant (`skil\u200Cls/`), and a trailing-dot variant (`skills./`) of a skill root are
   each reported `rejected`, are never scanned or installed, and the exact skill roots
   still install; exit 1, `fatal: false`.
k. A data repo skill that ships a baseline and holds CRLF bytes in a text file
   refuses the whole run before any write: exit non-zero, nothing installed or
   deleted, the manifest and the installed copies unchanged, the message names the
   files and the fix, and no scan runs. The same repo with LF bytes installs the
   skill. A NUL-bearing (binary) file with CR bytes does not trip the guard.

## Non-goals

- SkillSpector rules and baselines (out of scope).
- No new npm dependency.
- Project snapshots (`sync-projects.mjs`) keep their own behavior.
- Negative scan caching stays absent: a rejected skill is rescanned on the next run.
- The vendored shipped skills (`shipped/ottr/`) get no CRLF guard: they come from
  this repo's own checkout, not from the data repo, and no recorded incident
  involves them.
- A kept installed copy of a scan-rejected skill may predate the scan gate (an
  install by an older alate); retention changes nothing about bytes that are already
  on the machine.
