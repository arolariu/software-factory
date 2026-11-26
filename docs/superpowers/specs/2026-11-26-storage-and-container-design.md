# Software Factory: storage and container design

Status: proposed

## Goal

Deploy the Svelte portal and task API as one Linux container image, with one running instance on a host with persistent local storage. An image replacement must not lose connected repo tabs, the mapping from issues to Copilot sessions, or the files needed to recover Azure DevOps runs. The image is replaceable; the installation is not stateless.

GitHub tasks use native GitHub-hosted Copilot sessions. Azure DevOps tasks use the Copilot SDK on the factory host, with a separate worktree per task. Both use the requester's Copilot identity. Repository access and draft PR publication use the requester's repository-provider identity. The factory does not merge PRs.

## Approaches

| Approach | Tradeoff |
| --- | --- |
| **Selected: one container on a host with local disk** | One deployment and origin for the static assets, API, and sign-in callbacks. Needs an available host and persistent disk; no assumption of free compute. |
| Static frontend on Azure Static Web Apps Free plus a separate backend | Hosts the UI for free, but still needs a backend host and disk, and adds a deployment and cross-origin configuration. The Free plan cannot run this image or mount its volumes. |

Defer multiple replicas, managed databases, full provider metadata sync, and support for arbitrary Git hosts.

For repo data, the selected approach is **mappings plus last-known lists per connection**. Keeping only mappings would simplify caching and revocation, but every first load would wait on the provider and an outage would leave the repo tab empty.

For removal, the selected approach is **explicit stop and remove**. Blocking removal until every task is handled separately protects unfinished work, but makes it harder to reclaim disk space. The confirmation makes that tradeoff visible without turning ordinary tab switching into a destructive action.

## Repository portal

**New connection** opens a modal dialog over the current view. It asks for the GitHub or Azure DevOps repository URL and an authentication method. **Interactive sign-in** is the only supported method in v1; the URL identifies the provider. **Continue to sign-in** asks the backend to validate the URL and initiate GitHub or Microsoft Entra sign-in. After the backend confirms repository access, add and select that repository's tab. Cancelling the dialog or cancelling or failing sign-in does not add a tab.

Within each repository, show **Active tasks**, **Open issues**, **Active PRs**, **Closed PRs**, and **Closed issues**, in that order. Open issues remains selected by default when opening a repo; the other views load independently so a slow PR or CI fetch does not block task monitoring or issue triage. Azure DevOps labels issues as work items and makes their project scope clear.

The desktop shell follows the Paint sketch: identity pill at top left, a divider before the connected repo tabs and **New connection**, and two stacked metrics at top right: active Copilot sessions above total AI credits used through the factory. Each connected tab shows its GitHub or Azure DevOps logo beside the repo name and includes the provider in its accessible name. The left rail contains **Repo settings**, **Factory settings**, **Copilot settings**, and **Statistics**, with the deployment's short commit SHA and build timestamp at the bottom. The main area owns the selected repository's work views and **Sync**. Repo settings follow the selected connection; factory settings do not. Copilot settings are distinct from the one-run overrides on an issue.

The identity pill shows the active GitHub account's profile avatar, with a fallback when it is unavailable. Clicking the pill opens a popover with the same factory-only AI credits total as the header and separate options to switch GitHub or Azure DevOps accounts through interactive sign-in. Change the active account only after authorization succeeds. Reload identity-scoped data for the new account and never move existing tasks or their credentials to it.

Each settings entry opens its own navigable view in the main area, not a side pane. Keep the shell visible, indicate the current entry, and let browser Back return to the previous repo view. **Repo settings** are scoped to a connection (authorization, sync, removal). **Factory settings** are scoped to the installation. **Copilot settings** are scoped to the signed-in user's account and task defaults. The mockup fields illustrate those scopes; they do not establish a settings API or permissions model.

**Statistics** is a separate main-area view across the signed-in user's authorized repository connections, independent of the selected tab. The mockup shows active and completed tasks, finished outcomes, published draft PRs, and credits by repository. Use the same task records and measured usage as the header; do not expose other users' activity or present unknown usage as zero.

Clicking the header's **Active sessions** count opens a dedicated main-area view of active Copilot sessions started by Software Factory, across all authorized repository connections, regardless of the selected tab. Each row shows the linked task or issue, session status, and repository name and provider. Read the persisted factory task-to-session mappings and current session state; exclude unlinked sessions, terminal sessions, and queued tasks that do not have a session yet. The header count uses the same scope. Returning to the repository view preserves its selected pane.

Each session row has **View issue**, **View task**, and **Archive task** buttons. View issue opens the linked provider issue or work item in a new tab. View task opens the same inline task accordion used in the repo's Active tasks pane, keyed to the row's task rather than the selected repo. Archive task asks for **Stop and archive** confirmation. Keep the row visible until the runtime confirms the stop and the factory archives the task. Then remove it from both active lists and refresh the header count. Archiving does not delete the upstream issue, PR, or GitHub-hosted session.

In the cross-repository session view, put **Needs your answer** before the other running work and show the count for each group. Only sessions with a pending human question belong in the first group. Keep per-row repo context and controls available in both groups.

```text
[ Signed in as Sam ]  [ owner/repo ] [ org/project/ado-repo ] [+ New connection]   [ Usage ]
Repo settings       | Active tasks | Open issues | Active PRs | Closed PRs | Closed issues   [Sync]
Factory settings    | v #42  Fix pagination on large imports                    [Start task] [Gear]
Copilot settings    |        Large imports repeat records across page boundaries.
Build SHA / UTC     | > #43  Retry stalled imports
                    |        [Author: Sam] [Created: Nov 23, 2026] [Assigned to: Sam]
```

In Svelte, keep the application shell mounted across repo navigation. Put the selected connection and work view in the URL so reload and browser history work; keep fetched data and loading state keyed by connection and view to avoid showing one repo's data under another tab. Keep the header summary separate from the repo snapshots. Proposed scope: active sessions and AI credits for the signed-in user's factory tasks across repos, not an account-wide GitHub billing total. Use backend-confirmed session state and measured SDK usage when available; distinguish unavailable or partial usage from zero. Read build info from deployment metadata rather than the selected repository.

The **Open issues** toolbar combines title or issue-number search with **Anyone**, **Assigned to me**, or **Unassigned** filters. Keep filters scoped to the repo, show visible versus total counts, and offer **Clear filters** when nothing matches. Use stable provider assignee IDs for **Assigned to me** in the live portal. Filtering must not change launch eligibility or add status badges to the collapsed rows.

In **Statistics**, show completed tasks and measured AI credits by week, with labeled values as well as a visual comparison. State the date range separately from all-time totals and explain missing usage rather than plotting it as zero.

The build footer links the short SHA to the full commit in the public `arolariu/software-factory` GitHub repository. The UTC build timestamp links to the exact GitHub Actions run that produced the deployed artifact, including the run attempt when applicable. Bake the actual checked-out revision, build timestamp, and producer run URL into the artifact at build time; use the producing workflow's `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, not the most recent run or the deployment job. If a local preview has no published commit or producer run, show the available provenance as plain text without inventing a destination.

Use compact rows rather than cards. In **Open issues**, the title is followed by badges for the issue author, creation date, and assignment, with **Unassigned** when there is no assignee. Do not repeat the Open status in the collapsed row. Clicking or keyboard-activating the issue row itself expands its details inline: description, provider link, and any related PR or task status. Only eligible rows show launch controls: **Start task**, then the settings cog immediately to its right. The row's Start task uses defaults. These two controls are separate from the accordion trigger and do not toggle it. If there is already an active task or linked PR, show the reason in the expanded details instead of offering a duplicate launch. Closed issues never offer launch. The backend rechecks eligibility rather than relying on the cached list. On narrow screens, let fields wrap without reversing the order of the controls.

When a row opens, fetch that exact GitHub issue or Azure DevOps work item from its provider using the active connection's identity. Preserve the provider's title, description as authored, labels or work-item fields, assignees, comments, and related links as exposed by its API; do not substitute a summary or a cached list excerpt. Render provider Markdown or HTML safely in the portal rather than embedding the provider page. Load the detail and discussion on demand, with pagination when needed. Keep the **Navigate to Issue** button visible in the accordion even if details fail to load. It opens the verified provider URL in a new tab. This is a faithful view of the accessible issue data, not a replica of provider UI or controls.

The open issue accordion also has a red **Close issue** button. It opens a confirmation dialog that identifies the issue and focuses **Cancel** by default. Only confirming submits a provider write under the requester's repository identity. Recheck authorization and current state; for Azure DevOps use a terminal state allowed by the work item's process, not a hard-coded state name. Move the row to the closed list only after the provider confirms the change, and leave it in place with an error if the write fails. Closing the issue does not stop a task or change its PR.

The cog opens a **Configure task** modal, not a side panel. Show the selected issue and optional overrides for model, reasoning effort, feature branch name, and extra instructions. Fetch model capabilities through the Copilot SDK using the same signed-in Copilot identity and runtime as the task. Offer only selectable models and the selected model's supported effort levels. Reset an effort choice if it becomes incompatible; if capability discovery is unavailable, explain that overrides cannot be selected instead of showing a hard-coded catalog. Revalidate requested choices at start.

The feature branch override names the task's output branch, not its base branch or a filesystem path. For Azure DevOps, the factory creates the branch inside the private task worktree; validate the name and reject conflicts without reusing or overwriting an existing branch. For GitHub-hosted sessions, enable this override only if the runtime or the supported publication path can honor the output branch name. The SDK's documented cloud repository `branch` option selects starting context, not an output branch. The worktree directory is always factory-assigned. **Start task** submits overrides for this run only; it does not change Copilot defaults. **Close dialog** or Escape discards unsubmitted changes and returns focus to the cog without starting anything.

In **Active tasks**, **View task** opens the inline task accordion, not a side panel or a separate page. Keep one row expanded at a time in each pane. The expanded task shows status, recent activity, a pending question when present, and a form for replying or adding context. Keep the actions keyboard-accessible and announce whether the API accepted a reply. Toggle or navigate away without affecting the running task. A Svelte row owns its presentation, while the backend owns execution and the task stream is keyed by the stable task ID. Begin loading task detail only when a row opens, release that view's subscription when it closes, and keep the collapsed row's summary independently current.

**Active tasks** is a per-repo view of existing, nonterminal factory tasks. The API reads the authorized requester's SQLite task rows for the selected connection, then resolves the issue or work item by its stored key and the Copilot session by its recorded SDK identity. Render one row per task, not one row per discovery result. Show the work-item key even when the title or link is unavailable; closing the issue does not hide an ongoing task. Distinguish queued, running, waiting for input, and work that needs attention; an uncertain session state must not be presented as running. Completed, stopped, and failed tasks leave this view. Display **No active tasks** only after a successful empty query.

The API serves the stored list without waiting for an SDK inventory call. Runtime updates and **Sync** refresh verified mappings and session state; missing discovery results do not remove the task. External sessions without a verified mapping remain in **Unlinked**, not in Active tasks.

Active PR rows show the PR key and title, `source -> target` branch names, the CI count, and **Open PR**, which opens the provider URL in a new browser tab. Include draft PRs in Active PRs and label them **Draft**. Closed PR rows keep the same base layout and distinguish **Merged** from **Closed without merge** (including abandoned Azure DevOps PRs). If check data is available for a closed PR, show it for the final observed revision; do not imply the checks have run again.

In **Active PRs** and **Closed PRs**, label provenance as **Mine**, **Others**, or **Factory**. **All** is the default filter in each pane and shows every PR it contains that the active connection can read; **My PRs** and **Factory PRs** show their respective categories. The filters are independent of whether a PR was merged or who closed it. Factory provenance wins even when the provider lists the requester as author. Match factory PRs using the verified repo-scoped PR keys recorded at publication or reconciliation, not by author, branch name, or PR text. For non-factory PRs, compare the provider's stable author ID with the active connection's identity; don't guess when author data is missing. Show the actual author separately, and don't expose task details from another user's connection.

On factory PRs in either pane, use that same PR-to-task mapping to show the authorized session reference. For GitHub-hosted sessions, **Open Copilot session** opens the verified URL recorded from the SDK in a new tab; do not construct the URL from the session ID. For Azure DevOps worktree sessions, show the SDK **Session ID** as text, not a GitHub link. Omit the reference when the mapping or session access cannot be verified; the PR itself remains visible to authorized repo readers.

**CI count** is passed checks out of all reported, applicable CI checks for the displayed PR revision, not just required checks. GitHub adapters read check runs and CI status contexts; Azure DevOps adapters read CI PR statuses and build validation results. Use the latest result per check for that revision, not prior commits or retry attempts. Do not count the same build twice if it is confirmed to appear in both Azure DevOps feeds. Exclude approvals and non-CI merge policies. For example, **1/3 passed** can mean one passed, one failed, and one pending; show the breakdown in text on demand. Skipped or neutral results are not passes. A successful lookup with zero reported checks displays **No checks**; missing or inaccessible data displays **Checks unavailable**. If a previously loaded count is shown during a refresh failure, label it stale, and never reuse a count from an earlier revision.

The repository snapshot may include check totals, breakdown, PR revision, and freshness; load CI independently of PR rows. The same per-repo Sync behavior applies: keep known rows visible while refreshing, show a skeleton on first load only, and distinguish an empty list from a load error.

## Container layout

```text
Browser ── HTTPS ──> one Linux container
                     ├─ static Svelte assets and same-origin task API
                     ├─ Copilot SDK adapter ──> GitHub-hosted sessions
                     ├─ repository adapters ──> GitHub and Azure DevOps
                     └─ isolated ADO execution ──> task worktree

Host-local mounts:   /data                   SQLite index and private app state
                     /workspaces             Azure DevOps Git data and worktrees
                     /run/secrets            read-only keys and OAuth app secrets
```

Build the Svelte assets in a build stage; the runtime image serves those assets and contains the API, Git, and the pinned Copilot SDK runtime. Expose one HTTP listener behind HTTPS. Run the API as non-root and use a read-only image filesystem where practical. Mount the whole `/data` directory, not just the database file: SQLite can create `-wal` and `-shm` files beside the database. Use a host-local filesystem, not a mounted network share, and use SQLite's online backup mechanism rather than copying just the live database file.

Keep encrypted user credentials separate from the task index, in private application storage protected by a separately mounted key. Neither those credentials nor the SQLite directory are accessible to commands the agent runs. SQLite stores account IDs, not access or refresh tokens. The repository adapter performs authorized reads and publication; no repository write credentials enter an agent worktree.

The initial deployment is for a trusted installation, not a public multi-tenant runner. Worktrees separate edits; they do **not** isolate code execution. The Azure DevOps path requires sandboxing that prevents task commands from reading application data, secrets, other tasks' workspaces, or host files. Do not use privileged mode or mount the Docker socket. If the host cannot provide verified isolation within this package, disable Azure DevOps execution on that host rather than running commands in the API's security context. GitHub-hosted runs do not depend on the factory's worktree storage.

For Azure DevOps, the repository adapter clones on first use and fetches on later starts, using the requester's current read authorization. The clone is a backend-owned seed, not a workspace exposed to the agent. Prepare a private Git copy from the selected base commit and create the task's worktree from that copy inside the sandbox. A linked worktree shares Git refs and configuration with its parent; do not attach an agent worktree directly to a seed clone shared by other tasks. Store the task's base commit and workspace reference in private runtime state for resume. Sync refreshes portal data; it does not alter a running task's checkout.

## SQLite schema

`users` is the portal principal. `identities` stores the provider accounts linked to it, keyed by verified issuer and subject. `repositories` identifies a repo using its provider's stable ID in a stable scope, not the pasted URL or repo name. `repo_connections` is the per-user authorization link and tab. `tasks` owns the issue-to-session mapping. One task gets at most one Copilot session; a new attempt after a terminal result gets a new task.

Upstream providers remain authoritative for issues and PRs. SQLite keeps a last-known snapshot of the issue and PR lists for each authorized repo connection, not a full mirror. Store only the fields needed to render the lists and verified links; keep issue bodies, comments, diffs, and transcripts out of snapshots. `work_item_key` is the issue number in a GitHub repo or the Azure DevOps work-item ID in the repo's organization. Azure Boards work items are not intrinsically repo-scoped; a repo tab can show project work items, labeled as such, while a task explicitly pairs one with the selected repo. For v1, that pair defines the one-active-task constraint.

Enable foreign keys for every connection and WAL on the local database. Example initial schema (`*_at` are UTC Unix milliseconds):

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE identities (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'azure_devops')),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  UNIQUE (provider, issuer, subject),
  UNIQUE (id, user_id)
);

CREATE TABLE repositories (
  id TEXT NOT NULL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'azure_devops')),
  provider_scope TEXT NOT NULL,
  provider_repo_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  UNIQUE (provider, provider_scope, provider_repo_id)
);

CREATE TABLE repo_connections (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  identity_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  removal_requested_at INTEGER,
  disconnected_at INTEGER CHECK (
    disconnected_at IS NULL OR removal_requested_at IS NULL
  ),
  PRIMARY KEY (repo_id, user_id),
  FOREIGN KEY (identity_id, user_id) REFERENCES identities(id, user_id)
);

CREATE TABLE repo_snapshots (
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work_items', 'pull_requests')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id, kind),
  FOREIGN KEY (repo_id, user_id) REFERENCES repo_connections(repo_id, user_id),
  FOREIGN KEY (identity_id, user_id) REFERENCES identities(id, user_id)
);

CREATE TABLE tasks (
  id TEXT NOT NULL PRIMARY KEY,
  repo_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  repo_identity_id TEXT NOT NULL,
  copilot_identity_id TEXT NOT NULL,
  work_item_key TEXT NOT NULL,
  start_request_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('github_cloud', 'ado_worktree')),
  runtime_scope TEXT NOT NULL,
  requested_session_id TEXT,
  sdk_session_id TEXT,
  session_url TEXT,
  draft_pr_key TEXT,
  draft_pr_url TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'starting', 'running', 'waiting_input', 'publishing',
    'stopping', 'needs_auth', 'needs_recovery',
    'completed', 'stopped', 'failed'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER CHECK (
    archived_at IS NULL OR state IN ('completed', 'stopped', 'failed')
  ),
  FOREIGN KEY (repo_id, requester_id) REFERENCES repo_connections(repo_id, user_id),
  FOREIGN KEY (repo_identity_id, requester_id) REFERENCES identities(id, user_id),
  FOREIGN KEY (copilot_identity_id, requester_id) REFERENCES identities(id, user_id),
  UNIQUE (requester_id, start_request_id),
  UNIQUE (runtime_kind, runtime_scope, requested_session_id),
  UNIQUE (runtime_kind, runtime_scope, sdk_session_id)
);

CREATE UNIQUE INDEX one_active_task_per_repo_item
  ON tasks (repo_id, work_item_key)
  WHERE state NOT IN ('completed', 'stopped', 'failed');

CREATE INDEX tasks_by_tab
  ON tasks (requester_id, repo_id, created_at DESC);
```

`runtime_scope` names the stable session namespace used to resume or reconcile that SDK session, not a transient process ID. It is set at task creation and the actual SDK ID is recorded as soon as the runtime returns it. `draft_pr_key` stores the provider's repo-scoped PR identifier. Session and draft PR URLs are for navigation, not matching.

The API validates the provider for each identity and execution path, checks live repository authorization, canonicalizes work-item keys, and rechecks that the issue is open and has no linked PR before launch. Foreign keys prevent attaching another user's provider identity; they do not substitute for those checks. A reconnect may restore access but must not silently change the identities captured on an existing task. Read-only **Unlinked** sessions are discovered under the current user's identity when the SDK exposes them; do not create rows for them or infer issue links.

## Per-repository sync

**Sync** is read-only upstream. It does not start or stop a session, push code, create a PR, or change an issue. At most one sync runs per repo connection. Fetch the authorized work-item list, PR list, and discoverable Copilot sessions as separate sources. Replace a source's snapshot only after all pages for that refresh were retrieved; a successful empty list replaces old rows, whereas a failed or incomplete fetch does not. Merge verified task changes without allowing an older sync to overwrite newer state from the active runtime. A missing session in discovery is not proof that it stopped or was deleted.

For launch and reconciliation:

1. Reserve a factory task ID and its repo/work-item mapping before calling Copilot. Request an opaque session ID derived from the task ID where supported, and record the returned SDK ID regardless. Use documented repo association and integration attribution as context, not as per-task keys. If the pinned runtime supports discoverable per-session metadata, add a versioned opaque factory task reference; do not put issue text, credentials, or user identifiers in it. Verify create/list round-tripping on each runtime before relying on it. Give the agent the issue and any known PR URL as prompt context, but never read prompt text back as an authoritative mapping or authorization signal.
2. Look up owned tasks by the exact returned SDK ID in the correct runtime namespace. Recover a missing ID only when the runtime confirms a pre-reserved ID in that namespace, or the backend can verify a factory-issued correlation reference against its existing task. A session title, prompt, timestamp, or repo match alone is not evidence. Leave unresolved sessions in **Unlinked**; do not silently import them as tasks.
3. Retain the exact PR reference returned by publication and refresh its state from the provider. Use provider-confirmed issue/work-item links to show related PRs, but do not infer that a session authored a PR merely because both point to the same issue. If publication may have succeeded but the response was lost, reconcile the exact publication reference before trying again.

In the portal, show a skeleton only when there is no snapshot. Keep last-known rows visible while Sync runs, mark each source's freshness, and show a partial success when a source fails. Persist the per-source freshness with the snapshot. A cache read must use the current portal user and the repo connection's active identity. Evict or hide snapshots on disconnect, identity change, or confirmed authorization failure; only serve stale data for a transient failure under the same valid connection. Discard late refresh results from a superseded or revoked connection.

Sync can repair missing fields on existing mappings; it cannot promise reconstruction after losing SQLite, since session discovery and metadata round-tripping vary by runtime. SQLite backup and restore preserve the authoritative mapping.

## Remove a repository tab

**Remove repo** applies to the signed-in user's connection, not the upstream repository. If that connection has unfinished tasks or unpublished changes, show an explicit **Stop and remove** confirmation that says unpublished changes may be discarded. The confirmed action does not affect other users' connections or tasks.

1. Persist the pending removal and advance `generation` before starting cleanup. Reject new task starts, Sync, and publication for the removing connection. Discard late Sync writes from the prior generation. Reconcile any launch or publication already in flight; do not claim that a draft PR already published was undone.
2. Cancel queued tasks and request that active tasks stop. Confirm the hosted session or local process is no longer running before completing removal. If confirmation is unavailable, keep the operation pending and show the blocker; for GitHub, link to the session so the requester can stop it there. Do not archive or delete a hosted session as a side effect of removing its tab.
3. For Azure DevOps, reclaim only the connection's stopped task worktrees, their private Git copies, and associated local resume files. Reclaim the backend-owned seed clone only when no other live connection or task uses it; coordinate the check with new workspace allocation. GitHub needs no local checkout cleanup. Cleanup must be safe to retry after a restart.
4. Evict the connection's snapshots and set `disconnected_at` while clearing `removal_requested_at`. Hide the tab but retain stable task/session/issue/PR identifiers. Reconnecting starts a new generation and requires fresh authorization. The same provider identity can see its retained links again, but cannot restore deleted workspace files. Exclude previously tracked sessions from **Unlinked** while their tab is disconnected. Never delete upstream branches, PRs, issues, or repositories.

## Restart and removal behavior

- **Start:** reserve the task and its request ID before calling the SDK. Repeating the same request returns the same task; a different request for an already active repo/item is rejected. Store the session ID when allocated and wait for the cloud session's readiness signal before sending the first prompt. Keep pending start inputs in protected application state until delivered; do not put transcripts, prompts, or tokens in the task index.
- **Restart:** reconnect known GitHub sessions by ID; the hosted execution can outlive the container. Keep Azure DevOps worktrees on `/workspaces` and SDK resume metadata in private durable storage. Local processes do not survive container replacement. Attempt to resume only when the workspace and SDK state are consistent; otherwise show `needs_recovery`. If startup or publication failed after a provider may have accepted the request, reconcile before retrying; never create a duplicate session or draft PR blindly.
- **Authorization failure:** keep the result and move to `needs_auth` if publication is blocked. Resume after the original requester reconnects; never switch to a bot or another user's credentials. Revalidate before publishing. Verify that native GitHub sessions expose a supported change handoff before enabling automatic requester-authored PRs on that path.
- **Remove a task:** stop active work and confirm it has stopped before retiring the task or cleaning up its local worktree. Archive a GitHub cloud session only if the supported integration permits it; otherwise hide the task locally. Do not claim that a GitHub-hosted session was deleted. Retain the mapping so previously tracked sessions are not rediscovered as external. Never delete issues, remote branches, or PRs as a side effect.

## What the build must prove

1. Replacing the container on the same host preserves repo tabs and mappings; a known cloud session reconnects, and an interrupted Azure DevOps task is recoverable or clearly marked as not running.
2. Concurrent launches on the same repo/item create at most one active task. Retries do not duplicate a Copilot session or a draft PR. Switching repo tabs or accounts cannot expose another user's connections, tasks, or credentials.
3. The Azure DevOps process can modify its own worktree but cannot access `/data`, `/run/secrets`, or a sibling worktree. Publication uses the requester's provider identity and leaves review and merge to the team.
4. Sync is safe to repeat. A partial failure preserves only the affected source's prior snapshot, an authoritative empty result clears it, and revocation hides it. Missing or ambiguous Copilot discovery never creates a false task-to-issue or task-to-PR link.
5. Stop and remove survives a restart, prevents stale Sync from restoring cached rows, and leaves another user's connection and in-use Azure DevOps clone intact. An uncertain stop stays pending rather than deleting a workspace still in use.
6. Connecting a repository opens its issue list without waiting on CI. New PR revisions never inherit old check totals, and closed issues cannot start tasks.
7. Activating an issue row expands its details, while Start task and the cog on its right do not expand or collapse it. View task in Active tasks expands that task without changing the route or interrupting the session. Switching repositories clears the old accordion and never displays details from the previous connection.
8. Active tasks shows only the selected connection's nonterminal tasks. A closed or temporarily unavailable issue does not hide its active task; a terminal task leaves the pane, and an unlinked session never appears there.
9. Issue details match the authorized provider data and open its exact URL in a new tab. Task override options follow the signed-in Copilot account and runtime; unsupported reasoning and output branch choices cannot be submitted.
10. In both PR panes, a requester-authored factory PR appears under Factory PRs, not My PRs. All includes PRs from other authors, and the filters don't change PR visibility or authorization.

The builder can choose the API framework, SQLite driver, image base, sandbox mechanism, and event transport. Do not scaffold or deploy anything from this design until it is approved.

References: [Azure Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans), [SQLite WAL](https://sqlite.org/wal.html), [Copilot SDK cloud sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/cloud-sessions), [Azure DevOps Copilot app support](https://docs.github.com/en/copilot/how-tos/github-copilot-app/manage-azure-devops-work), [Git worktrees](https://git-scm.com/docs/git-worktree), [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks), [Azure DevOps PR statuses](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/list?view=azure-devops-rest-7.1), [Azure DevOps policy evaluations](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1).
