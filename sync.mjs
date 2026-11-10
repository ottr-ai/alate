#!/usr/bin/env node
// Installs the data repo's rule files into omp's user rules dir. The tool checkout ships no rules.
// A rule the data repo drops is deleted from the target when it still holds the recorded content;
// a rule alate never installed is only reported.
// Per-item contract (specs/provision-item-by-item.md): one rejected rule or one uncovered origin
// stays out and is reported; every item that passed still installs. Global refusals stay fatal.
// Usage: node sync.mjs [targetDir] [--data <dir>|--repo <owner/name[@ref]>]
//   targetDir default: $PI_CODING_AGENT_DIR/rules, else ~/.omp/agent/rules
//   data dir: --data <dir>, else --repo (shallow clone), else $ALATE_DATA, else ../agent-data beside this checkout
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSourceInside, checkDestination, cleanupData, describeProblem, die, fingerprint, NOT_RULES, originGate, parseArgs, PROVISION_ENV, resolveDataDir, ruleProblems, writeProvisionResults } from './lib/data.mjs';

const args = parseArgs(process.argv.slice(2), ['--data', '--repo'], [], true);
if (args.positional.length > 1) die('Usage: node sync.mjs [targetDir] [--data <dir>|--repo <owner/name[@ref]>]');
const data = resolveDataDir(args, { allowClone: true });
const target = args.positional[0] ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'rules');
let fatal = false;
let error = null;
let items = [];
try {
  // Test-only file gate (the server-side twin is ALATE_TEST_PROVISION_GATE in server.ts):
  // lets a server test hold this script before any write and kill it, so provision's
  // null-exit-code stop (a close code of null from a signal) is reachable in a hermetic
  // suite. Inert unless the env var is set AND the gate file exists.
  while (process.env.ALATE_TEST_SCRIPT_GATE && existsSync(process.env.ALATE_TEST_SCRIPT_GATE)) {
    await delay(10);
  }
  // A junction or symlink pointing back at the data dir would make sync overwrite its own source.
  if (existsSync(target) && realpathSync.native(target) === realpathSync.native(data.dir)) {
    throw new Error(`Target resolves to the data dir (${target}); refusing to install into itself.`);
  }
  const isMd = name => /\.mdc?$/.test(name); // omp loads <agentDir>/rules/*.{md,mdc}, top level only

  const rules = new Map();
  const failItem = (item, status, rule = null, at = null, report = null) => {
    const entry = { item, status, rule, at };
    if (report !== null) entry.report = report.length > 4000 ? `${report.slice(0, 4000)}…` : report;
    items.push(entry);
  };
  for (const entry of readdirSync(data.dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isMd(entry.name)) continue;
    const file = join(data.dir, entry.name);
    assertSourceInside(data.dir, file);
    const bytes = readFileSync(file);
    // AGENTS.md is agent context too, so it gets the hidden-character scan, never the rule frontmatter gate.
    const problems = ruleProblems(entry.name, bytes.toString('utf8'), { frontmatter: !NOT_RULES.has(entry.name) });
    if (problems.length) {
      // Per item: a rejected rule stays out; NOT_RULES files are not installed by sync at
      // all, so a problem there is only a rejected report and never stops the other rules.
      const first = describeProblem(problems[0]);
      failItem(entry.name, 'rejected', first.rule, first.at, problems.join('\n'));
      continue;
    }
    if (NOT_RULES.has(entry.name)) continue;
    rules.set(entry.name, bytes);
  }
  // Origin gate: when the data repo ships upstreams.json, every public item needs a recorded origin there.
  // Fatal problems mean the gate itself is broken: no origin verdict is possible, so the run refuses.
  // An uncovered item fails alone: an uncovered rule is excluded (a record-matching installed copy
  // is then deleted below); keys without '/' are always rules, keys with '/' belong to other scripts
  // and are reported only. A hint carries the gate's per-item remediation text (for example the
  // pinned-Python message for an unpinned uvx/pipx server) and travels with the item's report.
  const gate = originGate(data.dir);
  if (gate.fatal.length) throw new Error(`Nothing installed. Fix:\n  ${gate.fatal.join('\n  ')}`);
  for (const p of gate.uncovered) {
    failItem(p, 'no-origin', null, null, gate.hints?.[p] ?? null);
    if (rules.has(p)) rules.delete(p);
  }

  // alate records the fingerprints of the rules it installs (target/.alate-installed.json),
  // so a rule the data repo drops is deleted when nobody edited it here. A rule with no
  // record — hand-made, or installed by an older alate — is only reported, never deleted.
  const manifestFile = join(target, '.alate-installed.json');
  checkDestination(target, manifestFile);
  let recorded = {};
  if (existsSync(manifestFile)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
      recorded = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string'));
    } catch (err) {
      console.error(`Ignoring unreadable ${manifestFile} (${err.message}): dropped rules are only reported.`);
    }
  }

  // Preflight every destination guard before the first write, so a mid-run directory,
  // alias, or hardlink at one rule name cannot let earlier rule names through —
  // deletions included: never delete through a symlink, a hardlink alias or a directory.
  for (const name of rules.keys()) checkDestination(target, join(target, name));
  for (const name of Object.keys(recorded)) if (!rules.has(name)) checkDestination(target, join(target, name));

  mkdirSync(target, { recursive: true });
  const old = new Map();
  for (const [name] of rules) {
    const dest = join(target, name);
    old.set(name, existsSync(dest) ? readFileSync(dest) : null);
  }
  let unchanged = 0;
  for (const [name, bytes] of rules) {
    if (old.get(name)?.equals(bytes)) {
      unchanged++;
      failItem(name, 'unchanged');
      continue;
    }
    writeFileSync(join(target, name), bytes);
    console.log(`${old.get(name) ? 'updated' : 'added'}  ${name}`);
    failItem(name, 'installed');
  }
  let deleted = 0;
  const gone = new Set();
  for (const name of Object.keys(recorded)) {
    if (rules.has(name) || !existsSync(join(target, name))) continue;
    if (fingerprint(name, readFileSync(join(target, name))) === recorded[name]) {
      unlinkSync(join(target, name));
      console.log(`deleted  ${name}`);
      deleted++;
      gone.add(name);
    } else {
      console.log(`changed here, kept: ${join(target, name)}`);
    }
  }
  console.log(`${unchanged} unchanged, ${deleted} deleted in ${target}`);
  // A rule alate did not own after this run stays and is reported: deleted ones are gone,
  // a kept-but-changed copy loses its record when the manifest is rewritten below.
  const stale = readdirSync(target).filter(name => isMd(name) && !rules.has(name) && !gone.has(name));
  if (stale.length) console.log(`Not from the data repo, left in place: ${stale.join(', ')}`);
  writeFileSync(manifestFile, `${JSON.stringify(Object.fromEntries([...rules.keys()].map(name => [name, fingerprint(name, rules.get(name))])), null, 2)}\n`);
  items.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  const failed = items.filter(it => it.status === 'rejected' || it.status === 'no-origin');
  if (failed.length) {
    console.log('Failed items:');
    for (const it of failed) {
      console.log(`  ${it.item} — ${it.status === 'no-origin' ? 'no origin' : `rejected: ${it.rule} at ${it.at}`}`);
      // A rejected rule's problem lines are already on the status line; only the origin
      // hints (for example the pinned-Python remediation) add new information here.
      if (it.status === 'no-origin' && it.report) console.log(`    ${it.report}`);
    }
    process.exitCode = 1;
  }
  fatal = false;
  error = null;
} catch (err) {
  fatal = true;
  error = err.message;
  console.error(err.message);
  process.exitCode = 1; // not process.exit: finally below must still remove a cloned temp dir
} finally {
  if (process.env[PROVISION_ENV]) writeProvisionResults(process.env[PROVISION_ENV], { fatal, error, items });
  cleanupData(data);
}
