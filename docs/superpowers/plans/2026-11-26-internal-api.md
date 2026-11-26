# Software Factory Internal API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide the Svelte portal with a typed, tested wire contract for repository browsing, Active Sessions, and gated commands.

**Architecture:** Shared schemas own portable DTOs and validation rules. Fastify routes call application modules through an injected interface; the contract suite uses Fastify injection and explicit test adapters, not a provider or an authentication bypass.

**Tech Stack:** TypeScript, Fastify 5, TypeBox-compatible JSON Schema, Vitest, npm.

**Spec:** [Internal API design](../specs/2026-11-26-internal-api-design.md).

## Global Constraints

- Same-origin `/api`, no public version prefix; `/auth/*` and `/healthz` are not SPA routes.
- Preserve `GET /api/active-sessions` and the existing `ActiveSessionSummary` fields. Use no provider or SDK calls on this route.
- Validate inputs and outputs, never accept a requester ID, and use `Cache-Control: no-store` for private API replies and errors.
- A write is not accepted until durable; `202` always carries `Location`. Keep gated commands unavailable until proven. No real provider or SDK calls in contract tests.
- Private snapshot access expires after **15 minutes**. `503 ACCESS_UNVERIFIED` clears affected frontend rows and counts; it is not a last-good transport failure.
- Invariant checks are server-side. Fixture adapters must not be reachable in the production composition.

**Execution order:** Backend system [Task 1](2026-11-26-backend-system.md#task-1-create-the-runtime-and-persistence-foundation) lands first so `npm run check` and the Vitest script exist. Complete this API plan before wiring the real modules in backend Tasks 2–5. Both plans use the same `buildApp` and `PortalModules` interface; do not scaffold them twice.

## Review Focus

- Prototype or extra fields supplied by the browser are rejected, not dropped while proceeding (Task 1).
- A valid Svelte navigation fallback cannot hide an API or OAuth routing failure (Task 2).
- Expired provider authorization must not return an apparently valid empty cross-repo summary (Task 2).
- A caller whose access changed between attempts must not see a previously accepted receipt (Task 3).
- An unverified or incomplete check result must not look like a green zero-check result (Task 1).

## File Map

| Path | Responsibility |
| --- | --- |
| `src/shared/api/schemas.ts`, `src/shared/api/schemas.test.ts` | Wire DTOs, enum and paging constraints, public schema tests |
| `src/server/http/portal-modules.ts` | Typed module interface at the HTTP seam |
| `src/server/http/{routes,auth-routes,repository-routes,task-routes,problems}.ts` | Route registration, CSRF checks and response mapping |
| `src/server/build-app.ts` | Existing Fastify composition from Backend Task 1; registers HTTP routes |
| `tests/api/{reads,commands}.test.ts`, `tests/api/fixtures.ts` | Network-free injection tests; adapters are test-only |

---

### Task 1: Establish the wire schemas

**Produces:** `src/shared/api/schemas.ts` exports `ApiSchemas`, `ApiProblem`, `ActiveSessionSummary`, `StartTask`, `TaskInput`, `OperationView`, and the remaining named request/response DTOs from the spec. Derive TS types from schemas; never import Fastify or SQLite in this module.

- [ ] Add `strictWireInput`, `authorizedSummaryShape`, and `unavailableIsNotEmpty` in `schemas.test.ts`. Assert `Value.Check(ApiSchemas.startTask, { startRequestId: "req1", workItemKey: "42", requesterId: "other" })` is `false`; an invalid query `limit: 101` is rejected; a nullable session title remains valid; and an unavailable `CheckDetail` with numeric zero counts or an unavailable snapshot with `items: []` is rejected.
- [ ] Run `npm run test -- src\shared\api\schemas.test.ts`; expect failure for missing schemas.
- [ ] Implement strict object schemas, discriminated availability and snapshot shapes, all route query/body and response schemas, the `TaskInput` variants, and the complete status and operation enums. Preserve the approved DTO names and nullability; check evidence with unavailable status has null counts. For strict inputs, configure validation to reject rather than strip extra properties.
- [ ] Run the same test command plus `npm run check`; expect all tests and type checks to pass.
- [ ] Commit the shared schemas and tests as `feat: define internal API payload schemas`.

### Task 2: Register authenticated reads and access responses

**Consumes:** `buildApp` from Backend Task 1 and `ApiSchemas` from Task 1.

**Produces:** `registerPortalRoutes(app: FastifyInstance, modules: PortalModules): void`. `PortalModules` groups `identity`, `repositories`, `tasks`, and `operations`; methods return typed DTOs or domain failures with a stable safe code. Only `identity` converts request cookies into an authenticated `Requester`. No handler accepts a requester from input or exposes a provider record.

- [ ] Add API injection cases in `tests/api/reads.test.ts`: assert an unsigned `GET /api/me` returns `401 AUTH_REQUIRED`; an out-of-scope task returns `404 NOT_FOUND`; an expired-grant summary returns `503 ACCESS_UNVERIFIED` with no `sessions` or `repositories`; and a healthy empty summary returns `{repositories: [], sessions: []}`. Assert the summary route calls only the task read interface. Under SPA fallback, assert an unknown `/api/*`, OAuth subpath, or non-GET frontend path does not return HTML. Check one live-detail fixture and a PR revision mismatch separately from the list snapshots.
- [ ] Run `npm run test -- tests\api\reads.test.ts`; expect the fixture-backed routes to fail before registration.
- [ ] Implement the single safe error mapper and register the full inventory of reads, including Build, health, CSRF bootstrap, PR checks, unlinked sessions, task activity, and statistics. Register interactive auth starts/callbacks/logout as explicit routes using the identity module and safe redirects. Ensure no-store error headers and distinct denial/unverified errors; keep Fastify error serialization from exposing raw validation input or credentials.
- [ ] Rerun the read tests and `npm run check`; expect contract and routing assertions to pass.
- [ ] Commit the HTTP read composition as `feat: expose portal read and sign-in contracts`.

### Task 3: Register command receipts and capability failures

**Consumes:** `registerPortalRoutes`, `PortalModules`, and the shared command schemas.

**Produces:** Application command results `AcceptedTask = {taskId: string; state: "queued"}` and `AcceptedOperation = {operationId: string}`; successful issue close returns the confirmed `IssueRow`. HTTP computes `Location` from the accepted ID and never schedules work or constructs provider-side IDs.

- [ ] Add injection tests in `tests/api/commands.test.ts` for Sync coalescing, start replay, conflicting input under the same request ID, stale question, unconfirmed archive, and provider-confirmed close. Assert a start receipt contains `Location: /api/tasks/task_fixture`; a disabled start returns `409 CAPABILITY_UNAVAILABLE` with zero accepted intents; wrong Origin or CSRF token never invokes the command; and a replay after access loss returns denial rather than the old receipt. Assert the owner can read only the safe receipt after a completed removal, while another requester receives `404`.
- [ ] Run `npm run test -- tests\api\commands.test.ts`; expect the missing command handlers to fail.
- [ ] Register Sync plus all gated mutations with strict schemas. Check requester access and CSRF before capability and replay results are exposed. Delegate fingerprint checks, mutual exclusion, persistence, state transitions, and actual effects to application modules. Use `/api/operations/{id}` for operation receipts and `/api/tasks/{id}` for task start receipts. Never return `202` for a disabled or unpersisted operation.
- [ ] Run `npm run test -- tests\api` and `npm run check`; expect success using injected adapters and no outside requests.
- [ ] Commit the command contract as `feat: define gated commands and acceptance receipts`.
