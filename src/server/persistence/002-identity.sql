ALTER TABLE identities ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE identities ADD COLUMN avatar_url TEXT;
ALTER TABLE repositories ADD COLUMN name TEXT NOT NULL DEFAULT '';

CREATE TABLE portal_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  csrf_token TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  identity_id TEXT,
  host_id TEXT,
  registration_binding TEXT,
  expires_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) = (identity_id IS NULL)),
  CHECK ((user_id IS NULL) = (host_id IS NULL)),
  CHECK ((user_id IS NULL) = (registration_binding IS NULL)),
  FOREIGN KEY (identity_id, user_id) REFERENCES identities(id, user_id)
);
CREATE INDEX portal_sessions_expiry ON portal_sessions (expires_at);

CREATE TABLE oauth_intents (
  state_hash TEXT PRIMARY KEY NOT NULL,
  session_hash TEXT NOT NULL REFERENCES portal_sessions(session_hash) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'azure-devops')),
  host_id TEXT NOT NULL,
  registration_binding TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_intents_expiry ON oauth_intents (expires_at);

CREATE TABLE delegated_grants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('portal', 'repository', 'copilot')),
  registration_binding TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (identity_id, user_id) REFERENCES identities(id, user_id),
  UNIQUE (user_id, identity_id, host_id, purpose, registration_binding),
  UNIQUE (id, user_id, purpose),
  UNIQUE (id, user_id, identity_id, purpose)
);

CREATE TABLE connection_access (
  connection_id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'repository' CHECK (purpose = 'repository'),
  generation INTEGER NOT NULL CHECK (generation > 0),
  access_verified_at INTEGER,
  denied_at INTEGER,
  FOREIGN KEY (connection_id, repo_id, user_id, identity_id)
    REFERENCES repo_connections(id, repo_id, user_id, identity_id),
  FOREIGN KEY (grant_id, user_id, identity_id, purpose) REFERENCES delegated_grants(id, user_id, identity_id, purpose)
);

CREATE TABLE copilot_defaults (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'copilot' CHECK (purpose = 'copilot'),
  FOREIGN KEY (account_id, user_id, purpose) REFERENCES delegated_grants(id, user_id, purpose)
);
