# Path-source write flags on GET /health

Ottr's board saves `user/omp/agent/config.yml` through alate's file editor. For a `path`
source, only a git-versioned and writable folder can save. A plain folder makes the PUT
answer `commit: ""`. A read-only folder makes the PUT fail with a raw fs error. GET
/health carried no field that told the two cases apart, so a client learned the verdict
only from one refused save.

## Fields

For a `path` source, GET /health carries:

- `git` — true when `git -C <dir> rev-parse --is-inside-work-tree` exits 0. This is the
  same gate that `editPathSource` (`web/dashboard.mjs`) uses before it commits. One
  shared helper serves both callers.
- `writable` — true when `fs.accessSync(dir, fs.constants.W_OK)` passes. The probe never
  writes to the folder. `false` is reliable. `true` can over-report: some kernels pass
  W_OK on a read-only bind mount, and a root process passes W_OK on any existing folder.
  The PUT can still fail with a raw fs error when the probe said true.

For a `repo` source, and when no source is set, both fields are `null`. A repo PUT always
commits on a fresh clone, so the flags are not folder properties there.

The server computes both fields at request time from the folder on disk. It stores
neither field. The PUT path and its answers stay unchanged.

## Acceptance checks

- A git folder as the path source reports `git: true`.
- A plain folder as the path source reports `git: false`.
- A repo source reports `null` for both fields.
- `node server.test.mjs` covers all three cases and the two probe helpers.

## Non-goals

- No change to the write, commit, or push behavior of PUT /api/file.
- No Ottr-side change. Ottr reads the fields in its own card.
- No caching of the probe results.
