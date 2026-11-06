# SkillSpector scanner trust: never execute a scanner from a turn-writable home

## Threat

`install-user.mjs` resolved the scanner from `<home>/.cache/skillspector-venv/bin/skillspector`
first, then PATH, and the only identity check was a `--version` probe. The `home` volume is
shared with worker turns (compose.yaml mounts it at `/root`; every layer `.cache` links there),
so any agent turn could plant a `skillspector` that answers the probe. The next provision ran
it as the provisioner with the server's full environment, which carries `ALATE_API_KEY`.
The planted binary also passed every skill, so the fail-closed skill gate was gone, and the
passes were cached.

The scanner is a pip console script, so it runs a system Python. That interpreter loads the
user site-packages of its `HOME` (`<home>/.local/lib/python3.X/site-packages`) and executes
every `.pth` file and `usercustomize.py` there at start. A turn can plant those too, so even
the pinned scanner binary must never see a home that turns can write as its Python user site.

## Contract

1. Resolution order in `runScan`: `SKILLSPECTOR_BIN` (when set), the pinned venv
   (`SKILLSPECTOR_VENV`, default `<homedir>/.cache/skillspector-venv`), then `skillspector` on PATH.
2. `SKILLSPECTOR_BIN` must be an absolute path whose realpath lies outside the canonical
   target home (`resolveHome(home)`; a `--home` through a symlink measures like the path it
   resolves to). A violation refuses the run with an error that names the rule. No fallback.
3. The venv candidate runs only when the binary exists, is owned by root on POSIX
   (`stat.uid === 0`; Windows skips the uid rule), and its realpath lies outside that
   canonical home. Otherwise install-user skips it with a logged reason and probes the next
   candidate. A candidate is never executed before its trust check.
4. The version pin (`SKILLSPECTOR_REF`) still applies to every probed candidate. A candidate
   that runs and reports a wrong version still refuses the run.
5. Spawned children get allowlisted environments. `server.ts` passes provision script children
   only documented keys plus the `ALATE_TEST_*` family. `install-user.mjs` passes the scanner,
   bun, and sync children only their documented keys. `ALATE_API_KEY` never crosses a spawn
   boundary.
   - scanner child: `PATH HOME USERPROFILE TEMP TMP TMPDIR LANG LC_ALL TZ SystemRoot SystemDrive ComSpec PATHEXT`, and `PYTHONNOUSERSITE=1` forced (never passed through from the parent)
   - bun and sync children: the same keys, plus proxy keys for bun (`HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy`) and `ALATE_TEST_SCRIPT_GATE` for sync
   - server to script children: those keys, plus `PI_CODING_AGENT_DIR ALATE_LAYER ALATE_DATA ALATE_KEEP_TEMP SKILLSPECTOR_BIN SKILLSPECTOR_VENV` and every `ALATE_TEST_*` key
6. The image pins the scanner. The Dockerfile copies the pip-installed entry point to
   `/usr/local/bin/skillspector` and sets `ENV SKILLSPECTOR_BIN=/usr/local/bin/skillspector`,
   so the image never resolves a scanner binary from the home volume.
7. Python never loads a user site from the home: the scanner child runs with
   `PYTHONNOUSERSITE=1` on every spawn (probe included, because a `.pth` executes at
   interpreter start), and the image sets `ENV PYTHONNOUSERSITE=1` for every Python process
   in the container.

## Acceptance checks

- `install-user.test.mjs` plants a venv under the target home whose binary answers the pin and
  writes a marker on `scan`. The run must serve the scan with the trusted scanner
  (`SKILLSPECTOR_BIN` or the PATH stub), never execute the planted binary, and log the refusal.
- `SKILLSPECTOR_BIN` inside the target home or a relative path refuses the run.
- A venv outside the home that is not owned by root is skipped (test guarded to non-root runners).
- A `--home` given through a symlink to the real home measures containment like the path it
  resolves to: a venv planted in the real home is refused (alias regression test).
- The scanner child environment dump in `install-user.test.mjs` must not contain `ALATE_API_KEY`
  when install-user runs with it set, and must carry `PYTHONNOUSERSITE=1`.
- A test plants a user-site `.pth` file under the target home that writes a marker when Python
  executes it, with a positive control that proves the marker appears without the guard. The
  guarded scan run must not execute it (test guarded to POSIX runners whose python3 supports
  user site).
- `server.test.mjs` captures the provision child environment through `ALATE_TEST_CHILD_ENV`.
  A server started with `ALATE_API_KEY` must not pass it to children, and documented keys
  (`PATH`, `SKILLSPECTOR_BIN`, `ALATE_TEST_*`) must pass.
- The Dockerfile pin check in `install-user.test.mjs` stays green (`ARG SKILLSPECTOR_REF`).

## Non-goals

- The SkillSpector pass-cache key does not bind the installed bytes: separate card.
- Layer prefix duplication and symlinked-home path bugs: ALAT-84, ALAT-85, ALAT-81.
- PATH entries that point into a turn-writable directory on a shared multi-user host: PATH
  comes from the operator's server environment, not from the home. Documented residual risk.
