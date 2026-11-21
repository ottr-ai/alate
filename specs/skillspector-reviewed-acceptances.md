# SkillSpector: a skill baseline cannot accept its own HIGH or CRITICAL findings

## Threat

`install-user.mjs` scans each skill folder with `--use-shipped-baseline`. The scanner then
applies the `.skillspector-baseline.yaml` inside the scanned folder. That file comes from the
same source as the skill: a third-party author ships it, and `sync-user` captures it from the
machine with the rest of the folder. SkillSpector v2.13.0 puts no severity cap on a baseline.
A glob rule `rules: [{id: "*", reason: x}]` suppresses every finding.

Proof (2026-11-15, pinned build v2.13.0): a test skill with three HIGH findings (SC2 `curl | sh`,
PE3 `~/.ssh/id_rsa` read, TM2) exits 1 without a baseline. With the glob baseline above, the same
`scan --no-llm --fail-on-findings --use-shipped-baseline` exits 0 and reports no issues.
`--show-suppressed --format json` lists the five hidden findings.

## Decision

User decision 2026-11-15 on ALAT-142: a cap plus a reviewed allowlist, and the data repo triage
lands before the cap.

- A shipped baseline can still accept LOW and MEDIUM findings.
- A suppressed finding of any other severity (HIGH, CRITICAL, or a severity the gate does not
  know) passes only when a review entry outside the skill folders covers it.

## Review files

Two files hold review entries. Both are optional. A missing file holds no entries.

- `<data repo>/skillspector-reviews.json`: entries for data repo skills. The file is at the data
  repo root, outside `user/`, so `sync-user` never captures it and `install-user` never installs
  it into a home. A skill author cannot ship it.
- `<alate checkout>/shipped/skillspector-reviews.json`: entries for the skills that alate vendors
  under `shipped/ottr/`. Their baselines are alate's own scan records (`lib/shipped.mjs`), and the
  entries change only through an alate commit.

The gate uses the union of both files. Each entry applies to the skill item key that it names, in
any mode and from either file.

Format (version 1):

```json
{
  "version": 1,
  "accepted": [
    {
      "skill": "user/agents/skills/impeccable",
      "rule": "AS1",
      "file": "reference/hooks.md",
      "key": "sha256:<64 lowercase hex>",
      "reason": "Hook documentation names agent config directories; the skill writes none."
    }
  ]
}
```

- `skill`: the skill item key, the same key that the provision results use
  (`user/agents/skills/<name>`, `user/omp/agent/skills/<name>`,
  `user/omp/agent/managed-skills/<name>`).
- `rule`: the finding's rule id (`id` in the scanner JSON).
- `file`: the finding's file, relative to the skill folder (`location.file`).
- `key`: the finding key (next section).
- `reason`: a non-empty review note.

Validation. A file that breaks one of these rules refuses the whole run before any write. The
error names the file path and the first broken rule.

- The file is UTF-8 JSON. The top level is an object with `version` equal to `1` and an
  `accepted` array. No other top-level keys.
- Each entry is an object with exactly the five keys above. Each value is a string.
- `skill` starts with `user/`. It has no empty segment, no `.` or `..` segment, and no backslash.
- `rule` and `file` are not empty. `reason` is not empty after trim.
- `key` matches `^sha256:[0-9a-f]{64}$`.
- One file holds a given (`skill`, `key`) pair only once.

## Finding key

The key binds the rule, the severity, the file, the matched text, and the sha256 of the whole
bytes of the flagged file in the scanned skill folder. A change to any byte of that file makes a
new key, and the finding needs a new review.

The file hash is necessary. The scanner computes `match_fingerprint` from the matched phrase
only, and some rules give a fixed `explanation`. Without the file hash, an author can rewrite a
quoted example (for example the break-ui phrase "ignore previous instructions", reviewed as test
data) as a direct instruction, regenerate the baseline, and keep the old review. Line numbers are
not in the key, because the file hash already covers them.

When the flagged file is not a readable file inside the scanned skill folder (no `file`, a path
that leaves the folder, a missing file), the finding has no key. No entry can cover it, so the
skill is rejected.

JavaScript (the gate; `dir` is the scanned skill folder):

```js
const content = createHash('sha256').update(readFileSync(resolve(dir, f.location.file))).digest('hex');
const key = `sha256:${createHash('sha256').update(JSON.stringify([
  f.id ?? null, f.severity ?? null, f.location.file, f.match_fingerprint ?? null, f.explanation ?? null, content,
])).digest('hex')}`;
```

Python (for tools that write review files; the same bytes as the gate):

```python
content = hashlib.sha256(open(os.path.join(skill_dir, f['location']['file']), 'rb').read()).hexdigest()
key = 'sha256:' + hashlib.sha256(json.dumps(
    [f.get('id'), f.get('severity'), f['location']['file'], f.get('match_fingerprint'), f.get('explanation'), content],
    ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
```

`explanation` is part of the key because some findings carry no `match_fingerprint` (LP1 emits
one finding per undeclared capability, and only `explanation` tells them apart).

Every entry written with the version of the key before the file hash (no `content` element)
stops matching, so each review file needs its keys computed again. The bytes did not change, so
the reviews stay valid: compute the new key of each reviewed finding on the same bytes.

## Scan contract

- Every scan runs `skillspector scan <dir> --no-llm --fail-on-findings --use-shipped-baseline
  --show-suppressed --format json`. The JSON report goes to stdout. Diagnostics go to stderr.
- Exit 0 or 1 with stdout that parses as a JSON object, with `issues` and `suppressed` arrays
  whose elements are objects, and a `suppressed_count` equal to the `suppressed` length: the
  gate judges the report. Any other result (another exit code, a signal, stdout that is not such
  an object) is a `scan error` rejection of that skill, as before.
- A judged report whose `analysis_completeness.ledger_exceptions` holds an `output_limit`
  entry with `phase: "finding_output"` is a `scan error` rejection, and the gate never
  caches it. The pinned build stops the findings output at `MAX_FINDING_OUTPUT_RECORDS`
  (10,000 records) and drops later findings from both lists. Proof (2026-11-15, v2.13.0):
  a skill with 12,000 bare package names in `a/requirements.txt` (SC1, LOW) and
  `curl … | sh` in `scripts/setup.sh` gets a report with 9,998 SC1 findings and no SC2
  finding (HIGH); the ledger entry for `a/requirements.txt` carries
  `phase: "finding_output"`. A baseline that accepts the LOW flood needs no review, so
  without this rule the HIGH finding passes unseen.
- An `output_limit` entry in any other phase (v2.13.0: `phase: "static"`, the bounded OSV
  dependency lookups and manifest parses; proof 2026-11-21, agent-data `shorts`) rejects
  the skill with rule `incomplete dependency coverage` at that entry's `path`, never
  cached: the finding lists are complete, but advisory coverage for the named files is
  missing. It applies only when no finding and no unreviewed acceptance already rejects.
  Decision and risks: `specs/scan-budget-and-ae1-determinism.md`.
- A judged report with `runtime_limit` ledger entries is a degraded scan (a wall-clock
  budget busted under concurrent load; the AE1 finding set varies with it). The gate
  re-scans such skills one at a time after the concurrent pass and adopts the re-run
  verdict; only the post-re-run verdict can record a pass.
- Other partial-coverage reasons (`static_parse_limit`, `reference_missing`) occur in 64
  of the 85 skills of agent-data and drop no finding, so they do not reject. On
  2026-11-15 no skill of agent-data or of `shipped/` had an `output_limit` exception.
- Verdict for one skill:
  - One or more `issues`: rejected. The status line carries the first issue's rule and
    `file:line`.
  - No issues, but one or more suppressed findings that need review and have no matching entry:
    rejected with rule `unreviewed baseline acceptance` and the first such finding's
    `file:line`.
  - Otherwise: pass.
- A suppressed finding needs review when its `severity` is not `LOW` or `MEDIUM`.
- An entry matches a finding when its `skill` equals the skill's item key, and `rule`, `file`,
  and `key` equal the finding's values.
- The log block `--- SkillSpector report: <dir>` and the rejection report hold a text rendering
  of the JSON, never the raw JSON. Each issue and each unreviewed acceptance is two lines in the
  scanner's terminal shape (`  HIGH: SC2 - <pattern>` and `    Location: <file>:<line>`), so
  `describeScanReport` keeps working. An unreviewed acceptance starts with
  `  Unreviewed baseline acceptance:` and adds a third line with the review entry to add, with the
  reason left for the reviewer to write:
  `    Review entry: {"skill":"…","rule":"…","file":"…","key":"sha256:…","reason":"<review note>"}`.
  Scanner stderr follows the rendering.

## Verdict cache

A pass now depends on the review entries too. The cache key gets the format token
`skill-pass-fmt-3` (entries that an older alate wrote miss once and rescan) and binds the full
scan argument list plus the sorted (`rule`, `file`, `key`) triples of the entries for that skill
item. A new, removed, or changed entry for one skill rescans only that skill. A changed `reason`
does not rescan.

## Rollout

The data repo triage lands first: a report sorts each HIGH finding that a baseline accepts into
review entry, fix, or drop, and the user approves it. On 2026-11-15 (agent-data `d293423`) 26
of 72 baselined skills accepted 118 HIGH findings and no CRITICAL finding. The alate change merges
only after the data repo carries its `skillspector-reviews.json`. Otherwise those 26 skills drop
out of the next install.

The file hash joined the key after the first triage (ALAT-142 review, 2026-11-15). The data repo
file from that triage (agent-data `e8987c6`, 88 entries) needs its keys computed again on the
same bytes before the alate change merges.

## Acceptance checks

- A skill whose baseline suppresses a HIGH finding with no entry is rejected with rule
  `unreviewed baseline acceptance`. The output names the skill folder and prints the review entry
  to add. The other skills install.
- The same skill passes with a matching entry in `skillspector-reviews.json`.
- An entry for another skill, or with another key, rule, or file, does not cover the finding.
- A baseline that suppresses only LOW or MEDIUM findings passes with no entry.
- An invalid review file refuses the run before any write, and names the file.
- A cached pass rescans after its skill's entries change.
- The real pinned scanner rejects the glob-baseline test skill, and passes it with entries.
- The real pinned scanner rejects break-ui after its quoted example becomes a direct instruction
  and its baseline is regenerated, although the old entry's rule, severity, file, match
  fingerprint, and explanation stay equal. Only a new review entry lets it install.
- The real pinned scanner rejects the flood skill (12,000 LOW SC1 findings before a `curl … | sh`
  script, all accepted by a glob baseline) with `scan error`, because the report records an
  `output_limit` exception.

## Non-goals

- No change to the scanner, its pin, or the baseline format.
- No severity cap in the data repo's pre-push gate (`.githooks/skillspector-scan.sh`). The
  install gate is the enforcement point.
- No review entries for MEDIUM or LOW findings.

## Alternatives considered

- Refuse every baseline that accepts a HIGH finding, with no allowlist: rejected, because it
  drops 26 skills until each finding is fixed.
- Refuse glob rules only: rejected. One data repo baseline uses globs, and an author can write
  exact fingerprints for their own findings.
- Key entries on the baseline's v2 fingerprint: rejected. The scanner JSON does not carry it.
- Bind a window of lines around the match (`code_snippet`) instead of the whole file: rejected.
  The window size is the scanner's choice, some findings have no snippet (LP1), and a change just
  outside the window (for example a removed "attack example:" heading) can change what the
  matched text means.

## Risks

- A data repo commit can add an entry, the same as it can add a skill. Review of the data repo
  stays the control for that file.
- An entry covers each finding with the same rule, severity, matched text, and explanation in the
  same unchanged file. A repeated phrase in a reviewed file stays covered.
- Any edit to a file with an accepted finding above MEDIUM drops the skill until a person reviews
  the finding again and updates the entry key. This is the cost of binding the context.
