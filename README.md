# Software Factory

A light, desktop-first portal for repository triage and Copilot task tracking. The foundation serves a signed-out Svelte shell and its [Fastify API](docs/superpowers/specs/2026-11-26-internal-api-design.md) from one Linux container. Repository reads and explicit Sync are available through the API once delegated identity is configured. The browser is not wired to these flows yet, and task execution remains disabled.

## Run locally

Use Bash (Git Bash on Windows), Node **24.22.3**, npm **12.2.3**, and the approved npm registry configured outside the repository. Install scripts are disabled for this dependency set; the pinned SQLite package bundles its native binary.

```bash
npm ci --ignore-scripts --strict-peer-deps
npm run check
npm test
npm run build
mkdir -p data
FACTORY_DATA_DIR="$PWD/data" npm start
```

Open `http://localhost:3000`. `/healthz` checks local schema readiness and `/api/build` returns artifact metadata (null fields for an unstamped local build). Use a private, writable data directory; SQLite stores its WAL and SHM alongside the database.

### Configure delegated identity

#### Interactive hosted setup (preview)

Set `FACTORY_MANAGEMENT_MODE=1` and `FACTORY_PUBLIC_ORIGIN` to the instance's canonical HTTPS origin behind trusted ingress. Start with a fresh private `/data` directory and leave `FACTORY_IDENTITY_CONFIG_FILE` unset. Factory generates and retains its vault key in `/data/management-vault.key`. Protect that file separately from the stopped database backup pair; an existing vault cannot be opened without its matching key.

Configure the public client IDs of two distinct GitHub App registrations with device flow enabled using `FACTORY_GITHUB_PORTAL_CLIENT_ID` and `FACTORY_GITHUB_REPOSITORY_CLIENT_ID`. Client IDs are not secrets. From a trusted interactive host terminal, run `podman exec -it <container> node dist/server/main.js setup-code`. Enter the resulting ten-minute code at `/setup`, then complete GitHub approval in the external browser. No pre-created account, OAuth client secret, or access token is needed. The repository app still needs an approved installation and read permissions.

Setup is owner-only. The preview UI can toggle new repository authorization and connect, reconnect, or disconnect a repository locally. Disconnect does not revoke upstream authorization. Custom app replacement, Windows/Tauri packaging and signing, and provider staging verification are not part of this preview. Legacy configured deployments use the mode below; populated legacy data cannot be claimed in preview mode.

#### Legacy file-configured mode

Leave `FACTORY_IDENTITY_CONFIG_FILE` unset for the sign-in-disabled foundation. To enable the identity API, use a canonical HTTPS public origin and mount a private JSON configuration and a separate raw 32-byte encryption key. Set `FACTORY_IDENTITY_CONFIG_FILE` to the JSON file's mounted path and `FACTORY_CREDENTIAL_KEY_FILE` to the key path (defaults to `/run/secrets/identity-key`). Do not put either file in the build context or commit it.

Stop the application before backing up `factory.sqlite` and `credentials.sqlite` as one consistent pair. Credential rotation crosses both databases, so two independent online snapshots can produce a grant that points to a missing vault entry. Restore both files from the same stopped backup before starting the application, and escrow the matching key separately.

The configuration has `publicOrigin`, a `github` array, and an optional `azureDevOps` object. Each GitHub entry has `hostname` (`github.com` or one explicit `<tenant>.ghe.com`), `label`, and `registrations` (`portal` required, `repository` and `copilot` optional). Each registration has `id`, `clientId`, `secret`, and an optional `scope` for GitHub. Use distinct applications per purpose; the repository GitHub App must be installed with Issues and Pull requests read permissions. Azure DevOps takes a single-tenant Entra `tenantId` and a delegated `registration`. Register `<publicOrigin>/auth/github/callback` and, when enabled, `<publicOrigin>/auth/azure-devops/callback` as exact callbacks. Verify entitlement and provider/org consent in staging before enabling real accounts. The signed-out browser shell does not initiate sign-in yet.

### Repository reads and Sync

`POST /api/connections/{id}/sync` queues read-only work and returns a `Location` receipt. Sync publishes a snapshot only after its entire source succeeds; a partial fetch never replaces existing rows. Reads page indexed SQLite rows and do not contact providers. Each source needs its own successful Sync within the 15-minute access window; reading Git data does not extend cached Azure Boards access. Restart retries interrupted read-only work only while its connection generation still matches.

Upstream scans are bounded to 20 pages per source. If a source exceeds the bound, it stays unavailable or retains its last complete authorized snapshot rather than publishing truncated data. Azure Boards work items are project scoped. GitHub CI uses the listed head revision; Azure DevOps CI and Copilot session discovery are reported as unavailable in this milestone. Provider behavior has been tested with offline fixtures, not a live tenant. Azure DevOps needs delegated Boards and Git read access.

## Test coverage

Colocate `<module>.test.ts` with its production module. Run `npm exec -- playwright install chromium` once, then `npm run coverage`. The separate server and UI reports enforce 95% lines, statements, branches, and functions. The container smoke checks the built application, not the Bash helpers themselves.

`npm run check` uses the shared strict TypeScript settings for the server, Svelte, tests, and tooling, including declaration-file checks. The compiler is pinned to the newest stable release supported by `svelte-check`; see the [dependency baseline](docs/superpowers/specs/2026-11-26-npm-dependencies.md#exact-pins).

## Verify the Linux image

Supply an npm config scoped to the approved registry outside this repository. The smoke script builds the `Containerfile` with Podman and tests non-root startup, replacement, and online SQLite backup/restore. `both` additionally loads the exact image into an already-running Rancher Desktop **Moby** engine through `rdctl`, without switching engines or invoking a Docker CLI. The Windows path uses the running Podman machine and the shared Windows drive. Do not point either test at a production engine.

```bash
bash scripts/container-smoke.sh podman "$npm_config_path"
bash scripts/container-smoke.sh both "$npm_config_path" --browser
```

`--browser` uses the pinned Chromium to check the Podman-hosted app at 1080 × 720. For deployment, provision host-local `/data` owned by UID/GID `1000:1000` with mode `0700`. The container accepts ext4, XFS, Btrfs, and ZFS mounts; network shares, memory-backed mounts, and unrecognized filesystems are rejected before SQLite opens. Update `.containerignore` when adding build inputs. See the [container specification](docs/superpowers/specs/2026-11-26-docker-image-design.md) for ingress and recovery requirements.
