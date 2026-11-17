# Modern Web Guidance skill and dashboard audit

## Behavior

Use the published `modern-web-guidance` skill at version `1.0.0` under Apache-2.0.
The published repository pin is `4dd968349e54ca45a05dd5c818fb035c9054b022`.
The source URL is <https://github.com/GoogleChrome/modern-web-guidance/tree/4dd968349e54ca45a05dd5c818fb035c9054b022/skills/modern-web-guidance>.
The npm CLI pin is `modern-web-guidance@1.0.0`.
The registry published this version on 2026-11-10, more than seven days before this task.

Install the skill through the `add-third-party-skill` board flow.
That flow stores the skill and its lock entry in agent-data, not alate.
Agent-data card `AGEN-102` owns those edits and the SkillSpector review.
Alate then imports and provisions the snapshot through its existing path after integration.
The install must make the skill available to omp and the intended Ottr workers.
The lock must name the immutable source, version, and content hash.
Any skill command that uses the CLI must use the same version pin.
Set `DISABLE_TELEMETRY=1` in each skill command example.
The upstream CLI sends raw search queries by default, so private project details must not enter that path.
The lock uses the commit-pinned `sourceUrl` and the published tag `v1.0.0` in `ref`.
For a GitHub source, record the skill directory's Git tree hash, not the `SKILL.md` SHA-256.

Run the pinned CLI's `legacy-scan` before the fix on these files:

- `web/index.html`
- `web/style.css`
- `web/app.js`
- `web/dashboard.mjs`
- `web/diff.mjs`

Save the report at `docs/research/mwg-legacy-scan.md`.
Give every finding a fixed or justified result.
Keep the Galley Proof layout, colors, typography, focus behavior, and reduced-motion behavior.
Fix true positives only when the native API keeps those rules and current browser behavior.
A pattern with no safe replacement needs a concrete reason in the report.
After the fix, use the same pinned artifact for one confirmation scan of the five files.

The GitHub token field must not save a key when Enter confirms IME composition.
Ignore Enter when `KeyboardEvent.isComposing` is true or `keyCode` is `229`.
Keep ordinary Enter and the Save key button unchanged.
Check both composition signals and the ordinary Enter path in a real browser.

## Assumptions

- The published companion artifact is the install source, not the authoring repository.
- The approved board flow determines the skill snapshot path and lock format.
- A universal skill path is acceptable when omp lists the skill through the approved flow.
- This card must not edit another project's checkout or install into a live home.
- The agent-data card owns the host and worker delivery prerequisite.
- A scanner match is a review prompt, not proof of a defect.
- No dashboard change is necessary when every finding has a valid reason.

## Boundaries and errors

Review third-party executable code before use.
Run the audit with a temporary home and cache, without credentials.
Use `npx` with the exact CLI version and lifecycle scripts off.
If the CLI accepts only a directory, scan byte-identical copies of only the five files.
Record the package integrity, source hashes, command, and raw result in the report.
A scan error is not a clean audit result.
Do not suppress SkillSpector findings without the required baseline reason and external review entry.
Do not store credentials in the report, skill, lock, or dashboard code.

## Acceptance checks

1. Omp lists the skill after the agent-data import and provision.
   The lock names version `1.0.0`, the immutable published source, and its content hash.
   Record the host and worker Node versions and the pinned SkillSpector result.
2. The report exists and accounts for every scan finding across all five files.
3. Any dashboard fixes pass `node server.test.mjs` and `npx tsc --noEmit`.
   Verify changed browser behavior in the rendered dashboard.
   Save screenshots for any visible UI change and run the required blind visual check.
4. `npm ls --depth=0` has no new dependency.
   `package.json` and `package-lock.json` stay unchanged.
   The full verified chain from `AGENTS.md` passes after `npm ci`.
5. Check the README against the result.
   Update it only when the task makes its existing text stale.

## Non-goals

- No npm dependency, scanner service, scheduled scan, or CI gate.
- No dashboard redesign or new browser support policy.
- No authoring tools, guide graders, or extra MWG skills.
- No mutation gate in this work turn.
- No merge, push, tag, release, or direct live provision from this card.
