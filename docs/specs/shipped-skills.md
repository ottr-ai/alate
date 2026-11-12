# Ottr's shipped skills install on every provision

Alate vendors every skill folder under Ottr's `.agents/skills` at the pinned commit
(`github.com/ottr-ai/ottr`, commit `a7191d7fab8bbe337e918aa15f0a8e53df3e323a`) and installs
every folder in that tree on every provision. Today this tree holds seven skills:
`check-ottr-board`, `diff-security-review`, `explain-project`, `llm-to-code`, `retro`,
`ui-ux-check`, and `web-perf-audit`.
omp loads `.agents/skills` only for runs inside the Ottr checkout itself, so a provisioned
worker home has none of them unless alate vendors the tree (fix list #45, Alate part).

## Pinned source

- `lib/shipped.mjs` holds the pin: repo `ottr-ai/ottr` and the full commit SHA. The source
  is the whole `.agents/skills` tree at that commit; the module also enumerates the vendored
  folders, one per skill. `shipped/ottr/.agents/skills/<name>/` holds the vendored bytes,
  mirroring the upstream layout. The skill bytes stay exactly the pinned commit's bytes
  (LF). The `.skillspector-baseline.yaml` files are alate's own scan records: alate
  regenerates each one for the vendored bytes with the pinned scanner in `--no-llm` mode
  and keeps the accepted reasons. A baseline fingerprint binds the scan mode and the exact
  bytes, so an upstream baseline does not suppress alate's findings (the 2026-11-11 CI
  install failure).
- Re-pinning is a new commit: copy the whole `.agents/skills` tree at the new upstream
  commit into `shipped/ottr/`, bump `SHIPPED_PIN.commit`, regenerate each vendored skill's
  `.skillspector-baseline.yaml` (`skillspector baseline <skill-dir> --no-llm` at the pinned
  scanner, restore each entry's accepted reason from the previous baseline), and run the
  scan gate over the vendored tree before the commit
  (`skillspector scan <skill-dir> --no-llm --fail-on-findings --use-shipped-baseline`).
  The update checker (below)
  makes the new upstream state visible with the same 7-day age gate as every other skill row.
- The Ottr image path was rejected as the source: alate cannot read another container's
  image, and the compose stack gives it no Docker socket. A provision-time git fetch of the
  pin was rejected too: it makes every fresh provision depend on egress to public GitHub —
  exactly what the reporting stack (corporate proxy, GitHub Enterprise only) cannot rely on —
  and hermetic tests could only prove plumbing, never the skills landing.

## Install (install-user.mjs)

Shipped skills are a second skill source beside the data repo snapshot. The source is the
vendored tree; the enumeration in `lib/shipped.mjs` lists its folders. The same gates apply
in the same order as for snapshot skills; nothing about them is weaker.

1. For each vendored skill folder, the folder must exist and pass the structure gate
   (`SKILL.md` frontmatter, `skillProblems`), the hidden-character gate over the whole
   folder (one bad `.md`/`.mdc` file fails that one skill; the `SKILL.md` entrypoint is
   judged by the structure gate), and the SkillSpector scan gate (same pinned
   scanner, `--no-llm`, the skill's own shipped `.skillspector-baseline.yaml`, same scan
   cache). A gate rejection fails that one skill per item and never stops the others.
2. A data repo skill of the same name wins, but only a copy the gates accept: when the
   snapshot holds a skill folder named like the pin (any `skills/` or `managed-skills/`
   dir under `user/`, the same set `collectSkillDirs` scans) that passed the origin and
   structure gates, alate skips the shipped copy for that name and logs the skip
   (`shipped skill <name> skipped: the data repo has its own copy`). The snapshot's install
   plan already covers the home path. A snapshot copy the origin or structure gate rejected
   installs nothing, and its rels leave the plan and the manifest, so it never counts as
   the data repo's own copy: counting it would skip the shipped install and then let the
   deletion path remove the home's files — one capture round trip disabled every shipped
   skill (ALAT-124). The skip decision sees the origin and structure verdicts; a snapshot
   copy that only the later scan gate rejects still suppresses its name here, and the
   capture rule below keeps the normal round trip from ever creating such a copy.
3. Otherwise the shipped skill installs under `~/.agents/skills/<name>`, one plan entry per
   file, rel keys `agents/skills/<name>/...` (snapshot spelling, like
   `user/agents/skills/...`). Machine state rules are the snapshot's: an in-place install
   refuses a machine-changed copy unless `--force`; layer mode keeps the machine copy;
   record-matching copies update. Manifest records, deletion when the upstream tree drops a
   skill folder, and unchanged counting all behave exactly like snapshot skills.
4. Per-item results use the skill key `user/agents/skills/<name>`, so the existing
   aggregation regex and the dashboard's failed-item count cover shipped skills.
5. The vendored tree is load-bearing and the source fails closed. An absent or unreadable
   tree is a broken tool install, and an empty enumeration would treat the shipped skills
   already in the home as obsolete and delete them — so `shippedSkills` throws, and
   install-user refuses the whole run before deletions or a layer switch (fatal, exit 1,
   nothing written or deleted). A tree that exists but holds zero folders stays a visible
   note, not an error.

## Capture (sync-user.mjs)

A capture of `.agents/skills` must never copy the shipped skills back into the data repo:
a captured copy sits at `user/agents/skills/<name>` with no recorded origin, so the next
provision rejects it — and a rejected copy also suppressed the shipped install, so the
round trip deleted the shipped files from the home (ALAT-124).

- For each child of a skill root item (`.agents/skills`, `.omp/agent/skills`,
  `.omp/agent/managed-skills`) named like a vendored skill, the capture leaves the name
  out only when its file list and bytes equal the vendored copy, judged with the same
  SKIP_DIRS rule as the capture walk. A byte change, an extra file, or a missing file
  counts as an edit, and the edited skill captures: a machine edit is state the data repo
  must hold.
- The bridge shape `.omp/agent/skills -> .agents/skills` (a link between two allowlisted
  roots) reaches the shipped bytes through the link, so the filter runs for that item too:
  no shipped skill lands as `user/omp/agent/skills/<name>`.
- Each left-out name logs
  `note: user/<root>/<name>: the bytes equal the vendored shipped copy; left out of the capture`.
- The vendored set is computed lazily: a home without `.agents/skills` never reads the
  vendored tree. A tree that cannot be read refuses the capture (fail closed, like
  install step 5), because without the shipped set the capture would copy every child
  back.

## Update checker (lib/updates.mjs)

Each vendored skill folder gets a row beside the lock-driven skill rows, built after them:

- `name`: the skill name; `kind`: `image-pin` (the pin-applied-in-the-owning-repo kind,
  because the update procedure is alate's documented re-pin — copy the vendored tree at the
  new upstream commit, bump `SHIPPED_PIN.commit` — for updates and for upstream removals
  alike, never the skills CLI; `repo`: `ottr-ai/alate` (the alate repository,
  because applying an update is an alate re-pin commit, never an upstream skills update;
  `origin` and the upstream facts stay pointed at Ottr);
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
- The vendored tree is tool content, not snapshot content: the dashboard inventory and the
  file editor never see it, and it never becomes snapshot content — `sync-user.mjs` reads
  the vendored bytes only to judge which `.agents/skills` children match them (capture
  section). Its absence or unreadability refuses a provision (fail closed, install step 5)
  and refuses a capture of `.agents/skills`; it is never provisioned around.
- No provision-time network access is added anywhere.

## Acceptance checks

1. An empty data repo (a `user/` snapshot with no skills) provisions and every vendored
   skill lands in `~/.agents/skills/<name>` with the pinned bytes; the per-item results name
   each of them as installed.
2. A data repo that holds its own copy of one of the names keeps that copy (its bytes land in
   the home), the shipped copy of that name is skipped with a log line, and the other
   shipped skills still install.
3. A scan rejection of one shipped skill fails only that item; the others install.
4. A machine-changed shipped skill refuses the in-place install; `--force` takes the shipped
   bytes; layer mode keeps the machine copy.
5. The update checker reports one row per vendored skill folder with the pinned commit as
   `current`, holds `target` back for the 7-day first-seen gate, and suppresses a row whose
   name the snapshot carries.
6. A test adds a fifth skill folder to the vendored tree and it installs on provision, with
   no code changes to the install or update paths.
7. The update checker rows match the enumeration of vendored folders in `lib/shipped.mjs`,
   with no code changes.
8. Installed shipped skills survive a run whose vendored tree is gone: the run refuses with
   a fatal result naming the vendored tree, every previously installed
   `.agents/skills/<name>/SKILL.md` keeps its bytes, and a `--layer` run in the same state
   switches nothing — `.alate/current` stays on the previous layer and no new layer folder
   appears.
9. The capture round trip: install-user into a fresh home, sync-user capture, install-user
   again from the captured data repo, with and without an `upstreams.json` — the capture
   adds no `user/agents/skills/<name>` for any vendored name and logs the note per
   left-out name; both installs report 0 deleted and no skip lines, and every shipped
   `SKILL.md` keeps the vendored bytes. The bridge shape
   `.omp/agent/skills -> .agents/skills` captures no `user/omp/agent/skills/<name>` for a
   vendored name either. An edited shipped skill (a byte change, an extra file, or a
   missing file) captures, and a rejected stale copy in the data repo (no origin) fails
   only its own item without deleting or skipping the shipped copy.

## Non-goals

- No change to which skills the Ottr board requires: alate vendors the tree Ottr ships and
  decides nothing about the set (Ottr shipped `retro` on its own card, 2026-11-11).
- No auto-update of pins, no dashboard section for shipped skills, no manifest or schema
  change beyond the pin module.
