# Software Factory

A light, desktop-first portal for repository triage and Copilot task tracking. The foundation serves a signed-out Svelte shell and a Fastify API from one Linux container. Provider sign-in, browsing, and task execution are not enabled in this milestone.

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
