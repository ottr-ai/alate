# Ottr's shipped skills install on every provision

The board requires four skills that Ottr ships in its own checkout
(`.agents/skills/check-ottr-board`, `diff-security-review`, `explain-project`,
`ui-ux-check` in `github.com/ottr-ai/ottr`, commit `affd848b7e02c08339561c7282957e2a5fc9c201`).
omp loads `.agents/skills` only for runs inside the Ottr checkout itself, so a provisioned
worker home has none of them unless the data repo carries copies. Alate vendors that tree at
the pinned commit and installs it on every provision, so a fresh install needs no copy in the
data repo (fix list #45, Alate part).

## Pinned source

- `lib/shipped.mjs` holds the pin: repo `ottr-ai/ottr`, the full commit SHA, and one path per
  skill. `shipped/ottr/<path>` holds the vendored bytes, mirroring the upstream layout. The
  bytes stay exactly the pinned commit's bytes (LF; SkillSpector baselines fingerprint the
  upstream bytes).
- Re-pinning is a new commit: copy the four folders at the new upstream commit into
  `shipped/ottr/` and bump `SHIPPED_PIN.commit`. The update checker (below) makes the new
  upstream state visible with the same 7-day age gate as every other skill row.
- The Ottr image path was rejected as the source: alate cannot read another container's
  image, and the compose stack gives it no Docker socket. A provision-time git fetch of the
  pin was rejected too: it makes every fresh provision depend on egress to public GitHub —
  exactly what the reporting stack (corporate proxy, GitHub Enterprise only) cannot rely on —
  and hermetic tests could only prove plumbing, never the four skills landing.

## Install (install-user.mjs)

Shipped skills are a second skill source beside the data repo snapshot. The same gates apply
in the same order as for snapshot skills; nothing about them is weaker.

1. For each pinned skill, the vendored folder must exist and pass the structure gate
   (`SKILL.md` frontmatter, `skillProblems`) and the SkillSpector scan gate (same pinned
   scanner, `--no-llm`, the skill's own shipped `.skillspector-baseline.yaml`, same scan
   cache). A gate rejection fails that one skill per item and never stops the others.
2. A data repo skill of the same name wins: when the snapshot holds any skill folder named
   like the pin (any `skills/` or `managed-skills/` dir under `user/`, the same set
   `collectSkillDirs` scans), alate skips the shipped copy for that name and logs the skip
   (`shipped skill <name> skipped: the data repo has its own copy`). The snapshot's install
   plan already covers the home path.
3. Otherwise the shipped skill installs under `~/.agents/skills/<name>`, one plan entry per
   file, rel keys `agents/skills/<name>/...` (snapshot spelling, like
   `user/agents/skills/...`). Machine state rules are the snapshot's: an in-place install
   refuses a machine-changed copy unless `--force`; layer mode keeps the machine copy;
   record-matching copies update. Manifest records, deletion when the pin drops a skill, and
   unchanged counting all behave exactly like snapshot skills.
4. Per-item results use the skill key `user/agents/skills/<name>`, so the existing
   aggregation regex and the dashboard's failed-item count cover shipped skills. A missing
   vendored folder is a per-item `rejected` (`missing vendored copy`), never fatal.

## Update checker (lib/updates.mjs)

Each pinned skill gets a row beside the lock-driven skill rows, built after them:

- `name`: the skill name; `kind`: `skill`; `repo`: `ottr-ai/ottr`;
  `pin`: `{ file: "lib/shipped.mjs", key: <name> }`;
  `origin`: the GitHub tree URL of the pin; `current`: the pinned commit.
- The row runs the same first-seen head check as a lock row without a release stream
  (`runPathCheck` on the pin path, default branch): `target` is the head commit only when it
  differs from the pin and the checker first saw it more than 7 days ago. The skill folder
  gone upstream is a `removed: true` notification row, never a target.
- When the snapshot holds a skill folder of the same name, the shipped row is suppressed: the
  data repo copy wins, and its own lock or upstreams row already reports updates.
- Applying an update is an alate change (re-pin commit), not a provision action; the row only
  makes the newer upstream visible.

## Boundaries

- `sync.mjs` and the origin gate are unchanged: shipped skills are not data repo items and
  need no `upstreams.json` entry. A data repo may still record an origin for its own copy.
- The vendored tree is tool content, not snapshot content: the dashboard inventory, the file
  editor and `sync-user.mjs` never see it.
- No provision-time network access is added anywhere.

## Acceptance checks

1. An empty data repo (a `user/` snapshot with no skills) provisions and all four vendored
   skills land in `~/.agents/skills/<name>` with the pinned bytes; the per-item results name
   all four as installed.
2. A data repo that holds its own copy of one of the names keeps that copy (its bytes land in
   the home), the shipped copy of that name is skipped with a log line, and the other three
   shipped skills still install.
3. A scan rejection of one shipped skill fails only that item; the others install.
4. A machine-changed shipped skill refuses the in-place install; `--force` takes the shipped
   bytes; layer mode keeps the machine copy.
5. The update checker reports the four pins with the pinned commit as `current`, holds
   `target` back for the 7-day first-seen gate, and suppresses a pin whose name the snapshot
   carries.

## Non-goals

- No change to which skills the Ottr board requires, and no retro skill (Ottr decides that on
  its own card).
- No auto-update of pins, no dashboard section for shipped skills, no manifest or schema
  change beyond the pin module.
