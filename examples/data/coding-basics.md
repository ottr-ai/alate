---
description: Basic working habits for every coding task
---
# Coding basics

- Read the code around your change before you edit. Follow the local style.
- Keep diffs small and focused. One change per commit. No drive-by refactors.
- Reuse helpers that already exist. Do not add a dependency for a few lines.
- No fake success. Do not delete, skip, or weaken a test to make it pass.
- Do not hide errors. Surface them. A broad catch is a bug, not a fix.
- Run the tests and the type check before you hand off. Read the output.
- Report only what you verified. Say so when a result is partial or untested.
- Mark a deliberate shortcut with a comment. Name its limit and the upgrade path.
