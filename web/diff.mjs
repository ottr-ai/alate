// Line diff for the editor's proof marks. Shared by web/app.js (browser) and server.test.mjs (node).

// Hunks of b against a: { start (index in b), count (lines in b), old (lines from a) }.
// count 0 is a pure deletion before line `start`; old [] is a pure addition.
export function diffLines(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  if (!A.length && !B.length) return [];
  // ponytail: O(n*m) LCS on the changed middle; one hunk past 1M cells. Use Myers if large edits get common.
  if (A.length * B.length > 1e6) return [{ start: p, count: B.length, old: A }];
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, cur = null;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { if (cur) hunks.push(cur); cur = null; i++; j++; continue; }
    cur = cur || { start: p + j, count: 0, old: [] };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { cur.count++; j++; } else { cur.old.push(A[i]); i++; }
  }
  if (cur) hunks.push(cur);
  return hunks;
}
