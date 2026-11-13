# Capture baseline for the capture scripts

`sync-projects.mjs` and `sync-user.mjs` compare each machine file with the committed
snapshot and capture the machine bytes when the bytes differ. So a capture on one
machine can overwrite a newer snapshot that another machine or the board committed.
On 2026-11-13, agent-data commit `110c1f0` (board card OTTR-848) added three lines to
`projects/ottr/AGENTS.md`. The Windows host's pre-push hook then ran
`sync-projects.mjs`, whose capture copied the host's older `AGENTS.md` over the commit,
and the hook refused the push. A commit of that capture would have silently reverted
the board's commit.

Each capture script now keeps a baseline record outside the data repo. The record holds,
per file, the fingerprint of the snapshot bytes that the capture last wrote or adopted.
Both scripts compare with `fingerprint()` from `lib/data.mjs` (sha256 over
CRLF-normalized bytes), the repo's existing comparison rule.

## The baseline record

One JSON file per script, machine-local, outside the data repo. The file is a JSON map:

- key: the snapshot-relative path with `/` separators;
- value: the fingerprint of the snapshot bytes that the capture last wrote or adopted.

The locations:

- `sync-projects.mjs`: `<workspace-root>/.alate/captured-projects.json`. The workspace
  root is the project workspace, by default the parent folder of the data repo.
- `sync-user.mjs`: `<home>/.alate/captured-user.json`.

## Per-file decision

For each tracked file, `M` holds the machine bytes, `S` the committed snapshot bytes,
and `B` the baseline fingerprint. `fp()` is `fingerprint()` from `lib/data.mjs`.

- `S` missing: capture, as today; the repo holds nothing to lose. Set `B := fp(M)`.
- `fp(M) == fp(S)`: the file is unchanged. Seed or update `B` when it differed.
- `B` missing (first run): capture as today. `sync-projects.mjs` prints, per file,
  `note: projects/<key> has no capture baseline; captured the machine copy`.
  `sync-user.mjs` prints one aggregate line when N > 0:
  `note: N captured files had no baseline and were captured as today`.
- `fp(M) != B` and `fp(S) == B`: a local machine edit. Capture as today. Set `B := fp(M)`.
- `fp(M) == B` and `fp(S) != B`: the snapshot changed elsewhere (another machine or the
  board). See "Refresh and keep".
- `fp(M) != B` and `fp(S) != B`: a conflict. See "Conflict refusal".

## Refresh and keep

When only the snapshot changed, the two scripts act in opposite ways:

- `sync-projects.mjs` refreshes the machine copy. It writes the snapshot bytes to the
  project file, leaves the data repo untouched, sets `B := fp(S)`, and prints
  `refreshed projects/<key> into <machine path> (the snapshot changed elsewhere; the machine copy was unchanged)`.
- `sync-user.mjs` keeps the committed snapshot and never writes the home. It prints
  `note: user/<rel>: the committed snapshot changed elsewhere and this machine still holds the captured state; kept the snapshot (provision the machine to get it)`.
  `B` stays unchanged.

A capture never writes the live home. The next provision installs the committed
snapshot, so the machine gets the new bytes through the install path, with its
adaptation.

The summary lines gain a count only when the count is non-zero: `, R refreshed`
(`sync-projects.mjs`) and `, K kept` (`sync-user.mjs`).

## Conflict refusal

When a file changed on both sides, both scripts refuse the whole run before any write.
Nothing is written anywhere. stderr holds one line per conflict, and each line names
both paths:

```
conflict: the snapshot <data>/projects/<key> and the machine file <machine path> both changed since the last capture; resolve by hand
```

```
conflict: the snapshot <data>/user/<rel> and the machine file <home>/.<rel> both changed since the last capture; resolve by hand
```

The run exits with code 1.

## First run and corrupt state

A missing record file is a first run: every file follows the `B` missing rule above.

A corrupt or unreadable record file does not stop the capture. One note names the file,
and the run then behaves like a first run. The corrupt file stays as-is; the run does
not rewrite it.

## Acceptance checks

`sync-projects.mjs`:

a. The snapshot is newer and the machine copy is unchanged: the machine file holds the
   snapshot bytes, the data repo stays clean, the output names the refresh, and `B`
   holds `fp(S)`.
b. The machine file changed since the last capture: the capture runs as today, and the
   repo holds the machine bytes.
c. A file changed on both sides: exit code 1, nothing is written anywhere, and stderr
   names both paths.
d. No record exists: the behavior of today, plus the no-baseline note per file.

`sync-user.mjs` mirrors the cases:

e. The snapshot is newer and the machine copy is unchanged: the home stays untouched,
   the snapshot stays, and the note names the kept snapshot.
f. The machine file changed since the last capture: the capture runs as today.
g. A file changed on both sides: exit code 1, nothing is written anywhere, and stderr
   names both paths.
h. No record exists: the behavior of today, plus the aggregate note.

## Alternatives considered

- Refresh the home in `sync-user.mjs` when only the snapshot changed. Rejected: a
  capture never writes the live home, and the snapshot needs install-side adaptation
  that only the install path applies.
- Seed the `sync-user.mjs` baselines from the `installed.json` record of
  `install-user.mjs`. Rejected: that record has a different schema, and
  `install-user.mjs` owns it.

## Risks

- A lost or deleted record file falls back to the behavior of today: the next capture
  copies the machine bytes over a newer snapshot again. The incident can recur after a
  record loss.
- Two data repos that share one workspace root share one `captured-projects.json`. The
  key holds only the snapshot-relative path, so one repo's capture seeds the other
  repo's baselines.

## Non-goals

- No seeding of the `sync-user.mjs` baselines from the `installed.json` record of
  `install-user.mjs`: a different schema, owned by `install-user.mjs`.
- No new CLI flags.
- The agent-data pre-push hook flow itself is out of scope.
