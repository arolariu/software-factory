# Software Factory internal API design

Status: approved for implementation planning

## Goal and approach

Give the static Svelte portal a stable, same-origin TypeScript/Fastify HTTP contract for repository browsing, Active Sessions, and task commands. Specify the full contract now, ship the read path first, and give the frontend fixtures for gated commands. A read-only specification would be smaller, but would leave the task UI without a contract for pending work, retries, or unsupported features. This is not a public API; do not add a version prefix, client tokens, or a second task model.

The [backend system spec](2026-11-26-backend-system-design.md) owns execution and persistence. The [portal design](2026-11-26-storage-and-container-design.md) owns user flows except where this spec updates identity linking or account selection; the [Active Sessions design](2026-11-26-active-sessions-attention-design.md) owns grouping and freshness. This spec owns the wire format, and preserves `GET /api/active-sessions` from the existing frontend plan.

## Shared HTTP rules

- Fastify validates request and response schemas from one shared TypeScript contract. Use opaque IDs in paths, strict query enums, UTC RFC 3339 timestamps, and `null` for a known missing value. Treat URLs as validated external destinations, never as IDs. Resolve the requester from the server session; no route accepts a requester ID.
- Authenticate private reads and writes, check access at the resource or operation, and return `Cache-Control: no-store` even on errors. Static assets and SPA fallback do not handle `/api/*`, `/auth/*`, or `/healthz`. Use structured `application/problem+json` errors: `type: "about:blank"`, `title`, `status`, stable `code`, and non-sensitive `requestId`. Optional field errors contain only field names and safe validation codes. Never reflect raw upstream errors, token material, prompt content, or provider response bodies.
- `400 INVALID_REQUEST` for malformed input; `401 AUTH_REQUIRED` for absent/invalid portal session; `403 ACCESS_DENIED` for known denial on a visible scope; `404 NOT_FOUND` for absent or out-of-scope IDs; `409` for conflicts; `429 RATE_LIMITED` with `Retry-After` when available; `502 PROVIDER_ERROR`/`503 TEMPORARILY_UNAVAILABLE` for upstream failures. `409 CAPABILITY_UNAVAILABLE` is a recoverable contract result, not `501`, a hidden `404`, or a successful mutation.
- Interactive OAuth starts use a same-origin CSRF-protected POST. `GET /api/auth/csrf` returns `{csrfToken}` and establishes an anonymous pre-session when needed. Require `X-CSRF-Token` and the expected `Origin` on unsafe browser requests. OAuth callbacks verify single-use bound state instead of expecting a browser POST header. Rotate the portal session at sign-in; a failed or cancelled callback preserves the prior authorized session.
- The browser receives only an opaque, host-only portal session ID in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie. No GitHub, Copilot, or Entra access or refresh token is serialized into a cookie, frontend storage, or an API response.
- `202` means the work was durably accepted. Supply a `Location` header and a body with the task or operation ID. On acceptance replay the same normalized command, return the same ID and `Location`; never schedule it twice. Uncertain external outcomes are not reported as success. The UI observes progress with ordinary authenticated GETs.

## Route inventory

**Read release** includes sign-in, connections, non-executing account setup, browsing, user-triggered Sync (read-only upstream), and authorized task projections. **Gated** routes have schemas and fixtures from the start, but cannot accept real work until the relevant release gate passes. Where an owned scope can be identified, enforce `CAPABILITY_UNAVAILABLE` before creating an intent. All provider writes and agent commands are gated.

| Method and path | Release | Input and result |
| --- | --- | --- |
| `GET /healthz` | Read | `200 {status:"ok"}` when the app and schema are ready, otherwise `503`; no provider probes or internal paths. |
| `GET /api/build` | Read | `200 {revision:string|null,builtAt:string|null,runUrl:string|null}` from artifact metadata. |
| `GET /api/auth/csrf` | Read | `200 {csrfToken}`; same-origin, pre-session or signed-in. |
| `GET /api/me` | Read | `200 {user,accounts}` for portal and repository identities, with stable IDs, host, display labels, and public avatar URL; `401` otherwise. No Copilot token or entitlement inferred from sign-in. |
| `GET /api/auth/github/hosts` | Read | `200 {items:{id,label,hostname}[]}` for configured portal sign-in hosts, including approved `*.ghe.com`; available before sign-in. No client secrets or arbitrary issuer parameters. |
| `POST /api/auth/{provider}/start` | Read | Provider enum `github` or `azure-devops`; input is `AuthorizationIntent` below. `200 {authorizationUrl}`. GitHub sign-in is supported on configured GitHub hosts; linking/reconnecting always requires an existing portal session. |
| `GET /auth/{provider}/callback` | Read | Redeem the stored host-, purpose-, and session-bound intent and redirect with `303` to an allowlisted portal path. A successful repo flow commits a connection; a successful Copilot flow links only the Copilot grant. Cancellation or failure changes neither. No token or provider error in the redirect. |
| `POST /api/auth/logout` | Read | `204`; end the portal session, not active tasks. |
| `GET /api/copilot/accounts` | Read | `200 {items:CopilotAccount[],defaultAccountId:string\|null}` for linked Copilot accounts only. |
| `PUT /api/copilot/accounts/default` | Read | `{accountId:string\|null}` selects an owned and usable Copilot account for **new** runs, or clears it. `204`; never rebind existing tasks. |
| `GET /api/connections` | Read | `200 {items:Connection[]}` for the current requester only. |
| `GET /api/connections/{id}/issues` | Read | `state=open\|closed`, optional `cursor`, `limit`; return `SnapshotPage<IssueRow>`. |
| `GET /api/connections/{id}/issues/{key}` | Read | Optional `commentCursor`, `limit`; return `IssueDetail`. Live authorized provider read, not a new snapshot or a side effect. |
| `GET /api/connections/{id}/pull-requests` | Read | `state=active\|closed`, optional cursor/limit; return `SnapshotPage<PullRequestRow>`. |
| `GET /api/connections/{id}/pull-requests/{key}/checks` | Read | Required `headRevision`, optional cursor/limit; `200 CheckDetail`, or `409 PR_REVISION_CHANGED`. Reads independently from the PR list. |
| `POST /api/connections/{id}/sync` | Read | Empty body; `202 {operationId}`. Coalesce while one Sync is in flight for this connection generation. |
| `GET /api/operations/{id}` | Read | `200 OperationView`, scoped to the requester and their authorized connection. A completed removal receipt remains readable to its original requester after retirement; return only the safe receipt, not repository data. |
| `GET /api/connections/{id}/tasks` | Read | `state=active`, optional cursor/limit; `200 Page<TaskRow>`. Includes nonterminal tasks without a session ID. |
| `GET /api/active-sessions` | Read | `200 ActiveSessionSummary`; no SDK discovery, provider request, or Sync. Client filters do not alter the all-repo header count. |
| `GET /api/unlinked-sessions` | Read | Optional cursor/limit; `200 {availability,items,nextCursor}` from the requester's scoped discovery projection only. Unavailable inventory is not an empty known inventory. |
| `GET /api/tasks/{id}` | Read | `200 TaskDetail`; return state-appropriate actions and current stored projection, not a provider transcript. |
| `GET /api/tasks/{id}/activity` | Read | Optional cursor/limit; `200 {availability,items,nextCursor}` for recent authorized, normalized activity when the runtime supports it. No raw transcript or prompts. |
| `GET /api/connections/{id}/task-options` | Read | Optional `copilotAccountId`; otherwise resolve the requester’s default. `200 {copilotAccountId,launch,models,featureBranch}`; explicit unavailable capabilities, no shared-account or cross-host fallback. |
| `GET /api/statistics` | Read | `200 StatisticsView`; requester and accessible repositories only. Unknown measurements do not become zero. |
| `POST /api/connections/{id}/tasks` | Gated | `StartTask`; `202 {taskId,state:"queued"}` on first acceptance, `Location: /api/tasks/{id}`. Replay returns the same acceptance receipt. |
| `POST /api/tasks/{id}/inputs` | Gated | `TaskInput`; `202 {operationId}`. A reply must match the stored pending question ID; stale question returns `409 STALE_QUESTION`. |
| `POST /api/tasks/{id}/archive` | Gated | `{confirmed:true}`; `202 {operationId}`. Stop only when needed; do not hide/archive until stop is confirmed. |
| `POST /api/connections/{id}/remove` | Gated | `{confirmed:true}`; `202 {operationId}` for stop and cleanup. Preserve linked records; remove no upstream resources. |
| `POST /api/connections/{id}/issues/{key}/close` | Gated | `{confirmed:true,expectedRevision?:string}`; `200 {issue}` only after provider-confirmed close. `409 ISSUE_CHANGED` for known stale input. |

Portal sign-in, repository authorization, and Copilot authorization are independent. **Connect Copilot** and Copilot default selection change neither the signed-in portal user nor a repo connection. Repo reconnect proves the same provider account and host. Only one active connection per portal user and repo is allowed. To use a different account for that repo, retire the old connection first and create a new ID; until retirement is supported and complete, refuse the switch with `409 CONNECTION_ACCOUNT_CONFLICT`. The retired connection remains linked to its tasks, which the new account cannot inherit or mutate. Returning to an already connected repo is idempotent for the same account. Repo settings expose the provider, host and account; Copilot settings expose linked accounts, entitlement state and the default for new tasks.

## Payload definitions

These are the portable shape decisions, independent of the schema library. `Page<T>` is `{items:T[],nextCursor:string|null}`. Caps are 50 items by default, 100 maximum. Cursors are opaque and bound to requester scope, connection generation, filters, and snapshot revision where applicable; stale cursors return `409 SNAPSHOT_CHANGED`, prompting a restart at page one. No usable snapshot is distinct from a successful empty one.

```ts
type Provider = "github" | "azure_devops";
type AuthorizationIntent =
  | { intent: "sign_in"; hostId: string }
  | { intent: "connect"; repositoryUrl: string }
  | { intent: "reconnect"; connectionId: string }
  | { intent: "link_copilot"; hostId: string }
  | { intent: "reconnect_copilot"; copilotAccountId: string };
type CopilotAccount = {
  id: string; host: string; accountLabel: string;
  state: "connected" | "needs_auth";
  entitlement: "verified" | "unavailable" | "unverified";
};
type Availability = { available: true } | { available: false; reasonCode: string };
type SnapshotPage<T> =
  | { freshness: "not_synced" | "unavailable"; items: null; nextCursor: null; fetchedAt: null }
  | { freshness: "current" | "stale"; items: T[]; nextCursor: string | null; fetchedAt: string };

type SessionState = "queued" | "starting" | "running" | "waiting_input" |
  "publishing" | "stopping" | "needs_auth" | "needs_recovery" | "unverified";
type TaskState = Exclude<SessionState, "unverified"> | "completed" | "stopped" | "failed";
type SessionRow = {
  taskId: string; repoId: string; workItemKey: string;
  title: string | null; issueUrl: string | null; state: SessionState;
  blocker: "repo_auth" | "copilot_auth" | "recovery" | null;
};
type ActiveSessionSummary = {
  repositories: {id: string; name: string; provider: Provider}[];
  sessions: SessionRow[];
};
type StartTask = {
  startRequestId: string; workItemKey: string; copilotAccountId: string;
  overrides?: { model?: string; reasoningEffort?: string; featureBranch?: string; extraInstructions?: string };
};
type TaskInput =
  | { requestId: string; kind: "context"; text: string }
  | { requestId: string; kind: "answer"; questionId: string; text: string };
type OperationView = {
  id: string; kind: "sync_connection" | "remove_connection" | "task_input" | "archive_task";
  state: "queued" | "running" | "completed" | "partial" | "failed" | "needs_recovery";
  problemCode: string | null;
  sources?: {
    name: "work_items" | "pull_requests" | "sessions";
    state: "pending" | "updated" | "unchanged" | "failed" | "unavailable";
  }[];
};
```

| Shape | Required fields and semantics |
| --- | --- |
| `Connection` | `id`, `repoId`, `name`, `provider`, `host`, `repositoryUrl`, `accountLabel`, `state:"connected"\|"needs_auth"\|"removing"`. `id` is the connection handle used in nested routes; `repoId` is the stable, host-scoped factory repo handle used only for matching and filters. |
| `IssueRow` | `key`, `title`, `url`, `state:"open"\|"closed"`, `author`, `createdAt`, `assignees`, `revision:string|null`, `taskId:string|null`, `linkedPr:{key,url}\|null`, `launch:Availability`. `author` and `assignees` use `{id,displayName}` (author nullable). A verified linkage, not a title match, decides eligibility. |
| `IssueDetail` | `{issue:IssueRow, description:{format:"text"\|"markdown"\|"html",content:string}, fields:{label,value}[], related:{label,url}[], comments:Page<{id,author,createdAt,body:{format,content}}>}`. Content is untrusted; preserve text, sanitize before rendering, and do not proxy rendered provider pages. |
| `PullRequestRow` | `key`, `title`, `url`, `sourceBranch`, `targetBranch`, `state:"active"\|"merged"\|"closed"`, `draft`, `author`, `origin:"mine"\|"other"\|"factory"\|"unknown"`, `checks:{headRevision,availability,passed,total}\|null`, `session:{kind:"github_cloud",url}\|{kind:"ado_worktree",id}\|null`. Counts nullable when unavailable. Factory provenance wins over author and uses a verified PR key; session reference requires independent session access. |
| `CheckDetail` | `{headRevision,availability,passed:number\|null,total:number\|null,items:Page<CheckRow>\|null}`. A check row has `{id,name,state:"passed"\|"failed"\|"pending"\|"not_run"\|"unknown",url:string\|null}`. Do not return checks from a different revision. |
| `TaskRow` | `{taskId,repoId,workItemKey,title,issueUrl,state:TaskState}`. Stable IDs and source links, no credentials or raw SDK state. |
| `TaskDetail` | `{task:TaskRow,sessionState:SessionState\|null,observedAt:string\|null,pendingQuestion:{id,text}\|null,actions:{context:Availability,answer:Availability,archive:Availability},draftPrUrl:string\|null}`. Question text is authorized task detail, not in summaries or error bodies. |
| Unlinked sessions / task activity | `items` is null when unavailable, otherwise a paginated array. Unlinked session rows have `{id,runtimeKind,title:string\|null,url:string\|null}`; never infer an issue or make them actionable. Activity rows have `{id,at,kind,summary}` drawn from safe state transitions and runtime status labels, not user or model transcripts. |
| Task options | `copilotAccountId:string\|null`, `launch:Availability`, `models:{availability:Availability,items:{id,name,supportedEfforts:string[]}[]}`, `featureBranch:Availability`. Return the resolved ID even when a capability is unavailable; the client echoes the non-null ID on start so a concurrent default switch cannot change the actor. No fallback if the requested account cannot be used. |
| `StatisticsView` | `{activeTasks,completed,stopped,failed,draftPrs,credits:{measured:number\|null,unmeasuredTasks:number},repositories:[{repoId,activeTasks,completed,stopped,failed,draftPrs,credits}],weekly:[{weekStart,completed:number\|null,credits:number\|null}]}`. Counts cover authorized factory records; unknown history uses null, not zero. Rates derive from finished outcomes only. |

## State, safety, and acceptance

- `GET /api/active-sessions` joins authorized connections to known factory session mappings. Exclude orphan/unlinked sessions, tasks with no SDK ID, terminal tasks, and sessions verified terminal despite a nonterminal task. Uncertain sessions with IDs may remain `unverified`; this is a read-model state, not a persisted task state. Keep actionable local blockers. Sort by creation time descending then task ID. No refresh response promises that a session is live.
- Start requests reuse `(requester, startRequestId)` only with the same normalized input, including the target connection; different inputs return `409 REQUEST_ID_REUSED`. An independent request on the same active repo/work item returns `409 TASK_ALREADY_ACTIVE`. Inputs reuse IDs per task with the same semantics. Archive coalesces by task, removal by connection generation, and Sync only while in flight. The server rechecks applicability, authorization, and capability before any external effect.
- Resolve sign-in and Copilot `hostId` through the configured host registry. Derive new repo host from the validated URL and reconnect host from the authorized record. `sign_in`, `link_copilot`, and `reconnect_copilot` are GitHub-only. Do not accept client-supplied authorization endpoints, issuers, or credential purposes. A non-owned Copilot account ID returns `404`. An owned but incompatible GitHub account pair returns `409 COPILOT_REPO_IDENTITY_MISMATCH`; an expired Copilot grant returns `409 COPILOT_REAUTH_REQUIRED`; an unverified host/runtime capability returns `409 CAPABILITY_UNAVAILABLE`. None reserves work. Start fingerprints include the explicit Copilot account ID. Model lookup, reply, and stop use the correct scoped identity; reply and stop use the task’s original binding, not the current default.
- Snapshot refresh holds last-good pages only under the same authorized identity. Permission-sensitive data uses a 15-minute grant from the last successful provider access check. A live repository read may revalidate before serving; a SQLite-only direct read of an owned scope with an expired grant returns `503 ACCESS_UNVERIFIED`, without rows. Confirmed denial returns `403 ACCESS_DENIED` for the known owned scope and immediately invalidates the grant; a provider outage cannot renew it. Explicitly disconnected and denied connections are outside the cross-repository session projection. If an otherwise eligible connection's access is unverified, return `503 ACCESS_UNVERIFIED` for the whole summary rather than a partial count. Active Sessions remains a database read and never invokes repository Sync. A complete empty snapshot replaces an old nonempty snapshot; partial source pages do not.
- `ACCESS_UNVERIFIED` tells Svelte to hide sensitive rows and counts, not to keep the last-good data as for a generic transport failure. It must prompt for an explicit repository read or Sync that can revalidate authorization. A summary request that merely succeeds does not extend any grant.
- Test the wire contract without network effects: auth/CSRF, cross-user resource IDs, snapshot cursor invalidation, no stale private rows after denial, missing-session and uncertain-session projection, `202`/`Location` replay, capability-denied mutations with no accepted work, and separate request vs task state. Verify the shared Svelte count and list at 1080 × 720 against synthetic fixtures.

References: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700).
