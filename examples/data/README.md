# Starter data repo for alate

This repo is the CI fixture for the install flow and a starter you can copy.
Copy it into a new private GitHub repo, then fill it with your own data.

## Data repo layout

- Root `*.md` files (except `README.md`): rules, each with a `description:` frontmatter line.
- `user/`: home-relative snapshot of the machine's omp user layer (see the main README).
- `projects/`: per-project agent context snapshots, driven by `projects/projects.json`.
- `upstreams.json`: where every public item came from; `own` lists self-written paths.

## First run

1. Copy this folder into a new private GitHub repo and push it.
2. Fill it from a machine with a working omp setup: `node sync-user.mjs --data <repo>` (and `node sync-projects.mjs`).
3. Start the server: `docker compose up -d`.
4. Open http://127.0.0.1:4570, import `owner/name` with a GitHub token, provision.
