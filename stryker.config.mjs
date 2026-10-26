import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutation testing: `npm run test:mutation` runs this config.
// ponytail: Stryker's built-in command runner re-runs the whole suite
// (node server.test.mjs) per mutant, so there is no per-test coverage
// (no "NoCoverage" status). Upgrade path: a real test-runner integration.
export default {
  testRunner: "command",
  commandRunner: {
    command: "node server.test.mjs",
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
  timeoutMS: 20000,
  timeoutFactor: 2,
  // Sandbox outside any repo: a mutant that drops the spawn cwd must fail
  // there, not run node against this repo. The sandbox resolves fastify
  // through <tempDirName>/node_modules; a worktree run needs that symlink
  // pointing at a checkout with installed dependencies.
  tempDirName: join(tmpdir(), "alate-stryker"),
  mutate: ["server.ts", "web/dashboard.mjs", "lib/updates.mjs"],
  reporters: ["clear-text", "progress"],
  // Each break threshold equals the measured score of this tree, rounded down.
  // Raise it when the score rises; never lower it or shrink the mutate set.
  // Remaining survivors, deliberately untested:
  // - exact error-string wording beyond the pinned main ones (status codes are asserted);
  // - process lifecycle/timing: port negation, interval scaling, timer.unref, argv boundary;
  // - initial CLI selectors and the boot dashCheck duplicate the POST /api/import
  //   and tick paths; offline SQLite restart is covered by a second server instance;
  // - cloneRepo network paths: unreachable in a hermetic suite, no network in tests;
  // - display-only inventory internals: recursion/sort/dedup details whose observable
  //   rows are asserted; initial config.update reset values masked by the boot update check.
  // Editor (dashboard file editor) survivors, each killed or justified:
  // - killed by tests: the space-named path, the verbatim and null message, CR/LF
  //   flattening with a mid-line CR, empty-folder pruning with a surviving sibling and
  //   root, the 404 body naming the file (server.ts:380 and dashboard.mjs:406/430/432/448).
  // - justified: safeRelPath `shown` and the trimmed stderr sites only shape error or
  //   message text; a dropped empty-string or startsWith check still rejects through the
  //   split-segment clause with the same status and message; an empty message returns the
  //   fallback through the trim-or-fallback tail anyway; git's own cleanup strips the
  //   edge whitespace the dropped pre-trim would remove; rmSync force flags are moot
  //   because existence is verified immediately before; identArgs cannot see `git config
  //   user.email` fail with non-empty stdout, so the boolean shapes coincide; rev-parse
  //   HEAD never fails after a successful commit; the editRepoSource rmSync runs with
  //   recursive+force so its existsSync guard is redundant; server.ts:377 sends a
  //   non-string query path to the same 400 through safeRelPath and its fallback string
  //   only rewords the 404; server.ts:380:74 differs only past the 200-char display cut;
  //   the concurrent-write window (server.ts:391/393) is unreachable from a sequential
  //   fetch suite, which serves one origin over one connection.
  thresholds: { high: 80, low: 60, break: 91 },
};
