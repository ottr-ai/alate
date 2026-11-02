#!/usr/bin/env node
// Secret scan for a data-repo folder before its first commit. Usage: node scan-secrets.mjs <data-folder>
// Prints every scanned file (the list the user reviews before git add), findings as path:line: reason
// (never the value), and a short summary (rules, skills, plugins, captured user files, projects).
// Exit 0 clean, 1 on any finding (the caller must stop and ask, never commit), 2 on usage or IO errors.
// The content shapes mirror sync-user.mjs's SHAPES, so both scans refuse the same credentials; the
// file-name checks catch formats no shape can (.env files, key files, auth databases, oauth folders).
// Plain node only, like every other script.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const die = message => { console.error(message); process.exit(2); };
const folder = process.argv[2];
if (!folder || process.argv.length !== 3) die('usage: node scan-secrets.mjs <data-folder>');

// Same shapes as sync-user.mjs (SHAPES); keep the two lists in step. A hit prints the
// shape name and the position only, never the value.
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

// Names that are secrets by convention: no shape scan can vouch for these formats,
// so the file itself is the finding. Stop-and-ask favors a false alarm here.
const secretFile = name => {
  const base = basename(name).toLowerCase();
  const ext = extname(base);
  if (base === '.env' || base.startsWith('.env.') || ext === '.env') return 'env file (holds values, never $ENV references)';
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.[a-z0-9]+)?$/.test(base)) return 'SSH private key file';
  if (base === 'credentials') return 'credentials file';
  if (ext === '.pem' || ext === '.key') return 'key file';
  if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') return 'auth database file (for example agent.db)';
  return null;
};

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const files = [];
const findings = [];

// Depth-first walk. Links are findings on purpose: the capture scripts never write one,
// so a link here points somewhere the file list cannot vouch for. .git and node_modules
// stay out, like in the capture scripts.
const walk = (dir, rel = '') => {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const child = join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = lstatSync(child, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      findings.push({ rel: childRel, line: 0, reason: 'symbolic link (a capture never writes one; check where it points)' });
    } else if (st.isDirectory()) {
      if (name.toLowerCase() === 'oauth') findings.push({ rel: childRel, line: 0, reason: 'oauth folder (agent credential store)' });
      walk(child, childRel);
    } else if (st.isFile()) {
      files.push(childRel);
      const byName = secretFile(name);
      if (byName) findings.push({ rel: childRel, line: 0, reason: byName });
      else for (const [label, shape] of SHAPES) {
        const hit = shape.exec(readFileSync(child, 'latin1'));
        if (hit) findings.push({ rel: childRel, line: lineOf(hit.input, hit.index), reason: `possible ${label}` });
      }
    } else findings.push({ rel: childRel, line: 0, reason: 'special file' });
  }
};

try {
  walk(folder);

  const rules = readdirSync(folder, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md').length;
  const skills = files.filter(f => f.startsWith('user/') && basename(f) === 'SKILL.md').length;
  const captured = files.filter(f => f.startsWith('user/')).length;
  let plugins = 0;
  try {
    const pkg = JSON.parse(readFileSync(join(folder, 'user/omp/plugins/package.json'), 'utf8'));
    plugins = Object.keys(pkg.dependencies ?? {}).length;
  } catch { /* a capture without a plugins layer installs none */ }
  let projects = [];
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'projects/projects.json'), 'utf8'));
    projects = Object.keys(manifest.projects ?? {});
  } catch { /* no projects manifest yet */ }

  console.log(`scan: ${folder}`);
  for (const f of files) console.log(`file ${f}`);
  for (const f of findings) console.log(f.line ? `finding ${f.rel}:${f.line}: ${f.reason}` : `finding ${f.rel}: ${f.reason}`);
  console.log(`summary: ${rules} rules, ${skills} skills, ${plugins} plugins, ${captured} captured user files`);
  console.log(`projects: ${projects.length ? projects.join(', ') : 'none'}`);
  if (findings.length) {
    console.log(`clean: no - ${findings.length} finding(s). Stop. Never commit a secret. Remove or fix the findings, then scan again.`);
    process.exit(1);
  }
  console.log('clean: yes - the commit can go ahead after the user confirms');
} catch (err) {
  die(`scan failed: ${err.message}`);
}
