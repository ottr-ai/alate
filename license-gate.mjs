#!/usr/bin/env node
// Fail-closed license gate over the shipped npm tree: every package in the lockfile must carry an allowed SPDX expression. node license-gate.mjs [--lock <file>]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Exact inventory of the current shipped tree; anything else refuses the run.
const ALLOWED = new Set(['0BSD', 'Apache-2.0', 'BSD-3-Clause', 'BlueOak-1.0.0', 'CC-BY-4.0', 'ISC', 'MIT', 'OFL-1.1']);

// Identifier tokens of one SPDX expression: parens are grouping noise, the whole words
// AND / OR / WITH are operators, everything else must be an allowed license id.
const tokens = license =>
  license.replace(/[()]/g, ' ').split(/\s+/).filter(t => t && !/^(?:AND|OR|WITH)$/.test(t));

// violations(entries): violation strings for the given lockfile entries, sorted.
// entries: [{ name, version, license }]. Missing, empty, or non-string licenses and any
// identifier outside the allowlist are violations; the shape is name@version: license.
export const violations = entries =>
  entries.flatMap(({ name, version, license }) =>
    typeof license !== 'string' || !license.trim() || tokens(license).some(t => !ALLOWED.has(t))
      ? [`${name}@${version}: ${license === undefined ? '(no license field)' : typeof license === 'string' && !license.trim() ? '(empty license)' : license}`]
      : [])
    .sort();

const die = message => {
  console.error(message);
  process.exit(1);
};

export const main = () => {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: { lock: { type: 'string' } }, strict: true, allowPositionals: false });
  } catch (err) {
    die(`Usage error: ${err.message}\nUsage: node license-gate.mjs [--lock <file>]`);
  }
  const lock = parsed.values.lock ?? join(dirname(fileURLToPath(import.meta.url)), 'package-lock.json');
  let tree;
  try {
    tree = JSON.parse(readFileSync(lock, 'utf8'));
  } catch (err) {
    die(`license-gate: cannot read ${lock}: ${err.message}`);
  }
  if (!tree || typeof tree !== 'object' || !tree.packages || typeof tree.packages !== 'object') {
    die(`license-gate: ${lock} has no packages map (lockfileVersion 3 shape required)`);
  }
  const entries = Object.entries(tree.packages).map(([key, entry]) => ({
    // The "" key is the root project; node_modules/... keys strip to the package path.
    name: entry.name ?? key.replace(/^(?:node_modules\/)+/, ''),
    version: entry.version ?? '',
    license: entry.license,
  }));
  const bad = violations(entries);
  if (bad.length) {
    for (const v of bad) console.error(`license-gate: ${v}`);
    process.exit(1);
  }
  console.log(`license-gate: ${entries.length} packages checked, ${new Set(entries.flatMap(e => tokens(e.license).filter(t => ALLOWED.has(t)))).size} distinct allowed license ids`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
