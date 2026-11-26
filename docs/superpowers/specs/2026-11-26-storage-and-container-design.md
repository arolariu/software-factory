# Software Factory: storage and container design

Status: proposed

## Goal

Deploy the Svelte portal and task API as one Docker image, with one running instance on a host with persistent local storage. An image replacement must not lose connected repo tabs, the mapping from issues to Copilot sessions, or the files needed to recover Azure DevOps runs. The image is replaceable; the installation is not stateless.

GitHub tasks use native GitHub-hosted Copilot sessions. Azure DevOps tasks use the Copilot SDK on the factory host, with a separate worktree per task. Both use the requester's Copilot identity. Repository access and draft PR publication use the requester's repository-provider identity. The factory does not merge PRs.

## Approaches

| Approach | Tradeoff |
| --- | --- |
| **Selected: one Docker container on a host with local disk** | One deployment and origin for the static assets, API, and sign-in callbacks. Needs an available host and persistent disk; no assumption of free compute. |
| Static frontend on Azure Static Web Apps Free plus a separate backend | Hosts the UI for free, but still needs a backend host and disk, and adds a deployment and cross-origin configuration. The Free plan cannot run this image or mount its volumes. |

Defer multiple replicas, managed databases, full provider metadata sync, and support for arbitrary Git hosts.

## Container layout

```text
Browser ── HTTPS ──> one Docker container
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

## SQLite schema

`users` is the portal principal. `identities` stores the provider accounts linked to it, keyed by verified issuer and subject. `repositories` identifies a repo using its provider's stable ID in a stable scope, not the pasted URL or repo name. `repo_connections` is the per-user authorization link and tab. `tasks` owns the issue-to-session mapping. One task gets at most one Copilot session; a new attempt after a terminal result gets a new task.

Keep issues, PR statuses, and transcripts in their upstream systems. `work_item_key` is the issue number in a GitHub repo or the Azure DevOps work-item ID in the repo's organization. Azure Boards work items are not intrinsically repo-scoped; a repo tab can show project work items, labeled as such, while a task explicitly pairs one with the selected repo. For v1, that pair defines the one-active-task constraint.

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
  disconnected_at INTEGER,
  PRIMARY KEY (repo_id, user_id),
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
  sdk_session_id TEXT,
  session_url TEXT,
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
  UNIQUE (runtime_kind, runtime_scope, sdk_session_id)
);

CREATE UNIQUE INDEX one_active_task_per_repo_item
  ON tasks (repo_id, work_item_key)
  WHERE state NOT IN ('completed', 'stopped', 'failed');

CREATE INDEX tasks_by_tab
  ON tasks (requester_id, repo_id, created_at DESC);
```

`runtime_scope` names the stable session namespace used to resume or reconcile that SDK session, not a transient process ID. It is set at task creation and the actual SDK ID is recorded as soon as the runtime returns it. Cloud session URLs and draft PR URLs are added when known, not used as keys.

The API validates the provider for each identity and execution path, checks live repository authorization, canonicalizes work-item keys, and rechecks that the issue is open and has no linked PR before launch. Foreign keys prevent attaching another user's provider identity; they do not substitute for those checks. A reconnect may restore access but must not silently change the identities captured on an existing task. Read-only **Unlinked** sessions are discovered under the current user's identity when the SDK exposes them; do not create rows for them or infer issue links.

## Restart and removal behavior

- **Start:** reserve the task and its request ID before calling the SDK. Repeating the same request returns the same task; a different request for an already active repo/item is rejected. Store the session ID when allocated and wait for the cloud session's readiness signal before sending the first prompt. Keep pending start inputs in protected application state until delivered; do not put transcripts, prompts, or tokens in the task index.
- **Restart:** reconnect known GitHub sessions by ID; the hosted execution can outlive the container. Keep Azure DevOps worktrees on `/workspaces` and SDK resume metadata in private durable storage. Local processes do not survive container replacement. Attempt to resume only when the workspace and SDK state are consistent; otherwise show `needs_recovery`. If startup or publication failed after a provider may have accepted the request, reconcile before retrying; never create a duplicate session or draft PR blindly.
- **Authorization failure:** keep the result and move to `needs_auth` if publication is blocked. Resume after the original requester reconnects; never switch to a bot or another user's credentials. Revalidate before publishing. Verify that native GitHub sessions expose a supported change handoff before enabling automatic requester-authored PRs on that path.
- **Remove:** stop active work and confirm it has stopped before retiring the task or cleaning up its local worktree. Archive a GitHub cloud session only if the supported integration permits it; otherwise hide the task locally. Do not claim that a GitHub-hosted session was deleted. Retain the mapping so previously tracked sessions are not rediscovered as external. Never delete issues, remote branches, or PRs as a side effect.

## What the build must prove

1. Replacing the container on the same host preserves repo tabs and mappings; a known cloud session reconnects, and an interrupted Azure DevOps task is recoverable or clearly marked as not running.
2. Concurrent launches on the same repo/item create at most one active task. Retries do not duplicate a Copilot session or a draft PR. Switching repo tabs or accounts cannot expose another user's connections, tasks, or credentials.
3. The Azure DevOps process can modify its own worktree but cannot access `/data`, `/run/secrets`, or a sibling worktree. Publication uses the requester's provider identity and leaves review and merge to the team.

The builder can choose the API framework, SQLite driver, image base, sandbox mechanism, and event transport. Do not scaffold or deploy anything from this design until it is approved.

References: [Azure Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans), [SQLite WAL](https://sqlite.org/wal.html), [Copilot SDK cloud sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/cloud-sessions), [Azure DevOps Copilot app support](https://docs.github.com/en/copilot/how-tos/github-copilot-app/manage-azure-devops-work).
