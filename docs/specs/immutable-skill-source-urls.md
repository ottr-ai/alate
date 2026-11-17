# Immutable skill source URLs

## Behavior

The update checker accepts HTTPS repository URLs on `github.com`, with an optional `.git` suffix and trailing slash.
It also accepts `https://github.com/<owner>/<repo>/tree/<commit>/<path>` with a full 40-character hexadecimal commit.
The parser extracts only the owner and repository.
The skill lock retains its original `sourceUrl`.
The update checker uses the lock's `ref` and `skillPath`, not the URL's commit or path, for upstream checks.

## Boundaries and errors

Reject foreign hosts, credentials, ports, query strings, fragments, whitespace, backslashes, and malformed URLs.
Reject empty path segments, literal or encoded traversal, invalid repository names, and non-commit tree references.
Reject non-string input.
An invalid source produces the existing source URL error row before any upstream request for that source.
The shared parser retains the existing release and path check behavior for valid repository URLs.

## Assumptions

An immutable commit means a full Git SHA-1, not a branch, tag, or shortened hash.
A tree URL needs at least one path segment after the commit.
URL parsing follows the existing raw HTTPS GitHub URL match and repository name conventions.
Validation rejects traversal before any URL normalization.
The public test seam is `checkUpdates` with an in-memory snapshot and the existing GitHub endpoint stubs.

## Acceptance checks

- The exact AGEN-102 lock entry produces a normal `modern-web-guidance` update row.
- Bare repository URLs and `.git` URLs retain normal update rows.
- Request assertions prove that `ref` and `skillPath` control upstream checks.
- Invalid URLs produce errors without requests to their hosts.
- Deterministic properties check repository extraction and rejection through update rows.
- Run `node server.test.mjs` and the required work-turn chain after `npm ci`.
- Skip mutation gates in this work turn.

## Non-goals

Do not change agent-data, dependencies, the dashboard, import behavior, provisioning, or the immutable source pin.
Do not add support for arbitrary GitHub web URLs, other hosts, tags in tree URLs, or shortened commits.
