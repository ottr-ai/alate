# Security fast path through the 7-day update gate

Source: research report of card ALAT-20 (tiers A and B). Tier C (KEV auto-apply) is a non-goal.

## Behavior

The fast path applies to `github-release` check rows (`runReleaseCheck` in `lib/updates.mjs`) and
to `node-dist` check rows (`runNodeCheck`, see "node-dist" below).

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
5. Tier B: an OSV record (`GET <osvBase>/vulns/<CVE id>`) for a cited CVE id corroborates the
   candidate only when all of these hold:
   - The record has no `withdrawn` field.
   - A repo URL matches when it parses with `new URL`, has the host `github.com` exactly, and its
     first two path segments equal `<owner>/<repo>` (case-insensitive, a trailing `.git` stripped).
   - Bound entries: the `affected[]` entries that have a range whose `repo` URL matches. When no
     entry has one, and the record has exactly one `affected[]` entry, and a `references[].url`
     matches, that one entry is bound, unless one of its ranges has a `repo` (that repo is another
     repository: explicit package identity wins). Else no entry is bound (ambiguous packages fail closed).
   - A version `v` is affected by a bound entry when its `versions[]` list names `v` (equal by
     SemVer 2.0, build metadata ignored), or when one `SEMVER`/`ECOSYSTEM` range contains `v`.
     A range contains `v` by the OSV rule: walk its events in version order; `introduced <= v`
     sets affected, `fixed <= v` clears it, `last_affected < v` clears it. Order and equality
     follow SemVer 2.0, with prereleases (`2.0.0-rc.1 < 2.0.0`). `GIT` ranges (commit hashes) do
     not count.
   - Every bound `SEMVER`/`ECOSYSTEM` range must have a supported comparator: `SEMVER` ranges,
     and `ECOSYSTEM` ranges of the SemVer ecosystems `npm` and `crates.io`. Its event versions
     (`introduced` may be `0`), the entry's `versions[]`, `current`, and the candidate must all
     be SemVer 2.0. Any other ecosystem (PyPI, Debian, ...), a missing ecosystem, or any other
     version form fails closed to tier A. Plain dotted numbers are never compared across
     ecosystems.
   - The bound entries have a `SEMVER`/`ECOSYSTEM` range, `current` is known and affected, and
     the candidate is affected by no bound entry. So the candidate contains every fix, and the
     installed version does not.
   The checker lifts the gate: a tier B release is a target at once. These checks block a
   compromised upstream that cites an old CVE, a CVE of another project or package, a fix in a
   later interval, a look-alike host, or a withdrawn advisory.
6. Tier B from an alert: a CISA alert or a CERT-EU advisory corroborates a cited CVE id only when
   all of these hold:
   - The `github-release` check of the `upstreams.json` item has a non-empty string
     `advisoryProduct` (for example `"advisoryProduct": "PHP"`). Without it, alerts never count,
     and the checker fetches no feed for that row. The data repo owner sets this field, never the
     upstream.
   - The alert title names `advisoryProduct` as a whole word (case-insensitive, no letter, digit,
     `_` or `-` on either side), so `PHP` matches "Critical Vulnerabilities in PHP" but not
     "PHPUnit".
   - The alert title or text names the CVE id, and no digit follows it (`CVE-2026-3005` does not
     match `CVE-2026-30050`).
   So an upstream cannot lift its own gate with a CVE from an alert about another product.
   Ceiling: alerts carry no version data, so a CVE of the same product from an older alert that
   is still in the feed also counts. The feeds hold only the newest items (CISA about 30, CERT-EU
   about 10).
   Feeds (verified 2026-10-30):
   - CISA: `GET <cisaBase>/cybersecurity-advisories/all.xml` (RSS 2.0, all CISA advisories and
     alerts, about 30 items). The alert is `<title>` plus `<description>` (it names the CVE ids).
     Source: `cisa:<link>`.
   - CERT-EU: `GET <certEuBase>/publications/security-advisories-rss` (RSS 2.0, about 10 items).
     The RSS description often names no CVE, so for each `<link>` that ends in
     `/security-advisories/<yyyy>-<nnn>/`, the checker gets
     `<certEuBase>/publications/security-advisories/<yyyy>-<nnn>/json` and uses its `title` and
     `content_markdown`. Source: `cert-eu:<yyyy>-<nnn>`.
   The checker fetches the feeds at most once per `checkUpdates` run, and only when a bound row
   has a young release that cites a CVE. A non-ok status or a network error drops the alerts of
   that GET (fail closed). The GitHub token never goes to a feed.
7. The OSV lookup is memoized per `checkUpdates` run (one GET per CVE id). An OSV 404, an HTTP
   error, or a network error counts as "not corroborated" (fail closed: the gate stays).
   The table `osv_cache (id TEXT PRIMARY KEY, fetchedAt TEXT NOT NULL, record TEXT)` keeps the
   raw record (`NULL` for a 404) by CVE id across runs, never a verdict: the tier B repo binding
   is recomputed each run. A cached record is reused for 6 h, a cached 404 for 1 h, so a new
   record shows up soon. A non-404 HTTP error, a bad body, or a network error is never cached.
   A withdrawn record is cached and fetched again after its TTL like any other record.
8. The row of the picked release (`target ?? latest`) gets
   `security: { cves: [...], ghsas: [...], sources: ['osv:<id>', 'cisa:<url>', 'cert-eu:<id>', ...], tier: 'A' | 'B' }`
   when that release has security data. `cves` holds only CVE ids, `ghsas` only GHSA ids (both
   can be empty). `sources` has no duplicates. Only `osv:`, `cisa:` and `cert-eu:` sources give
   tier B. Other rows have no `security` key.
9. `qualifiesAt = publishedAt + gate`, where the gate is 7 days, 2 days (tier A), or 0 (tier B).
10. `checkUpdates(db, { securityFastPath: false })` turns the fast path off: no body scan, no OSV
   call, no advisory call, no feed call, no `security` key. The default is on. The server reads `securityFastPath` from
   `server-config.json` (default `true`) and passes it on. No route changes. A row carried forward
   after a failed check also follows this switch: it loses `security`, and its target becomes
   `null` unless the release is 7 days old.
11. `osvBase()` reads `ALATE_TEST_OSV_BASE`, else `https://api.osv.dev/v1` (test seam like `ghBase()`).
   `cisaBase()` reads `ALATE_TEST_CISA_BASE`, else `https://www.cisa.gov`. `certEuBase()` reads
   `ALATE_TEST_CERTEU_BASE`, else `https://cert.europa.eu`.

## node-dist

11. For each `index.json` entry that is newer than `current`, younger than 7 days, and has
    `security: true`, the checker fetches the release announcement
    `<nodeBlogBase>/v<version>`. `nodeBlogBase()` reads `ALATE_TEST_NODE_BLOG_BASE`, else
    `https://nodejs.org/en/blog/release`.
12. The announcement text goes through the same advisory pass as a release body (rules 2, 5, 6)
    with the repo `nodejs/node`, the entry version as the candidate, and `current`. So tier B
    also needs an OSV `fixed` version `f` with `current < f <= candidate`.
13. `security: true` without CVE ids gives tier A (`cves: []`, `sources: []`). A non-ok status,
    a network error, or a failed body read on the announcement counts as "no CVE ids", so the
    flag still gives tier A.
14. An entry without `security: true` gets no announcement fetch and keeps the 7-day gate. The
    checker computes the tier itself. It ignores every other `index.json` field, for example an
    upstream `advisory` or `tier` field.
15. When the picked entry has security data, `notesUrl` is its announcement URL. Else `notesUrl`
    stays the dist root.
16. `securityFastPath: false` makes no announcement and no OSV call (rule 9).

## Dashboard

The updates table status text marks a row that has `security`:
tier B "security fix, OSV confirmed" (an `osv:` source) or "security fix, alert confirmed" (alert
sources only), tier A "security fix, upstream claim".
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
- A reference on a look-alike host (`notgithub.com/<repo>`) gives tier A.
- A withdrawn record gives tier A.
- A record whose `fixed` version is newer than the candidate gives tier A.
- A record whose `fixed` version is at or below `current` gives tier A.
- Ranges `[0, 1.0.1)` and `[2.0.0, 2.0.1)`, current 1.0.0: candidate 2.0.0 gives tier A,
  candidate 2.0.1 gives tier B.
- Two packages, only referenced by URL: tier A (ambiguous).
- Two packages, each with a range `repo`: the fix of the tracked repo's package decides, never
  the fix of the other package.
- `securityFastPath: false` gives the plain 7-day behavior and makes no OSV request.
- A tier B row from an earlier run, then a failed check with `securityFastPath: false`: no
  `security` key, no target, `qualifiesAt` is +7 days.
- Two runs on one db make one OSV request per cited CVE id. A 500 is fetched again each run.
  A 2-hour-old 404 is fetched again, a 2-hour-old record is not. A record older than 6 h is.
- A 1-day-old release that cites a CVE named in a CISA alert whose title names the row's
  `advisoryProduct` gets tier B, source `cisa:<link>`, and is the target. A CERT-EU advisory JSON
  does the same with source `cert-eu:<id>`.
- An alert for another product, a row without `advisoryProduct`, a product that is only part of a
  word, or a CVE id that is only a prefix of the named id gives tier A.
- A feed error (HTTP 500) gives tier A.
- Each feed URL gets one GET per run. A row without `advisoryProduct` and `securityFastPath: false`
  make no feed request.
- A 1-day-old node-dist entry with `security: true`, whose announcement cites a CVE with an OSV
  record that references `github.com/nodejs/node` and has a fix at the entry version, is the
  target with tier B. Without the OSV record, or with an OSV fix after the entry version, it is
  tier A and not the target. With `securityFastPath: false`, the 7-day gate applies.

## Non-goals (own cards)

- Tier C (CISA KEV) and any auto-apply.
- A `php-dist` check kind.
- These items from the report are separate cards:
  - More tier A signals: a release marked as a security release, GHSA ids, repo-scoped GHSAs.

