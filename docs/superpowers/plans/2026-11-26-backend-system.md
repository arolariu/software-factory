# Software Factory Backend System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-container Fastify backend that serves the static portal, provides authenticated repository browsing and task reads, and can enable proven live commands independently.

**Architecture:** Fastify composes identity, repository, task, runtime, and persistence modules in one process. SQLite is authoritative for scoped snapshots and durable intents; an in-process loop performs supported effects outside transactions and reconciles interrupted work.

**Tech Stack:** TypeScript, Fastify 5, npm, a supported Node LTS on Debian/glibc, host-local SQLite, Vitest, Docker. First candidate: Node 24 LTS and `better-sqlite3`; verify the pinned combination in the image before using it. Pin the compatible SDK only when validating the runtime adapter.

**Spec:** [Backend system design](../specs/2026-11-26-backend-system-design.md). The [Internal API design](../specs/2026-11-26-internal-api-design.md) owns HTTP DTOs, routes, and errors.

## Global Constraints

- One non-root Linux image with static Svelte and the same-origin API. No broker, Redis, external scheduler, or separate worker service.
- Host-local `/data` and `/workspaces`; app keys mounted separately. WAL and foreign keys on. Never put provider write credentials in a task workspace.
- Only verified delegated requester identities. No PAT, bot, ambient CLI token, fixture auth, or simulated provider success in production.
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
| `package.json`, `package-lock.json`, `tsconfig.json`, `Dockerfile`, `.dockerignore` | Runtime pins, `check`, `test`, `build`, container packaging |
| `src/server/build-app.ts`, `src/server/main.ts` | Testable Fastify composition and production process lifecycle |
| `src/server/persistence/{open,migrations}.ts` | SQLite opening, transactions, migrations and connection/task invariants |
| `src/server/identity/{module,credentials}.ts` | Portal session, OAuth intent and exact-account credential handling |
| `src/server/repositories/{module,github,azure-devops}.ts` | Verified provider adapters, snapshots, Sync and source reads |
| `src/server/tasks/{module,projection}.ts` | Authorized task detail and Active Sessions projection |
| `src/server/operations/{module,runner}.ts`, `src/server/runtime/capabilities.ts` | Durable effect claims, reconciliation and default-off runtime gate |
| `tests/backend/{foundation,identity,sync,task-reads,operations}.test.ts`, `tests/backend/container-smoke.ps1` | Fault, isolation-of-data, restart, and packaging tests |

---

### Task 1: Create the runtime and persistence foundation

**Produces:** `buildApp(options: BuildAppOptions): Promise<FastifyInstance>` in `src/server/build-app.ts`; `openDatabase(path: string): Database` and `migrate(db: Database): void`. `BuildAppOptions` supplies `db`, `staticRoot`, and deployment metadata; once the API plan lands it also supplies `PortalModules`. Use the existing project root, not another server package.

- [ ] Set up the TypeScript/npm/Vitest test harness needed by this task. Add `foundation.test.ts`: assert the injected static entry loads and `/healthz` returns `{status:"ok"}` only after schema readiness; opening and closing the same DB preserves a seeded connection; an intentionally failed migration leaves the prior schema version and readiness false. Assert foreign keys and the partial unique constraints.
- [ ] Run `npm run test -- tests\backend\foundation.test.ts`; expect failure for the absent composition/migration implementation.
- [ ] Implement the migration runner with transactional version changes, host-local SQLite, WAL and foreign keys. Add the approved schema baseline plus stable connection IDs, retirement, and ownership keys. Port the static shell wiring without substituting the interactive HTML mockup for the application. The container smoke fixture supplies static files; the production image requires real built assets and serves no sample fallback.
- [ ] Add a non-root multi-stage Docker image and `container-smoke.ps1`: start the image with a disposable host-local data mount and fixture-built static assets, verify the route and DB readiness, replace the container using the same mount, then check the seeded DB row survives. Include a restoration check from a SQLite online backup. Validate the pinned SQLite binding on the target image.
- [ ] Run `npm run check`, the targeted tests, and `.\tests\backend\container-smoke.ps1`; expect type checks, tests, and replacement/restore smoke to pass.
- [ ] Commit the executable foundation and tests as `feat: add Fastify and SQLite container foundation`.

### Task 2: Bind identity and connection grants

**Consumes:** `PortalModules.identity`, the auth routes, SQLite connection IDs and ownership constraints.

**Produces:** `resolveRequester(cookie: string | undefined): Promise<Requester | null>`, `beginAuthorization(requester: Requester | null, input: AuthorizationIntent): Promise<{authorizationUrl: string}>`, and `completeAuthorization(callback: AuthorizationCallback): Promise<AuthorizationResult>`. Keep credentials behind the identity module; `readGrant(connectionId: string, requester: Requester, now: number)` distinguishes `valid`, `denied`, and `unverified`.

- [ ] In `identity.test.ts` assert `completeAuthorization` rejects reused or mismatched state, a failed callback leaves the old session intact, and switching provider accounts does not give the new account the old connection. With a test clock, assert age `899_999` ms is valid and age `900_000` ms is unverified. Assert confirmed denial invalidates immediately and a failed verification does not renew the grant.
- [ ] Run `npm run test -- tests\backend\identity.test.ts`; expect failure for the missing identity module.
- [ ] Implement GitHub sign-in and delegated GitHub/Entra connections through injectable OAuth adapters. Store an opaque portal session and single-use OAuth intent, validate callback and exact provider account, rotate sessions on sign-in, secure unsafe requests with the API's CSRF contract, and store encrypted private credentials outside the task index. Serialize token rotation per account. Require an existing connection to retire before a new account obtains access; do not transfer history.
- [ ] Rerun the identity and API read/command tests; expect cross-account failures to remain non-disclosing and fixtures to use the same authorization rules. Commit as `feat: bind delegated provider identities to repository connections`.

### Task 3: Implement read-only provider data and explicit Sync

**Consumes:** `PortalModules.repositories`, `readGrant`, the authorized connection handle and generation. **Produces:** `readSnapshot<T>(requester: Requester, query: SnapshotQuery): Promise<SnapshotPage<T>>`, `syncConnection(requester: Requester, connectionId: string): Promise<AcceptedOperation>`, `readIssue(requester: Requester, query: IssueQuery): Promise<IssueDetail>`, and `runNextOperation(): Promise<boolean>` initially handling Sync only. GitHub/ADO adapters own their paging and mapping; no other module interprets provider payloads.

- [ ] In `sync.test.ts` exercise partial pages, complete empty data, a second in-flight Sync, a different cursor revision, a check lookup for the wrong PR head, and a delayed page after connection generation changes. Assert a complete empty source returns `items: []`; a partial source keeps the previous complete rows; the delayed page changes neither the snapshot nor grant; and verified access denial returns no old rows.
- [ ] Run `npm run test -- tests\backend\sync.test.ts`; expect the missing repository implementation to fail.
- [ ] Implement validated HTTPS repository resolution, stable provider identifiers, authorized live details, independent revision-bound CI reads, and per-source snapshot replacement. GitHub filters PRs out of the issue feed; Azure Boards items retain their project scope. Store only verified links as authoritative. Reserve/coalesce Sync in SQLite; implement the operation reader and run loop here so it can complete Sync without Task 5. On restart, restart an incomplete read-only Sync only if its generation and authorization still permit it. Use stable cursors and source-level progress. Revalidate expired access only at a permitted live read or Sync, never on a cached summary.
- [ ] Rerun the Sync and injection tests. Mark unsupported provider capabilities unavailable, not empty. Commit as `feat: sync authorized GitHub and Azure DevOps repository views`.

### Task 4: Project tasks, sessions, and measured outcomes

**Consumes:** `PortalModules.tasks`, authorized connections and the persisted task/session observation. **Produces:** `readActiveSessions(requester: Requester): Promise<ActiveSessionSummary>` and `readTask(requester: Requester, taskId: string): Promise<TaskDetail>`; read-only task and stats routes use the same ownership and access checks.

- [ ] In `task-reads.test.ts` seed pending-input, unverified, pre-session, known-terminal, other-requester, and retired-connection records. Assert only allowed mapped rows appear and no provider adapter is invoked. Add an expired, otherwise eligible connection with no task rows; assert the summary returns `503 ACCESS_UNVERIFIED`, not `[]`. Assert missing usage remains null and weekly results ignore `updated_at` when no terminal timestamp exists.
- [ ] Run `npm run test -- tests\backend\task-reads.test.ts`; expect failure for the missing projection.
- [ ] Add durable session observations and explicit action availability. Project known task state separately from observed runtime state. Use an exact authorized grant for each required scope, sort by creation time then ID, and suppress terminal and unlinked sessions from Active Sessions. Expose Unlinked, recent activity, task options, and statistics only to the extent supported; unproven data is explicitly unavailable. Key per-user summaries and retain no transcript archive.
- [ ] Run `npm run test -- tests\backend\task-reads.test.ts tests\api\reads.test.ts` and `npm run check`; expect no provider reads and no private rows in denied or expired responses. Commit as `feat: project authorized factory tasks and sessions`. The separate Active Sessions frontend plan owns the browser check that those responses hide rows and counts.

### Task 5: Execute durable commands only behind capability gates

**Consumes:** Command DTOs and receipts, connection generation, repository/task modules, and Task 3's `runNextOperation`. **Produces:** `reserveOperation(requester: Requester, command: PortalCommand): Promise<AcceptedOperation | AcceptedTask>` and new command handlers in the existing operation loop. A separate `CapabilityGate` determines whether a real runtime or provider may perform a given effect. Production defaults to deny.

- [ ] In `operations.test.ts` assert parallel starts on one canonical item accept at most one independent request; same-key replay accepts only an identical command; an obsolete question cannot accept input; and disabled capability creates no operation. Simulate restart after an effect but before its receipt. Assert only exact confirmation can finish the effect, unconfirmed effects enter `needs_recovery` rather than retry, and unconfirmed stop leaves the worktree and archived flag unchanged.
- [ ] Run `npm run test -- tests\backend\operations.test.ts`; expect the missing reservation and runner to fail.
- [ ] Implement task/operation reservations and receipts with short transactions, exact-key replay and generation guards. Claim bounded work in-process, release the DB transaction before external calls, and reconcile by verified receipt/identity before any retry. Keep protected input content outside the receipt and discard it per retention policy. A stop-and-remove operation must not delete a shared clone still needed by another connection or task. Keep live command adapters disabled while testing with recorded or synthetic evidence.
- [ ] Run `npm run test -- tests\backend tests\api`, `npm run check`, and the container smoke test; expect gated and restart behavior to pass without live writes. Commit as `feat: reserve and reconcile gated factory commands`.
- [ ] Before any live rollout, record evidence for each gate in the backend spec: pinned SDK and requester identity, known readiness/stop and input behavior, requester-attributed publication, and host-verified Azure DevOps isolation. Capability trials may use only explicitly approved ordinary maintenance in disposable repositories. Without proof, leave the concerned effect disabled; do not defer the read release.
