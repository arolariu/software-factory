# Foundation Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update PR #1 to use Bash, colocated tests with enforced coverage, and one image verified in Podman and Rancher Moby.

**Architecture:** Preserve the existing Fastify/Svelte/SQLite runtime contracts. Build once with Podman and replay the runtime smoke suite against the same image in Rancher Desktop through its local Moby API.

**Tech Stack:** Bash, Node 24.22.3, npm 12.2.3, Vitest 5.1.1, Playwright, Podman, Rancher Desktop Moby.

**Spec:** [Foundation tooling and verification](../specs/2026-11-26-foundation-tooling-design.md).

## Global Constraints

- Do not invoke the Docker CLI, change Rancher engine configuration, or pass engine sockets to the app.
- Shell tooling is Bash; application, test, and runner configuration code remains TypeScript. Test names use `<module>.test.ts` beside their subject.
- Maintain the npm feed policy, private `/data`, native addon, startup/readiness, and provider-free scope.
- Enforce at least 95% statements, branches, functions, and lines separately for server and UI code.

## Review Focus

- Quoting or dates must not produce invalid build metadata (Task 1 build verification).
- Declaring a production file without importing it must not silently drop it from coverage (Task 2 include patterns and report inspection).
- A shell/browser error must not leave an unrelated container, volume, or host setting changed (Task 3 unique resource names and cleanup).
- An image that happens to share a tag must not be mistaken for the Podman-built image in Moby (Task 3 image identity check).
- A running container without usable persistent storage must not pass either engine's smoke (Task 3 negative startup and replacement tests).

## Task 1: Move build helpers and tests

**Files:** `scripts/build-artifacts.sh`, `src/server/build-app.test.ts`, `src/server/persistence/{open,migrations}.test.ts`, `src/web/AppShell.test.ts`, runner configs, and `package.json`. Remove the former metadata `.mjs` helper and retired test paths.

- [ ] Verify that the build emits null fields for missing local provenance and rejects invalid release metadata. Do not add a test file for the Bash helper.
- [ ] Implement the Bash writer. `BUILD_REVISION`, `BUILD_TIMESTAMP`, and `BUILD_RUN_URL` keep their existing validation and meaning; validate before copying `001-foundation.sql` and writing `dist/build.json`. Update the npm entry point to call Bash.
- [ ] Relocate HTTP, database, and browser tests beside their subject. Keep Playwright smoke and Vitest browser tests discoverable by their own configurations without running one test twice. Run `bash -n scripts/build-artifacts.sh`, `npm run check`, and `npm test`; expect green and no duplicate tests. Commit the tooling and layout changes.

## Task 2: Enforce coverage with real tests

**Files:** `package.json`, `package-lock.json`, Vitest server and browser config, colocated server/UI tests, and source only where a testable seam is warranted.

- [ ] Add `@vitest/coverage-v8@5.1.1` and the matching Vitest Playwright browser provider. Regenerate the registry-neutral lock under pinned Linux Node/npm. Configure `npm run coverage` to include all production modules in `src/server` and `src/web` and assert separate four-metric thresholds of 95%.
- [ ] Run the coverage command with the existing cases and record the failing metrics. Cover actual missing behavior, including startup and shutdown, unusable SQLite schema or path, and artifact success/unavailability/error display and links. Do not use coverage-ignore directives to meet the thresholds.
- [ ] Run `npm run check`, `npm test`, and `npm run coverage` with pinned Chromium available. Review the included files and both reports, then commit.

## Task 3: Verify the unchanged app on Podman and Rancher Moby

**Files:** `Containerfile`, `.containerignore`, `scripts/container-smoke.sh`, Bash health probe if needed, `README.md`, and the backend/container docs that link to the replaced smoke entry point. Remove `Dockerfile`, `.dockerignore`, and `tests/backend/container-smoke.ps1`.

- [ ] Port the smoke to Bash. Keep disposable names and trap cleanup. Assert non-root startup with read-only root, health, real assets, negative route and storage cases, replacement, and online SQLite backup/restore. Keep database test tooling outside the shipping application. First run the new script without the image build path and observe a failure.
- [ ] Build with `podman build --secret id=npm_config,src=... -f Containerfile` and use the existing private `/data` contract. Run the shell smoke and browser smoke in Podman. Verify the export contains the built image config, import it into Rancher Moby through `rdctl shell`, and verify the same content-addressed config (including root filesystem layer digests) after export from Moby. Leave Rancher in Moby mode and do not send registry credentials to that engine.
- [ ] Run the same runtime assertions for Rancher and report exact passes or blockers. Update run instructions and the file allowlist, check no tracked PowerShell or standalone JS helpers remain, and commit on the existing PR branch for review.
