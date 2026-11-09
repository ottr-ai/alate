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
  thresholds: { high: 80, low: 60, break: 90 },
};
