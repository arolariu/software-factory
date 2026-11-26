# Software Factory

A light, desktop-first portal for repository triage and Copilot task tracking. The foundation serves a signed-out Svelte shell and a Fastify API from one Linux container. Provider sign-in, browsing, and task execution are not enabled in this milestone.

## Run locally

Use Node **24.22.3**, npm **12.2.3**, and the approved npm registry configured outside the repository. Install scripts are disabled for this dependency set; the pinned SQLite package bundles its native binary.

```powershell
npm ci --ignore-scripts --strict-peer-deps
npm run check
npm test
npm run build
New-Item -ItemType Directory -Path .\data -Force | Out-Null
$env:FACTORY_DATA_DIR = (Resolve-Path .\data).Path
npm start
```

Open `http://localhost:3000`. `/healthz` checks local schema readiness and `/api/build` returns artifact metadata (null fields for an unstamped local build). Use a private, writable data directory; SQLite stores its WAL and SHM alongside the database.

## Verify the Linux image

With Docker BuildKit and PowerShell 7, supply an npm config scoped to the approved registry as a build secret. Keep that file outside this repository. The smoke test builds the image, checks the running non-root server, replaces it with the same data volume, and restores an online SQLite backup into a fresh volume.

```powershell
.\tests\backend\container-smoke.ps1 -NpmConfig $npmConfigPath -DockerContext default
```

For a browser check at 1080 × 720, first install the pinned Playwright Chromium (`npm exec -- playwright install chromium`) and pass `-Browser`. See the [container specification](docs/superpowers/specs/2026-11-26-docker-image-design.md) for production mount, ingress, and recovery requirements.
