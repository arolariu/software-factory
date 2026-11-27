# Desktop Distribution and Svelte Management Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver installer-based Windows Factory and interactive management on both Windows and hosted Linux without preloaded credentials or account identities.

**Architecture:** Stage A adds runtime-aware ownership, vault initialization, public auth and Settings to the existing TypeScript application. Stage B packages that app with a narrow Windows supervisor and a verified artifact pipeline. Optional provider integrations are independently gated.

**Tech Stack:** Svelte, Fastify, TypeBox, Node/npm, SQLite, Bash, Vitest, Chromium Playwright, Tauri 2/Rust, Windows x64 MSVC, NSIS and GitHub Actions.

**Spec:** [Desktop distribution and Svelte management plane](../specs/2026-11-27-desktop-management-plane-design.md). **Evidence:** [Interactive auth research](../research/2026-11-27-interactive-management-plane.md).

## Global Constraints

- No bundled tokens, app secrets, pairing codes, vault keys or signing credentials. The UI writes optional secrets; safe readers never return their values. Keep three purpose-bound grants and no ambient credential fallback.
- Existing configured hosted deployments retain the legacy path; new management mode is explicit. An unclaimed instance is not open enrollment. Hosted setup uses canonical HTTPS and a one-use ten-minute code from the local operator; desktop trust is established by native supervision.
- No unverified flow is a shipping default. GitHub.com sign-in and authorized browsing are required for each public-first runtime. Entra, EMU/GHE.com and Copilot stay independently gated; no agent execution.
- Keep strict TypeScript, colocated `*.test.ts`, both 95% coverage thresholds, Bash repository scripting, the approved npm feed and registry-neutral npm lock. Use Podman or Rancher Moby for Linux validation, not the Docker CLI.
- Windows first: x64 MSVC, per-user NSIS and no Node or container install prerequisite. No MSI, auto-update, other desktop targets or public unverified binaries.

## Review Focus

- Two browsers racing to claim one instance yield exactly one owner, and claim loss cannot reopen setup (Task 1).
- A completed provider proof cannot be attached by another browser session or consumed twice, including concurrent completion (Task 2).
- A stale edit or an attempted owner-registration swap with another account leaves the active owner and old registration intact (Task 3).
- A credential key lost during restart or upgrade never causes replacement or loss of the encrypted vault (Tasks 1 and 5).
- Promoted release bytes are the native install-smoked, signed bytes, not a rebuilt or substituted installer (Task 6).

## Worktree and file map

The three design documents live in `.worktrees/desktop-management-design`, branch `docs/desktop-management-plane`, based on the rebased PR #5 tip `69909f9`. Before coding, check that branch and the approved docs are intact. If publishing a new stack layer is requested, verify the current GitHub stack and fork a distinct implementation branch from the verified parent; bring over these docs without altering any milestone worktree. If the stack moved, reconcile the interface changes before beginning. Do not push or merge as part of planning.

| Area | Proposed location |
| --- | --- |
| Runtime mode and composition | `src/server/main.ts`, `src/server/identity/portal.ts`, `src/server/management/runtime.ts` |
| Persistence, claim and vault key | `src/server/persistence/004-management.sql`, `src/server/persistence/migrations.ts`, `src/server/management/{setup,vault-key,operator}.ts` |
| Wire contract and routes | `src/shared/api/management-schemas.ts`, `src/server/http/management-routes.ts`, `src/server/build-app.ts`, `src/server/http/routes.ts` |
| Authorization and Settings | `src/server/identity/device-flow.ts`, `src/server/management/{authorization,settings}.ts`, `src/web/settings/{Setup,InstanceSettings,MyConnections}.svelte`, `src/web/settings/api.ts`, `src/web/AppShell.svelte` |
| Windows supervisor and pipeline | `src-tauri/{Cargo.toml,tauri.conf.json,capabilities/,src/}`, `scripts/package-windows-sidecar.sh`, `scripts/windows-install-smoke.sh`, `.github/workflows/{windows-artifacts,windows-release}.yml` |

## Stage A: Shared management plane

### Task 1: Persist an unclaimed instance and issue operator pairing

**Files:** Persistence, runtime mode, `management/{setup,vault-key,operator}.ts` and adjacent tests; add `setup/status` and `setup/pair` in `management-routes.ts`. Update the Containerfile allowlist and SQL packaging.

**Produces:** `createSetupStore(db, clock)` with `status(): { state: 'unclaimed' | 'claimed' }`, `issueCode(): { code: string; expiresAt: number }`, `pair(sessionId: string, code: string): void`, and transactional `claimOwner(sessionId: string, account: VerifiedPortalAccount): void`. `VerifiedPortalAccount` is `{ provider, host, subject, registrationId }`, produced only by verified authorization. `loadOrInitializeVaultKey(store, vaultExists)` returns a 32-byte key or fails without modifying an existing vault. The operator command is `node dist/server/main.js setup-code`, using the same configured data directory and safe direct terminal output.

- [ ] Add `setup.test.ts` cases for single-use, supersession, wrong session, simultaneous claim, and expiry at `issuedAt + 600_000`; assert final owner count `1` and issuance after claim fails. Add key tests for first launch, restart, and a missing or wrong key with an existing vault. Add injection tests for redacted unclaimed status, pairing `204`, wrong Origin/CSRF, and no remote issuance. Start management mode against a populated legacy database and assert it refuses to expose setup.
- [ ] Run `npm test -- src/server/management src/server/http/management-routes.test.ts`; expect failure for the missing setup modules/routes.
- [ ] Implement the separate startup paths. `FACTORY_MANAGEMENT_MODE=1` selects hosted management; `FACTORY_PUBLIC_ORIGIN` supplies its canonical HTTPS origin. Reject a simultaneous legacy credential configuration or a populated legacy state without a management owner. Issue pairing only from the local operator command. Persist digest and expiry, bind the claim to the session, and rate-limit the pairing endpoint even before sign-in. Use private persisted file permissions for the hosted key; expose an injectable native key adapter for Stage B. Keep fixtures out of production.
- [ ] Repeat targeted tests and run `npm run check`; expect green, including v3 upgrade, credential-free hosted startup and existing configured legacy mode. Commit `feat: add a host-verified Factory setup claim`.

### Task 2: Add GitHub device authorization and atomic completion

**Files:** `identity/device-flow.ts`, `management/authorization.ts`, shared schemas/routes and adjacent tests. Consume setup, existing identity/vault boundaries, and the exact provider registry.

**Produces:** `createAuthorizationService(deps)` with `start(sessionId, intent): Promise<AuthorizationStart>`, `status(sessionId, flowId): AuthorizationStatus`, `cancel(sessionId, flowId): void`, and `complete(sessionId, flowId): Completion`. A `Completion` may carry a rotated session only to the cookie-writing handler; it is never a JSON response. `AuthorizationStart` returns `flowId`, `expiresAt` and `browserInstructions` only; `AuthorizationStatus` uses the six states in the spec.

- [ ] Add deterministic transport tests: a pending response and `slow_down` honor the provider interval, expiry prevents further polls, cancel stops the transaction, and refresh has no secret. Add injection tests for no other-session access, no raw device credential in the start response, GET not consuming proof, and ready proof consumed once even under concurrent completion; a claim and owner session commit together. Assert missing GitHub installation denies repository browsing even after portal sign-in.
- [ ] Run `npm test -- src/server/identity/device-flow.test.ts src/server/management/authorization.test.ts src/server/http/management-routes.test.ts`; expect failure for the absent public-flow behavior.
- [ ] Implement GitHub.com separate public registrations, bounded polling and one-time completion. Store provisional provider credentials in the vault and clean up on expiry/cancel; make session/owner changes and proof consumption atomic. Keep legacy HTTPS callback and unsupported providers separate. Record staging proof for GitHub portal and repository flows, exact installation permission, refresh and denied access on a disposable repository before enabling the default.
- [ ] Run the above tests, API injection suite and `npm run check`; expect green with no live provider needed for automation. Commit `feat: authorize GitHub accounts interactively without app secrets`.

### Task 3: Add owner Settings, requester connections and the Svelte flows

**Files:** `management/settings.ts`, `management-routes.ts`, `management-schemas.ts`, `web/settings/` and `AppShell.svelte`, with adjacent API and component tests.

**Produces:** `readSettings(owner): InstanceSettings` (redacted and versioned) and `updateSettings(owner, expectedVersion, update): InstanceSettings`, using the current owner's verified identity and an explicit reauthorization proof for registration replacement. `settings/api.ts` implements setup, flow, Settings and existing connection calls using typed DTOs. Signed-in user credentials remain distinct from owner provider configuration.

- [ ] Add injection and Chromium tests for anonymous/non-owner refusal, Svelte setup-code → approval → ready → completion, masked configured status, stale version `409`, same-account rebind vs different-account rejection, and prevention of last-path removal. Verify browser reload, expiry, cancellation and denied access show explicit states. Disconnect must immediately block local use, and a failed upstream revocation must not be presented as successful.
- [ ] Run `npm test -- src/server/management/settings.test.ts src/server/http/management-routes.test.ts` and the fixture-backed browser suite; expect failure before Settings is wired.
- [ ] Implement owner-only configuration and audit metadata, user-scoped Connect/Reconnect/Disconnect, and the shared Svelte Setup/Settings views. Gate unsupported flows in the UI and again on the server. Use `/setup` as an explicit SPA path rather than broadening fallback.
- [ ] Run `npm run check`, `npm run coverage`, and a Chromium fixture happy path at 1080 × 720; expect both gates green and unchanged API isolation. Run `bash scripts/container-smoke.sh both "$npm_config_path"`; expect existing Linux boot and persistence behavior. Commit `feat: manage Factory and provider connections from Svelte`.

## Stage B: Windows sidecar and release artifacts

### Task 4: Package a private Windows runtime

**Files:** `src-tauri/`, Windows runtime adapter, `scripts/package-windows-sidecar.sh`, and native lifecycle tests. Consume the Stage A setup and key adapters, not browser-only credentials.

**Produces:** `startServer({ runtime: 'desktop', dataDir, artifactDir, port: 0, ... })` listening on numeric IPv4 loopback; a native supervisor starts and stops exactly one child, binds the app window to the returned local session, and passes setup proof and the OS-protected key through the private channel only. `bash scripts/package-windows-sidecar.sh` stages pinned Windows Node, `dist` and target production modules for the `x86_64-pc-windows-msvc` Tauri build.

- [ ] Add Windows lifecycle tests for non-loopback refusal, ordinary WebView/background requests without native setup proof, second launch with same data directory, clean shutdown, forced exit and key persistence. Test opening SQLite from staged Windows production dependencies before invoking the installer.
- [ ] Run the Windows native tests before supervision is wired; expect no managed start or ownership binding.
- [ ] Implement the pinned sidecar packaging, supervised startup/close, OS-user key wrapping and narrow IPC capabilities. Use the system browser for provider authorization; no arbitrary process command or local-path access from Svelte.
- [ ] Run Rust tests and the native build on Windows x64, with the pinned Node version and `npm run check`; expect the installed resource layout and native SQLite to work without a system Node or container engine. Commit `feat: package the Windows desktop sidecar`.

### Task 5: Smoke-test installation, upgrade and live desktop GitHub authorization

**Files:** `scripts/windows-install-smoke.sh`, Windows smoke fixtures, and operator README. Consume the Stage B sidecar, approved GitHub public IDs and disposable staging repo.

- [ ] Add installer assertions: clean machine, per-user install without elevation, real portal launch, no external Node, restart after a forced exit, and upgrade with a data copy from the prior supported release. Assert a missing vault key fails closed and no ordinary browser navigation can claim ownership.
- [ ] Run `bash scripts/windows-install-smoke.sh <installer>` on Windows x64; expect failure if the sidecar, resource, local trust, WebView2 or upgrade contract is incomplete.
- [ ] Fix the packaged startup path and verify system-browser GitHub sign-in and repository grant end-to-end against the approved staging account; complete the first hosted proof against HTTPS and host pairing separately. Record the exact capabilities proved and keep all others off.
- [ ] Run the same smoke against the final installer; expect installation, browse and restart with data intact. Keep test secrets outside the fixture and never record them in logs. Commit `test: verify a clean Windows install and upgrade`.

### Task 6: Build, sign and promote the exact Windows installer

**Files:** `.github/workflows/windows-artifacts.yml`, `.github/workflows/windows-release.yml`, and release operator instructions. Consume the Task 5 smoke contract and a protected signing environment.

- [ ] Add a workflow handoff check: a missing signature, digest mismatch, or missing smoke result must block promotion. Verify PRs/forks cannot access private feed or signing credentials and cannot publish a release.
- [ ] Build one per-user NSIS installer on native Windows x64 using pinned toolchains and the approved npm feed. Upload installer, SHA-256, producing run metadata and results. Sign and verify before the release smoke, so promotion uses the exact signed installer that passed.
- [ ] On a trusted release tag, download and verify that output and attach it to a draft GitHub Release; do not rebuild in the publish job. Validate with a disposable draft and compare digest and signature with the workflow output. No public publish without the required approvals and staging evidence.
- [ ] Commit `ci: publish verified Windows installer artifacts`.

## Follow-on capability proofs

Track Entra desktop loopback PKCE and hosted device code as separate follow-on tasks, using only delegated Azure DevOps scopes and proving tenant consent and denial. Validate GitHub EMU and `ghe.com` host, installation, refresh and policy independently; validate Copilot account authorization separately from runtime. A blocked capability stays visibly unavailable. These proofs do not expand v1 into a broker, automatic enrollment, MSI or live Copilot commands.
