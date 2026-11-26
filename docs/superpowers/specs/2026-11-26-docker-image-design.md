# Software Factory Docker image and deployment contract

**Status:** Foundation packaging is implemented in the [root Dockerfile](../../../Dockerfile). Future provider and SDK capabilities remain gated. The [backend implementation plan](../plans/2026-11-26-backend-system.md#task-1-create-the-runtime-and-persistence-foundation) owns the image smoke tests.

## Decision

Build one Linux image from the root npm project. Fastify serves the compiled Svelte portal and the same-origin API from one Node process. SQLite and private application state live on host-local storage; replacing the image does not make the deployment stateless. The first image proves the portal, API, and storage foundation without requiring Copilot credentials, a runner, or provider calls for health.

| Approach | Trade-off |
| --- | --- |
| **Selected: multi-stage build, one runtime image** | Build and test with the full toolchain, then copy only deployment artifacts and production dependencies. Separate stage boundaries do not add deployed services. |
| Single-stage image | Simpler Dockerfile, but ships build tooling and development dependencies to production. |
| Separate static host, API, and worker | Independent scaling is possible, but adds deployment units and more coordination around auth, operations, and recovery. Not needed for the approved single-host release. |

The [dependency baseline](2026-11-26-npm-dependencies.md) owns package pins. The [storage design](2026-11-26-storage-and-container-design.md#container-layout), [backend design](2026-11-26-backend-system-design.md), and [HTTP contract](2026-11-26-internal-api-design.md) own storage semantics, identity, and routes respectively. The [editable C4 canvas](../../architecture/software-factory-c4.excalidraw) locates those responsibilities from system context through routes and functions.

## Reference Dockerfile

Use the same digest-pinned, official Debian/glibc Node 24.22.3 slim image for install and runtime stages, built for the **target Linux architecture**, not copied from host `node_modules`. Pass the verified full `node:24.22.3-<debian>-slim@sha256:…` reference as `NODE_IMAGE` from CI; verifying the tag, digest, architecture, certificate trust, and native addon on the chosen platform is part of adoption. npm 12.2.3 is bootstrapped in a build stage only.

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS npm-base
WORKDIR /app
RUN --mount=type=secret,id=npm_config,required=true \
    NPM_CONFIG_USERCONFIG=/run/secrets/npm_config \
    npm install --global npm@12.2.3 --ignore-scripts --no-audit --no-fund
COPY package.json package-lock.json .npmrc ./

FROM npm-base AS build
RUN --mount=type=secret,id=npm_config,required=true \
    NPM_CONFIG_USERCONFIG=/run/secrets/npm_config \
    npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY . .
ARG BUILD_REVISION
ARG BUILD_TIMESTAMP
ARG BUILD_RUN_URL
RUN --network=none npm run check && npm test && npm run build

FROM npm-base AS prod-deps
RUN --mount=type=secret,id=npm_config,required=true \
    NPM_CONFIG_USERCONFIG=/run/secrets/npm_config \
    npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
  CMD ["node","-e","fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exitCode=1},()=>{process.exitCode=1})"]
CMD ["node","dist/server/main.js"]
```

### Stage and artifact rules

- **Build:** `npm run build` compiles `dist/web/index.html` and fingerprinted assets from Vite, plus `dist/server/main.js` and the migration files required by `openDatabase()` and `migrate()`. Keep migrations with the server output; do not require the source tree at runtime. Run type checks, unit tests, and browser fixture tests in CI, not in the final image. The metadata writer emits `dist/build.json` from the three public CI inputs. It validates the full commit SHA, UTC build time, and exact workflow run URL for `arolariu/software-factory`; invalid release inputs fail the build, while absent local inputs are `null`. `GET /api/build` serves this artifact, not container startup time. The UI links the revision to the GitHub commit and the timestamp to the producing run when present.
- **Install:** supply the approved Microsoft registry via the BuildKit `npm_config` secret even when no credential is needed; a missing mount fails the build. CI validates the selected registry before building. The tracked `.npmrc` contains only `save-exact=true` and `omit-lockfile-registry-resolved=true`. Lock exact versions and integrity, reject registry `resolved` URLs and non-registry dependencies in the baseline, and do not fall back to another feed. No install scripts are needed in the foundation: SQLite ships a bundled glibc addon. If a later dependency needs a lifecycle script, explicitly approve it and run it only in a no-network stage with the feed config unmounted. Keep any compiler and headers outside the runtime, and prove the addon loads on each target architecture.
- **Runtime:** retain only the built assets, compiled server and migrations, metadata, package type metadata, and Linux production modules. No source tree, compiler, browser test binaries, npm cache/config, fixtures, or credentials are copied into the runtime. The base image may include npm; the app is started directly by Node, not by `npm start`. Use a `.dockerignore` allowlist for the tracked build inputs (including the portable `.npmrc`); exclude `.git`, host `node_modules`, existing output, design artifacts, `.env` files, local credential/config files, and tests not needed by the build. CI must verify image contents independently.
- **Later capabilities:** add the pinned Copilot SDK and needed platform optional packages only after runtime proof; add Git to the runtime only when the approved Azure DevOps path needs it. Git is not required for provider browsing. Keep any SDK writable state out of `/app`; a future adapter must explicitly separate temporary state from durable resume metadata. A Git worktree or the container boundary alone is not a sandbox.

## Deployment contract

| Boundary | Contract |
| --- | --- |
| Ingress | One Fastify listener on `0.0.0.0:3000`; terminate TLS at trusted ingress. This is the only app container; ingress is host/platform infrastructure. Configure the canonical HTTPS origin explicitly for OAuth redirects and Origin validation. Trust forwarded headers only from the configured proxy; do not expose the backend port directly to public clients. |
| `/app` | Immutable artifact. Run as the image's unprivileged `node` user; provision mounts for its numeric UID/GID. Use a read-only root filesystem, drop Linux capabilities and enable no-new-privileges. Never use privileged mode or mount the Docker socket. |
| `/data` (required) | Pre-provision a writable, private host-local directory, one active Factory instance per data directory. Store SQLite with its WAL/SHM siblings, the separate encrypted credential store, and approved durable private state. Mount the directory, not just the DB file. Initial startup can migrate an empty mounted directory; if `/data` is absent or unwritable, fail rather than creating an ephemeral DB elsewhere. Do not place it on a network share or mount it into a task process. |
| `/run/secrets` | Read-only runtime secrets with restricted file access, including the app encryption key and configured OAuth app secrets. Keep these out of the DB backup, image, build-time registry config, logs, and task environment. A deployment with configured provider auth must fail startup if required secret files are absent or unreadable. |
| `/tmp` | Bounded writable tmpfs for temporary files if needed; never the location of the DB, credential store, or durable SDK resume state. |
| `/workspaces` (gated) | Separate, writable host-local storage only for an approved Azure DevOps runner. Keep backend seed clones private; a task sees only its own isolated workspace, never sibling workspaces, application data, secrets, or repository write credentials. If that boundary cannot be proved on the host, leave Azure DevOps execution unavailable. Native GitHub-hosted runs do not require this mount. |

Do not run overlapping replicas against the same `/data`, including during rollout. Stop the old instance before starting the replacement. This accepts a short deployment interruption in exchange for simple single-writer ownership. Use SQLite's online backup API for live DB backups, a consistent protected backup of the separate credential state when needed, and separate key escrow. Restore both state and access to keys on an isolated target before relying on a backup. For rollback, verify the old image accepts the current schema or restore the compatible pre-upgrade backup with an explicit accounting of writes after that backup.

### What happens inside the container

1. **Boot:** `main()` loads and validates configuration, assets, metadata, and mount access. `openDatabase()` configures WAL and foreign keys; `migrate()` applies pending transactional migrations. Then `buildApp()` composes Fastify and registers health, API, OAuth callbacks, and static delivery. Listen only once the foundation is ready. A failure before bind exits nonzero; the image probe cannot report ready. `GET /healthz` returns `200 {"status":"ok"}` only when locally ready and `503` when a listening instance is not ready; no provider, SDK, or secret detail in the response.
2. **Serve:** Fastify sends `index.html` only for frontend navigation, serves immutable fingerprinted assets, and never falls back to the SPA for `/api/*`, `/auth/*`, `/healthz`, or a missing asset. The browser calls the same origin and gets an opaque session cookie; provider access uses independently verified grants on the server. Authorized snapshots and task projections come from SQLite. An explicit Sync can use authorized provider reads; refreshing the Active Sessions summary cannot.
3. **Process operations:** When an operation is allowed, persist the request and receipt before responding `202`. An in-process runner claims durable work and records the effect before network I/O; no SQLite write lock spans that I/O. The browser follows the returned `Location`. A replacement reconciles uncertain effects using exact evidence and does not blindly replay them. Live task effects stay default-off until each provider, runtime, and host gate passes.
4. **Stop:** On `SIGTERM`, mark unready, stop claiming operations, drain Fastify and in-flight work within a deadline shorter than the runtime's stop timeout, and close SQLite. Preserve uncertain intent for reconciliation. This is process shutdown, not a request to stop or archive GitHub-hosted tasks. Keep any interrupted Azure DevOps run recoverable or explicitly `needs_recovery`; never delete its workspace based only on container exit.

## Acceptance before shipping the image

| Check | Evidence |
| --- | --- |
| Build and package | Resolve using the approved feed and pinned Node/npm pair; check the URL-free lock, `npm ci`, type checks, tests, native SQLite import/query, and actual Fastify plugin registration on each target. Inspect image layers/config for registry config, secrets, dev packages, and source leakage. |
| Start and route | Run the built image as non-root with read-only root and a disposable host-local data directory. Verify `/healthz`, `/api/build`, static entry and a deep link; verify a missing asset, API route, or OAuth path never returns the SPA. Inject a migration failure and verify no readiness and no partial version advance. |
| Replace and restore | Seed through test-only composition or a disposable database, replace the image with the same mounts, and verify persistence and migration compatibility. Restore an online backup on a fresh directory. Verify errors on missing mount or key as applicable. |
| Drain and gate | Stop during an operation and confirm replacement reconciles rather than replaying an unknown effect. Check that the read image remains ready while SDK and Azure DevOps execution are disabled. Test isolation, identity, and stop confirmation separately before enabling live commands. |

References: [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/), [BuildKit secrets](https://docs.docker.com/build/building/secrets/), [Dockerfile reference](https://docs.docker.com/reference/dockerfile/), [SQLite WAL](https://sqlite.org/wal.html), [SQLite online backup](https://sqlite.org/backup.html).
