# Skill lock digest checks

## Behavior

The update checker accepts two values in `skillFolderHash`:

- A 64-character hexadecimal SHA-256 digest from `skills@1.7.0`.
- A GitHub folder tree SHA, as before.

For SHA-256 locks, compare the source folder with the CLI digest algorithm. Sort regular files by relative path with `localeCompare`. Use `/` as the path separator. Feed each path, then its raw file bytes, into one SHA-256 hash. Exclude directories named `.git` or `node_modules` at any depth. Exclude symlinks and Git submodules.

Use this comparison in both path and release modes. An equal folder produces no target. A different folder produces a target only after the existing age gate permits it. Keep source refs, release stream selection, and the release match limit unchanged. Keep tree SHA locks on the existing comparison path.

## Boundaries and errors

Read source data through the existing GitHub API boundary. Never execute source files. Never install a skill or edit a lock. Never send credentials to a URL from a tree response. Use API paths built from the repository and object SHA.

A missing folder keeps the existing removed notification. For SHA-256 locks, an incomplete tree, failed blob read, or invalid blob response produces an error. The error must not retain an old update target. Legacy tree SHA checks keep their existing response and error policy.

## Assumptions

A 64-character hexadecimal lock value identifies the CLI SHA-256 algorithm. Other lock values retain the existing tree SHA behavior. The check compares upstream source bytes, not local compatibility patches. It does not authorize replacement of local files.

## Acceptance checks

- Observe a failure before the fix for unchanged SHA-256 locks in path and release modes.
- Check equal folders, changed files, renamed files, nested files, binary bytes, ignored directories, and symlinks.
- Check that changed folders respect the path first-seen gate and the release age gate.
- Check existing 40-hex locks in both modes.
- Check incomplete trees and failed or invalid blob reads without an update target.
- Replay the two EGM digests at commit `72d06f52a2482885d9a64bd24b291c6e8628942c` from isolated source data.
- Run the focused update tests and the required project checks.

## Non-goals

No lock migration, skill installation, automatic patch replacement, approval change, or edit in another project.

## Source evidence

The npm metadata for [skills@1.7.0](https://registry.npmjs.org/skills/1.7.0) names commit `7407f3893ad4dceab546ac002c3ef806e4000c73`.

[`computeSkillFolderHash` and `collectFiles`](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/local-lock.ts) define the digest. [`add.ts`](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/add.ts) writes that digest to the global lock when the clone fallback supplies the folder. Other install paths can write a tree SHA.

The published npm archive has SHA-512:

```text
39f78f9c37edf97b7dfed0a81dd0947b97e433c8be43740e4903b9de19bb98ab6c5f2bdcf8228e000962556678f381d2ddc5b1fbaafea1bd0002b8b1b378d85f
```

This value matches the registry integrity field. A replay used the published digest function and isolated source bytes at the EGM commit above. It produced:

```text
egm-drift-report 60acfd354ef952f4ccc2dc3d93ef01514b083802dc5dcf809fe405faa045569e
egm-bootstrap 9634992792894d0c8159fe55e1b22267a8c03d260c90d141fbbf21fd9dfdbb6d
```

Both values match the supplied locks. The replay ran no skill code and wrote nothing to a live home.

## Verification evidence

The baseline was commit `abf16eb7905e7ef2e648e890516b9ef42c0ba729`. The focused runner used the permanent ALAT-191 block from `server.test.mjs`. Its baseline module kept the original checker logic. Only import paths and the shipped source root changed for the temporary location.

The baseline runner collected assertion failures instead of stopping at the first failure. The permanent tests retain normal assertions.

```text
node /tmp/alat-191-final-focused-before.mjs
ALAT-191 focused before complete
passed: 268
failed: 137
exit: 1

node /tmp/alat-191-final-focused-after.mjs
ALAT-191 focused after complete
exit: 0
```

Each row below names the permanent test cases. Braces show each value that the test loop uses.

| Cases | Before the fix | After the fix |
| --- | --- | --- |
| `sha256-unchanged-{path,release}` | Both fail. Both return a false target. | Both pass with no target. |
| `sha256-changed-{nested,binary,rename}-path` | All pass. The old mismatch also detects real changes. | All pass. |
| `sha256-changed-{nested,binary,rename}-release` | All fail to identify the installed release. | All pass. |
| `sha256-first-seen-path`, `sha256-first-seen-path-mature` | Both pass. The existing first-seen gate already works. | Both pass. |
| `sha256-release-age`, `sha256-release-age-mature` | Both fail. The current release does not match. | Both pass. |
| `legacy-40hex-{unchanged,changed}-{path,release}` | All pass. These cases retain the existing tree SHA behavior. | All pass without blob reads. |
| `sha256-missing-folder-{path,release}` | Both pass. These cases retain the existing removal notice. | Both pass. |
| `sha256-ignored-entries-{path,release}` | Both fail the current and target assertion. | Both pass. |
| `sha256-property-*` | Unchanged generated folders fail. Changed folders pass because the old mismatch detects real changes. | All 200 default cases pass. |

The source failure cases use both `path` and `release` modes:

```text
truncated
missing-tree
invalid-tree-path
invalid-tree-type
invalid-blob-sha
unsupported-file-mode
missing-file-sha
failed-blob
invalid-blob-shape
invalid-base64
invalid-encoding
invalid-size
blob-timeout-connect
blob-timeout-headers
blob-timeout-body
```

Each case first creates a valid target. Before the fix, every case fails the error assertion. Every case except `missing-tree` also fails the target-clear assertion. The old `missing-tree` path reports removal, so its target-clear assertion already passes. After the fix, all cases report an error and clear the target.

The isolated EGM smoke command also passed:

```text
node /tmp/alat-191-egm-smoke.mjs
path: both unchanged folders have target=null
release: both unchanged folders have target=null
path: both changed folders have the mature commit target
release: both changed folders have the mature release target
Pinned refs and lock bytes remain unchanged.
```

The exact required chain passed with exit code 0 in 135.65 seconds:

```sh
npm ci && npm audit --omit=dev --audit-level=low && node license-gate.mjs && node zero-deps.test.mjs && node license-gate.test.mjs && node crlf.test.mjs && node home-guard.test.mjs && node home-guard.test.mjs record && node sync.mjs "$(mktemp -d)" --data examples/data && node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node install-projects.test.mjs && node lib/bundles.test.mjs && node lib/canonical.test.mjs && node install-bundles.test.mjs && node canonical-form.test.mjs && node architecture.test.mjs && node clone.test.mjs && node skills/create-data-repo/scan-secrets.test.mjs && node scripts/mutant-run.test.mjs && npx tsc --noEmit && node lib/env-proxy.test.mjs && node server.test.mjs && node home-guard.test.mjs check
```

The run used a separate `ALATE_HOME_GUARD_SNAPSHOT` path under `/tmp`. The server suite reported `server ok`. The production audit reported zero vulnerabilities. The dependency install reported two moderate vulnerabilities in the full dependency tree. This task changed no dependencies.

The suite skipped real SkillSpector checks because the pinned scanner was absent. Mutation tests did not run because this was a work turn. No credentials entered source code. Blob reads retain the existing host-specific token boundary to prevent credential disclosure.

There were no deviations from the requested behavior. No lock or skill content changed. No skill install used a live home. No other project checkout changed.
