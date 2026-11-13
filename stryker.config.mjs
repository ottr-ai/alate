import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutation testing: `npm run test:mutation` runs this config.
// The command is scripts/mutant-run.mjs: stage 1 runs only the test files that reach
// the mutated file, stage 2 runs the rest, so every mutant still faces the whole chain.
// ponytail: coverageAnalysis stays "off". The suite exercises the mutate set through
// spawned child processes, whose coverage no in-process hook can see, so per-test
// analysis cannot work here (the tap-runner keys coverage per test file; the native
// node:test runner is an unmerged PR). Upgrade path: a real test-runner integration.
export default {
  testRunner: "command",
  commandRunner: {
    command: "node scripts/mutant-run.mjs server.test.mjs",
  },
  coverageAnalysis: "off",
  // Cache per-mutant results and only re-test mutants of changed code.
  // ponytail: with coverageAnalysis "off" the differ cannot see WHICH tests changed,
  // so results that predate a test-only change are served stale — delete
  // stryker-incremental.json after growing the suite without touching server code.
  incremental: true,
  incrementalFile: "stryker-incremental.json",
  concurrency: 8,
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time. The suite
  // spawns the server and waits on updates, so the 5 s default is too tight.
  // The factor is 4, not 2: on a shared box a load spike can stretch a chain run
  // several-fold, and a stretched run must fail its own assertions, not time out —
  // a timeout verdict for a merely slow mutant is a false kill.
  timeoutMS: 20000,
  timeoutFactor: 4,
  // The dry run itself gets this ceiling (default 5 minutes): the CLI chain's net
  // time reaches 4 minutes under load, so the default kills the initial run.
  dryRunTimeoutMinutes: 10,
  // Sandbox outside any repo: a mutant that drops the spawn cwd must fail
  // there, not run node against this repo. The sandbox resolves fastify
  // through <tempDirName>/node_modules; a worktree run needs that symlink
  // pointing at a checkout with installed dependencies.
  tempDirName: join(tmpdir(), "alate-stryker"),
  mutate: ["server.ts", "web/dashboard.mjs", "lib/updates.mjs"],
  reporters: ["clear-text", "progress"],
  // The break threshold holds the score of a green gate: 90. The user ruled on
  // 2026-11-09 that a break threshold never goes above 90, and that a threshold
  // above 90 may be set to 90. The 2026-11-08 quiet full run with the ALAT-93
  // teardown patch (ALAT-94 commits 3f654a7, 5b28943) measured 91.48: 314 survivors
  // of 3686 mutants — 118 in lib/updates.mjs, 82 in web/dashboard.mjs, 114 in server.ts.
  // Never lower the threshold or shrink the mutate set.
  // Survivors proven equivalent during that work (harness splice of the exact rows):
  // - the boardHttpUrl empty catch: protocol stays null, so the result is the same false;
  // - checkUpdates/loadUpdates max scans (`>` vs `>=`, guard flips): every row of one run
  //   carries the same ctx.now stamp, so no order of equal values changes the max;
  // - entry sort comparators (`<`/`>` variants, second-ternary flips): binary insertion
  //   still sorts unique paths from the truthful `<` answer alone;
  // - computeChanges `?.` drops ahead of a `?? []` default, and next-side chains on the
  //   always-full scanInventory shape; parseJsonc `i <= src.length` (the compound
  //   condition stops one step later at no extra character);
  // - listFiles/countFiles existsSync and type guards behind callers that already check;
  //   remoteHead split/index shapes and its default stdio array; rmSync force flags on
  //   existing files; the github-path `''` sentinel (startsWith('') is always true).
  // The remaining unlisted survivors await triage (follow-up card). Earlier justified classes:
  // - exact error-string wording beyond the pinned main ones (status codes are asserted);
  // - process lifecycle/timing: port negation, interval scaling, timer.unref, argv boundary;
  // - initial CLI selectors and the boot dashCheck duplicate the POST /api/import
  //   and tick paths; offline SQLite restart is covered by a second server instance;
  // - cloneRepo network paths: unreachable in a hermetic suite, no network in tests;
  // - runReleaseCheck advisories fallback `[]` (non-array answer, fetch error): any filler
  //   entry has no `vulnerabilities` array, so it can never name the candidate (equivalent);
  // - alert feeds (fetchAlerts): the real cisa.gov/cert.europa.eu default bases (no network in
  //   tests); the `''` fallbacks of a missing RSS tag, a failed feed GET, and a missing CERT-EU
  //   title/content (any filler text names no CVE and no product, or yields no `<item>`); the
  //   `.catch(() => null)` filler (`filter(Boolean)` drops null and undefined alike).
  // - display-only inventory internals: recursion/sort/dedup details whose observable
  //   rows are asserted; initial config.update reset values masked by the boot update check.
  // Editor (dashboard file editor) survivors, each killed or justified:
  // - killed by tests: the space-named path, the verbatim and null message, CR/LF
  //   flattening with a mid-line CR, empty-folder pruning with a surviving sibling and
  //     root, the 404 body naming the file (the GET /api/file handler and dashboard.mjs:406/430/432/448).
  // - justified: safeRelPath `shown` and the trimmed stderr sites only shape error or
  //   message text; a dropped empty-string or startsWith check still rejects through the
  //   split-segment clause with the same status and message; an empty message returns the
  //   fallback through the trim-or-fallback tail anyway; git's own cleanup strips the
  //   edge whitespace the dropped pre-trim would remove; rmSync force flags are moot
  //   because existence is verified immediately before; identArgs cannot see `git config
  //   user.email` fail with non-empty stdout, so the boolean shapes coincide; rev-parse
  //   HEAD never fails after a successful commit; the editRepoSource rmSync runs with
  //   recursive+force so its existsSync guard is redundant; the GET /api/file handler sends a
  //   non-string query path to the same 400 through safeRelPath and its fallback string
  //   only rewords the 404; the display-cut line differs only past the 200-char cut;
  //   the concurrent-write window (fileEdit's running/writing check) is unreachable from a sequential
  //   fetch suite, which serves one origin over one connection.
  // ALAT-127 delta survivors (v0.3.0..9764e42) proven equivalent after the killing tests
  // landed (final delta rerun 2026-11-12 after the ready-report review fixes: 92.11, exit 0,
  // these 34 are the remaining survivors; earlier reruns also held up to 13 timeout verdicts,
  // which score as kills, so run-to-run scores above ~91 carry that noise). Each proof cites
  // its command output or its pinned example input.
  // - server.ts readFileSync encoding literal (:120): `node -e 'const b=Buffer.from(JSON.stringify({fatal:false,items:[{item:"réglé.md"}]}),"utf8"); console.log(JSON.stringify(JSON.parse(b))===JSON.stringify(JSON.parse(b.toString("utf8"))))'`
  //   → `true` — JSON.parse of a Buffer calls ToString, which decodes the same UTF-8 bytes.
  // - server.ts readProvisionResults shape checks (:121): the only results-file writers are
  //   sync.mjs:150 / install-user.mjs:1225, both calling writeProvisionResults (lib/data.mjs:811),
  //   which always serializes `{fatal: boolean, error, items: array}` through tmp+rename —
  //   pinned example input `{fatal:false, items:[]}` passes every check; missing/unparseable
  //   files return null through the catch, which no mutant touches.
  // - server.ts provision mkdtemp prefix (:130): `node -e 'const
  //   {mkdtempSync}=require("node:fs");const d=mkdtempSync(require("node:path").join(require("node:os").tmpdir(),""));console.log(!!d)'`
  //   → `true`; nothing asserts or greps the `alate-provision-` prefix (the suite's /proc scan
  //   matches the TMPDIR, not the prefix).
  // - server.ts `source?.kind`/`source.importedSha` optional chains (:145, :190): pinned example
  //   — the suite's "No source configured yet" case: POST /provision with no source answers 400
  //   before provision() runs, so the chains never see null; nothing nulls the source afterwards.
  // - server.ts the `?? ''` fallback markers (:145) and updates.mjs `current ?? ''` (:454):
  //   `node -e 'const sha=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;const p=/^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:\.post(\d+))?$/i;console.log(sha.test(""),sha.test("Stryker was here!"),p.exec("")===null,p.exec("Stryker was here!")===null)'`
  //   → `false false true true` — every fallback string misses both regexes, so each yields the
  //   same no-`--commit` / `{rel:[-1],post:0}` sentinel.
  // - server.ts path-source kind ternary (:145): a path source never carries `importedSha`
  //   (only cloneRepo's repo sources set it), so the true branch's `?? ''` yields the same ''
  //   as the false arm — `node -e 'const s={kind:"path",name:"x"};console.log((s.importedSha ?? "")==="")'`
  //   → `true`.
  // - server.ts entry guards (:166): every entry comes from failItem (sync.mjs:39, install-user.mjs:547)
  //   with a non-empty string item and a status among the four STATUS_RANK keys — pinned example
  //   `{item:'bad.md', status:'rejected', rule:null, at:null}`; the guard never fires on reachable files.
  // - server.ts report-presence condition and `||` flip (:170) and the rule/at ternary
  //   true-mutants (:168, :169): reachable entries carry rule/at as null-or-string and report
  //   as non-empty-string-or-absent, so the substituted null/undefined equals the raw value —
  //   `node -e 'const x=[null,"s"];console.log(x.every(v => (typeof v==="string"?v:null)===(true?v:null)))'`
  //   → `true` and `node -e 'const x=[undefined,"s"];console.log(x.every(v => (typeof v==="string"&&v ? v : undefined)===(true?v:undefined)))'`
  //   → `true` (failItem/storeItem never write a null-valued report key, only absent or string).
  // - server.ts worse-status-wins `>` → `>=` (:180): rank equality only occurs when both scripts
  //   report the same key `no-origin` — both run originGate over the same snapshot, and an
  //   uncovered skill is excluded by install-user too, so the reassigned status/rule/at equal
  //   the stored ones. Pinned example: `{item:'k',status:'no-origin',rule:null,at:null}` assigned
  //   over itself — `node -e 'const a={item:"k",status:"no-origin",rule:null,at:null},b={...a};Object.assign(a,{status:b.status,rule:b.rule,at:b.at});console.log(JSON.stringify(a)===JSON.stringify({item:"k",status:"no-origin",rule:null,at:null}))'`
  //   → `true`; different-rank pairs (the suite's rank fixtures) assign under both operators.
  // - server.ts single-report cap condition (:171): children pre-cap reports to ≤4000 chars or
  //   exactly 4001 ending '…' (sync.mjs:41, install-user.mjs:548), and
  //   `node -e 'const r="x".repeat(4000)+"…";const c=r.length>4000?r.slice(0,4000)+"…":r;console.log(c===r,r.length)'`
  //   → `true 4001` — capping the 4001 form reproduces it byte-for-byte.
  // - server.ts null-exit clause (:186): a signal-killed child never reaches its `finally`
  //   (sync.mjs:147-151), so code null always pairs with no results file → `parsed === null`
  //   already breaks; pinned example: the suite's 4c killed-child run.
  // - server.ts items sort strictness/branch mutants (:192): `node -e 'const m=new Map();m.set("x",{item:"x"});m.set("x",{item:"x"});console.log(m.size)'`
  //   → `1` — merged Map keys are unique, so the comparator never sees equal names. Pairwise
  //   check that the `<=`/`>=` strictness flips and both branch-drops order identically to the
  //   original for distinct names: `node -e 'const orig=(a,b)=>a.item<b.item?-1:a.item>b.item?1:0;const vs=[(a,b)=>a.item<=b.item?-1:a.item>b.item?1:0,(a,b)=>a.item<b.item?-1:a.item>=b.item?1:0,(a,b)=>a.item>b.item?1:0,(a,b)=>a.item<b.item?-1:1];const names=["user/omp/agent/config.yml","zz-order.md","a.md","z.md","m.md","b.md"];console.log([names,[...names].reverse(),[...names].sort().reverse(),[...names].sort()].every(p=>vs.every(v=>JSON.stringify([...p].sort(orig))===JSON.stringify([...p].sort(v)))))'`
  //   → `true`.
  // - server.ts parser error literals (:282): pinned example — the suite's `'{oops'` case asserts
  //   the pinned 400 body `invalid JSON body`; the error handler maps every FST_ERR_CTP code to
  //   that fixed text, so the Error's own message is unused.
  // - server.ts dashCheck host `?? ''` (:488, if the ?? variant survives): `node -e 'console.log(["","h.tld","0"].every(x => (x ?? "") === (x || "")))'`
  //   → `true` — parseDataSpec always returns host as a string.
  // - updates.mjs PYPI_STABLE /i flag (:425): `node -e 'const p=/^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:\.post(\d+))?$/i;const v="V1.0.POST2";console.log(JSON.stringify(p.exec(v.toLowerCase())?.slice(1)),JSON.stringify(p.exec(v.toUpperCase())?.slice(1)))'`
  //   → identical capture groups — the flag makes toLowerCase vs toUpperCase equivalent.
  // - updates.mjs comparator loop bound (:434): n = max(rel lengths) puts index n out of range for
  //   BOTH arrays, so the dropped iteration subtracts 0-0 (rel pairs [0,1]/[0,1,0], [0,1,2]/[0,1],
  //   [1,0]/[0,9,9] all compare identically with `i < n` and `i <= n`).
  // - updates.mjs null files filler (:447): `node -e 'const t1=["Stryker was here"].map(f => f.upload_time_iso_8601 ?? f.upload_time).find(Boolean);const t2=[].map(f => f.upload_time_iso_8601 ?? f.upload_time).find(Boolean);console.log(t1,t2,t1===t2)'`
  //   → `undefined undefined true` — a filler entry has no upload timestamp and is skipped by
  //   `if (!t) continue` exactly like the empty array.
  // - updates.mjs shipped-suppression root predicate (:775): the surviving `root !== -1` → true
  //   is equivalent: every row matched by `user/*<name>/*` starts with the literal `user/`, so
  //   with root still -1 the mutant evaluates seg[0] === name, and no shipped pin is named
  //   'user' (`shippedSkills` names: check-ottr-board, diff-security-review, explain-project,
  //   llm-to-code, retro, ui-ux-check, web-perf-audit). The length-gate flips (`>= root + 2`,
  //   `> root - 2`) are killed by the snapshot row `user/retro/skills/retro`: it matches the
  //   GLOB (first `*` = 'retro/skills', trailing `*` = empty) with the pin name as the LAST
  //   segment, so the override folder holds no file and the shipped retro row must stay
  //   (`seg.length === root + 2` — sqlite probe: GLOB match 1, isOverridePath false); the
  //   flipped operators return true and wrongly suppress it. The child-check drop
  //   (`seg[root + 1] === name` → true) is killed by the snapshot row
  //   `user/skills/other/retro/SKILL.md` — a GLOB-matching row (it contains `retro/`) whose
  //   override child is another skill: the original keeps the retro row, the mutant
  //   suppresses it. The pre-existing deepRoot case kills the same mutant.
  // - updates.mjs glob escaping (:779): the shipped pin names contain none of `[`, `*`, `?`
  //   (`shippedSkills` list above), so the replace callback is never invoked (174), bracketing
  //   every character is a same-matching GLOB (173: `'user/skills/retro/SKILL.md' GLOB
  //   'user/*[r][e][t][r][o]/*'` = 1, same as the unbracketed pattern), and `[c]` is a faithful
  //   literal-class escape (175: `'a?b' GLOB 'a[?]b'` = 1). A kill would need a vendored skill
  //   named with a GLOB special.
  thresholds: { high: 80, low: 60, break: 90 },
};
