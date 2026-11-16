# Canonical form of data-repo files

One canonical, OS-neutral form of every file in the data repo. Capture writes only
that form; install renders it for the target OS. The repo never stores machine bytes.

## Problem

The data repo stores whatever the capturing machine held, so each OS boundary breaks
provisioning in its own way:

- Line endings: CRLF fingerprint churn (ALAT-122), the install that deleted 30 skills
  on Windows (ALAT-178), the seed refusal of the committed CRLF `impeccable.cmd`
  (ALAT-183, fixed on main).
- Paths: `mcp.json` and `marketplaces.json` captured with `C:\Users\...` paths
  (ALAT-152, fixed on main as the `/root` stored form).
- Capture direction: an older machine copy overwrote a newer committed file
  (ALAT-154/ALAT-158, fixed on main as the capture baselines).
- Modes: Windows bind mounts mark every file executable, and the scanner reads mount
  noise as content (SC9); install staging works around the scan, but written modes
  come from nothing in particular, not from the repo.
- One checkout serves two Git versions: `C:/workspace` checkouts are bind-mounted
  into Linux containers, so container installs see the Windows checkout's bytes.

## The canonical form

The repo (its git index) holds:

- Text files: LF line endings. Binary means a NUL byte in the first 8000 bytes (git's
  own heuristic); binary files hold raw bytes. A lone CR stays (git parity: `text`
  normalization removes CRLF, never a bare CR).
- `*.cmd` and `*.bat`: LF in the index, CRLF in every working tree
  (`text eol=crlf` in `.gitattributes`). cmd.exe wants CRLF batch files on every OS,
  so install renders CRLF for them on every target.
- Home paths in JSON and config files: POSIX absolute paths under the snapshot home
  `SNAP_HOME` (`/root`). This prefix is the home placeholder. It is the form
  `toStoredForm()` writes on capture and `forTarget()` re-roots at the target home on
  install; the two stay inverse. A separate literal `${HOME}` or `~` token would be a
  second mechanism for the same job (see Alternatives).
- `config.yml` host paths (`shellPath`, `skills.customDirectories`) and deployment
  blocks: dropped at capture, re-added at install (existing strips, unchanged).
- File modes: the git index's `100755`/`100644`, never the filesystem. Install writes
  `0755` for an index-executable file and `0644` for everything else, and the mode
  applies to fresh and updated files alike: every write enforces it (`fchmodSync` on
  the open fd, `chmodSync` beside `writeFileSync`), so an existing file never keeps a
  filesystem mode the index contradicts. A data dir that
  is not a git checkout gives `0644`. A capture records no mode: exec lives in the
  index, set by git (`git update-index --chmod=+x`) at commit time.

`.gitattributes` carries the rules: `* text=auto eol=lf`, `*.cmd text eol=crlf`,
`*.bat text eol=crlf`, the binary types `binary`, and the existing pinned exceptions
(a `-text` file stays raw until its baseline is regenerated with it). The alate
fixture `examples/data/.gitattributes` ships this ruleset to fresh data repos. The
real agent-data repo applies the same ruleset plus a one-time renormalize on a clean
branch:

```
git switch -c canonical-form
printf '...\n' > .gitattributes   # the ruleset above
git add --renormalize .
git commit -m "sync: one canonical form (LF text, crlf cmd/bat, index modes)"
```

Code never parses `.gitattributes`: `lib/data.mjs` holds one constant
(`CRLF_SUFFIXES = ['.cmd', '.bat']`) that mirrors the rules, with a comment naming the
file it must stay in sync with.

## Behaviour

### Capture (`sync-user.mjs`, `sync-projects.mjs`)

- Every captured text file is normalized to the canonical form before the gates run:
  CRLF becomes LF, binary bytes pass through, JSON path storage (`toStoredForm`) and
  the config strips stay as they are. One note line names each file whose bytes the
  normalization changed.
- The capture baselines (specs/capture-baseline.md) decide what a capture may write.
  This card reuses them; it builds no second overwrite rule. Fingerprints are
  CRLF-insensitive, so a repo file that still holds CRLF bytes compares equal to a
  canonical capture and the renormalize commit happens without capture churn.
- A capture never writes the live home and never records modes.

### Install (`install-user.mjs` including the board seed, `install-projects.mjs`, `sync.mjs`)

- Every source read renders in this order: canonicalize the checkout bytes (the data
  dir may be a CRLF checkout), run the item transforms (`forTarget` JSON re-rooting,
  the config gates, the layer remap), then render for the target: CRLF for
  `.cmd`/`.bat`, LF for all other text, binary untouched. `forTarget` re-roots the
  stored form at the target home on every platform, so the placeholder becomes the
  target home everywhere; an install into the workers' home `/root` is an identity
  (`specs/stored-json-path-form.md` records the amended rule). The rendered bytes are
  what the fingerprint compares, the record, and the write all see, so an installed
  file holds the target form and stays byte-stable across installs from any checkout
  form.
- The scan gate judges the rendered bytes: every snapshot skill is scanned through a
  staged copy that holds the rendered bytes with clean modes (the existing staging
  becomes the one scan path; the exec-bit-only condition is subsumed). The verdict
  cache keys the staged bytes, which are exactly the bytes the install copies.
- Modes come from the index rule above. `writeFileInside` gains a mode parameter;
  every install write passes `0755` or `0644` from it.
- Merged worker lists (`tools.json`, `apt.txt`, `env.txt`, `requirements.txt`) render
  the same way, in bundles mode, in the `workers/_all/` fleet folder, and in the
  verbatim non-bundles path.

### Per-OS differences as data

Data-repo manifests may carry per-OS facts; install resolves them for the target.
No file is ever duplicated per OS.

- A `tools.json` entry may carry an optional `os` array of platform names
  (`linux`, `win32`, `darwin`). Install drops the entry (and the field) when the
  target platform is not in the list. The entry may sit in any worker-list source:
  a bundle folder, a project's own `workers/<p>/` file, the `workers/_all/` fleet
  folder, or a verbatim non-bundles list. Every check (the source pre-check and the
  merged-result check) validates the resolved bytes, so a raw `os` shape never
  refuses a run that resolution would accept.
- A `tools.json` value may be an object keyed by platform names, for example
  `{"linux": "npx", "win32": "npx.cmd"}`. Install resolves it to the target's value
  and drops the wrapper. This covers the one value-level difference alate knows
  today (the `cmd /c` MCP wrapper keeps its existing `unwrapCmd` handling; the
  marker is for list data, not `mcp.json`).
- Anything else in an entry installs verbatim, as today.

## Error cases

- An `os` value that is not an array of known platform names refuses the run,
  naming the file and the entry name.
- A per-OS object with an unknown platform key, or without the target platform's
  key, refuses the run, naming the file and the entry name.
- A capture or install source that cannot be decided text or binary (unreadable)
  refuses as it does today.
- The CRLF source guard (a text file under a baseline-shipping skill dir) stays
  fatal. Canonical capture makes it unreachable for fresh captures. In a
  git-checkout data dir it passes a `*.cmd`/`*.bat` candidate (the checkout's CRLF
  smudge of LF index bytes) and a candidate whose bytes equal its committed blob;
  every other candidate whose bytes differ from the committed blob refuses, and a
  data dir without git refuses every candidate. The guard keeps guarding stale
  checkouts (see Risks).

## Acceptance checks

Each fails before the change:

1. Round trip, Linux-ward: a fixture home in Windows form (JSON with `C:\Users\x`
   paths, CRLF text files, a CRLF `.cmd`, a binary file) captures into a fresh data
   repo with `--first`; the repo holds canonical bytes (LF text, LF `.cmd`,
   `/root` JSON paths, identical binary). Install into a fresh Linux-form home; the
   installed files hold the target form (LF text, CRLF `.cmd`, re-rooted JSON paths,
   identical binary). Capture that home again: the data repo is byte-identical
   (tree hash) to before the install.
2. Round trip, Windows-ward: the canonical data repo renders through the win32
   direction — text stays LF, `.cmd` renders CRLF, JSON re-roots at
   `C:\Users\x` — and a capture of a home holding exactly those rendered bytes
   writes nothing (the repo already holds their canonical form).
3. Modes: a source file the filesystem marks `0777` installs `0644` (the install
   never takes the exec bit from the filesystem, bind-mount noise included); a file
   the data repo's git index marks `100755` installs `0755`.
4. Per-OS data: a `tools.json` entry with `os: ["linux"]` installs into a Linux
   target and drops from a win32 target; a `{"linux": "npx", "win32": "npx.cmd"}`
   value installs as `npx` on Linux and `npx.cmd` on win32; the unknown-platform
   forms refuse.
5. The project's check and test commands (the verified chain in `AGENTS.md`) exit 0.
6. A baseline-shipping skill fixture in a git checkout of the canonical ruleset
   holds a `.cmd` whose index blob is LF and whose working-tree bytes are CRLF
   under a clean `git status`; install exits 0 and the installed `.cmd` holds CRLF.
   A non-suffix text file in the same checkout whose working bytes are CRLF over an
   LF blob still refuses, named in the message while the `.cmd` stays unnamed.

## Alternatives considered

- **chezmoi (or another dotfile manager) as the provisioning source.** Rejected: a
  tool replacement is out of scope for this card and would abandon the item gates,
  baselines, layer switch, and dashboard this repo already owns. Its one-source
  state plus per-OS apply is the model this spec follows, not its implementation.
- **A literal `${HOME}` (or `~`) placeholder string in JSON and config.** Rejected:
  `toStoredForm`/`forTarget` already implement a home placeholder (the `/root`
  prefix) as inverse pair with byte-stable round trips; a second token would need
  its own parser on every reader and a repo-wide migration for no behavior gain.
- **Parsing `.gitattributes` at runtime to learn line-ending rules.** Rejected:
  one constant with a sync comment is testable without an attribute parser; the
  rules this card needs are two suffixes and the binary heuristic.

## Risks

- **One checkout, two Git versions.** A `C:/workspace` checkout bind-mounted into
  Linux containers still shows Windows checkout bytes to the container. Canonical
  reads tolerate that (CRLF checkout bytes render correctly), so installs stay
  correct either way; a separate clone per OS would stay the cleaner shape but
  needs its own decision (workflow, tokens, disk) and stays out of scope.
- **The CRLF source guard turns redundant.** Staged canonical scanning judges the
  rendered bytes, so a stale CRLF checkout would scan correctly even without the
  guard. The guard stays in this card (a fatal safeguard is not weakened on
  inference); a later card may relax it with its own evidence.
- **Scan-cache invalidation.** Cache keys now bind the staged rendered bytes, so
  the first provision after this change rescans every skill once. The per-skill
  scan cost (~15 s, parallel at most 8) is the price of judging canonical bytes;
  later installs hit the warm cache as today.
- **Renormalize touches history-sensitive fingerprints.** The renormalize commit
  changes index bytes of `*.cmd` files. The one pinned `-text` file (the
  check-ottr-board `SKILL.md`) keeps its raw CRLF bytes until its baseline is
  regenerated with it, so no baseline breaks.

## Non-goals

- No switch to chezmoi or another provisioning tool.
- No change to Ottr: installed worker lists and skill trees hold plain target-form
  bytes, exactly what Ottr reads today.
- No capture-side mode recording; exec stays a git-index decision.
- No relaxation of the CRLF source guard beyond the tracked-checkout exemption in
  Error cases; the SkillSpector rules and the baseline severity cap stay untouched.
- The real agent-data renormalize is a data-repo card (filed from this task), not a
  commit in that checkout from this branch.
- No bundles-feature changes beyond the worker-list render points this card needs.
