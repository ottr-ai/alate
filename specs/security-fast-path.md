# Security fast path through the 7-day update gate

Source: research report of card ALAT-20 (tiers A and B). Tier C (KEV auto-apply) is a non-goal.

## Behavior

The fast path applies only to `github-release` check rows (`runReleaseCheck` in `lib/updates.mjs`).

1. `runReleaseCheck` keeps the release `body` of each candidate.
2. For each candidate that is newer than `current` and younger than 7 days, the checker collects
   these signals:
   - CVE ids in the body, `/CVE-\d{4}-\d{4,}/gi` (upper-cased, de-duplicated, first 20 only).
   - GHSA ids in the body, `/GHSA(-[23456789cfghjmpqrvwx]{4}){3}/gi` (normalized to
     `GHSA-xxxx-xxxx-xxxx`, de-duplicated, first 20 only).
   - A security-release line: a body line that starts with `security fix`, `security fixes`,
     `security release(s)` or `security update(s)` (case-insensitive, whole word). Leading
     spaces, tabs, and markdown marks `# > * _ -` are allowed before it, so `## Security fixes`
     and `* Security release` match. Text inside a sentence (`contains no security fix`) and
     longer words (`Security fixture`) do not.
   - Published repo advisories: `GET <ghBase>/repos/<owner>/<repo>/security-advisories?state=published&per_page=100`
     with the GitHub token, one GET per check row (only when a candidate is young). An advisory
     counts when a `vulnerabilities[].patched_versions` version token equals the candidate
     version (`cmpVer`). Its `ghsa_id` joins the GHSA ids. A non-array answer, an HTTP error, or a
     network error counts as "no advisory".
3. No signal: no security data, the normal 7-day gate applies.
4. Tier A: at least one signal. The release author controls every one of these signals (the repo
   advisories too), so they only shorten the gate to 2 days. They never lift it.
5. Tier B: an OSV record (`GET <osvBase>/vulns/<CVE id>`) exists for a cited id, and the record
   text references the release repo (`github.com/<owner>/<repo>`, case-insensitive, the next
   character is not `[\w.-]`). The checker lifts the gate: a tier B release is a target at once.
   The repo reference blocks a compromised upstream that cites an old, unrelated CVE.
6. The OSV lookup is memoized per `checkUpdates` run (one GET per CVE id). An OSV 404, an HTTP
   error, or a network error counts as "not corroborated" (fail closed: the gate stays).
7. The row of the picked release (`target ?? latest`) gets
   `security: { cves: [...], ghsas: [...], sources: ['osv:<id>', ...], tier: 'A' | 'B' }` when
   that release has security data. `cves` holds only CVE ids, `ghsas` only GHSA ids (both can be
   empty). Only `osv:` sources give tier B. Other rows have no `security` key.
8. `qualifiesAt = publishedAt + gate`, where the gate is 7 days, 2 days (tier A), or 0 (tier B).
9. `checkUpdates(db, { securityFastPath: false })` turns the fast path off: no body scan, no OSV
   call, no advisory call, no `security` key. The default is on. The server reads `securityFastPath` from
   `server-config.json` (default `true`) and passes it on. No route changes. A row carried forward
   after a failed check also follows this switch: it loses `security`, and its target becomes
   `null` unless the release is 7 days old.
10. `osvBase()` reads `ALATE_TEST_OSV_BASE`, else `https://api.osv.dev/v1` (test seam like `ghBase()`).

## Dashboard

The updates table status text marks a row that has `security`:
tier B "security fix, OSV confirmed", tier A "security fix, upstream claim".
The lede of the updates view names the shorter gates.

## Acceptance

- A 1-day-old release whose body cites a CVE with a repo-referencing OSV record is the target,
  `qualifiesAt === publishedAt`, `security.tier === 'B'`.
- A 2-day-old release with a CVE and an OSV 404 gets `security.tier === 'A'`, is the target, and
  `qualifiesAt` is +2 days.
- A 3-day-old tier A release is the target. A 1-day-old one is not.
- A 3-day-old release with a `## Security release` line gets tier A and is the target. A 1-day-old
  one is not the target.
- A body that cites only a GHSA id gives tier A, with the id in `ghsas` and `cves` empty.
- A published repo advisory that names the candidate in `patched_versions` gives tier A.
- Plain notes, `contains no security fix`, and `Security fixture` give no `security` key.
- An OSV record that does not reference the repo (or references `<repo>-other`) gives tier A.
- `securityFastPath: false` gives the plain 7-day behavior and makes no OSV request.

## Non-goals

- Tier C (CISA KEV) and any auto-apply.
- CISA alert and CERT-EU feeds (no stable machine feed tied to a repo).
- Other check kinds (`npm`, `node-dist`, `github-path`, `chrome-for-testing`, skill releases).
- A `php-dist` check kind.
- A DB cache of OSV verdicts.
