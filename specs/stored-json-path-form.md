# Stored form of captured absolute JSON paths

sync-user.mjs stores every absolute path in a captured JSON file in one form. A sync
from Windows and a sync from Linux then write equal bytes when nothing else changed.
The agent-data pre-push hook no longer sees a path-form flip on each push from the
other platform.

## Stored form

The stored form is a POSIX absolute path under the snapshot home `SNAP_HOME` (`/root`).

- A path qualifies when it is absolute in either platform form (`C:\...` or `/...`) and
  one of its segments is a known capture root (`.omp`, `.agents`, `.pi`).
- The stored path replaces everything before the known root with `SNAP_HOME`.
- `C:\Users\domin\.omp\plugins\x` stores as `/root/.omp/plugins/x`.
- `C:\root\.omp\plugins\cache\y` stores as `/root/.omp/plugins/cache/y`.
- `/root/.omp/agent/mcp.json` (a Linux worker's own output) stays unchanged.
- A relative path, or an absolute path with no known root segment (`/usr/bin/node`,
  `D:\tools\foo`), stays byte for byte. A file with no move is not rewritten at all.

## Coverage

Every captured file whose snapshot rel path ends in `.json`: `.omp/agent/mcp.json`,
`.omp/marketplaces.json`, the plugin manifests and lock JSONs, `pix.json`,
`optimizer.json`. `config.yml` and non-JSON files stay out. This is the same file set
`forTarget()` ports on install.

## Rules

- `lib/data.mjs` holds the one segment matcher (`rootedParts`) and `SNAP_HOME`.
  `forTarget()` and the new capture-side `toStoredForm()` both use them, so the two
  directions stay inverse.
- `forTarget()` stays the only install-side port. With the workers' home `/root`, a
  Linux install passes the stored form through untouched, and a Windows install re-roots
  it at the Windows home. Capture inverts both.
- sync-user.mjs applies `toStoredForm()` before the secret gates and the write, so the
  gates judge the stored text. One note line reports each file with moves.

## Error cases

- Unparsable JSON: the bytes stay untouched. This is the same rule as `forTarget()`.
- A move re-serializes with `JSON.stringify(doc, null, 2)` plus a final newline. These
  are the exact bytes `forTarget()` writes on install, so round trips stay byte-stable.

## Acceptance checks

1. Equal bytes: capture a JSON file whose `.omp` path is a Windows path, then capture
   the same file with the `/root` POSIX path. Both captures write equal bytes to
   `user/`. This test fails before the fix.
2. Round trip: stored bytes through `forTarget()` with platform `win32` and home
   `C:\Users\domin`, then through `toStoredForm()`, give the stored bytes again. The
   same holds for `linux` with home `/root`.
3. A path outside the known roots stores without a change.

## Non-goals

- `config.yml` and other non-JSON files.
- The Windows host's own `C:\root` home (an omp setting on that machine).
- The agent-data pre-push hook.
- Any change to `forTarget()` install behavior.

## Risks

- JSON files that held Windows paths in MCP `env` values or args now store `/root`
  forms. Worker behavior stays the same: `forTarget()` runs its rebase before the
  Linux-only env drop and disable checks, so those checks already saw POSIX forms
  before this change.
- A Linux install into a home other than `/root` leaves the stored `/root` prefix in
  place. Workers run as root. A future non-root Linux target needs its own direction,
  as the `lib/data.mjs` ponytail note already records.
