# SkillSpector scan budget and AE1 determinism: alate-side decisions (AGEN-120 owner task)

Owner decisions for two scanner behaviors that make a legitimately vendored skill
unprovisionable (Finding 1) or provision-flaky (Finding 2) with the pinned SkillSpector
v2.13.0 build. The alate output_limit guard stays. No scanner pin change happens here;
every alternative that needs one is rejected below with its reason.

## Background

`install-user.mjs` scans every skill snapshot with the pinned scanner (`SKILLSPECTOR_REF`,
v2.13.0), concurrently, at most `min(8, availableParallelism())` scans at a time. A judged
report is a JSON object with `issues`, `suppressed`, and a matching `suppressed_count`.
`analysis_completeness.ledger_exceptions` is the scanner's completeness ledger: one public
entry per omitted or bounded piece of inspection work, with required keys `outcome`,
`phase`, `reason_code`, `message`, `path`, `start_line`, `end_line`, and optional keys
`analyzers` (analyzer id list), `error_class`, `fatal`, `scope`
(`skillspector/inspection_ledger.py`, class `InspectionLedgerException`).

Evidence, 2026-11-21, pinned v2.13.0 at `~/.cache/skillspector-venv`, agent-data `main`:

- `skillspector scan shorts` reproduces 4 of 4 runs: one `output_limit` ledger entry with
  `phase: "static"`, `path: "requirements.txt"`,
  `analyzers: ["static_patterns_supply_chain_dependencies_output_limit"]`, `fatal: false`.
- Real flood fixture (12,000 LOW SC1 names before a HIGH SC2 script, glob baseline): the
  report holds BOTH a `phase: "finding_output"` entry for `a/requirements.txt` (the
  findings-list truncation; only emitter is `finalize_inspection_ledger.py`,
  `MAX_FINDING_OUTPUT_RECORDS`, no `analyzers` key) AND `phase: "static"` entries for the
  bounded dependency lookups.
- Three cutter-skill scans in parallel produce `runtime_limit` ledger entries and extra
  HIGH AE1 instances on `SKILL.md` (for example ffmpeg-skill gained two at lines 34 and 50
  versus the sequential run of identical bytes). The dependency-analysis phase shares a
  30 s wall-clock budget (`MAX_DEPENDENCY_ANALYSIS_SECONDS`, `osv_client.OsvQueryBudget.
  note_runtime_limit`); under OSV latency the budget busts, coverage goes partial, and the
  AE1 finding set changes. AE1 severity is HIGH, so an instance outside the reviewed key
  set (`skillspector-reviews.json` keys bind file bytes + matched evidence) rejects the
  skill. A live provision scans many skills 8-way concurrently, so this is the normal
  condition, not an edge case.

## Finding 1: the OSV query-batch budget — decision

`parseScanReport` keys `truncated` on `reason_code === 'output_limit'` alone, so the
lookup-budget entry rejects shorts as `scan error`. The rejection is factually right (the
four PyPI pins were never checked against OSV, so their advisory coverage is genuinely
missing), but the reason is wrong: the finding lists of that report are complete; nothing
was truncated.

Decision: keep the rejection, split the class by the ledger `phase`, which the pinned
build sets truthfully:

- An `output_limit` entry with `phase: "finding_output"` means the per-scan findings cap
  fired: findings past the cap are missing from both lists. This stays the existing
  `scan error` rejection, uncached, with the existing message.
- Any other `output_limit` entry (today: `phase: "static"`, the bounded dependency lookups
  and manifest parses) becomes a per-item rejection with rule
  `incomplete dependency coverage`, `at` set to the first such entry's `path`, never
  cached, with a report head naming the starved lookups. The skill still never installs.
  Precedence is unchanged: real findings reject first (`issues`, then unreviewed baseline
  acceptances), and the coverage rule applies when nothing else rejects.
- An unknown future `phase` keeps the strict class (fail-closed): only the exact phase
  `static` gets the softer rule label. A report that carries both classes rejects as
  `scan error` — the `finding_output` entry wins.

Rationale: the guard stays; the operator sees the true cause (advisory coverage for named
files is missing) instead of a scanner-malfunction message, and the rule names the file to
fix content-side.

### Alternatives considered

- Raise or split `MAX_OSV_QUERY_BATCHES` upstream and bump the pin: rejected. No released
  build carries a budget change; the newest release inside the 7-day age gate is v2.13.4
  (2026-11-04) and its changelog has no OSV budget change. A pin bump also invalidates
  every v2 baseline fingerprint (they bind `scanner_version`), which forces a cross-project
  baseline regeneration in agent-data right after AGEN-120 regenerated them for v2.13.0.
- Per-file budget fairness upstream: rejected for the same pin-bump and age-gate reasons.
- Accept lookup-limited scans with a recorded degradation: rejected. The unqueried
  packages' advisories are unknown; accepting would vouch for coverage the scan does not
  have. The guard is intentional and stays.
- Raise the budget at invocation time (flag or env): rejected. No such knob exists in
  v2.13.0's `OsvQueryBudget.create`, and alate would silently re-balance a scanner-internal
  cost decision per invocation.

### Risks

- A future scanner version renames `phase` or moves the findings cap to another phase: a
  true truncation entry could then land in the softer class. It still rejects the skill and
  stays uncached; only the label softens. The pin bump path re-checks this spec.
- The coverage rule fires only when nothing else rejects, so a lookup-limited scan that
  also carries a real finding rejects under the finding's rule. The coverage fact then
  appears only in the report text, which the rejection carries.

## Finding 2: load-dependent AE1 verdicts — decision

A judged scan whose ledger holds `reason_code: "runtime_limit"` entries is a degraded
scan: its verdict depends on machine load, not on the skill bytes. Decision: `runScan`
re-runs every degraded skill sequentially after the concurrent pass and adopts the re-run
verdict:

- The first pass runs the pool as today. A scan that resolves judged with runtime_limit
  entries records no verdict; `runScan` logs the count.
- After the concurrent pass, the degraded skills re-scan one at a time (fresh staged copy
  each, same arguments, bounded to one re-run per skill per install). The re-run verdict
  replaces the first-pass verdict through the same path (findings, unreviewed acceptances,
  pass, scan error). If the re-run is itself runtime-limit-limited, its verdict still
  stands; sequential conditions are the deterministic reference (evidence: sequential runs
  are stable, no runtime_limit entries).
- Only the post-re-run verdict can record a pass. Two installs of the same bytes now
  produce the same verdicts regardless of load: concurrent scans without runtime_limit
  entries already agree with the sequential verdict, and degraded ones re-run to it.

`SCAN_CACHE_FORMAT` bumps `skill-pass-fmt-3` → `skill-pass-fmt-4`: a pass an older alate
recorded may come from a load-degraded scan, so every cached verdict misses once and
rescans under the new semantics.

### Alternatives considered

- Scanner-side determinism for ledger findings (severity cap, or exclude coverage findings
  from the varying set): rejected. The fix upstream knows about (#828, sc8 budget counting
  only its own CPU time) sits in the changelog's unreleased section; no released build
  carries it, and a pin bump invalidates every baseline fingerprint (same costs as
  Finding 1).
- Ignore uncovered AE1 instances when runtime_limit entries exist: rejected. It would let a
  genuinely unreviewed HIGH finding pass whenever the machine is loaded. That weakens the
  gate.
- Document the variance as acceptable: rejected. A provision gate must not reject the same
  bytes on one run and accept them on the next.

### Risks

- A scan could change findings under load with no runtime_limit entry. Not observed: the
  concurrent AE1 deltas co-occurred with runtime_limit storms. If one appears, the trigger
  set grows by ledger reason code in this spec.
- OSV.dev unavailability flips the dependency lookups to the scanner's fallback static
  list with no ledger entry in v2.13.0, so a skill's verdict can differ between installs
  with no alate-visible signal. Observed 2026-11-21: shorts passed one install while OSV
  rate-limited this machine and rejected as `incomplete dependency coverage` the next
  minute. The re-run mechanism cannot see this state; fixing it needs a scanner-side
  ledger entry for the fallback (pin-bump path, out of scope here).
- A skill whose dependency analysis busts the 30 s budget even sequentially pays one extra
  scan per cold-cache install. Bounded and deterministic; the deploy log names it.

## Contract changes in other specs

- `specs/skillspector-reviewed-acceptances.md`, Scan contract: the blanket
  `output_limit → scan error` clause splits into the two classes above, and gains the
  runtime_limit re-run clause.
- `specs/provision-item-by-item.md`, install-user gate order step 6: gains the
  `incomplete dependency coverage` rejection class; it is a scan-gate rejection, so the
  scan-rejected retention rule (ALAT-178: the installed record-matching copy stays whole)
  applies to it unchanged.

## Acceptance checks

- A judged report with a `phase: "static"` `output_limit` entry rejects its skill with
  rule `incomplete dependency coverage` at the entry's `path`, prints the cause, never
  caches, and leaves the copy-retention behavior unchanged (test fails before the fix:
  today it rejects as `scan error`).
- A judged report with a `phase: "finding_output"` entry still rejects as `scan error`
  with the existing message, including the mixed report shape (pinning test, passes
  before and after).
- Benign partial-coverage reasons (`static_parse_limit`, `reference_missing`) still pass.
- A first-pass report with a `runtime_limit` entry and an extra unreviewed HIGH finding,
  followed by a clean re-scan, installs the skill, scans it exactly twice, and the re-scan
  starts after the first scan ends (test fails before the fix: today the skill rejects).
- A re-scan that is still runtime-limit-limited adopts the re-run verdict and never runs a
  third scan.
- A cache recorded before this change misses once and rescans (`skill-pass-fmt-4`).
- Real-scanner acceptance (reported, not unit-tested): `install-user.mjs` against the
  agent-data snapshot rejects shorts with `incomplete dependency coverage` naming
  `requirements.txt`; a 3-skill concurrent run over the cutter skills yields the same
  verdicts twice in a row.

## Non-goals

- No scanner pin change, no new scanner install, no baseline regeneration.
- No agent-data content changes (AGEN-120 owns those).
- No change to the benign partial-coverage reason set or to `describeScanReport`.
