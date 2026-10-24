#!/usr/bin/env node
// Installs the data repo's rule files into omp's user rules dir. The tool checkout ships no rules.
// A rule the data repo drops is deleted from the target when it still holds the recorded content;
// a rule alate never installed is only reported.
// Usage: node sync.mjs [targetDir] [--data <dir>|--repo <owner/name[@ref]>]
//   targetDir default: $PI_CODING_AGENT_DIR/rules, else ~/.omp/agent/rules
//   data dir: --data <dir>, else --repo (shallow clone), else $ALATE_DATA, else ../agent-data beside this checkout
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertSourceInside, checkDestination, cleanupData, descriptionText, die, fingerprint, parseArgs, resolveDataDir, unwrapCmd } from './lib/data.mjs';

const args = parseArgs(process.argv.slice(2), ['--data', '--repo'], [], true);
if (args.positional.length > 1) die('Usage: node sync.mjs [targetDir] [--data <dir>|--repo <owner/name[@ref]>]');
const data = resolveDataDir(args, { allowClone: true });
const target = args.positional[0] ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'rules');
try {
  // A junction or symlink pointing back at the data dir would make sync overwrite its own source.
  if (existsSync(target) && realpathSync.native(target) === realpathSync.native(data.dir)) {
    throw new Error(`Target resolves to the data dir (${target}); refusing to install into itself.`);
  }
  const NOT_RULES = new Set(['AGENTS.md', 'README.md']);
  const isMd = name => /\.mdc?$/.test(name); // omp loads <agentDir>/rules/*.{md,mdc}, top level only
  // Invisible characters smuggle instructions past human review ("Rules File Backdoor"): C0/C1 controls
  // except tab/LF/CR, Unicode format chars (zero-width, bidi overrides, tag characters, BOM), variation selectors.
  const HIDDEN = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

  const rules = new Map();
  const problems = [];
  for (const entry of readdirSync(data.dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isMd(entry.name)) continue;
    const file = join(data.dir, entry.name);
    assertSourceInside(data.dir, file);
    const bytes = readFileSync(file);
    const text = bytes.toString('utf8');
    // AGENTS.md is agent context too, so it gets the same scan.
    text.split('\n').forEach((line, i) => {
      const hit = HIDDEN.exec(line);
      if (hit) {
        const codePoint = hit[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
        problems.push(`${entry.name}:${i + 1}:${hit.index + 1}: hidden character U+${codePoint}`);
      }
    });
    if (NOT_RULES.has(entry.name)) continue;
    rules.set(entry.name, bytes);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!frontmatter || !descriptionText(frontmatter[1])) {
      problems.push(`${entry.name}: needs frontmatter with a description`);
    }
  }
  // Origin gate: when the data repo ships upstreams.json, every public item needs a recorded origin there.
  const upFile = join(data.dir, 'upstreams.json');
  if (existsSync(upFile)) {
    let up = null;
    let parsed = false;
    try { up = JSON.parse(readFileSync(upFile, 'utf8')); parsed = true; }
    catch (err) { problems.push(`upstreams.json: ${err.message}`); }
    if (parsed) {
      const KINDS = new Set(['image-pin', 'mcp', 'rule-set', 'skill', 'plugin']);
      const CHECKS = new Set(['github-release', 'github-path', 'npm', 'node-dist', 'chrome-for-testing']);
      const items = Array.isArray(up.items) ? up.items : [];
      const own = Array.isArray(up.own) ? up.own : [];
      items.forEach((item, i) => {
        const label = item?.name ? `item "${item.name}"` : `item "#${i}"`;
        if (!KINDS.has(item?.kind)) problems.push(`upstreams.json: ${label}: unknown kind ${item?.kind ?? '(missing)'}`);
        if (typeof item?.origin !== 'string' || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(item.origin))
          problems.push(`upstreams.json: ${label}: origin is not a GitHub repo URL`);
        if (item?.check !== undefined && !CHECKS.has(item.check?.type))
          problems.push(`upstreams.json: ${label}: unknown check type ${item.check?.type ?? '(missing)'}`);
        if (item?.pin !== undefined && !(typeof item.pin === 'object' && item.pin && [item.pin.repo, item.pin.file, item.pin.key].every(v => typeof v === 'string' && v)))
          problems.push(`upstreams.json: ${label}: pin needs repo, file and key`);
      });
      // ponytail: hand-rolled glob, only **, *, ? (no {} alternation / character classes); switch to a glob lib if upstreams.json ever needs them.
      const globRe = pat => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replaceAll('\0', '.*') + '$');
      const covered = p => own.some(g => globRe(g).test(p)) || items.some(it => (Array.isArray(it?.paths) ? it.paths : []).some(g => globRe(g).test(p)));
      const uncovered = [];
      for (const name of rules.keys()) if (!covered(name)) uncovered.push(name);
      const readJson = rel => {
        try { return JSON.parse(readFileSync(join(data.dir, rel), 'utf8')); }
        catch (err) {
          if (err.code !== 'ENOENT') problems.push(`${rel}: ${err.message}`); // a missing file means nothing to check
          return null;
        }
      };
      const skillLock = readJson('user/agents/.skill-lock.json');
      const lockDir = join(data.dir, 'user', 'agents', 'skills');
      if (existsSync(lockDir)) for (const d of readdirSync(lockDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const rel = `user/agents/skills/${d.name}`;
        if (!skillLock?.skills?.[d.name] && !covered(rel)) uncovered.push(rel);
      }
      for (const sub of ['user/omp/agent/skills', 'user/omp/agent/managed-skills']) {
        const dir = join(data.dir, sub);
        if (!existsSync(dir)) continue;
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          if (!covered(`${sub}/${d.name}`)) uncovered.push(`${sub}/${d.name}`);
        }
      }
      const mcp = readJson('user/omp/agent/mcp.json');
      const serverArgs = cfg => (Array.isArray(cfg?.args) ? cfg.args : []).filter(a => typeof a === 'string');
      for (const [name, cfg] of Object.entries(mcp?.mcpServers ?? {})) {
        const bare = unwrapCmd(cfg) ?? cfg ?? {}; // a Windows capture wraps npx in cmd /c; judge the real program
        const strs = [bare.command, ...serverArgs(bare)].filter(s => typeof s === 'string');
        const firstArg = serverArgs(bare).find(a => !a.startsWith('-'));
        const ok = strs.some(s => /(^|[\\/])plugins[\\/]/.test(s))
          || ((bare.command === 'npx' || bare.command === 'bunx') && items.some(it => it?.kind === 'mcp'
            && typeof it.check?.package === 'string' && (firstArg === it.check.package || firstArg?.startsWith(`${it.check.package}@`))));
        if (!ok) uncovered.push(`user/omp/agent/mcp.json "${name}"`);
      }
      uncovered.sort().forEach(p => problems.push(`${p}: no recorded origin — add an item to upstreams.json or an own entry`));
    }
  }
  if (problems.length) throw new Error(`Nothing installed. Fix:\n  ${problems.join('\n  ')}`);

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
      continue;
    }
    writeFileSync(join(target, name), bytes);
    console.log(`${old.get(name) ? 'updated' : 'added'}  ${name}`);
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
} catch (err) {
  console.error(err.message);
  process.exitCode = 1; // not process.exit: finally below must still remove a cloned temp dir
} finally {
  cleanupData(data);
}
