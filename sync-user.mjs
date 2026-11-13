#!/usr/bin/env node
// Captures this machine's omp user layer (settings, MCP servers, plugin manifests, skills, extensions) into user/.
// Usage: node sync-user.mjs [--home <dir>] [--data <dir>]   (home default: the current user's home; data default: ../agent-data)
// Direction is machine -> data repo: omp rewrites its own config, so the machine stays the source of truth
// and user/ holds refreshed copies, never hand-edited. Paths mirror the home directory minus the leading dot
// (~/.omp/agent/config.yml -> user/omp/agent/config.yml), so no harness loads the copies as live config.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceInside, CAPTURE_ROOTS, checkDestination, fingerprint, parseArgs, readBaselines, resolveDataDir, toStoredForm, withoutDeploymentBlocks, withoutHostPaths, withoutMemoryBackend, writeBaselines, yamlProblems } from './lib/data.mjs';
import { SHIPPED_SKILLS_DIR, shippedSkills } from './lib/shipped.mjs';

/** @typedef {{ values: Record<string, string | undefined>, flags: Set<string>, positional: string[] }} CliArgs */
/** @typedef {[string, Buffer, string]} CapturedFile */

// --repo is a valued option so resolveDataDir can refuse cloning with the capture-specific
// message; capture takes no flags and no positional arguments.
const args = /** @type {CliArgs} */ (parseArgs(process.argv.slice(2), ['--home', '--data', '--repo']));
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
// No item is required: a missing ITEMS entry is 'not present', never an error, because every
// omp home differs and a fresh one misses most entries. Refusal stays for secrets and
// unreadable files only; ITEMS remains the allowlist of what may be captured.
// Shapes of real credentials (codeguard-1-hardcoded-credentials), not words: docs that only mention keys still sync.
/** @type {[string, RegExp][]} */
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
/** @param {string} value @param {string} [fix] @returns {string | null} */
const scalarProblem = (value, fix = 'reference an env var instead') => {
  let v = value.trim();
  const q = v.length > 1 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]) ? v[0] : '';
  if (q) v = v.slice(1, -1).trim();
  v = v.replace(/^(?:bearer|basic)[ \t]+/i, '');
  return !v || /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(v)
    ? null : `holds a literal value; ${fix}`;
};
// The YAML scalar of a raw value: a " # comment" tail (or a bare "#..." comment) is
// commentary, not value, so `key: $VAR # note` and `key: # note` stay valid.
/** @param {string} value @returns {string} */
const yamlScalar = value => value.trim().replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
// Judges a comment-stripped scalar (yamlScalar). A block indicator (|, >, with
// chomping/indent digits) hides the value and refuses. An unquoted true/false/null/~ is
// a real boolean/null scalar and stays inert; the same spelling quoted is a string and
// refuses. Anything else must be an empty or complete env reference.
/** @param {string} v @returns {string | null} */
const yamlValueProblem = v => {
  if (/^[|>][0-9+-]*$/.test(v)) return 'holds a YAML block; reference an env var instead';
  if (/^(?:true|false|null|~)$/i.test(v)) return null;
  return scalarProblem(v);
};
// `key:` with no value can still receive a plain multiline literal from a deeper line
// below it; the first meaningful line decides, and deeper means the secret holds one.
/** @param {string[]} lines @param {number} i @param {number} keyIndex @returns {string | null} */
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
/** @param {string} text @param {(message: string) => void} say @returns {void} */
const jsonProblems = (text, say) => {
  let doc;
  try { doc = JSON.parse(text); } catch { say('is not valid JSON'); return; }
  /** @param {any} node */
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (SECRET_NAME_RE.test(key)) {
        // mcp.json names the concrete fix: quote the env reference in the JSON, put the
        // name in the project's env.txt, and set its value once in Ottr's Settings -> Env.
        const bad = typeof value === 'string'
          ? scalarProblem(value, 'use "$VAR" in mcp.json, put the name VAR in workers/<project>/env.txt, and set it in Ottr Settings -> Env')
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
/** @param {string} dir @param {string} [sub] @returns {string[]} */
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
/** @param {string} text @param {number} index @returns {number} */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Membership anchors: the allowlisted item paths joined to the CANONICAL home. A link
// is safe only when its canonical target sits on or below one of these lexical paths -
// never because some other item's root happens to resolve to the same target (two item
// roots junctioned onto ~/.omp/oauth both refuse). Anchors stay lexical on purpose:
// assertSourceInside would realpath them straight back through the link. The
// .omp/agent/skills -> .agents/skills bridge stays allowed: its target IS an item path.
const realHome = realpathSync.native(home);
const itemRoots = ITEMS.map(item => join(realHome, item));
/** @param {string} p @returns {boolean} */
const anchored = p => itemRoots.some(root => {
  const rel = relative(root, p);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
});
// Depth-first capture of one allowlisted item directory. Every component is checked
// BEFORE descent: a link must resolve and land on an allowlisted item anchor; dangling
// links, special files and recursion cycles refuse the whole capture. Recursion
// ancestors are the canonical directories on the current descent path only - no global
// dedup, so ordinary aliases across independent items never mask a real cycle.
/** @param {string} abs @param {string} rel @param {string} root @returns {CapturedFile[]} */
const captureDir = (abs, rel, root) => {
  /** @type {CapturedFile[]} */
  const out = [];
  /** @param {string} abs @param {string} rel @param {Set<string>} ancestors */
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
      else out.push([childRel, readFileSync(child), `${st.dev}:${st.ino}`]);
    }
  };
  visit(abs, rel, new Set([root]));
  return out;
};

// Credential gates key on the canonical ORIGIN of the bytes, never the capture-relative
// path: a link inside an item may alias a CONFIG file (its target is an item anchor, so
// the walk allows it), and the aliased copy must pass the same deployment-strip and
// secret gates as the canonical capture, or the strip's credential control never runs.
// The origin is the file identity (dev:ino), not its path: a symlink resolves to the
// target's identity and a hard link shares it, so both alias kinds match the canonical
// capture where a realpath key would miss a hard link. A missing CONFIG item resolves
// nowhere and is reported by the ITEMS loop below.
/** @type {Map<string, string>} */
const configOrigins = new Map();
for (const item of CONFIG) {
  try {
    const st = statSync(join(realHome, item));
    configOrigins.set(`${st.dev}:${st.ino}`, item);
  } catch { /* missing: the item is absent, so nothing aliases it */ }
}

// The vendored shipped skills (lib/shipped.mjs) install to .agents/skills/<name> on every
// provision, and the capture must never copy them back into the data repo: a captured copy
// sits at user/agents/skills/<name> with no recorded origin, so the next provision rejects
// it — and a gate-rejected copy also suppressed the shipped install, so the round trip
// deleted the shipped skills from the home (ALAT-124). A name leaves out only when its
// bytes equal the vendored copy — same file list, byte-identical files; an edited skill
// still captures, because a machine edit is state the data repo must hold. Computed
// lazily: a home without .agents/skills never reads the vendored tree. Fail closed, like
// install-user: with the tree unreadable the shipped set is unknown, and copying every
// child back is exactly the bug this gate exists to stop, so the capture refuses.
const toolRoot = dirname(fileURLToPath(import.meta.url));
let shippedDirs = /** @type {Map<string, string> | null} */ (null);
let shippedProblem = /** @type {string | null} */ (null);
/** @returns {Map<string, string> | null} */
const vendoredShipped = () => {
  if (shippedDirs !== null || shippedProblem !== null) return shippedDirs;
  try {
    shippedDirs = new Map(shippedSkills(toolRoot).map(s => [s.name, s.dir]));
  } catch (err) {
    shippedProblem = `~/.${SHIPPED_SKILLS_DIR}: the vendored shipped skills tree is missing or unreadable (/** @type {Error} */ (err).message); copying .agents/skills back would capture the shipped skills into the data repo, and a provision with upstreams.json would then delete them from the home`;
  }
  return shippedDirs;
};
// The vendored skill's files as [rel, bytes], with the same SKIP_DIRS rule as captureDir,
// so the comparison sees the same file set. A special file (null bytes) or an unreadable
// tree never compares equal, so the skill captures.
/** @param {string} dir @returns {[string, Buffer | null][]} */
const vendoredFiles = dir => {
  /** @type {[string, Buffer | null][]} */
  const out = [];
  /** @param {string} d @param {string} sub */
  const visit = (d, sub) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      const child = join(d, entry.name);
      if (entry.isDirectory()) visit(child, rel);
      else if (entry.isFile()) out.push([rel, readFileSync(child)]);
      else out.push([rel, null]);
    }
  };
  visit(dir, '');
  return out;
};

// Skill roots among the capture items: install-user writes the shipped skills to
// .agents/skills, and a home may bridge .omp/agent/skills -> .agents/skills (a supported
// shape), so the vendored bytes can sit under either root; managed-skills is the same
// class of home content. Every skill root gets the shipped-equality filter, or the bridge
// would capture each shipped skill as user/omp/agent/skills/<name> — no recorded origin,
// so the next provision rejects it and can delete it from the home.
const SKILL_ITEMS = new Set([SHIPPED_SKILLS_DIR, '.omp/agent/skills', '.omp/agent/managed-skills']);

/** @type {string[]} */
const problems = [];
/** @type {[string, Buffer][]} */
const plan = [];
/** @type {string[]} */
const summary = [];
let present = 0;
for (const item of ITEMS) {
  const src = join(home, item);
  if (!existsSync(src)) {
    summary.push(`~/${item}: not present`);
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
    /** @type {CapturedFile[]} */
    let found = st.isDirectory() ? captureDir(src, item, root) : [[item, readFileSync(src), `${st.dev}:${st.ino}`]];
    if (SKILL_ITEMS.has(item) && st.isDirectory()) {
      const shipped = vendoredShipped();
      if (shippedProblem) problems.push(shippedProblem);
      if (shipped) {
        // Group the capture entries under each shipped name; children outside the vendored
        // set and top-level files keep their entries untouched.
        /** @type {Map<string, [string, Buffer, CapturedFile][]>} */
        const groups = new Map();
        /** @type {CapturedFile[]} */
        const kept = [];
        const prefix = `${item}/`;
        for (const entry of found) {
          const rest = entry[0].startsWith(prefix) ? entry[0].slice(prefix.length) : null;
          const slash = rest === null ? -1 : rest.indexOf('/');
          const name = slash > 0 ? /** @type {string} */ (rest).slice(0, slash) : null;
          if (name === null || !shipped.has(name)) { kept.push(entry); continue; }
          if (!groups.has(name)) groups.set(name, []);
          /** @type {[string, Buffer, CapturedFile][]} */ (groups.get(name)).push([/** @type {string} */ (rest).slice(slash + 1), entry[1], entry]);
        }
        const skipped = [];
        for (const [name, files] of groups) {
          const byRel = new Map(vendoredFiles(/** @type {string} */ (shipped.get(name))));
          const equal = files.length === byRel.size && files.every(([rel, bytes]) => {
            const v = byRel.get(rel);
            return v !== undefined && v !== null && bytes.equals(v);
          });
          if (equal) skipped.push(name);
          else for (const file of files) kept.push(file[2]);
        }
        skipped.sort();
        for (const name of skipped)
          console.log(`note: user/${item.replace(/^\./, '')}/${name}: the bytes equal the vendored shipped copy; left out of the capture`);
        found = kept;
      }
    }
    for (let [rel, bytes, origin] of found) {
      const configItem = configOrigins.get(origin); // origin of the bytes, not the path
      // Absolute paths of either platform form store under the snapshot home before any
      // gate, so a sync from Windows and from Linux write equal bytes and the gates judge
      // the stored text.
      if (rel.endsWith('.json')) {
        const stored = toStoredForm(rel, bytes, { roots: CAPTURE_ROOTS });
        for (const note of stored.notes) console.log('note: ~/' + note);
        bytes = stored.bytes;
      }
      let text = bytes.toString('utf8');
      if (configItem !== undefined && configItem.endsWith('.yml')) {
        // Machine-only content leaves FIRST: deployment settings stay on the target, the
        // memory backend is injected at spawn with a --config overlay, and the host shell
        // setup (shellPath, skills.customDirectories) names absolute paths of the capture
        // machine. omp writes customDirectories as a flow list, which the fail-closed syntax
        // gate below cannot decode, so the gate must judge the portable text the strips
        // produce, never the machine's raw bytes — an entry the strip removes cannot refuse
        // the whole capture, and syntax the strips keep still refuses. The shared terminator
        // rule keeps the last kept line's line end, so install-user compares like against like.
        text = withoutDeploymentBlocks(text);
        text = withoutMemoryBackend(text);
        const portable = withoutHostPaths(text);
        if (portable !== text) console.log(`note: user/${rel.replace(/^\./, '')}: dropped the machine shell setup (shellPath, skills.customDirectories)`);
        text = portable;
        for (const p of yamlProblems(text, rel)) problems.push(p);
        bytes = Buffer.from(text);
      }
      for (const [name, shape] of SHAPES) {
        const hit = shape.exec(text);
        if (hit) problems.push(`~/${rel}:${lineOf(text, hit.index)}: possible ${name}`);
      }
      if (configItem !== undefined) {
        if (configItem.endsWith('.json')) jsonProblems(text, msg => problems.push(`~/${rel}: ${msg}`));
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
    present++;
    summary.push(`~/${item}: captured`);
  } catch (err) {
    problems.push(/** @type {Error} */ (err).message.startsWith('~/') ? /** @type {Error} */ (err).message : `~/${item}: ${/** @type {Error} */ (err).message}`);
  }
}
if (problems.length) {
  console.error(`Nothing synced. Fix:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
for (const line of summary) console.log(line);
// Nothing present means nothing to write: leave the data repo untouched.
if (!present) {
  console.log('nothing to capture');
  process.exit(0);
}

// Capture baselines (specs/capture-baseline.md): per captured file, a fingerprint of the
// snapshot bytes this machine last wrote. The record tells a machine edit (capture) from a
// snapshot that changed elsewhere (keep the committed snapshot; the next provision brings
// it to the machine — the capture never writes the home). When both moved, the file is a
// conflict and the run writes nothing: it never picks a side silently.
const statePath = join(home, '.alate', 'captured-user.json');
let baselines;
let stateUsable = true;
try {
  baselines = readBaselines(statePath);
} catch (err) {
  baselines = null;
  stateUsable = false;
  console.log(`note: ${statePath} is not a valid capture baseline (${/** @type {Error} */ (err).message}); every file counts as having no baseline`);
}

// Repos use autocrlf: the comparison shares the CRLF normalize rule with the fingerprints.
try {
  // Stale names are collected and the output tree validated BEFORE any write, so a
  // stale-tree error refuses the whole capture and leaves the prior snapshot untouched.
  const wanted = new Set(plan.map(([rel]) => rel));
  const stale = existsSync(join(data.dir, 'user'))
    ? listOutput(join(data.dir, 'user')).filter(rel => !wanted.has(rel)) : [];
  // Two passes: every planned destination is preflighted (and its old bytes staged)
  // before the first write, so a bad destination refuses the whole capture untouched.
  /** @type {[string, string, Buffer, Buffer | null][]} */
  const staged = [];
  const conflicts = [];
  /** @type {Record<string, string>} */
  const updates = {};
  const keptNotes = [];
  let added = 0, updated = 0, unchanged = 0, kept = 0, noBase = 0;
  for (const [rel, bytes] of plan) {
    const to = join(data.dir, 'user', rel);
    checkDestination(data.dir, to);
    const old = existsSync(to) ? readFileSync(to) : null;
    const fpMachine = fingerprint(rel, bytes);
    const fpSnap = old ? fingerprint(rel, old) : null;
    const base = baselines ? baselines[rel] ?? null : null;
    if (old && fpMachine === fpSnap) { // unchanged: seed the baseline so the next run can judge
      unchanged++;
      if (stateUsable && base !== fpMachine) updates[rel] = fpMachine;
      continue;
    }
    if (old && base !== null && base !== fpMachine && base !== fpSnap) {
      conflicts.push({ rel, to });
      continue;
    }
    if (old && fpMachine === base) { // the committed snapshot moved; the machine still holds the captured state
      kept++;
      keptNotes.push(`note: user/${rel}: the committed snapshot changed elsewhere and this machine still holds the captured state; kept the snapshot (provision the machine to get it)`);
      continue;
    }
    // capture: a machine edit, a first run, or a snapshot file missing in the data repo
    staged.push([rel, to, bytes, old]);
    if (stateUsable) updates[rel] = fpMachine;
    if (base === null) noBase++;
  }
  if (conflicts.length) {
    for (const { rel, to } of conflicts)
      console.error(`conflict: the snapshot ${to} and the machine file ${join(home, `.${rel}`)} both changed since the last capture; resolve by hand`);
    process.exit(1);
  }
  for (const note of keptNotes) console.log(note);
  for (const [rel, to, bytes, old] of staged) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
    if (old) { updated++; console.log(`updated  user/${rel}`); }
    else { added++; console.log(`added    user/${rel}`); }
  }
  if (noBase) console.log(`note: ${noBase} captured files had no baseline and were captured as today`);
  for (const rel of stale) console.log(`note: user/${rel} is gone from this machine; delete it by hand if stale`);
  console.log(`${added} added, ${updated} updated, ${unchanged} unchanged${kept ? `, ${kept} kept` : ''} from ${home}`);
  if (stateUsable && Object.keys(updates).length) {
    try {
      writeBaselines(statePath, { ...baselines, ...updates });
    } catch (err) {
      console.log(`note: ${statePath}: could not write the capture baseline (${/** @type {Error} */ (err).message}); the next capture runs without one`);
    }
  }
} catch (err) {
  console.error(/** @type {Error} */ (err).message);
  process.exit(1);
}
// ponytail: stale copies are reported, never deleted (like sync-projects.mjs); add --prune if removals get common.
// ponytail: third-party skills are vendored whole (a large one is ~1.6 MB per update); if that bloats history,
// copy only the skills missing from .skill-lock.json and reinstall the rest from their recorded sources.
