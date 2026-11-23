# Imported-commit label

The dashboard header and the Settings data-source view label the imported commit
`<count>-<hash>`, for example `1287-d9f6c7b`, so the operator sees the size of the
imported history at a glance. The data repo carries no tags, so no git-describe form
is used. This replaces the earlier describe-string format of this card.

## Behavior

- At import time the server computes a commit count and a label and stores the label on
  the source as `commitLabel`, next to `importedSha`.
- The label is `<count>-<short hash>`: the number of commits reachable from the imported
  commit, a dash, and the short hash.
- The count comes from `git rev-list --count HEAD` for a path source, and from the
  source host's REST API for a repo source: one `GET /repos/<name>/commits?sha=<sha>&per_page=1`
  request whose `link` header names the last page, which is the exact count. The stored
  key rides only to the configured `ALATE_GITHUB_HOST` (the `gitAuthEnv` rule); a
  `tokenHost` recorded by a foreign-host import is a withhold flag: the key then rides
  nowhere.
- When the count is unknown, the label is the short hash alone. A failed lookup (network,
  rate limit, bad key, 404) only logs; the import never fails because the count failed.
- A folder that is not a git work tree stores `''` and shows no commit.
- The header shows the label, with the full sha in its title tooltip. Settings > Commit
  shows the label and keeps the full sha in the same row.
- When the periodic remote check knows the remote is ahead, the header and the banner
  show `N behind` (the compare endpoint's `ahead_by`), unchanged by this rework.

## Boundaries and error cases

- A failed REST lookup stores the short hash alone and only logs; the import proceeds.
- Repos with more commits than one page are counted exactly through the `link`
  header's last page number.
- Stored snapshots from before this change have no `commitLabel` field: the UI falls
  back to the short hash alone (path sources show no commit).

## Acceptance checks

- A 5-commit fixture yields `5-<hash>`.
- A stored state without a count renders the short hash alone.
- A test asserts the exact GitHub request URL the repo-source path sends.

## Non-goals

- No tags, no new dependency, no change to how imports or provisions run, no change to
  `importedSha` semantics for path sources.
