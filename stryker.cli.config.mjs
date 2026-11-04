import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutation gate for the provisioning CLIs: `npm run test:mutation` runs this config after
// stryker.config.mjs. It mutates lib/data.mjs and the four CLI scripts with the CLI
// self-checks as the runner, so the security gates that live outside the server
// (ruleProblems, redactSecrets, safeRel, checkDestination, forTarget, the CONFIG origin
// gate, the hidden-character scan) are mutated like the server half.
// ponytail: Stryker's built-in command runner re-runs the whole CLI suite per mutant, so
// there is no per-test coverage (no "NoCoverage" status). Upgrade path: a real test-runner
// integration.
export default {
  testRunner: "command",
  commandRunner: {
    command:
      "node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node clone.test.mjs && node skills/create-data-repo/scan-secrets.test.mjs",
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
  timeoutMS: 20000,
  timeoutFactor: 2,
  mutate: ["lib/data.mjs", "sync.mjs", "install-user.mjs", "sync-user.mjs", "sync-projects.mjs"],
  reporters: ["clear-text", "progress"],
  // Each break threshold equals the measured score of this tree, rounded down.
  // Raise it when the score rises; never lower it or shrink the mutate set.
  thresholds: { high: 80, low: 60, break: 0 },
};
