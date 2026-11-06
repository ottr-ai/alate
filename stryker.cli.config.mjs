import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutation gate for the provisioning CLIs: `npm run test:mutation` runs this config after
// stryker.config.mjs. It mutates lib/data.mjs and the four CLI scripts with the CLI
// self-checks as the runner, so the security gates that live outside the server
// (ruleProblems, redactSecrets, safeRel, checkDestination, forTarget, the CONFIG origin
// gate, the hidden-character scan) are mutated like the server half.
// ponytail: the command is scripts/mutant-run.mjs, which runs only the test files that
// reach the mutated file first and the rest after, so every mutant still faces the whole
// chain. coverageAnalysis stays "off": the CLI suites exercise the scripts through
// spawned child processes, whose coverage no in-process hook can see, so per-test
// analysis cannot work here (the tap-runner keys coverage per test file; the native
// node:test runner is an unmerged PR). Upgrade path: a real test-runner integration.
export default {
  testRunner: "command",
  commandRunner: {
    command:
      "node scripts/mutant-run.mjs sync.test.mjs install-user.test.mjs sync-user.test.mjs sync-projects.test.mjs clone.test.mjs skills/create-data-repo/scan-secrets.test.mjs",
  },
  coverageAnalysis: "off",
  // Separate cache and sandbox from stryker.config.mjs: a different mutate set, and the
  // two runs may execute concurrently.
  incremental: true,
  incrementalFile: "stryker-incremental-cli.json",
  tempDirName: join(tmpdir(), "alate-stryker-cli"),
  concurrency: 8,
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time. The CLI suites spawn
  // script processes and the scanner stub, so the 5 s default is too tight.
  // The factor is 4, not 2: on a shared box a load spike can stretch a chain run
  // several-fold, and a stretched run must fail its own assertions, not time out —
  // a timeout verdict for a merely slow mutant is a false kill.
  timeoutMS: 20000,
  timeoutFactor: 4,
  // The dry run itself gets this ceiling (default 5 minutes): the CLI chain's net
  // time reaches 4 minutes under load, so the default kills the initial run.
  dryRunTimeoutMinutes: 10,
  mutate: ["lib/data.mjs", "sync.mjs", "install-user.mjs", "sync-user.mjs", "sync-projects.mjs"],
  reporters: ["clear-text", "progress"],
  // The break threshold equals the measured score of this tree, rounded down (fresh
  // cache, quiet machine, 2026-11-06: 76.86). Raise it when the score rises; never
  // lower it or shrink the mutate set.
  // Remaining survivors in the gates (ruleProblems, redactSecrets, safeRel,
  // checkDestination, forTarget, the CONFIG origin gate, the hidden-character scan),
  // each justified:
  // - forTarget: the emptied catch falls through to the same `{ bytes, notes: [] }`
  //   return; split('') empties are absorbed by findIndex/posix.join; the roots set
  //   holds dot-dirs, so parts[0] (a drive segment) never matches and `i < 0` == `i <= 0`;
  //   a non-mcp rel or a null/plain doc re-serializes to the captured bytes; `??` equals
  //   `&&` on boolean operands; `Object.values` always exists; the surviving typeof shape
  //   walks primitive entries without pushing anything; non-object env yields no
  //   WIN_PATH-matching entries; the `?? ''` default cannot match WIN_ONLY_COMMAND;
  //   `added` is read only as truthiness.
  // - assertSourceInside: `||` to `??` on all-boolean operands is equivalent, and the
  //   `rel === ''` disjunct is absorbed by the escape clause.
  // - descriptionText: 307:24 (drop the split's leading empty element) and 308:11 (skip
  //   only exact-empty lines) mask each other and are absorbed by the final trim; a `$`
  //   anchor is redundant behind a greedy `.*`; the trim at 321:10 is a no-op after the
  //   comment strip; quote-escape regex mutants differ only on backslash-escaped quotes
  //   no rule fixture carries.
  // - cloneData/cloneCommand: the token env differs only with an empty GH_TOKEN or both
  //   vars set, and the token never reaches argv or stderr; the mkdtemp prefix and
  //   rmSync `force` flags are unobserved (cleanup is keyed on the mkdtemp handle, and
  //   the target was just created); empty stdio entries coerce to 'pipe'; every reachable
  //   git failure prints a non-whitespace fatal, so the empty-stderr shapes are dead.
  // - CONFIG origin gate: the flipped guards at 250:19/250:27 diverge only on env-ref
  //   values with indented continuations, which the fail-closed yamlProblems gate refuses
  //   before the scan runs; every captured rel starts with '.', so 258:30's anchor is
  //   absorbed; the unprefixed branch at 261:19 is reachable only from data.mjs's
  //   outside-root error, whose path never contains '~/'.
  // resolveDataDir/parseDataSpec survivors (lines 270-291) are outside the named gates.
  thresholds: { high: 80, low: 60, break: 76 },
};
