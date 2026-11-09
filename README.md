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
- **Provision** runs `sync.mjs` (rules into `~/.omp/agent/rules`) and `install-user.mjs` (the user layer) from the snapshot into the container home volume. The pipeline stops at the first script that fails, and the response lists only the scripts that ran. The image carries the pinned SkillSpector build that `install-user.mjs` requires; the image pins the scanner to an absolute path (`SKILLSPECTOR_BIN=/usr/local/bin/skillspector`) and sets `PYTHONNOUSERSITE=1`, so neither the scanner binary nor its Python modules ever come from the mounted home volume the workers mount. A host that runs the script outside the image installs it by hand (see the script header). The provisioned `config.yml` never carries a memory backend. The board injects the backend at spawn time as a deployment setting, and install drops the entry from snapshots that an older alate captured.

With `ALATE_LAYER=1` (compose.yaml sets it), `install-user.mjs` installs each provision into a new `.alate/layers/<commit>-<n>` folder and switches `.alate/current` with one atomic symlink rename. A provision never changes files a running turn reads. State outside the layer (agent.db, oauth, sessions, git/gh config, caches) stays shared through symlinks. Old layers are cleaned up after the switch; `current` and the one before it are kept, and layers a running turn pins are protected through `.alate/in-use.json`. The first layer over an existing in-place home takes the machine part of `config.yml` (the deployment blocks and any machine edits) from the home, so the migration keeps it. A home `config.yml` that still holds what the in-place install wrote — its record in the home's `installed.json`, compared modulo the deployment blocks and the memory backend entry — takes the snapshot instead, so a stale pre-layer config never freezes. This covers a home that an alate older than the strip installed: its record hashes the entry as part of the snapshot, and a home that still holds exactly those bytes takes the snapshot too. The `--layer` flag enables the same behavior on any home. Without it, the in-place install stays as before.
- Workers mount the same volume.
- The **dashboard** lists the snapshot inventory and edits files. Each edit commits and pushes.
- The dashboard shows upstream updates with a 7-day age gate. For a GitHub path or branch item, including skill and plugin heads, the 7 days run from the checker's first sight of the head commit. Every new commit restarts the wait. A GitHub release waits only 2 days when it marks a security fix: its notes cite a CVE or GHSA id or have a security-release line (for example `## Security release`), or a published advisory of its repository names it as patched. It waits 0 days when a live OSV record for a cited CVE binds an affected package to its GitHub repository, and that package's ranges cover the installed version but not the release. Only SemVer versions (`SEMVER` ranges, and the `npm` and `crates.io` ecosystems) can remove the gate. Other ecosystems, such as PyPI or Debian, keep the 2-day gate. It also waits 0 days when a [CISA](https://www.cisa.gov/cybersecurity-advisories/all.xml) alert or a [CERT-EU](https://cert.europa.eu/publications/security-advisories-rss) advisory names a cited CVE and, in its title, the product that the item's `check.advisoryProduct` in `upstreams.json` names (for example `"advisoryProduct": "PHP"`). Without that field, alerts do not count. A Node.js release that `index.json` marks as a security release gets the same tiers: its release announcement supplies the CVE ids, and the OSV record must bind `nodejs/node`. Set `securityFastPath` to `false` in `server-config.json` to keep the 7-day gate for all releases.

## Data repo layout

- Root `*.md` and `*.mdc` files: the rules, each with a `description:` frontmatter line.
- `user/`: home-relative snapshot without the leading dot (`~/.omp/agent/config.yml` → `user/omp/agent/config.yml`). Capture strips the `backend:` entry under the top-level `memory:` key, and the emptied `memory:` mapping with it. The memory backend is a deployment setting that the board injects at spawn time, not agent-layer content. A `*.md` or `*.mdc` file directly under `user/omp/agent/rules/` is a rule: it needs the same `description:` frontmatter and clean characters as the root rules. Every other `*.md`/`*.mdc` in the snapshot (agent context such as `AGENTS.md` or `RULES.md`) needs the same clean characters.
- `projects/projects.json` plus `projects/<name>/`: per-project agent-context snapshots.
- `workers/<project>/` plus the fleet folder `workers/_all/`: the worker additions Ottr's turns install. `apt.txt` lists Debian packages, one per line, `#` comments. `tools.json` is a JSON array of downloads; each entry has `name`, `url` (`https://` only), `sha256` (64 lowercase hex characters), `unpack` (`zip`, `tar.gz` or `none`), and `bin` (the executable inside the archive; absent when `unpack` is `none`). `env.txt` lists env var names, one per line, `#` comments; names only, never values. `requirements.txt` lists Python packages, one pinned and hashed line per package: `name==version --hash=sha256:<64 hex>`, one or more `--hash` tokens, `#` comments and blank lines, no options, extras, or URL requirements. `install-user.mjs` validates `tools.json`, `env.txt`, and `requirements.txt` before it writes anything.
- `upstreams.json` (optional): records the origin of each public item. When the file exists, `sync.mjs` refuses items with no recorded origin. The root `own` list holds files you wrote yourself.

## Scripts

| Script | Purpose | Key flags |
| --- | --- | --- |
| `sync.mjs` | Install the data repo's rules into omp's rules dir. | `[targetDir]` |
| `install-user.mjs` | Restore the `user/` snapshot onto a machine. Refuses any snapshot `*.md`/`*.mdc` file with hidden characters, and a rule under `user/omp/agent/rules/` with no `description:` frontmatter, before any write. Scans every skill snapshot first with SkillSpector (fail-closed, pinned tag, the snapshot's shipped `.skillspector-baseline.yaml` applied; needs Python 3.12+ and the pinned build, see the script). The scan resolves the scanner as `SKILLSPECTOR_BIN` (absolute path outside the home, else refuse), then a pinned venv (`SKILLSPECTOR_VENV`, accepted only when root-owned and outside the home it installs into), then PATH, and refuses a scanner whose version is not the pin; a candidate inside the turn-writable home is never executed, and every provision child runs with an allowlisted environment, so `ALATE_API_KEY` never reaches a spawned process. The scanner child always runs with `PYTHONNOUSERSITE=1`, so Python never loads user site-packages from the home. The scans run in parallel (at most `min(8, availableParallelism())` children, each report printed as one block) and only changed skills rescan: a passed verdict is cached under `<home>/.alate/skillspector-pass.json`, keyed on the skill folder's own content hash plus the scanner build and scan arguments; a rejection is never cached, and a changed skill, scanner, or unreadable cache file means a full rescan of that skill. In layer mode a machine change to the plugins install files (`omp/plugins/package.json`, `bun.lock`, `patches/`) never rides into the new layer: the snapshot wins, and a note names each file. The plugins `bun install` runs `--ignore-scripts` unless the data repo ships a `plugins-allow-scripts` marker at its root, and with an allowlisted environment, so server secrets never reach bun or a lifecycle script. The install uses bun's `copyfile` backend, so the provisioner never creates a hard link into the snapshot tree. | `--home`, `--force`, `--skip-plugins` |
| `sync-user.mjs` | Capture this machine's omp user layer into the repo. | `--home` |
| `sync-projects.mjs` | Refresh per-project snapshots into the repo. | `--root` |

All install scripts take `--data <dir>` or `--repo <owner/name[@ref]>` (set `GH_TOKEN` for private repos). Capture scripts take `--data <dir>` only.

## API

| Route | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | none | Server, source, update, and layer-mode status. |
| `POST /api/login` | none | `{"key": "<app key>"}` sets a session cookie for the dashboard. |
| `POST /config` | Bearer | Import `{"repo": "owner/name"}` or `{"path": "<dir>"}`. |
| `POST /provision` | Bearer | Run `sync.mjs` and `install-user.mjs` from the stored snapshot. The run stops at the first failed script, and `results` lists only the scripts that ran. |
| `GET /api/updates` | Bearer | Board contract records only, one record per pinnable upstream. `/api/state` keeps every row. |
| `POST /api/updates/check` | Bearer | Run the upstream check now and return the fresh list. |

Dashboard routes under `/api` need no key on a loopback bind. On a loopback bind, dashboard writes also need a same-origin `Origin` header or a same-host `Referer` header (the dashboard sends them; scripts use the Bearer token). On a loopback bind, the server also refuses any request whose `Host` header does not name the server (`localhost`, `127.x.x.x`, `[::1]`). On any other bind they need the key or a login session.

## Security

- Treat the data repo as trusted code. Rules change agent behavior. Skills and plugins run code. install-user scans every skill snapshot statically with SkillSpector before it lands (fail-closed, pinned tag, the snapshot's shipped `.skillspector-baseline.yaml` applied, see the script list above); the scanner binary itself is resolved only from trusted locations, the scanner child runs with `PYTHONNOUSERSITE=1` so planted Python modules in the home never load, and the provision pipeline spawns every child with an allowlisted environment; the scan checks content, the upstreams origin gate checks provenance, and neither replaces review of the data repo itself.
- Keep credentials in environment variables. Capture refuses credential-shaped values, but it cannot prove that a file is secret-free.
- A non-loopback bind serves plain HTTP, and the session cookie carries no `Secure` flag. Put a TLS reverse proxy in front for remote access.
- The compose file publishes the port on host loopback only (`127.0.0.1:4570:4570`).
- The dashboard refuses to be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). On a loopback bind the dashboard is key-free, so a framed page could otherwise change its state with one click.
- On a loopback bind the server refuses requests whose `Host` header does not name the server. A page at a DNS-rebound hostname sends an `Origin` that matches the request `Host`; the `Host` check stops that page from reaching the key-free dashboard.
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
npm ci && npm audit --omit=dev --audit-level=low && node license-gate.mjs && node zero-deps.test.mjs && node license-gate.test.mjs && node home-guard.test.mjs && node home-guard.test.mjs record && node sync.mjs "$(mktemp -d)" --data examples/data && node sync.test.mjs && node install-user.test.mjs && node sync-user.test.mjs && node sync-projects.test.mjs && node architecture.test.mjs && node clone.test.mjs && node skills/create-data-repo/scan-secrets.test.mjs && npx tsc --noEmit && node server.test.mjs && node home-guard.test.mjs check
```

home-guard.test.mjs brackets the chain: the early record snapshots the home's `.alate`, `.agents` and `.omp`, and the final check fails the run when a path or an mtime there changed. The platform's own runtime files (the omp databases, logs, cache, run, the session stores under `.omp`, and the two bookkeeping files under `.alate`) stay excluded: a live worker writes them during any chain.

CI runs this chain on every push. `release.yml` builds a multi-arch Docker image and publishes it to `ghcr.io/ottr-ai/alate` on each GitHub release, tagged `latest`, `vX.Y.Z` and `X.Y.Z`, and `vX.Y` and `X.Y`.

## License

MIT. See [LICENSE](LICENSE).
