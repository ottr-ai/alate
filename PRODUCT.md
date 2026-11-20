# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One operator (the repo owner) who keeps the omp agent setup (rules, skills, user layer, project context files) in a private data repo, and provisions it onto machines and Ottr Docker workers.

## Product Purpose

Loopback dashboard to import a data-repo snapshot, review and edit its files as proof corrections (commit + push), see update state, and provision item by item. Each skill is scanned by SkillSpector before install. No personal data lives in the tool repo.

## Capabilities and Constraints

- Loopback-only and key-free on 127.0.0.1.
- Strict CSP, no third-party scripts, no build step.
- Self-hosted fonts.
- Installable PWA.
- Single operator, no accounts.
