# Imported-commit describe

The dashboard header and the Settings data-source view show the imported commit in
git-describe form, so the operator sees how far the import sits from the last release.

## Behavior

- At import time the server computes a describe string and stores it on the source as
  `describe`, next to `importedSha`.
- Forms, identical to `git describe --tags`:
  - `<tag>-<n>-g<hash>`: the nearest tag reachable from the commit, with `n` commits
    since that tag. `n` is the smallest ahead count over the reachable tags.
  - `<tag>`: exactly, when the commit is the tagged one.
  - `<hash>`: the short hash alone, when no tag is reachable. This is also the fallback
    for a failed lookup: the import never fails because describe failed, and the server
    logs a warning.
- Repo source: the tags and ahead counts come from the source host's REST API. The
  stored key rides only to the host it belongs to (the recorded `tokenHost`, else the
  ambient `ALATE_GITHUB_HOST`). A lookup failure stores the short hash.
- Path source: `git describe --tags --always` runs in the checkout. A folder that is not
  a git work tree stores `''` and shows no commit.
- The header shows the describe string, with the full sha in its title tooltip. Settings
  > Commit shows the describe string and keeps the full sha in the same row.
- When the periodic remote check knows the remote is ahead, the header and the banner
  show `N behind`, where `N` is the compare endpoint's `ahead_by` of
  `<importedSha>...<remoteSha>`. Without a count the surfaces keep their current text.

## Boundaries and error cases

- A failed REST lookup (network, rate limit, bad key, 404) stores the short hash and
  only logs; the import proceeds.
- Tags beyond the first `per_page=100` page are not compared.
- Equal smallest ahead counts resolve to the first tag in the API's response order.
- Stored snapshots from before this change have no `describe` field: the UI falls back
  to the short sha, as before.

## Acceptance checks

- A fixture repo with tag `v1` and three later commits yields `v1-3-g<hash>`.
- The tagged commit yields `v1`.
- A repo without tags yields the short hash.
- A test asserts the exact GitHub request URLs the repo-source path sends, and the
  Authorization header per host state.

## Non-goals

- No change to how imports or provisions run, no new dependency.
- No change to `importedSha` semantics for path sources.
