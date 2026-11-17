# Modern Web Guidance legacy scan

## Scope and assumptions

This report records a `modern-web-guidance@1.0.0` scan of five source files before the dashboard fix.
The scanner found one occurrence. The fix adds an IME guard. A later confirmation scan found zero occurrences.

The input scope contains exactly these files:

- `web/index.html`
- `web/style.css`
- `web/app.js`
- `web/dashboard.mjs`
- `web/diff.mjs`

The review read `DESIGN.md`, `AGENTS.md`, and the dashboard sections of `docs/how-it-works.md` and `README.md` before triage.
The [task spec](../specs/modern-web-guidance.md) defines the wider delivery.
The scan changed no dashboard source, manifest, or lockfile. The coordinator later applied the source fix below.

The scan treats these files as plain source, not as a framework project.
`web/dashboard.mjs` contains server-side logic, although its path is under `web/`.
The static assets use the Galley Proof design from `DESIGN.md`.
That design requires square corners, print-like type, hairlines, proof red, and interaction blue.
A modernization suggestion must not replace those choices without a separate design need.

Agent-data card `AGEN-102` delivered the skill snapshot, lock entry, and SkillSpector review through the approved flow.
The current worker resolves the skill. Separate host checks remain unverified.

### Skill delivery evidence

The lock records version `1.0.0`, ref `v1.0.0`, and the commit-pinned companion URL named in the task spec.
Its Git tree hash is `2bafd62db079eae1a4b6c34d0af4f9c3490266a2`.
The [GitHub contents record][skill-tree] confirms that hash for the skill directory at the pinned commit.
The snapshot retains all 209 upstream guides and the Apache-2.0 license.
Local changes pin CLI commands and disable telemetry. Each changed file has a notice.

The current worker's 212 skill files match the agent-data snapshot bytes.
Its `SKILL.md` SHA-256 is `b454f9563ac7c7f172ae6661cb14db4c00db8112128288184e9ff0f45f9a5fd7`.
A fresh `omp read 'skill://modern-web-guidance:1-30'` process returned exit code `0` and the local runtime rules.
Bun launched that command directly, because the shell URI resolver rejects the ranged skill argument.
The worker runs Node `v24.21.0`. The approved flow uses the universal `.agents/skills` root, not a second installer.

The AGEN-102 record reports a passing SkillSpector `v2.13.0` static gate on the final snapshot.
It records zero active findings and 73 exact accepted findings, with 54 HIGH and 19 MEDIUM occurrences.
The baseline has no broad rule. The external registry holds all 54 required HIGH review keys.
Scan coverage remains partial, with 174 fully inspected components and 37 partly inspected components.
The existing triage also records an unchanged SSRF risk in the email-ownership guide.
This report does not treat that source risk as a scanner false positive.

The project chain in this worker skips real-scanner checks because it lacks the pinned scanner.
The separate AGEN-102 gate supplies the final skill scan evidence.
This worker has no configured SSH host, and its board token permits card creation only.
The separate host's Node version, skill resolution, and active Alate import remain unverified.
No direct host install, import, or provision occurred in this task.

## Package identity and prior inspection

The official [version record][npm-version] names `modern-web-guidance@1.0.0` and Apache-2.0.
The official registry publication time is `2026-11-10T03:29:19.190Z`.
At the task's `2026-11-17T11:39Z` reference time, the version exceeds the seven-day age requirement.
The package requires Node `>=22.0.0`.
The execution used Node `v24.21.0`, npm `11.19.0`, and npx `11.19.0`.

The npm [tarball][npm-tarball] passed a SHA-512 comparison before any package code ran.
Both the supplied value and the computed value are:

```text
sha512-vafIZwC8AS6QjM2yyoflZbnc7n3/TVOMLbEMRdPTwcFy0f9/Tq8s5rJQ8UIqRt2KPl9ixravyaMR4nTGuUrcmg==
```

The tarball SHA-256 is:

```text
bd7aa623ad10710a9ad6678fdbcc0b890c903c54fd6abfc126ff42de01f0e577
```

The registry names authoring commit `544c250575f7811d87fef8b1c064bc9571cbfb80` in `GoogleChrome/modern-web-guidance-src`.
The task also pins companion tag `v1.0.0` to `4dd968349e54ca45a05dd5c818fb035c9054b022` in `GoogleChrome/modern-web-guidance`.
Those commits identify different repositories. This audit uses the npm artifact as the execution identity, not the companion commit.

The review inspected the tar member list, package metadata, CLI bundle, scanner bundle, and the packaged IME guide before execution.
The package declares no npm dependencies or lifecycle scripts.
Its executable is `skills/modern-web-guidance/modern-web.mjs`.

The inspected [CLI branch][cli-source] imports `legacy-scan.mjs` only for `legacy-scan` or its `analyze` alias.
That branch calls the analyzer and writes its result.
It does not call the separate `install`, `update`, or `uninstall` branches.
The analyzer parses source rather than executing the dashboard modules.
It can call `git ls-files` within its target and otherwise walks that target.
The fresh target contains no repository and exactly the five copies.

The CLI enables telemetry by default.
The inspected [telemetry control][telemetry-source] returns before watchdog creation when `DISABLE_TELEMETRY=1`.
This execution sets that value and omits `ENABLE_FILE_LOGGING`.
The inspected scan path has no source-upload operation.
The process receives an explicit environment with no inherited credentials.
This applies the no-hardcoded-credentials rule and prevents a scanner process from receiving dashboard or agent credentials.

The npx cache lockfile records version `1.0.0`, the official tarball URL, and the same SHA-512 integrity.
The executed CLI and scanner bytes match the inspected tar members:

| Executed file under the package root | SHA-256 |
| --- | --- |
| `skills/modern-web-guidance/modern-web.mjs` | `ce15b805ce2fd1e0150e36a128955b6dcebcb1a005253d9df55c8b1b3f4e9d41` |
| `skills/modern-web-guidance/legacy-scan.mjs` | `d752acf0c5a723a8d9cdf89b3187fdb594ab17947c60770a9f871b00119903df` |

## Scratch path deviation

The first scratch directory is `/tmp/alat175-mwg-audit-bh28oegb`.
The tarball write there failed with `ENOSPC` after the in-memory integrity comparison passed.
`df -h /tmp /workspace` showed `/tmp` at 100% with zero available space.
The coordinator then authorized `/var/tmp` and explicit scratch paths for `TMPDIR`, HOME, and the npm cache.

The complete scratch directory is:

```text
/var/tmp/alat175-mwg-audit-ozmzm62_
```

The first worker kept both scratch directories. They do not exist in this worker.
An initial `npm --version` attempt failed because npm refuses the same `/dev/null` path for user and global configuration.
The final execution used two distinct empty configuration files in the scratch directory.
No scanner ran during either setup failure.

## Exact execution

Python `subprocess.run` executed this argv without a shell, from the complete scratch directory:

```text
npx --yes --ignore-scripts --registry=https://registry.npmjs.org --package=modern-web-guidance@1.0.0 -- modern-web-guidance legacy-scan ./input --json
```

The process received exactly this environment:

```text
PATH=/usr/local/bin:/usr/bin:/bin
HOME=/var/tmp/alat175-mwg-audit-ozmzm62_/home
USERPROFILE=/var/tmp/alat175-mwg-audit-ozmzm62_/home
TMPDIR=/var/tmp/alat175-mwg-audit-ozmzm62_/tmp
XDG_CACHE_HOME=/var/tmp/alat175-mwg-audit-ozmzm62_/cache
XDG_CONFIG_HOME=/var/tmp/alat175-mwg-audit-ozmzm62_/config
npm_config_cache=/var/tmp/alat175-mwg-audit-ozmzm62_/cache/npm
npm_config_userconfig=/var/tmp/alat175-mwg-audit-ozmzm62_/config/npm-user.conf
npm_config_globalconfig=/var/tmp/alat175-mwg-audit-ozmzm62_/config/npm-global.conf
npm_config_ignore_scripts=true
npm_config_audit=false
npm_config_fund=false
DISABLE_TELEMETRY=1
NO_COLOR=1
LANG=C.UTF-8
```

The process used lifecycle scripts off through both the flag and environment.
The input directory contains byte-identical copies under `input/web/`.
No source outside those five files entered the scanner target.
No install or provision subcommand ran. No new dependency entered the project.

## Complete observed result

The process returned exit code `0` with one finding, not a zero-findings result.
Its stdout contains 2,758 bytes of complete JSON.
Its stderr contains only an npm update notice from `11.19.0` to `12.2.2`.
No update command ran.

The JSON reports `activeRuleCount: 35`, `activeGuideCount: 33`, and `totalFindings: 1`.
It contains no `error` or `skippedDocsAndTestsCount` field.
The [analyzer implementation][analyzer-source] returns zero for a successful scan even when it finds occurrences.
An invalid invocation or target instead returns one.
The human-readable formatter samples occurrences, but this audit uses the complete JSON arrays.

| Input | Observed occurrences | Disposition |
| --- | ---: | --- |
| `web/index.html` | 0 | Zero findings in this scan. |
| `web/style.css` | 0 | Zero findings in this scan. |
| `web/app.js` | 1 | Fixed at lines 757-761 after the scan. |
| `web/dashboard.mjs` | 0 | Zero findings in this scan. |
| `web/diff.mjs` | 0 | Zero findings in this scan. |

### Occurrence 1

- File and line: `web/app.js:757` in the input snapshot.
- Guide and rule: `ime-safe-enter-submit`.
- Count: one.
- Disposition: fixed at `web/app.js:757-761`. No finding receives a justified exemption.
- Scanner message: `Keydown Enter listener triggers submission/action without checking event.isComposing or event.keyCode === 229 for IME composition safety`.

The exact source line is:

```js
tokenInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveKey(); } });
```

The handler acts on an input's `keydown` event and calls `saveKey()` when `ev.key` is `Enter`.
It checks neither `ev.isComposing` nor `ev.keyCode === 229`.
The next action sends the current field value to `/api/settings` and clears the field after success.
This matches the rule's keep criterion for a custom Enter action without a composition guard.
It is not a global hotkey, native form submit event, modifier-only shortcut, or editor newline handler.

The field is `type="password"` and holds a GitHub token, not normal CJK prose.
GitHub token text uses ASCII. This limits the expected effect but does not justify the missing guard.
The browser evidence below confirms the event-handler defect with synthetic events.
It does not prove that a supported browser permits an operating-system IME session in this password field.

The packaged [IME guide][ime-guide] recommends both `isComposing` and the `229` fallback for Safari event order.
The pinned companion guide bytes also match the npm guide bytes.
The fallback uses a deprecated property only to identify an IME event, not to replace `ev.key`.
The coordinator applied this minimal replacement at `web/app.js:757-761`:

```js
tokenInput.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
  ev.preventDefault();
  saveKey();
});
```

This guard leaves composition events and their default behavior alone.
It keeps ordinary Enter submission and the explicit Save key button.
It changes no layout, style, copy, static-asset route, API shape, or dependency.
The README remains accurate because no layout, style, or copy changed.

### Browser regression evidence

The browser used the actual dashboard static assets against an isolated API fixture.
It used no live backend or real credential.
The fixture counted settings POST requests. The retained files are `ime-before.json` and `ime-after.json` under the scratch root.

Before the fix, both IME cases failed their expected zero-POST result:

| Event | Expected POST count | Before POST count | After POST count | After `defaultPrevented` |
| --- | ---: | ---: | ---: | --- |
| Enter with `isComposing: true`, `keyCode: 13` | 0 | 1 | 0 | `false` |
| Enter with `isComposing: false`, `keyCode: 229` | 0 | 1 | 0 | `false` |
| Ordinary Enter with `isComposing: false`, `keyCode: 13` | 1 | 1 | 1 | `true` |
| Escape with `keyCode: 27`, named `other key` in the evidence | 0 | 0 | 0 | `false` |

Before the fix, both IME cases also set `defaultPrevented: true`.
After the fix, both sent zero POST requests and preserved the input value, focus, and default behavior.
The Save key click still sent one POST request. Empty Enter still sent one POST request.

The first after-fix attempt reused the old document and did not load the changed handler.
A fresh navigation with a query then loaded the new `app.js` and passed.
The final after-fix claims use that fresh document, not the stale attempt.

The resumed turn repeated six cases in each theme with HeadlessChrome `154.0.0.0` and agent-browser `0.41.1`.
All twelve checks passed. Ordinary Enter and Escape used trusted browser events. The Save key check used a browser click.
The two IME cases preserved the field value, focus, and default behavior in both themes.
The empty-Enter request contained only the empty token field and produced the existing remove-key status.
The browser reported no console messages or page errors.
Both themes kept the same control geometry and showed no horizontal overflow.
The current result file is `/tmp/alat-175-browser-ime-KCOHrZ/smoke-results.json`.
It records request metadata, not credentials. The owned browser session and fixture closed through their normal APIs.

The two IME checks use synthetic `KeyboardEvent` events in a browser.
They prove the handler's response to those signals, not an operating-system IME session.
The existing Node suite has no DOM runner.
No permanent Node test parses source or tests a copied handler. The retained browser proof is the behavioral regression check.

## Post-fix confirmation

The resumed turn scanned byte-identical copies of the same five files after the fix.
It verified the original tarball's SHA-512 and both inspected bundle hashes before execution.
It selected that tarball through `npx --package=<verified tarball path>` with lifecycle scripts off.
The process used a temporary home, an explicit environment without credentials, and `DISABLE_TELEMETRY=1`.
This keeps the execution on the inspected version `1.0.0` bytes.

The process returned exit code `0`, `totalFindings: 0`, `activeRuleCount: 35`, and `activeGuideCount: 33`.
All five input copies matched their source bytes.
Only the `web/app.js` hash differs from the pre-fix table below.
Its post-fix SHA-256 is `6161b3caef81aa9f9136995593b4c96b016cb80b65d01a649b6b49a077e871fa`.

The context-mode sandbox removed this confirmation run's temporary files after the command returned.
The command result retains the exit code, rule counts, and all five input hashes.
The confirmation scan has the same coverage limits as the original scan.

## Source hash evidence

The source and staged SHA-256 values match for every input.
`source-hashes.json` records both values and `byteIdentical: true` for each file.
These hashes identify the pre-edit scan input, not any later dashboard fix.

| Input | Bytes | Source and staged SHA-256 |
| --- | ---: | --- |
| `web/index.html` | 2609 | `c53b6ef32671308ecc6277c35a46d7f6526932afc9fefec0235578c1b5795185` |
| `web/style.css` | 23045 | `86186704c8d1e2556cbb304f1261f912a0b264abf135bc1c2dd4b85a40f034ca` |
| `web/app.js` | 62293 | `0092270cfa5ce4380b8c5a27d1ad3194e98f4a30200feaf395fd30c868d7a7bd` |
| `web/dashboard.mjs` | 72649 | `e4f33321e582e539167a30dd6574ccc27b556480616b1971d95529ab63fb32d0` |
| `web/diff.mjs` | 1465 | `1b1853457a1e903c3256505defe26dd78cd64e7e3013ece9a9be0d8b915a91df` |

## Raw evidence and limits

The first worker kept these files under `/var/tmp/alat175-mwg-audit-ozmzm62_`:

- `legacy-scan.json`: complete machine-readable findings and verifier rubric.
- `legacy-scan.stderr.txt`: complete stderr.
- `exit.json`: exit code and output sizes.
- `source-hashes.json`: source and copy hashes.
- `input-shape.json`: byte sizes, line counts, and maximum line lengths.
- `invocation.json`: argv, working directory, environment, and tool versions.
- `artifact-inspection.json`: expected integrity, actual integrity, and bundle hashes.
- `executed-package-hashes.json`: executed bundle hashes and equality results.
- `guide-source.json`: pinned guide URL, HTTP status, hash, and equality with the npm guide.
- `npm-metadata.json`, `publication.json`, and `tar-members.json`: package identity evidence.
- `modern-web-guidance-1.0.0.tgz`: the complete verified artifact.
- `cache/npm/_npx/04707d615c601c1e/package-lock.json`: npx execution package record.
- `input/web/`: all five retained source copies.
- `ime-before.json`: failing synthetic IME cases before the fix and ordinary-key controls.
- `ime-after.json`: passing synthetic IME cases after fresh navigation, input and focus checks, and button and empty-Enter POST counts.

The raw JSON SHA-256 is `797bb6af99f5308f3d8449f7ccb8114f979590cc4fa0f9166dba4dceb0a0f01a`.

The scanner says its 35 deterministic rules cover about 20% of the guidance corpus.
Zero findings do not establish full web compatibility, accessibility, security, performance, or design compliance.
The [file filters][filter-source] accept all five input extensions.
Each input is below the 1,000,000-byte source limit and 1,200-character line threshold.
Their paths contain no excluded directory, test marker, or vendor filename.
The default 25,000-file cap cannot truncate a target with five files.
The JSON does not include a per-file visit trace, so the zero counts mean no occurrence for each eligible input in this run.

The scan used no guide filter and no project Baseline override.
The design and nearby architecture docs name no browser version floor or Baseline year.
That remains an ambiguity, not permission to choose a newer browser requirement.
The deterministic analyzer path does not read `.mwgrc` to select a browser Baseline.
A future recommendation that depends on a browser floor needs that decision first.

The scratch HOME and explicit environment prevent accidental access through inherited credentials or user npm configuration.
They do not provide an operating-system security boundary.
This audit inspected the executed package path before use and disabled its telemetry.
It did not capture network packets or prove containment against arbitrary malicious package code.

The requested one-off scan is an audit deliverable, not a test gate.
The coordinator then fixed its sole occurrence and retained the browser regression evidence above.
The original report edit ran no project checks or install or provision commands.
The later confirmation scan has its own result above. The pre-fix hashes still identify the original audit input.

[npm-version]: https://registry.npmjs.org/modern-web-guidance/1.0.0
[npm-tarball]: https://registry.npmjs.org/modern-web-guidance/-/modern-web-guidance-1.0.0.tgz
[cli-source]: https://github.com/GoogleChrome/modern-web-guidance-src/blob/544c250575f7811d87fef8b1c064bc9571cbfb80/src/cli/modern-web.ts
[analyzer-source]: https://github.com/GoogleChrome/modern-web-guidance-src/blob/544c250575f7811d87fef8b1c064bc9571cbfb80/src/analyzing/cli.ts
[telemetry-source]: https://github.com/GoogleChrome/modern-web-guidance-src/blob/544c250575f7811d87fef8b1c064bc9571cbfb80/src/cli/telemetry/clearcut-logger.ts
[filter-source]: https://github.com/GoogleChrome/modern-web-guidance-src/blob/544c250575f7811d87fef8b1c064bc9571cbfb80/src/analyzing/scanners/file-filter.ts
[ime-guide]: https://github.com/GoogleChrome/modern-web-guidance/blob/4dd968349e54ca45a05dd5c818fb035c9054b022/skills/modern-web-guidance/guides/forms/ime-safe-enter-submit.md
[skill-tree]: https://api.github.com/repos/GoogleChrome/modern-web-guidance/contents/skills?ref=4dd968349e54ca45a05dd5c818fb035c9054b022
