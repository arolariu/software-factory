# Foundation tooling and verification

**Status:** Approved for planning. Applies to the foundation in PR #1. This supersedes engine, script, and test-layout assumptions in the earlier backend and container plans; it does not change the app or deployment topology.

Replace standalone JavaScript and PowerShell build and verification scripts with Bash. Keep TypeScript application and test code. Colocate tests using the infix `.test`, for example `build-app.test.ts` next to `build-app.ts`, and keep browser tests next to the UI they exercise. Do not add dedicated test files for Bash helpers.

## Selected approach

Build one OCI-compatible image from one `Containerfile` with Podman. Run it in Podman, then load the same built image into Rancher Desktop's existing Moby engine and run it there. Use the local Moby API through `rdctl shell`, not the Docker CLI. Don't switch Rancher engines, expose a socket, change host settings, or mount an engine socket into the application.

Two separately built images would make it harder to tell whether differences were due to the runtime or the build and would require the feed in both environments. Using `nerdctl` against Rancher Desktop would require switching Rancher to containerd; the approved target is Moby.

## Acceptance

- `npm run build` still publishes validated metadata, the migration SQL, and the compiled Svelte app. Missing local provenance stays null. Invalid build dates, commit IDs, or run URLs still fail. Shell tooling must not write outside the build/test paths it owns.
- Enforce at least **95% each** for statements, branches, functions, and lines, separately for the server and UI. Include unimported production TypeScript and Svelte files in measurement; exclude tests, config, generated bundles, and non-executable assets. Exercise startup, HTTP routing, SQLite, and UI states rather than excluding uncovered application modules or relaxing thresholds.
- Keep the registry external to the repository and lockfile. Preserve the pinned Node/npm versions, secret-mounted feed configuration, non-root read-only runtime, private `/data`, and no provider or SDK setup.
- Run health, static/API route boundaries, graceful shutdown, persistence on replacement, and online backup/restore in disposable smoke fixtures. Verify both installed engines without ever invoking the Docker CLI. Verify the existing 1080 × 720 Chromium smoke against the built image.
- Build tooling is Bash on Linux or Git Bash on Windows. Document how to run both engine checks. Do not merge PR #1 as part of this change.
