# Alate

<p align="center">
  <a href="https://github.com/ottr-ai/ottr"><img src="https://raw.githubusercontent.com/ottr-ai/ottr/main/.github/assets/built-with-ottr.png" alt="Built with Ottr"></a>
</p>

> *"Alate (Latin ālātus, from āla ('wing')) is an adjective and noun used in entomology and botany to mean 'winged'"* — the winged reproductive form of an ant. ([Wikipedia: Alate](https://en.wikipedia.org/wiki/Alate))

<p align="center">
  <img src="logo.png" alt="alate — a smiling winged ant" width="320">
</p>

alate provisions an [omp](https://github.com/can1357/oh-my-pi) agent on any machine: global agent rules, the omp user layer, and per-project agent-context snapshots. It ships no content of its own. All content lives in your own private data repo, so the tool stays public and your rules and machine state stay private.

## Quick start

1. Clone alate, then copy [`examples/data`](examples/data) into a new private GitHub repo. It is a starter template.

   ```sh
   git clone https://github.com/ottr-ai/alate && cd alate
   ```

2. Capture: fill the repo from the machine that already runs omp.

   ```sh
   node sync-user.mjs --data /path/to/your-data-repo
   node sync-projects.mjs --data /path/to/your-data-repo   # optional
   git add . && git commit -m "capture" && git push
   ```

3. Run the server:

   ```sh
   docker compose up -d
   docker compose logs alate   # first start prints: alate API key: <key>
   ```

   The named volumes keep the server key, the SQLite db, and the provisioned omp home across restarts.

4. Open <http://127.0.0.1:4570>, import your repo as `owner/name` with a GitHub token, and provision.

Capture is the prepared way to get a usable setup. Docker Compose is the prepared way to run the server.

## Start from your current setup

The `create-data-repo` skill runs the quick start for you. It checks the prerequisites, captures this machine's omp setup with `sync-user.mjs` and `sync-projects.mjs`, scans the result for secrets, and creates the private repo. It asks before each step outside your machine and refuses a public repo.

Install it on the machine that already runs omp:

```sh
npx skills add ottr-ai/alate --skill create-data-repo
```

Then ask your agent to run the skill. The scan stops before any commit when it finds a secret. The quick start above is the manual path.

## How it works

- **Import** stores a snapshot of the data repo in SQLite on the server.
- **Provision** runs `sync.mjs` (rules into `~/.omp/agent/rules`) and `install-user.mjs` (the user layer) from the snapshot into the container home volume. The image carries the pinned SkillSpector build that `install-user.mjs` requires; a host that runs the script outside the image installs it by hand (see the script header).
- Workers mount the same volume.
- The **dashboard** lists the snapshot inventory and edits files. Each edit commits and pushes.
- The dashboard shows upstream updates with a 7-day age gate. A GitHub release waits only 2 days when it marks a security fix: its notes cite a CVE or GHSA id or have a security-release line (for example `## Security release`), or a published advisory of its repository names it as patched. It waits 0 days when a live OSV record for a cited CVE binds an affected package to its GitHub repository, and that package's ranges cover the installed version but not the release. Only SemVer versions (`SEMVER` ranges, and the `npm` and `crates.io` ecosystems) can remove the gate. Other ecosystems, such as PyPI or Debian, keep the 2-day gate. It also waits 0 days when a [CISA](https://www.cisa.gov/cybersecurity-advisories/all.xml) alert or a [CERT-EU](https://cert.europa.eu/publications/security-advisories-rss) advisory names a cited CVE and, in its title, the product that the item's `check.advisoryProduct` in `upstreams.json` names (for example `"advisoryProduct": "PHP"`). Without that field, alerts do not count. A Node.js release that `index.json` marks as a security release gets the same tiers: its release announcement supplies the CVE ids, and the OSV record must bind `nodejs/node`. Set `securityFastPath` to `false` in `server-config.json` to keep the 7-day gate for all releases.

## Data repo layout

- Root `*.md` files: the rules, each with a `description:` frontmatter line.
- `user/`: home-relative snapshot without the leading dot (`~/.omp/agent/config.yml` → `user/omp/agent/config.yml`). A `*.md` file directly under `user/omp/agent/rules/` is a rule: it needs the same `description:` frontmatter and clean characters as the root rules.
- `projects/projects.json` plus `projects/<name>/`: per-project agent-context snapshots.
- `workers/<project>/` plus the fleet folder `workers/_all/`: the worker additions Ottr's turns install. `apt.txt` lists Debian packages, one per line, `#` comments. `tools.json` is a JSON array of downloads; each entry has `name`, `url` (`https://` only), `sha256` (64 lowercase hex characters), `unpack` (`zip`, `tar.gz` or `none`), and `bin` (the executable inside the archive; absent when `unpack` is `none`). `env.txt` lists env var names, one per line, `#` comments; names only, never values. `install-user.mjs` validates `tools.json` and `env.txt` before it writes anything.
- `upstreams.json` (optional): records the origin of each public item. When the file exists, `sync.mjs` refuses items with no recorded origin. The root `own` list holds files you wrote yourself.

## Scripts

| Script | Purpose | Key flags |
| --- | --- | --- |
| `sync.mjs` | Install the data repo's rules into omp's rules dir. | `[targetDir]` |
| `install-user.mjs` | Restore the `user/` snapshot onto a machine. Refuses a rule file under `user/omp/agent/rules/` with hidden characters or no `description:` frontmatter, before any write. Scans every skill snapshot first with SkillSpector (fail-closed, pinned tag, the snapshot's shipped `.skillspector-baseline.yaml` applied; needs Python 3.12+ and the pinned build, see the script). The scan prefers the pinned venv (`SKILLSPECTOR_VENV`, same layout as the data repo's scan hook) and refuses a scanner whose version is not the pin. | `--home`, `--force`, `--skip-plugins` |
| `sync-user.mjs` | Capture this machine's omp user layer into the repo. | `--home` |
| `sync-projects.mjs` | Refresh per-project snapshots into the repo. | `--root` |

All install scripts take `--data <dir>` or `--repo <owner/name[@ref]>` (set `GH_TOKEN` for private repos). Capture scripts take `--data <dir>` only.

## API

| Route | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | none | Server, source, and update status. |
| `POST /api/login` | none | `{"key": "<app key>"}` sets a session cookie for the dashboard. |
| `POST /config` | Bearer | Import `{"repo": "owner/name"}` or `{"path": "<dir>"}`. |
| `POST /provision` | Bearer | Run `sync.mjs` and `install-user.mjs` from the stored snapshot. |
| `GET /api/updates` | Bearer | One record per tracked upstream. |

Dashboard routes under `/api` need no key on a loopback bind. On a loopback bind, dashboard writes also need a same-origin `Origin` header (the dashboard sends it; scripts use the Bearer token). On any other bind they need the key or a login session.

## Security

- Treat the data repo as trusted code. Rules change agent behavior. Skills and plugins run code. install-user scans every skill snapshot statically with SkillSpector before it lands (fail-closed, pinned tag, the snapshot's shipped `.skillspector-baseline.yaml` applied, see the script list above); the scan checks content, the upstreams origin gate checks provenance, and neither replaces review of the data repo itself.
- Keep credentials in environment variables. Capture refuses credential-shaped values, but it cannot prove that a file is secret-free.
- A non-loopback bind serves plain HTTP, and the session cookie carries no `Secure` flag. Put a TLS reverse proxy in front for remote access.
- The compose file publishes the port on host loopback only (`127.0.0.1:4570:4570`).
- The dashboard refuses to be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). On a loopback bind the dashboard is key-free, so a framed page could otherwise change its state with one click.
- Keep `/state` (server key and SQLite db) out of the image.

## Run without Docker

```sh
npm ci && node server.ts --data examples/data
```

Needs Node 24.12+. Flags: `--port` or `PORT`, `--host` or `ALATE_HOST`, `--config <file>`, `--db <file>`. The default bind is `127.0.0.1:4570`. The server prints `alate API key: <key>` on first start; with `ALATE_API_KEY` set, it prints `alate API key: taken from ALATE_API_KEY`.

`ALATE_API_KEY` sets the first-start API key from the environment, so a deployment can pair a board (for example Ottr's compose file) without a manual copy of the key. The value needs 32 characters or more: a shorter value makes the server exit with an error instead of generating a key, because the paired board would then fail silently. The value is saved to the config file and never printed. A key that is already in the config wins over the env value, and `POST /api/key` keeps rotating the key as before.

## Development

One manifest, one lockfile, no build step. The verified chain:

```sh
npm ci && npm audit --omit=dev --audit-level=low && node zero-deps.test.mjs && node sync.mjs "$(mktemp -d)" --data examples/data && node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node architecture.test.mjs && node clone.test.mjs && node skills/create-data-repo/scan-secrets.test.mjs && npx tsc --noEmit && node server.test.mjs
```

CI runs this chain on every push. `release.yml` builds a multi-arch Docker image and publishes it to `ghcr.io/ottr-ai/alate` on each GitHub release, tagged `latest`, `vX.Y.Z` and `X.Y.Z`, and `vX.Y` and `X.Y`.

## License

MIT. See [LICENSE](LICENSE).
