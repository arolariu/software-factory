# Desktop distribution and Svelte management plane

**Status:** Approved for implementation planning. Based on the repository-read milestone at PR #5 (`69909f9`). This extends the [internal API](2026-11-26-internal-api-design.md) and [deployment contract](2026-11-26-docker-image-design.md); it does not enable task execution. Provider feasibility and limitations are recorded in the [research note](../research/2026-11-27-interactive-management-plane.md).

## Intent

Ship the same Factory as a Linux container and a standalone, per-user Windows x64 Tauri installer. Either runs without a pre-created Factory account or preloaded provider secrets. Operators use Svelte Settings to claim and configure the instance; users sign in and authorize their own connections interactively. The desktop app does not require Node, Podman, another Factory deployment, or a cloud identity broker for the default path. Provider sign-in and repository browsing still require network access.

**Non-goals:** A Rust backend rewrite, automatic enrollment of other users, generic secret management, bundled provider credentials, macOS/Linux desktop targets, MSI, auto-update, Copilot SDK entitlement changes, and local repository execution. The existing signed-out portal is not a finished Settings UI.

## Approaches and decision

| Approach | Trade-off |
| --- | --- |
| **Selected: one Fastify/Svelte app, packaged with a Tauri-managed sidecar on Windows** | Reuse SQLite, the API, authorization rules and UI. Use provider-supported public flows where verified. Build and test another native artifact, and explicitly handle desktop lifecycle and startup trust. |
| Desktop shell for a hosted Factory only | Simpler installer and keeps confidential flows on an existing server, but can't run the whole application independently. Not the default desktop edition. |
| Confidential app credentials supplied for every install | Reuses the existing HTTPS callback flow, but defeats install-and-sign-in. Keep custom registrations only as an explicit deployment override, not the first-run requirement. |

The current `main.ts` opens identity only when a mounted config is present, and the current OAuth transport requires a client secret for code exchange. Both assumptions need to become deployment-specific. The production app currently binds all interfaces; desktop mode must not inherit that listener.

## Claim and Settings

```text
Hosted:  Open HTTPS setup -> Enter host pairing code -> Sign in -> Instance Settings
Desktop: Open Factory     -> Confirm setup locally   -> Sign in -> Instance Settings
Claimed: Sign in -> Connect repository -> Link Copilot when supported
```

- **Hosted:** The only up-front deployment configuration is non-secret infrastructure: canonical public HTTPS origin, trusted ingress and persistent storage. A local operator runs an on-demand pairing command using the app's data volume and OS permissions; there is no remote issuance endpoint. It prints one high-entropy code directly to the operator, not the app log. Store only its digest, expire it after ten minutes, and supersede previously unused codes. Accept it only on the configured HTTPS origin in a rate-limited, CSRF-protected setup request. Consume it atomically and bind a short-lived claim to the current anonymous session. Invalid, expired and reused codes get the same safe error. If setup expires or is cancelled, the operator can issue a new code while the instance is unclaimed.
- **Desktop:** Tauri confirms setup in native UI under the launching OS user's profile. Only the trusted native supervisor can authorize an initial claim through its private child channel. A localhost request, a user-supplied header or another WebView cannot authorize setup. Keep setup proof out of command-line arguments, browser URLs and logs.
- **Both:** Successful interactive sign-in atomically converts a valid claim into one durable owner binding and rotates the session. Use the exact verified provider account and registration, not email. Concurrent claims cannot create multiple owners. Once claimed, disable bootstrap, including local issuance. The default first release is owner-only; team enrollment and owner transfer need their own design. Existing installations retain their legacy behavior until an explicit operator migration is designed; do not assume ownership from a pre-existing row. The v1 recovery runbook covers restoring a consistent backup and recovering the bound provider account. If neither works, the instance remains locked; no reset-ownership endpoint or automatic reopening of bootstrap is in scope.
- **Instance Settings:** Owner-only. Show configured provider capabilities, host/tenant policy, public client IDs and safe last-verification status. Support explicit save/validate/reconnect for optional custom registrations. An existing confidential registration can be replaced without exposing its secret. Reject stale edits and removal of the last usable sign-in path. Replacing the owner's registration requires explicit reauthorization under the proposed registration, with the same verified provider, host and immutable account; activate the replacement and update the owner binding together, only after proof. Existing repository and Copilot grants do not silently move across host, account, purpose or registration. Record actor, action and time in audit metadata without secrets.
- **My Connections:** Each signed-in user manages only their own repository and Copilot grants. Show **Connect**, **Reconnect** and **Disconnect** with explicit offline, expired, denied and unsupported states. Disconnect blocks local use immediately; do not claim upstream revocation unless the provider confirms it. Do not require Copilot sign-in for repository reads. The current one-repository/one-active-account rule remains.

### Boundary and storage

Fastify owns authorization and transport. No requester ID or owner role is accepted from Svelte input. Use strict schemas, `no-store`, safe errors, same-origin checks and CSRF for unsafe requests. Keep opaque sessions HTTP-only and use an appropriate secure transport for each runtime; do not relax hosted cookie policy to make loopback work. Provider access, refresh, device authorization and confidential app secrets stay out of Svelte state after submission, DTOs, URLs, logs, crash reports, and artifacts. The user-visible device code is the exception: display it transiently on the initiating screen, never return the provider's device credential.

Use the existing encrypted vault for provider tokens and custom registration secrets. New installs generate a random vault key without an operator entering a value: Windows uses OS-user protection, and hosted uses an app-owned private key file outside the two database files and their backup set. A missing or mismatched key on an existing vault fails closed; never create a replacement over it. Stop the app and back up the two databases as a pair; protect and escrow the key separately. Releases, signing and the approved npm feed have separate CI credentials that are never shipped or entered in Settings.

### Interactive authorization

Keep portal, repository and Copilot grants separate. Ship public registration identifiers only for flows verified against the target provider and policy. Use an external browser for approval, never an embedded sign-in WebView. Persist a bounded, purpose-bound transaction tied to the initiating Factory session; only the backend handles provider credentials, status polling, expiry, cancellation and binding checks. Allow only registered provider endpoints and approved host/tenant combinations. No PAT input, no ambient CLI fallback, and no provider token passed through an app redirect.

| Deployment | Default candidate and required proof |
| --- | --- |
| GitHub.com, desktop or hosted | GitHub App device authorization for each applicable purpose; prove delegated repository installation/permissions and refresh without a secret. Validate EMU and configured `ghe.com` hosts separately. Confirm Copilot entitlement and public-flow compatibility independently before offering that button. |
| Entra, desktop | Public client authorization code with PKCE through the system browser and a provider-registered loopback callback. The native app receives the response and the backend completes its own bound session handoff. Prove delegated Azure DevOps Boards/Git access and tenant consent. |
| Entra, hosted | Public device authorization is a candidate where the tenant permits it; it is not equivalent to a native loopback callback. Prove the flow with delegated Azure DevOps scopes and representative tenant policy. If blocked, show the limitation; offer a separately configured confidential registration only where approved. |

The offline tests validate our behavior, not the providers' live acceptance. Each runtime's public-first release requires a real staging proof for GitHub.com sign-in and read-only browsing of one authorized repository. EMU, GHE.com, Entra and Copilot link remain independently gated and unavailable until proven; label that coverage in release notes. A broker is a separate decision if an essential provider cannot support a public flow; do not silently add a hosted service or weaken trust.

### Proposed wire additions

| Endpoint | Contract |
| --- | --- |
| `GET /api/setup/status` | Before sign-in, returns only whether the instance is `unclaimed` or `claimed` and which verified setup path is available. |
| `POST /api/setup/pair` | Hosted anonymous pre-session plus CSRF and `{code}`. Consumes an eligible code, binds setup to the session and returns `204`. No owner is assigned until sign-in completes. |
| `POST /api/authorization/flows` | Starts an approved purpose-specific public flow. Returns an opaque `flowId`, expiry, and only safe browser instructions. Require setup binding, authenticated requester, or normal sign-in pre-session as appropriate. |
| `GET /api/authorization/flows/{id}`, `DELETE /api/authorization/flows/{id}` | Initiating-session-scoped status (`pending`, `ready`, `complete`, `cancelled`, `expired`, `failed`) and CSRF-protected cancellation. GET never attaches an account, rotates a session, or renews a grant. |
| `POST /api/authorization/flows/{id}/complete` | Initiating-session-scoped and CSRF-protected; consumes verified `ready` proof once. Returns `204`; successful portal sign-in rotates the session via `Set-Cookie`, never JSON. Claiming and first sign-in commit together. |
| `GET /api/settings/instance`, `PUT /api/settings/instance` | Owner-only read and version-checked update; credentials may be write-only inputs and cannot appear in a returned schema. Keep provider account actions in requester-scoped routes. |

An external browser callback or device polling result can make proof ready, but only the initiating Factory session can claim it. Verify the actual cookie behavior on Windows WebView2 and in the hosted browser before enabling either flow. Legacy configured deployments keep their existing routes. Add `/setup` to the vetted SPA paths without broadening asset/API fallback.

## Windows packaging and publishing

Tauri supervises the existing pinned Windows Node executable with the compiled `dist` and Windows production dependencies as resources. Verify distribution licensing, checksums, native SQLite loading and that the installer contains only the allowlisted runtime files. Run one instance per user data directory. Bind Fastify to an ephemeral port on `127.0.0.1` only, report readiness over the private parent/child channel, and trust only the supervised window's local session. Treat loopback as reachable by other local processes and ordinary web pages: constrain hosts/origins and IPC, expose no general shell API, and open provider pages in the OS browser. This is not a sandbox against arbitrary code already running with the same Windows user's privileges. Drain or terminate the owned child on exit; prove crash/relaunch, install/upgrade and migration against the per-user data path.

Build the Windows x64 MSVC target and one per-user NSIS installer on a native Windows runner, with pinned Rust, Node, npm, Tauri and the approved feed. Let WebView2 Evergreen handle the evergreen runtime path; test a clean Windows machine. Build jobs upload installer/checksum and smoke results to GitHub Actions; a trusted version-tag workflow promotes the exact verified, signed bytes to a draft GitHub Release. Use distinct build/release permissions and protected signing credentials. Unsigned development artifacts are not public releases. The Windows workflow must not depend on a container engine, while Linux continues using Podman and Rancher Desktop Moby without the Docker CLI.

References: [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [Windows installer targets](https://v2.tauri.app/distribute/windows-installer/), [Tauri GitHub Actions pipeline](https://v2.tauri.app/distribute/pipelines/github/), [Windows code signing](https://v2.tauri.app/distribute/sign/windows/), [GitHub Actions artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts), and [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Acceptance before public release

1. Install and launch on clean Windows x64 without Node, a container engine, or a configured provider identity. First launch, repeat launch, forced exit, and upgrade preserve expected state without orphaned desktop processes.
2. On hosted Factory, a remote visitor cannot claim the instance; a fresh operator can pair and sign in. Replay, expiry, concurrent claims, wrong-session flow access, denied policy and failed stale edits leave the owner and credential state intact.
3. With an approved staging repository, both consumption modes verify interactive authorization, read-only browsing, rotation/reconnect and sign-out. No secret appears in compiled assets, runtime logs, or response DTOs. If a provider or tenant is unverified, ship it disabled rather than assuming compatibility.
4. Strict project checks and both 95% TypeScript/Svelte coverage gates pass; Bash is used for repository automation. Existing Linux image, native SQLite, restart and paired backup/restore behavior remain supported. The signed GitHub Release asset matches the installer tested by the release pipeline.
