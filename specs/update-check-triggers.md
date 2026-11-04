# Re-run the upstream update check when the snapshot changes

The stored update rows (the `updates` table) serve GET /api/updates and the
dashboard. The check re-runs ahead of the 24 h `--update-interval` timer
whenever the stored snapshot changes, so an applied update leaves the list at
once.

## Behavior

- The check also runs:
  - after a repo-source snapshot refresh that brings a new commit
    (`selectSource`, so `/config`, `/api/import`, and the auto-update refresh
    in `dashCheck`);
  - after a dashboard file edit that commits and pushes (PUT/DELETE `/api/file`);
  - after a successful provision (`POST /provision`).
- `POST /api/updates/check` starts a check now and returns the fresh list,
  the same `{checkedAt, updates}` shape as GET `/api/updates`. Same Bearer-key
  auth as GET `/api/updates`: a missing or wrong key is 401, another method on
  the route is 405.
- One snapshot change queues one trigger: `selectSource` reports whether it
  queued the check for a new repo commit, and `/config` plus `/api/import` fire
  their own trigger only when it did not (path sources have no commit). Two
  triggers for one change never queue a second rerun.
- One check runs at a time (`updateRunning`). A snapshot-change caller that
  arrives during a run marks the run stale: the running check read an older
  snapshot, so exactly one more check follows when it ends. Plain callers (the
  timer, POST `/api/updates/check`) join the running check without queueing a
  rerun. A failed check logs its error and keeps the previous rows; the returned
  promise never rejects, so fire-and-forget callers (the timer, the triggers)
  stay safe.
- The 24 h timer stays the release-refresh trigger. The new triggers only
  rewrite rows for the snapshot the server already stores.

## Acceptance

- The data-repo snapshot moves a pin to its target; the next GET
  `/api/updates` (no timer tick in between) reports the pin at the target
  (`current` = `latest`), so the board drops the row. Proven for the editor
  path, the auto-update refresh path, and provision.
- `POST /api/updates/check`: 401 without or with a wrong key; 200 with the
  key; two overlapping POSTs run one check.
- A snapshot change that lands while a check runs queues exactly one more
  check: a pushed edit during a held check reruns once, and a rapid second
  import stays one-at-a-time and reruns once.
- GET on the route is 405.

## Provider payload

- GET `/api/updates` and POST `/api/updates/check` keep only records that pass
  the board's `record()` checks (`isValidUpdateRecord` in `lib/updates.mjs`
  mirrors them), so a board pull never logs dropped records.
- `/api/state` keeps every row: error rows, managedBy rows, and rows without a
  pin stay visible on the dashboard.

## Non-goals (own cards)

- No board-side change: the Ottr board can call POST `/api/updates/check` from
  its refresh button (own Ottr card).
- No change to the record shape (U3) or to the 7-day age gate.
