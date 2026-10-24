#!/usr/bin/env node
// Captures this machine's omp user layer (settings, MCP servers, plugin manifests, skills, extensions) into user/.
// Usage: node sync-user.mjs [--home <dir>] [--data <dir>]   (home default: the current user's home; data default: ../agent-data)
// Direction is machine -> data repo: omp rewrites its own config, so the machine stays the source of truth
// and user/ holds refreshed copies, never hand-edited. Paths mirror the home directory minus the leading dot
// (~/.omp/agent/config.yml -> user/omp/agent/config.yml), so no harness loads the copies as live config.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { assertSourceInside, checkDestination, parseArgs, resolveDataDir, withoutDeploymentBlocks, yamlProblems } from './lib/data.mjs';

// --repo is a valued option so resolveDataDir can refuse cloning with the capture-specific
// message; capture takes no flags and no positional arguments.
const args = parseArgs(process.argv.slice(2), ['--home', '--data', '--repo']);
const data = resolveDataDir(args, { allowClone: false });
const home = args.values['--home'] ?? homedir();
// Hand-edited config: a secret-named key here must reference an env var, never hold the value, because an MCP
// server's API key rarely has a known shape. Generated lock files get the shape scan only.
const CONFIG = ['.omp/agent/config.yml', '.omp/agent/mcp.json'];
// Never credentials, memory or history: ~/.omp/oauth, the *.db files, memories/ and sessions/ stay off this list.
// ~/.pi/agent/optimizer.json stays off too: the pix plugin's machine-local runtime toggle state,
// the same class as sessions and memories. Its per-session initial values (pix.json) are configuration.
// An allowlist on purpose, so new state or token files stay out too: a new omp config file needs a line here.
const ITEMS = [
  ...CONFIG,
  '.omp/agent/optimizer.json',
  '.pi/agent/pix.json',
  '.omp/agent/extensions',
  '.omp/agent/skills',
  '.omp/agent/managed-skills',
  '.omp/marketplaces.json',
  '.omp/plugins/package.json',
  '.omp/plugins/bun.lock',
  '.omp/plugins/omp-plugins.lock.json',
  '.omp/plugins/installed_plugins.json',
  '.omp/plugins/patches',
  '.agents/.skill-lock.json',
  '.agents/skills',
];
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
// Items a home may legitimately lack: ~/.omp/plugins/patches exists only once a patched
// plugin is installed, and its absence must not refuse the capture. Everything else in
// ITEMS is required.
const OPTIONAL = new Set(['.omp/plugins/patches']);
// Shapes of real credentials (codeguard-1-hardcoded-credentials), not words: docs that only mention keys still sync.
const SHAPES = [
  ['AWS access key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{22,})/],
  ['API key', /\b(?:sk-(?=[\w-]*\d)[\w-]{20,}|[spr]k_(?:live|test)_[A-Za-z0-9]{16,})/],
  ['Google API key', /\bAIza[\w-]{35}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['JWT', /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/]{40}/],
  ['password in a URL', /\b[a-z][\w+.-]*:\/\/[^\s:/@'"`]+:(?![$<{%*])[^\s/@'"`]+@/i],
];
// Credential-named keys must hold an environment reference, never a value: any literal
// (long, short, or numeric) and any YAML block scalar refuses the capture, and problems
// name the key and line only, never the value. The ONLY exemption is numeric token-budget
// metadata on exactly a maxTokens/max-tokens/max_tokens key (MAX_TOKEN_KEY); arbitrary
// max-prefixed credentials are scanned like any other. JSON is parsed (jsonProblems) so
// unicode-escaped key spellings cannot rename a credential past the scan.
const SECRET_NAME = 'api[_-]?key|secret|token|passw(?:or)?d|authorization|credential|private[_-]?key';
const SECRET_KEY = new RegExp(`["']?([\\w.-]*(?:${SECRET_NAME})[\\w.-]*)["']?[ \\t]*:[ \\t]*`, 'gi');
// Escaped key spellings cannot hide: every .yml CONFIG item must also satisfy the
// fail-closed yamlProblems gate in lib/data.mjs, which refuses syntax the raw bytes can't decode.
const SECRET_NAME_RE = new RegExp(SECRET_NAME, 'i');
const MAX_TOKEN_KEY = /^max[_-]?tokens?$/i;

// One complete $VAR or ${VAR} reference - never mismatched braces - with optional
// surrounding quotes and an optional Bearer/Basic prefix. Only an empty string passes
// without a reference: 'true'/'null' and "Bearer null" are strings, and strings refuse.
// Actual booleans/null are handled per syntax by the callers (typed in JSON, unquoted
// in YAML); they never reach here as inert spellings.
const scalarProblem = value => {
  let v = value.trim();
  const q = v.length > 1 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]) ? v[0] : '';
  if (q) v = v.slice(1, -1).trim();
  v = v.replace(/^(?:bearer|basic)[ \t]+/i, '');
  return !v || /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(v)
    ? null : 'holds a literal value; reference an env var instead';
};
// The YAML scalar of a raw value: a " # comment" tail (or a bare "#..." comment) is
// commentary, not value, so `key: $VAR # note` and `key: # note` stay valid.
const yamlScalar = value => value.trim().replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
// Judges a comment-stripped scalar (yamlScalar). A block indicator (|, >, with
// chomping/indent digits) hides the value and refuses. An unquoted true/false/null/~ is
// a real boolean/null scalar and stays inert; the same spelling quoted is a string and
// refuses. Anything else must be an empty or complete env reference.
const yamlValueProblem = v => {
  if (/^[|>][0-9+-]*$/.test(v)) return 'holds a YAML block; reference an env var instead';
  if (/^(?:true|false|null|~)$/i.test(v)) return null;
  return scalarProblem(v);
};
// `key:` with no value can still receive a plain multiline literal from a deeper line
// below it; the first meaningful line decides, and deeper means the secret holds one.
const continuationProblem = (lines, i, keyIndex) => {
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (!l || l.startsWith('#')) continue;
    return lines[j].length - lines[j].trimStart().length > keyIndex
      ? 'holds an indented multiline value; reference an env var instead' : null;
  }
  return null;
};
// mcp.json: parse-based scan so escaped keys resolve before matching; invalid JSON
// refuses. Problems name the field only, never the value.
const jsonProblems = (text, say) => {
  let doc;
  try { doc = JSON.parse(text); } catch { say('is not valid JSON'); return; }
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (SECRET_NAME_RE.test(key)) {
        const bad = typeof value === 'string' ? scalarProblem(value)
          : typeof value === 'number' ? 'holds a numeric literal; reference an env var instead'
          : typeof value === 'boolean' || value === null ? null
          : 'holds a nested value; use a flat env reference';
        // Numeric token-budget metadata on exactly a maxTokens-style key is exempt.
        if (bad && !(MAX_TOKEN_KEY.test(key) && typeof value === 'number')) say(`"${key}" ${bad}`);
      }
      visit(value);
    }
  };
  visit(doc);
};

// Stale-output listing: never reuses the source walker. The output tree is data-repo
// state, so an unexpected link or special file there refuses the capture; lstat never
// follows, which also makes junction cycles impossible to enter.
const listOutput = (dir, sub = '') => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = sub ? `${sub}/${name}` : name;
    const lst = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (!lst) throw new Error(`user/${rel} disappeared while listing stale outputs`);
    if (lst.isSymbolicLink()) throw new Error(`user/${rel} is a link in the output tree; remove it by hand first`);
    if (lst.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...listOutput(join(dir, name), rel));
    } else if (!lst.isFile()) throw new Error(`user/${rel} is not a regular file; remove it by hand first`);
    else out.push(rel);
  }
  return out;
};
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Membership anchors: the allowlisted item paths joined to the CANONICAL home. A link
// is safe only when its canonical target sits on or below one of these lexical paths -
// never because some other item's root happens to resolve to the same target (two item
// roots junctioned onto ~/.omp/oauth both refuse). Anchors stay lexical on purpose:
// assertSourceInside would realpath them straight back through the link. The
// .omp/agent/skills -> .agents/skills bridge stays allowed: its target IS an item path.
const realHome = realpathSync.native(home);
const itemRoots = ITEMS.map(item => join(realHome, item));
const anchored = p => itemRoots.some(root => {
  const rel = relative(root, p);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
});
// Depth-first capture of one allowlisted item directory. Every component is checked
// BEFORE descent: a link must resolve and land on an allowlisted item anchor; dangling
// links, special files and recursion cycles refuse the whole capture. Recursion
// ancestors are the canonical directories on the current descent path only - no global
// dedup, so ordinary aliases across independent items never mask a real cycle.
const captureDir = (abs, rel, root) => {
  const out = [];
  const visit = (abs, rel, ancestors) => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      const childRel = `${rel}/${name}`;
      const lst = lstatSync(child, { throwIfNoEntry: false });
      if (!lst) throw new Error(`~/${childRel}: disappeared while scanning`);
      let real;
      try { real = realpathSync.native(child); }
      catch { throw new Error(`~/${childRel}: is a dangling link (target missing)`); }
      if (lst.isSymbolicLink() && !anchored(real))
        throw new Error(`~/${childRel}: link resolves outside the allowlisted capture roots; fix or remove the link`);
      const st = statSync(child, { throwIfNoEntry: false });
      if (!st) throw new Error(`~/${childRel}: disappeared while scanning`);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (ancestors.has(real)) throw new Error(`~/${childRel}: recursion cycle through links`);
        visit(child, childRel, new Set(ancestors).add(real));
      } else if (!st.isFile()) throw new Error(`~/${childRel}: is not a regular file`);
      else out.push([childRel, readFileSync(child)]);
    }
  };
  visit(abs, rel, new Set([root]));
  return out;
};

const problems = [];
const plan = [];
for (const item of ITEMS) {
  const src = join(home, item);
  if (!existsSync(src)) {
    if (!OPTIONAL.has(item)) problems.push(`~/${item} is missing (fix ITEMS in sync-user.mjs or pass --home)`);
    continue;
  }
  try {
    // The item root is allowlisted but not separately chosen, so it too must stay inside
    // the canonical home; a linked root must additionally land on an allowlisted item.
    assertSourceInside(home, src);
    const root = realpathSync.native(src);
    if (!anchored(root)) {
      throw new Error(`~/${item}: resolves outside the allowlisted capture roots through a link; fix or remove the link`);
    }
    const st = statSync(src);
    if (!st.isDirectory() && !st.isFile()) throw new Error(`~/${item}: is not a regular file`);
    const found = st.isDirectory() ? captureDir(src, item, root) : [[item, readFileSync(src)]];
    for (let [rel, bytes] of found) {
      let text = bytes.toString('utf8');
      if (rel === '.omp/agent/config.yml') {
        for (const p of yamlProblems(text, rel)) problems.push(p);
        // Deployment settings stay on the target, not in the portable user layer; the shared
        // rule keeps the last kept line's terminator, so install-user compares like against like.
        text = withoutDeploymentBlocks(text);
        bytes = Buffer.from(text);
      }
      for (const [name, shape] of SHAPES) {
        const hit = shape.exec(text);
        if (hit) problems.push(`~/${rel}:${lineOf(text, hit.index)}: possible ${name}`);
      }
      if (CONFIG.includes(rel)) {
        if (rel.endsWith('.json')) jsonProblems(text, msg => problems.push(`~/${rel}: ${msg}`));
        else {
          const lines = text.split('\n');
          lines.forEach((line, i) => {
            SECRET_KEY.lastIndex = 0;
            let hit;
            while ((hit = SECRET_KEY.exec(line))) {
              const v = yamlScalar(line.slice(hit.index + hit[0].length));
              let bad = yamlValueProblem(v);
              if (!bad && v === '') bad = continuationProblem(lines, i, hit.index);
              // Numeric token-budget metadata on exactly a maxTokens-style key is exempt.
              if (bad && !(MAX_TOKEN_KEY.test(hit[1]) && /^-?\d+(?:\.\d+)?$/.test(v)))
                problems.push(`~/${rel}:${i + 1}: ${hit[1]} ${bad}`);
            }
          });
        }
      }
      plan.push([rel.replace(/^\./, ''), bytes]);
    }
  } catch (err) {
    problems.push(err.message.startsWith('~/') ? err.message : `~/${item}: ${err.message}`);
  }
}
if (problems.length) {
  console.error(`Nothing synced. Fix:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// Repos use autocrlf; compare modulo CRLF so checkouts and machine copies never churn each other.
const norm = b => b.toString('latin1').replaceAll('\r\n', '\n');
try {
  // Stale names are collected and the output tree validated BEFORE any write, so a
  // stale-tree error refuses the whole capture and leaves the prior snapshot untouched.
  const wanted = new Set(plan.map(([rel]) => rel));
  const stale = existsSync(join(data.dir, 'user'))
    ? listOutput(join(data.dir, 'user')).filter(rel => !wanted.has(rel)) : [];
  // Two passes: every planned destination is preflighted (and its old bytes staged)
  // before the first write, so a bad destination refuses the whole capture untouched.
  const staged = [];
  let added = 0, updated = 0, unchanged = 0;
  for (const [rel, bytes] of plan) {
    const to = join(data.dir, 'user', rel);
    checkDestination(data.dir, to);
    const old = existsSync(to) ? readFileSync(to) : null;
    if (old && (old.equals(bytes) || norm(old) === norm(bytes))) { unchanged++; continue; }
    staged.push([rel, to, bytes, old]);
  }
  for (const [rel, to, bytes, old] of staged) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
    if (old) { updated++; console.log(`updated  user/${rel}`); }
    else { added++; console.log(`added    user/${rel}`); }
  }
  for (const rel of stale) console.log(`note: user/${rel} is gone from this machine; delete it by hand if stale`);
  console.log(`${added} added, ${updated} updated, ${unchanged} unchanged from ${home}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
// ponytail: stale copies are reported, never deleted (like sync-projects.mjs); add --prune if removals get common.
// ponytail: third-party skills are vendored whole (a large one is ~1.6 MB per update); if that bloats history,
// copy only the skills missing from .skill-lock.json and reinstall the rest from their recorded sources.
