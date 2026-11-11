# Starter data repo for alate

This repo is the CI fixture for the install flow and a starter you can copy.
Copy it into a new private GitHub repo, then fill it with your own data.

## Data repo layout

- Root `*.md` files (except `README.md`): rules, each with a `description:` frontmatter line.
- `user/`: home-relative snapshot of the machine's omp user layer (see the main README).
- `user/omp/agent/skills/`: five bundled example skills (`interrogate`, `blast-radius`, `correct`, `benchmark-checklist`, `code-simplifier`), each recorded in `upstreams.json`.
- `projects/`: per-project agent context snapshots, driven by `projects/projects.json`.
- `upstreams.json`: where every public item came from; `own` lists self-written paths. The MCP servers in `mcp.json` need coverage too: a pinned `npx`, `bunx`, `uvx`, or `pipx run` package gets a `kind: "mcp"` item with an `npm` or `pypi` check. An `own` entry covers a self-written server only when its command is an absolute path under the home and the path matches an `own` glob, never a bare program name such as `uvx` or `npx`.

## Shipped skills

Alate installs every skill folder under Ottr's `.agents/skills` at the pinned commit on every provision, so a fresh install needs no copies of them here. Today this tree holds four skills (`check-ottr-board`, `diff-security-review`, `explain-project`, `ui-ux-check`). A data repo skill of the same name wins: your copy installs, and the shipped copy of that name stays out.

## First run

1. Copy this folder into a new private GitHub repo and push it.
2. Fill it from a machine with a working omp setup: `node sync-user.mjs --data <repo>` (and `node sync-projects.mjs`).
3. Start the server: `docker compose up -d`.
4. Open http://127.0.0.1:4570, import `owner/name` with a GitHub token, provision.
