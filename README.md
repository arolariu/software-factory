# Software Factory

A light, desktop-first portal for repository triage and Copilot task tracking. The Svelte workbench and its [Fastify API](docs/superpowers/specs/2026-11-26-internal-api-design.md) run in one Linux container. After signing in and connecting a repository, open the home page, choose the repository, and select **Sync** to load issues and pull requests. Task execution and repository writes remain disabled.

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

Set `FACTORY_GITHUB_CLIENT_ID` to the public Client ID of one GitHub App with device flow enabled. Factory uses this app for sign-in and explicit repository connection, but keeps their sessions and grants separate. Install the app on selected repositories with Issues and Pull requests read permissions. From a trusted interactive host terminal, run `podman exec -it <container> node dist/server/main.js setup-code`. Enter the resulting ten-minute code at `/setup`, then complete GitHub approval in the external browser. No pre-created account, OAuth client secret, or access token is needed.

Existing hosted previews can keep `FACTORY_GITHUB_PORTAL_CLIENT_ID` as a fallback. Keep the same sign-in Client ID to preserve the owner binding. `FACTORY_GITHUB_REPOSITORY_CLIENT_ID` is no longer used; reconnect repositories that were authorized with a different app.

To replace a claimed instance's public GitHub App, stop Factory and take a consistent database backup first. From a trusted interactive terminal, use the same release and data directory with `FACTORY_MANAGEMENT_MODE=1`, the existing `FACTORY_PUBLIC_ORIGIN` and `FACTORY_GITHUB_CLIENT_ID`, and set `FACTORY_GITHUB_REBIND_CLIENT_ID` to the new public ID. Run `node dist/server/main.js rebind-github-app` and approve in GitHub as the existing owner. Only an exact GitHub account match can switch the binding. After success, restart with the new `FACTORY_GITHUB_CLIENT_ID`, remove `FACTORY_GITHUB_REBIND_CLIENT_ID`, sign in again, and reconnect repositories. This procedure does not transfer ownership or change either GitHub App's installation.

Setup is owner-only. The preview UI can toggle new repository authorization and connect, reconnect, or disconnect a repository locally. Disconnect does not revoke upstream authorization. Browser-managed app replacement, the Windows installer and signing, and provider staging verification are not part of this preview. Legacy configured deployments use the mode below; populated legacy data cannot be claimed in preview mode.

#### Legacy file-configured mode

Leave `FACTORY_IDENTITY_CONFIG_FILE` unset for the sign-in-disabled foundation. To enable the identity API, use a canonical HTTPS public origin and mount a private JSON configuration and a separate raw 32-byte encryption key. Set `FACTORY_IDENTITY_CONFIG_FILE` to the JSON file's mounted path and `FACTORY_CREDENTIAL_KEY_FILE` to the key path (defaults to `/run/secrets/identity-key`). Do not put either file in the build context or commit it.

Stop the application before backing up `factory.sqlite` and `credentials.sqlite` as one consistent pair. Credential rotation crosses both databases, so two independent online snapshots can produce a grant that points to a missing vault entry. Restore both files from the same stopped backup before starting the application, and escrow the matching key separately.

The configuration has `publicOrigin`, a `github` array, and an optional `azureDevOps` object. Each GitHub entry has `hostname` (`github.com` or one explicit `<tenant>.ghe.com`), `label`, and `registrations` (`portal` required, `repository` and `copilot` optional). Each registration has `id`, `clientId`, `secret`, and an optional `scope` for GitHub. Use distinct applications per purpose; the repository GitHub App must be installed with Issues and Pull requests read permissions. Azure DevOps takes a single-tenant Entra `tenantId` and a delegated `registration`. Register `<publicOrigin>/auth/github/callback` and, when enabled, `<publicOrigin>/auth/azure-devops/callback` as exact callbacks. Verify entitlement and provider/org consent in staging before enabling real accounts. The signed-out browser shell does not initiate sign-in yet.

### Repository reads and Sync

`POST /api/connections/{id}/sync` queues read-only work and returns a `Location` receipt. Sync publishes a snapshot only after its entire source succeeds; a partial fetch never replaces existing rows. Reads page indexed SQLite rows and do not contact providers. Each source needs its own successful Sync within the 15-minute access window; reading Git data does not extend cached Azure Boards access. Restart retries interrupted read-only work only while its connection generation still matches.

Upstream scans are bounded to 20 pages per source. If a source exceeds the bound, it stays unavailable or retains its last complete authorized snapshot rather than publishing truncated data. Azure Boards work items are project scoped. GitHub CI uses the listed head revision; Azure DevOps CI and Copilot session discovery are reported as unavailable in this milestone. Provider behavior has been tested with offline fixtures, not a live tenant. Azure DevOps needs delegated Boards and Git read access.

## Check Copilot access

On a development host with dev dependencies installed, run `npm run build`, then run `bash scripts/check-copilot-access.sh` in an interactive terminal with `FACTORY_GITHUB_CLIENT_ID` set to the public Client ID of your device-flow-enabled GitHub App. Approve the new device code with the account you want to verify. The check uses only that freshly authorized token and calls the SDK's authentication and model discovery methods in a temporary runtime directory. It does not use existing CLI credentials, store the token, start a task, or send a prompt.

The result reports SDK authentication, model count, and models disabled by policy, not a personal plan name. A failed check or an empty model list does not prove an account has no Copilot subscription. [Organization seat details](https://docs.github.com/en/rest/copilot/copilot-user-management) are admin-only and not queried by Factory. The diagnostic entry point is not available in the production image.

On a hosted GitHub.com instance, `FACTORY_COPILOT_ACCESS=1` enables the opt-in Copilot section in Settings. Provide a writable temporary directory for the server user (normally `/tmp`); the SDK runs in an isolated temporary directory using the explicit Copilot grant, with no CLI-login or repository-grant fallback. Link Copilot through a separate device approval using the same GitHub App, then check the account's model catalog and quota. Account quota is reported as requests, not as an AI-credit balance. Missing quota, an unlimited allowance and a zero allowance are different states. The check never creates a session, sends a prompt or starts a cloud task.

Model prices appear in the SDK-reported unit per token batch only if the catalog and its pricing-unit response agree on the model. Prices are rates, not charges. Active Sessions can display the latest verified sample for a mapped task (nano-AI units and premium request cost reported separately). The task usage store has no live sampler yet; incomplete SDK credit totals do not appear as zero or get added to aggregate credits.

The portal's Active Sessions and Statistics screens distinguish an unavailable backend from a verified empty result. They do not discover sessions, launch work, or estimate unmeasured usage.

## Test coverage

Colocate `<module>.test.ts` with its production module. Run `npm exec -- playwright install chromium` once, then `npm run coverage`. The separate server and UI reports enforce 95% lines, statements, branches, and functions. The container smoke checks the built application, not the Bash helpers themselves.

`npm run check` uses the shared strict TypeScript settings for the server, Svelte, tests, and tooling, including declaration-file checks. The compiler is pinned to the newest stable release supported by `svelte-check`; see the [dependency baseline](docs/superpowers/specs/2026-11-26-npm-dependencies.md#exact-pins).

## Stage the Windows runtime

On Windows x64, use Git Bash and download `node-v24.22.3-win-x64.zip` from the [official Node release directory](https://nodejs.org/dist/v24.22.3/). Point `NPM_CONFIG_USERCONFIG` at the approved npm registry configuration outside the checkout, then run:

```bash
bash scripts/package-windows-sidecar.sh /path/to/node-v24.22.3-win-x64.zip /path/to/new-stage
```

The script checks the ZIP against the pinned SHA-256, builds committed `HEAD` with pinned npm, and stages only the executable, its license, compiled Factory files and production dependencies. It runs the packaged Node and SQLite against a fresh database before exposing the output. This is a staging directory, not an installer or a supervised desktop application.

The native vault-key component uses Windows user-scope DPAPI and refuses to replace a missing or invalid key for an existing vault. The native supervisor owns one child per data directory. It passes the key and per-launch channel token through anonymous pipes and stops the child when the supervisor exits. The child binds an ephemeral IPv4 loopback port and rejects direct browser requests. The Tauri window and its native proxy are not wired up yet.

On Windows, run `cargo test --locked --manifest-path src-tauri/vault-key/Cargo.toml` to test key protection. Set `FACTORY_TEST_WINDOWS_STAGE` to the staging directory created above, then run `cargo test --locked --manifest-path src-tauri/supervisor/Cargo.toml -- --include-ignored` to test start, stop, restart, and supervisor crash with the packaged Node executable.

## Verify the Linux image

Supply an npm config scoped to the approved registry outside this repository. The smoke script builds the `Containerfile` with Podman and tests non-root startup, replacement, and online SQLite backup/restore. `both` additionally loads the exact image into an already-running Rancher Desktop **Moby** engine through `rdctl`, without switching engines or invoking a Docker CLI. The Windows path uses the running Podman machine and the shared Windows drive. Do not point either test at a production engine.

```bash
bash scripts/container-smoke.sh podman "$npm_config_path"
bash scripts/container-smoke.sh both "$npm_config_path" --browser
```

`--browser` uses the pinned Chromium to check the Podman-hosted app at 1080 × 720. For deployment, provision host-local `/data` owned by UID/GID `1000:1000` with mode `0700`. The container accepts ext4, XFS, Btrfs, and ZFS mounts; network shares, memory-backed mounts, and unrecognized filesystems are rejected before SQLite opens. Update `.containerignore` when adding build inputs. See the [container specification](docs/superpowers/specs/2026-11-26-docker-image-design.md) for ingress and recovery requirements.
