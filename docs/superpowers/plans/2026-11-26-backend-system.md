# Software Factory Backend System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-container Fastify backend that serves the static portal, provides authenticated repository browsing and task reads, and can enable proven live commands independently.

**Architecture:** Fastify composes identity, repository, task, runtime, and persistence modules in one process. SQLite is authoritative for scoped snapshots and durable intents; an in-process loop performs supported effects outside transactions and reconciles interrupted work.

**Tech Stack:** TypeScript, Fastify 5, npm, a supported Node LTS on Debian/glibc, host-local SQLite, Vitest, and Podman-built OCI packaging verified on Podman and Rancher Moby. Pin the compatible SDK only when validating the runtime adapter.

**Spec:** [Backend system design](../specs/2026-11-26-backend-system-design.md). The [Internal API design](../specs/2026-11-26-internal-api-design.md) owns HTTP DTOs, routes, and errors.

## Global Constraints

- One non-root Linux image with static Svelte and the same-origin API. No broker, Redis, external scheduler, or separate worker service.
- Host-local `/data` and `/workspaces`; app keys mounted separately. WAL and foreign keys on. Never put provider write credentials in a task workspace.
- Only verified delegated requester identities. No PAT, bot, ambient CLI token, fixture auth, or simulated provider success in production.
- Keep portal, Copilot and repository grants purpose-scoped. Support GitHub.com EMU and approved `*.ghe.com` hosts without cross-host fallback; the browser receives only an opaque session cookie.
- One active connection per portal user/repo and one active task per canonical repo/work item. Keep retired connections for referential integrity.
- Private data uses a **15-minute** verified-access window. Outage does not extend it. Read-only summary routes never trigger provider requests.
- Serve the read release with live commands gated off. Prove individual capabilities before enabling them; no automatic merge or implicit upstream deletion.

**Execution order:** Complete Task 1 here, then the [Internal API plan](2026-11-26-internal-api.md), then Tasks 2–5 here. The [Active Sessions frontend plan](2026-11-26-active-sessions-attention.md) may use the shared contract with fixtures; backend Task 4 owns the single production `GET /api/active-sessions` projection and its API tests. Extend those tests rather than registering a second route.

## Review Focus

- A replacement container must not serve requests with a migration half applied (Task 1).
- A reconnect to a different account must not adopt the old connection's tasks (Task 2).
- A late provider result after a generation change must not resurrect cached private data (Task 3).
- An expired grant must suppress the summary even when no task happens to exist (Task 4).
- A crash after an external effect but before its receipt must not cause a duplicate start, publication, or unsafe cleanup (Task 5).

## File Map

| Path | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `Containerfile`, `.containerignore` | Runtime pins, `check`, `test`, `build`, container packaging |
| `src/server/build-app.ts`, `src/server/main.ts` | Testable Fastify composition and production process lifecycle |
| `src/server/persistence/{open,migrations}.ts` | SQLite opening, transactions, migrations and connection/task invariants |
| `src/server/identity/{module,credentials,github-hosts}.ts` | Portal session, purpose-bound OAuth, exact host registry, and exact-account credential handling |
| `src/server/repositories/{module,github,azure-devops}.ts` | Verified provider adapters, snapshots, Sync and source reads |
| `src/server/tasks/{module,projection}.ts` | Authorized task detail and Active Sessions projection |
| `src/server/operations/{module,runner}.ts`, `src/server/runtime/capabilities.ts` | Durable effect claims, reconciliation and default-off runtime gate |
| Colocated `<module>.test.ts`, `scripts/container-smoke.sh` | Fault, isolation-of-data, restart, and packaging tests |

---

### Task 1: Create the runtime and persistence foundation

**Produces:** `buildApp(options: BuildAppOptions): Promise<FastifyInstance>` in `src/server/build-app.ts`; `openDatabase(path: string): Database` and `migrate(db: Database): void`. `BuildAppOptions` supplies `db`, `staticRoot`, and deployment metadata; once the API plan lands it also supplies `PortalModules`. Use the existing project root, not another server package.

- [ ] Set up the TypeScript/npm/Vitest test harness needed by this task. Add `foundation.test.ts`: assert the injected static entry loads and `/healthz` returns `{status:"ok"}` only after schema readiness; opening and closing the same DB preserves a seeded connection; an intentionally failed migration leaves the prior schema version and readiness false. Assert foreign keys and the partial unique constraints.
- [ ] Run `npm run test -- src/server/build-app.test.ts`; expect failure for the absent composition/migration implementation.
- [ ] Implement the migration runner with transactional version changes, host-local SQLite, WAL and foreign keys. Add the approved schema baseline plus stable connection IDs, retirement, and ownership keys. Port the static shell wiring without substituting the interactive HTML mockup for the application. The container smoke fixture supplies static files; the production image requires real built assets and serves no sample fallback.
- [ ] Add the non-root multi-stage Containerfile and `scripts/container-smoke.sh`: start the built Svelte image with a disposable host-local mount, verify readiness, replace the container, and restore a SQLite online backup. Validate the native binding with Podman and Rancher Moby.
- [ ] Run `npm run check`, `npm run coverage`, and `bash scripts/container-smoke.sh both "$npm_config_path" --browser`; expect type checks, coverage gates and runtime smoke to pass.
- [ ] Commit the executable foundation and tests as `feat: add Fastify and SQLite container foundation`.

### Task 2: Bind identity and connection grants

**Consumes:** `PortalModules.identity`, the auth routes, SQLite connection IDs and ownership constraints.

**Produces:** `resolveRequester(cookie: string | undefined): Promise<Requester | null>`, `beginAuthorization(requester: Requester | null, input: AuthorizationIntent): Promise<{authorizationUrl: string}>`, and `completeAuthorization(callback: AuthorizationCallback): Promise<AuthorizationResult>`. Keep credentials behind the identity module; `readGrant(connectionId: string, requester: Requester, now: number)` distinguishes `valid`, `denied`, and `unverified`.

- [ ] In `identity.test.ts` assert `completeAuthorization` rejects reused state and a host, app, session, or purpose mismatch. Unknown `.ghe.com` hosts make no outbound call. Use the same provider user ID on GitHub.com and an approved tenant; assert they are distinct principals. Assert a tenant EMU can sign in without GitHub.com, linking Copilot leaves the portal and repository bindings unchanged, a failed callback preserves existing grants, and a renewed Copilot grant never makes a repo grant valid. With a test clock, age `899_999` ms is valid and age `900_000` ms is unverified; confirmed denial invalidates immediately and failed verification does not renew.
- [ ] Run `npm run test -- tests\backend\identity.test.ts`; expect failure for the missing identity module.
- [ ] Implement `GitHubHostProfile` as configured `{id, hostname, webOrigin, apiOrigin, registrations}`; registrations are purpose-keyed and server-only. Resolve host and purpose in `beginAuthorization`; redeem only the bound intent and lookup an immutable identity on that host. Separate GitHub sign-in, delegated GitHub/Entra repo access, and Copilot link/reconnect. Store `Secure`, `HttpOnly`, `SameSite=Lax` opaque sessions, one-use OAuth intent, and encrypted provider credentials outside the task index. Serialize rotation by requester, purpose, host, account and registration. Make Copilot default selection independent of repo resolution and retire prior repo connections before accepting account replacements.
- [ ] Rerun the identity and API read/command tests; expect cross-account failures to remain non-disclosing and fixtures to use the same authorization rules. Commit as `feat: bind delegated provider identities to repository connections`.

### Task 3: Implement read-only provider data and explicit Sync

**Consumes:** `PortalModules.repositories`, `readGrant`, the authorized connection handle and generation. **Produces:** `readSnapshot<T>(requester: Requester, query: SnapshotQuery): Promise<SnapshotPage<T>>`, `syncConnection(requester: Requester, connectionId: string): Promise<AcceptedOperation>`, `readIssue(requester: Requester, query: IssueQuery): Promise<IssueDetail>`, and `runNextOperation(): Promise<boolean>` initially handling Sync only. GitHub/ADO adapters own their paging and mapping; no other module interprets provider payloads.

- [ ] In `sync.test.ts` exercise partial pages, complete empty data, a second in-flight Sync, a different cursor revision, a check lookup for the wrong PR head, and a delayed page after connection generation changes. Assert a complete empty source returns `items: []`; a partial source keeps the previous complete rows; the delayed page changes neither the snapshot nor grant; and verified access denial returns no old rows.
- [ ] Run `npm run test -- tests\backend\sync.test.ts`; expect the missing repository implementation to fail.
- [ ] Implement validated HTTPS repository resolution via the approved host registry and host-scoped stable IDs. Verify equal numeric repo IDs on separate hosts never share snapshots or connection grants. Implement authorized live details, independent revision-bound CI reads, and per-source snapshot replacement. GitHub filters PRs out of the issue feed; Azure Boards items retain their project scope. Reserve/coalesce Sync in SQLite and let it complete without Task 5. Restart a partial read-only Sync only with a valid generation and authorization. Never revalidate a cached summary by invoking providers.
- [ ] Rerun the Sync and injection tests. Mark unsupported provider capabilities unavailable, not empty. Commit as `feat: sync authorized GitHub and Azure DevOps repository views`.

### Task 4: Project tasks, sessions, and measured outcomes

**Consumes:** `PortalModules.tasks`, authorized connections and the persisted task/session observation. **Produces:** `readActiveSessions(requester: Requester): Promise<ActiveSessionSummary>` and `readTask(requester: Requester, taskId: string): Promise<TaskDetail>`; read-only task and stats routes use the same ownership and access checks.

- [ ] In `task-reads.test.ts` seed pending-input, unverified, pre-session, known-terminal, other-requester, and retired-connection records. Assert only allowed mapped rows appear and no provider adapter is invoked. Add an expired, otherwise eligible connection with no task rows; assert the summary returns `503 ACCESS_UNVERIFIED`, not `[]`. Assert missing usage remains null and weekly results ignore `updated_at` when no terminal timestamp exists.
- [ ] Run `npm run test -- tests\backend\task-reads.test.ts`; expect failure for the missing projection.
- [ ] Add durable session observations and explicit action availability. Project known task state separately from observed runtime state. Use an exact authorized grant for each required scope, sort by creation time then ID, and suppress terminal and unlinked sessions from Active Sessions. Expose Unlinked, recent activity, task options, and statistics only to the extent supported; unproven data is explicitly unavailable. Key per-user summaries and retain no transcript archive.
- [ ] Run `npm run test -- tests\backend\task-reads.test.ts tests\api\reads.test.ts` and `npm run check`; expect no provider reads and no private rows in denied or expired responses. Commit as `feat: project authorized factory tasks and sessions`. The separate Active Sessions frontend plan owns the browser check that those responses hide rows and counts.

### Task 5: Execute durable commands only behind capability gates

**Consumes:** Command DTOs and receipts, connection generation, repository/task modules, and Task 3's `runNextOperation`. **Produces:** `reserveOperation(requester: Requester, command: PortalCommand): Promise<AcceptedOperation | AcceptedTask>` and new command handlers in the existing operation loop. A separate `CapabilityGate` determines whether a real runtime or provider may perform a given effect. Production defaults to deny.

- [ ] In `operations.test.ts` assert parallel starts on one canonical item accept at most one independent request; same-key replay accepts only an identical command including the Copilot account; obsolete questions cannot accept input; and disabled capability, cross-host or cross-account GitHub starts create no operation. Verify changing defaults leaves an accepted task's original binding intact. Simulate restart after an effect but before its receipt: only exact confirmation completes it, uncertainty enters `needs_recovery`, and unconfirmed stop leaves the worktree and archived flag unchanged.
- [ ] Run `npm run test -- tests\backend\operations.test.ts`; expect the missing reservation and runner to fail.
- [ ] Implement task/operation reservations and receipts with short transactions, exact-key replay and generation guards. Claim bounded work in-process, release the DB transaction before external calls, and reconcile by verified receipt/identity before any retry. Keep protected input content outside the receipt and discard it per retention policy. A stop-and-remove operation must not delete a shared clone still needed by another connection or task. Keep live command adapters disabled while testing with recorded or synthetic evidence.
- [ ] Run `npm run test -- tests\backend tests\api`, `npm run check`, and the container smoke test; expect gated and restart behavior to pass without live writes. Commit as `feat: reserve and reconcile gated factory commands`.
- [ ] Before live rollout, record evidence for each approved GitHub host (including GitHub.com EMU) and pinned SDK/runtime: exact identity, host and repo compatibility, enterprise policy, model availability, readiness/stop, input behavior, and requester-attributed publication. Separately verify the permitted Copilot/Entra pairing and local Azure DevOps isolation. Trials may use only explicitly approved ordinary maintenance in disposable repositories. Without proof, leave the concerned effect disabled; do not defer browsing.
