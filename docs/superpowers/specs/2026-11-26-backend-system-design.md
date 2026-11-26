# Software Factory backend system design

Status: approved for implementation planning

## Goal and approaches

Run the static Svelte portal and its internal API in one Linux Docker container with TypeScript, Fastify, and host-local SQLite. Start with authenticated browsing and task projections; design task commands now but do not enable live effects until the provider/runtime-specific gates pass. The image is replaceable; the SQLite data, private credentials, and authorized Azure DevOps workspaces are not stateless.

- **Selected: standalone Fastify modular monolith.** Fastify serves static assets and hosts the [HTTP contract](2026-11-26-internal-api-design.md). Repository and runtime variations sit behind separate interfaces in the same deployment. An in-process operation loop executes durable intent without a queue service.
- **Not selected: framework-owned server or split services.** SSR does not help the static portal, and separate API and workers add deployment, credential, and recovery coordination before we need independent scaling. Keep the execution seam testable in-process without committing to another process or service.

No Redis, message broker, network filesystem for SQLite, autonomous scheduling, provider polling from the browser, global worker administration, or automatic merges. Live fixtures are not an authentication or provider fallback.

## Module seams

```text
Svelte static build
  -> Fastify HTTP module -> identity / repository / task modules
                             -> SQLite persistence
                             -> GitHub and Azure DevOps adapters
                             -> runtime adapters (capability gated)
  <- authorized snapshots, task projections, operation receipts
SQLite durable intent -> in-process operation loop -> verified effects
```

| Module | Interface and invariant |
| --- | --- |
| HTTP | Parse and validate at the Fastify edge, pass a server-resolved principal and typed input, and serialize safe DTOs. Do not teach routes provider SDK objects or SQL. Serve SPA fallback only for frontend navigation. |
| Identity | Resolve an opaque portal session, authorize connections and effects, and acquire/refresh credentials for an exact verified provider account. Credentials never cross into HTTP DTOs, browser storage, repository worktrees, or logs. |
| Repository | Resolve canonical repo, list/paginate source data, read a source detail, and perform explicit capability-gated writes. GitHub and Azure DevOps adapters own provider pagination, relationships, check revisions, and error normalization. Persist only completed snapshot pagesets, never overwrite a complete snapshot with a partial source result. |
| Tasks | Authorize and project tasks, reserve idempotent commands, enforce legal transitions, and derive what the caller can do. Treat runtime status and portal task state as different facts. Return one authoritative read model to the Active Sessions list and header. |
| Runtime | Provide capabilities, verified observation, and supported lifecycle operations for the selected account/runtime. GitHub-hosted and local-worktree paths are distinct. The operation module must not infer runtime support from a shared method name or documentation for another version. |
| Persistence/operations | Own short transactions, schema migrations, operation claiming, exact effect receipts, and recovery. Keep side effects out of transactions and transport-specific state out of domain records. |

Use one supported Node LTS release and a Debian/glibc base. Pin the Node, Fastify, SQLite binding, and SDK packages in an executable image check, not from a preview documentation snippet. One module seam per actual variation: real GitHub/ADO adapters and synthetic test adapters. Tests use the same interface as production; the release build never loads fixture credentials or synthetic provider data.

## Delivery slices

1. **Foundation:** pure `buildApp` composition separate from process startup, type checking and Fastify injection tests, static/health routes, a non-root image, and restart-safe migrations on a host-local data directory.
2. **Read path:** GitHub portal sign-in on configured hosts, separate Copilot account linking, delegated GitHub/Entra repository connections, authorized queries, user-triggered provider Sync, live source detail, and SQLite task/operation projections. No real task start, reply, archive, issue close, or connection removal. Keep controls visibly unavailable with a reason rather than returning successful no-ops. Expose authorized fixture records only in test composition.
3. **Gated live commands:** validate each proof independently for the exact identity, provider, runtime build, and deployment. Draft PR authorship and local execution isolation remain separate release gates. Safe browsing and explicit Sync must not wait on a Copilot runtime proof.

## Identity and repository data

Separate three roles: **portal sign-in** identifies the factory user, **Copilot authorization** selects an entitled GitHub user for SDK work, and **repository authorization** selects the delegated GitHub or Entra account used for repo access and PR publication. Use purpose-specific authorization grants and select the app registration used for that purpose on the server. One verified account may fill multiple roles without sharing grants. Never fall back to PATs, ambient CLI auth, installation/bot credentials, or another user's grant.

Support GitHub.com, including Enterprise Managed Users (EMU), and explicitly configured GitHub Enterprise Cloud data-residency hosts (`<tenant>.ghe.com`). An EMU user can sign in on their own configured host without a GitHub.com personal account. Configure exact web/OAuth and API hosts and the app registrations for each deployment host; an allowed host for one tenant is not a wildcard for other tenants. Bind OAuth intent to the registration, purpose, selected host, browser session, and target connection or Copilot account. Use only the bound host's endpoints for callback redemption and account lookup. Treat GitHub account identity as `(provider, canonicalHost, immutableProviderUserId)`, not email or username. Treat repository identity as `(provider, canonicalHost, stableProviderScope, stableProviderRepositoryId)`; repositories on separate GitHub hosts never share access grants or uniqueness keys. This is not support for arbitrary GitHub Enterprise Server URLs.

For GitHub repository access, require delegated user authorization and the applicable app installation, enterprise restrictions, and target permissions. Azure DevOps Services connects through delegated Microsoft Entra authorization. A different provider account never inherits a repo connection. Preserve one active connection per portal user and repository; retire the old one before independently authorizing a new account. Reconnect only the same account on the same host.

Use only a random opaque portal session ID in a host-only `Secure`, `HttpOnly`, `SameSite=Lax` cookie. Encrypt provider tokens in a server-side credential store separate from the task index, with a separately mounted key. Address credentials by requester, purpose, provider host, immutable account, and app registration. Serialize and persist refresh rotation for the exact grant, and invalidate grants independently. Closing the browser does not revoke a server grant; revocation, expiry, or policy denial pauses the affected action for reauthorization and never causes identity fallback. Registry entries, app secrets, and tokens are not passed to repository worktrees.

Require the same verified GitHub host and user for the repo and Copilot grants on native GitHub-hosted starts in v1. Check repository access and enterprise Copilot policy for that host with the pinned SDK; identity equality alone is not permission or data-residency proof. Browsing can use another account without granting launch. Azure DevOps worktree sessions use a GitHub Copilot grant plus the repo connection's Entra grant only where policy permits that pairing and execution environment. Never mirror or send enterprise code through another host to compensate for an unsupported flow. Bind each task to its original repo and Copilot accounts; changing the Copilot default applies to future runs only.

Within a request, authenticate before resolving repo IDs. Validate repository URLs against supported HTTPS hosts and provider URL formats before any outbound call. Bind a connection to the authenticated requester, verified provider account, and generation. Use the generation on commits to reject late Sync results after removal or reconnect. A confirmed provider denial invalidates the grant immediately and hides affected caches. Check grant age at read time: at 15 minutes since successful access verification, revalidate before serving private data or return unavailable on provider failure. SQLite-only projections must not perform provider revalidation; fail the required scope as `ACCESS_UNVERIFIED`, and let an explicit authorized repo read, reconnect, or Sync refresh it. Optional provider signals can invalidate grants sooner but are not a dependency.

GitHub list issues can contain PRs; normalize them separately. Use provider-confirmed issue-to-PR relationships for launch eligibility and explicit unknown status if completeness is unverified. Azure Boards work items are project scoped; a task intentionally pairs one with a selected repo. Bind CI evidence to the displayed PR revision and label incomplete or unavailable evidence. Do not assume identical CI support across providers or use branch names as proof of Factory provenance.

## SQLite and runtime lifecycle

Use the [storage spec](2026-11-26-storage-and-container-design.md#sqlite-schema) as the baseline for `users`, `identities`, `repositories`, `repo_connections`, `repo_snapshots`, and `tasks`, including task ownership foreign keys and the partial unique active repo/work-item index. This spec supersedes the draft connection key: use a stable opaque `connection_id`, a partial unique `(repo_id,user_id)` for non-retired connections, and explicit connection foreign keys for tasks and snapshots. A same-account reconnect increments generation; replacement with a different account has a new connection ID. Retired connection records remain as tombstones, never as active authorization. Add explicit tracked session observations and operation records before commands are enabled.

| Record | Fields and invariants to add |
| --- | --- |
| Connection grant | `connection_id`, last verified account and generation, `access_verified_at`, and optional denial time. Accept an unexpired grant only for that exact account and generation. |
| Copilot account | Opaque account ID owned by the requester, linked to the verified GitHub host/user and Copilot registration. Maintain a nullable default separately from repo connections. Tokens and refresh state live only in the encrypted credential store. |
| Task metadata | `state_changed_at`, nullable `finished_at`, `connection_generation`, `start_request_fingerprint`; one requested/session ID per runtime namespace; immutable repo- and Copilot-account bindings including host and purpose. Same-account credential renewal can restore access without changing the actor. Set `finished_at` only on first terminal transition. |
| Session observation | Task ID, runtime namespace and session ID, observed state, `observed_at`, and `valid_until` when the adapter can assert a validity window. Missing, expired, or unverifiable running evidence is `unverified` at the read seam. Terminal observations supersede a stale task projection. Store pending question ID and authorized display context separately from the summary. |
| Operations | ID, requester/connection/generation, optional task ID, kind, state, request key/fingerprint where applicable, safe error code, and timestamps. Keep at most one in-flight Sync per connection generation and one removal per generation. Persist per-source outcomes. |
| Task effect receipts | Task ID, operation/effect key, phase (`reserved`, `in_flight`, `confirmed`, `uncertain`), provider reference, and timestamps. Never put raw prompt or token material in the ledger. Durable input text, if accepted, is protected private app state with bounded retention. |
| Usage | Task-linked measured amount and observation time when available, plus explicit unavailable state. Missing amounts do not contribute zero. Do not derive finishing time or question age from `updated_at`. |
| Optional read projections | Verified check results keyed by repo, PR, and revision; read-only, requester-scoped discovered session metadata; recent task activity generated from safe transition and operation records. No transcript archive or additional database. |

Use WAL and foreign keys; all processes using the database must use host-local storage. Run migrations before readiness, and mount the directory containing the DB rather than the DB file alone. Use SQLite's online backup API, and test restore with a replaced image. Put Mongo/Redis-like cache concerns outside scope: SQLite stores task/snapshot data, while browser view state is discardable.

**Operation flow.** Reserve the task/operation and intent in one short SQLite transaction. Durable acceptance survives process termination. An in-process loop claims bounded work with a short transaction; mark the external effect in flight and commit before contacting the provider. Recheck authorization, capability, and applicable state before the effect. On return, record the evidence and advance state atomically with a version or generation guard. Do not hold a SQLite write lock across network I/O. Preserve idempotency for the same normalized command; do not re-run a command whose outcome is merely uncertain.

**Restart and stop.** Resume from durable intent, not in-memory callbacks. A task can remain mapped even if a runtime listing omits it. Reconcile an in-flight effect by exact requester, namespace, requested/session ID, and recorded publication reference; retry only when nonoccurrence is verified. Missing proof leaves `needs_recovery`. Never recreate a PR after an ambiguous create response unless reconciliation proves it is safe. Stop must be confirmed before archiving or clearing an Azure DevOps worktree. Preserve task-to-issue/PR identity after removal; do not archive or delete the upstream issue, branch, or PR by implication.

## Release gates for live commands

| Gate | Evidence before enablement | If evidence is missing |
| --- | --- | --- |
| GitHub-hosted start/options | Pinned SDK and authorized user grant work in the Linux image for the selected host; confirm the host and repository association, enterprise entitlement and policy, readiness, and account-specific model/options. Prove GitHub.com EMU and each approved `ghe.com` host separately. | Browsing may remain enabled. Leave start disabled on the unproven host; do not silently use another host, account, or runtime. |
| GitHub input and stop | Prove the supported input mode and question correlation separately; demonstrate confirmed stop rather than assuming disconnect/delete stops remote work. | Disable only the affected control; preserve status and show a verified provider session link when permitted. |
| Requester-authored draft PR | Verify a supported handoff and a draft PR attributed to the requester under their authorized credentials. | Do not enable automatic publication for that path; no bot fallback or automatic merge. |
| Azure DevOps worktree runtime | On the intended host, verify process isolation denies access to app data, secrets, sibling workspaces, and the Docker socket. Test restart and confirmed stop before cleanup. | Keep local execution disabled; repo browsing is independent. |
| Issue close and repo removal | Confirm expected provider transitions and revision checks where supported. For removal verify cleanup is scoped to stopped work and never deletes shared seeds still needed. | Leave the relevant mutation disabled or pending; never report a successful destructive action prematurely. |

Keep the application non-root. The repo adapter may maintain a backend-owned seed clone; each Azure DevOps task uses a private Git copy/worktree, not a linked worktree that gives access to shared mutable Git metadata. A Docker container, UID, or Git worktree alone is not sufficient proof of command isolation. Do not use privileged mode, mount the Docker socket, or give the runner repository write credentials. Runtime readiness does not depend on enabling an unsafe local runner.

## Acceptance and builder decisions

- A newly built image boots with static assets and a migrated database; a replacement with the same host-local mounts preserves mappings and snapshots. No real provider or agent is needed to test the read foundation.
- Fault tests cover cross-account access, refresh after revocation, partial provider batches, duplicate launch reservations, restart after unknown external effect, and stop not confirmed. Verify no orphaned operation can overwrite state after connection generation changes.
- The requester can browse both supported providers when authorized even when all live task gates are off. SQLite summary refresh makes no provider calls and unavailable usage is not shown as zero.
- The builder selects the schema library and SQLite binding after proving them in the target image. Before enabling any real adapter, document the actual pinned runtime and capability proof. No pre-selected sandbox mechanism is asserted safe by this design.

References: [Fastify](https://fastify.dev/docs/latest/), [SQLite WAL](https://sqlite.org/wal.html), [SQLite online backup](https://sqlite.org/backup.html), [Git worktree](https://git-scm.com/docs/git-worktree), [GitHub App user delegation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [Azure DevOps Entra OAuth](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops), [Copilot SDK cloud sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/cloud-sessions).

Enterprise identity references: [Copilot SDK OAuth and EMU](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth#enterprise-managed-users-emu), [managed account restrictions](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/abilities-and-restrictions-of-managed-user-accounts), [GHE.com API access](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency#api-access), [GHE.com feature differences](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/feature-overview-for-github-enterprise-cloud-with-data-residency), [Copilot data residency policy](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/github-copilot-with-data-residency).
