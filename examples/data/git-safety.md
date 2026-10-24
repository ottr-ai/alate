---
description: Rules that keep git history and secrets safe
---
# Git safety

- Never force-push, not even to your own branch, unless the repo owner asks.
- Never commit secrets, tokens, keys, or personal data. Read `.env` files only for the task.
- Review the working tree and the diff before every commit. Stage explicit paths.
- Commits and pushes need an explicit ask from the user. Wait for it.
- Ask before you delete data, run migrations, deploy, or touch production. Show the targets first.
- Keep parallel work in separate branches or worktrees. Never share one checkout.
- History is shared. Treat it as write-once: no reset --hard, no rebase of public branches.
