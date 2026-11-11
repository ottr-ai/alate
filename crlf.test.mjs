// LF gate for the shipped skills: no file under shipped/ may hold a CR byte. The vendored
// skills' SkillSpector baselines are fingerprints over LF bytes, so a CRLF copy in an image
// makes the scan reject findings that the baselines accept. Reads the real vendored files,
// not a fixture. node crlf.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const shipped = join(root, 'shipped');

// Git's binary heuristic: a NUL byte in the first 8000 bytes marks a binary file, and CR
// inside a real binary is normal. `.gitattributes` marks the tracked binaries anyway.
const isBinary = buf => buf.subarray(0, 8000).includes(0);

const offenders = [];
let files = 0;
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    const buf = readFileSync(p);
    files++;
    if (!isBinary(buf) && buf.includes(13)) offenders.push(relative(root, p));
  }
};

assert(existsSync(shipped), 'missing vendored tree: shipped/');
walk(shipped);
offenders.sort();
assert.deepEqual(offenders, [],
  `CR bytes under shipped/ (ship LF only; .gitattributes pins "* text=auto eol=lf"):\n  ${offenders.join('\n  ')}`);
console.log(`crlf: ${files} files under shipped/, no CR byte`);
