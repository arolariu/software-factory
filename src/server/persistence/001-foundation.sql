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
  canonical_host TEXT NOT NULL,
  provider_scope TEXT NOT NULL,
  provider_repo_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  UNIQUE (provider, canonical_host, provider_scope, provider_repo_id)
);

CREATE TABLE repo_connections (
  id TEXT NOT NULL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  identity_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  removal_requested_at INTEGER,
  retired_at INTEGER CHECK (retired_at IS NULL OR removal_requested_at IS NULL),
  FOREIGN KEY (identity_id, user_id) REFERENCES identities(id, user_id),
  UNIQUE (id, repo_id, user_id, identity_id)
);

CREATE UNIQUE INDEX one_current_connection_per_user_repo
  ON repo_connections (user_id, repo_id) WHERE retired_at IS NULL;

CREATE TABLE repo_snapshots (
  connection_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work_items', 'pull_requests')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, kind),
  FOREIGN KEY (connection_id, repo_id, user_id, identity_id)
    REFERENCES repo_connections(id, repo_id, user_id, identity_id)
);

CREATE TABLE tasks (
  id TEXT NOT NULL PRIMARY KEY,
  connection_id TEXT NOT NULL,
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
    'stopping', 'needs_auth', 'needs_recovery', 'completed', 'stopped', 'failed'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER CHECK (archived_at IS NULL OR state IN ('completed', 'stopped', 'failed')),
  FOREIGN KEY (connection_id, repo_id, requester_id, repo_identity_id)
    REFERENCES repo_connections(id, repo_id, user_id, identity_id),
  FOREIGN KEY (copilot_identity_id, requester_id) REFERENCES identities(id, user_id),
  UNIQUE (requester_id, start_request_id),
  UNIQUE (runtime_kind, runtime_scope, requested_session_id),
  UNIQUE (runtime_kind, runtime_scope, sdk_session_id)
);

CREATE UNIQUE INDEX one_active_task_per_repo_item
  ON tasks (repo_id, work_item_key) WHERE state NOT IN ('completed', 'stopped', 'failed');

CREATE INDEX tasks_by_connection ON tasks (connection_id, created_at DESC);
