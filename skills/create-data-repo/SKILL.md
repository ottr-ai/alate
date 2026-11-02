---
name: create-data-repo
description: Create a new user's private agent-data repo for Alate from this machine's omp setup. Use when the user wants to start with Alate or Ottr from an existing machine instead of copying examples/data and running the capture scripts by hand.
---

# Create a data repo from this machine

This skill builds a private GitHub data repo for alate from the omp setup on this
machine. It copies the starter from `examples/data`, captures the user layer, scans
for secrets, and asks before every step outside this machine.

Rules that never change:

- Never create a public repo.
- Never commit a secret.
- Run a step outside this machine only after the user says yes.

## 1. Check the prerequisites

Check each item in this order. Stop and report when one fails.

1. Node 24.12 or later. Run `node --version`.
2. git. Run `git --version`.
3. gh, logged in. Run `gh auth status`.
4. An alate checkout. Ask the user for the path. When they have none, clone one:
   `git clone --depth 1 https://github.com/ottr-ai/alate <temp folder>/alate`
   Use this copy for the scripts below.

Call this checkout path ALATE below.

## 2. Choose the repo and the folder

1. Run `gh api user --jq .login` for the GitHub user name.
2. Ask the user for the repo name. Suggest `<user>/agent-data`.
3. Confirm one point with the user: the repo will be PRIVATE on GitHub. Refuse a public repo. Stop when the user still wants one.
4. Ask for the local folder for the repo. Suggest `<home>/agent-data`. Call this folder FOLDER below.

## 3. Copy the starter and capture

1. Copy the whole `<ALATE>/examples/data` tree into FOLDER.
2. Run `node <ALATE>/sync-user.mjs --data <FOLDER>`.
3. A failure stops this skill. Show the error.
4. Ask the user. When they agree, run `node <ALATE>/sync-projects.mjs --data <FOLDER>`. Skip it when they say no.

## 4. Scan for secrets

Run the scan before any commit. The script sits beside this SKILL.md file:

`node <skill folder>/scan-secrets.mjs <FOLDER>`

1. Show the user the file list from the output. This is what a commit would hold.
2. A `finding` line stops this skill. Show the file and the reason. Never show the value. Ask the user to remove the file or fix the capture. Then start again at step 3.
3. Never commit a secret.

## 5. Confirm and publish

Show the summary from the scan output: rules, skills, plugins, captured user files,
projects. Then run these steps one by one. Ask before each one. Run a step only on a
yes.

1. `git init` in FOLDER.
2. `git add .` and `git commit -m "capture from this machine"` in FOLDER.
3. `gh repo create <owner/name> --private --source . --remote origin` in FOLDER.
4. `git push -u origin HEAD` in FOLDER.

A failed step stops this skill. Show the error.

## 6. Tell the user the next steps

1. Point alate at the repo. Open the dashboard at http://127.0.0.1:4570 and import `owner/name` with a GitHub token. In Ottr, use Settings -> Alate.
2. Seed the Ottr board: `docker compose run --rm board-seed --repo <owner/name>`
