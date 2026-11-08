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
  // The break threshold holds the score of a green gate: 93. The 2026-11-07 full-set
  // quiet measurement scored 88.35 — the earlier 93.88 came from runs whose workers
  // shared one TMPDIR and did not cover this full mutate set — so the gate stays red
  // until about 169 more of the 423 measured survivors are killed or justified:
  // 217 in lib/updates.mjs (95 of them in the isValidUpdateRecord validator and its
  // boardText/boardHttpUrl/boardIso helpers), 94 in web/dashboard.mjs, 112 in
  // server.ts. Raise it when the score rises; never lower it or shrink the mutate set.
  // Remaining survivors: the named list below predates this task and covers the gates
  // it names; the full-set re-measure counts 423, and the unlisted ones await triage.
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
  thresholds: { high: 80, low: 60, break: 93 },
};
