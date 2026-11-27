CREATE TABLE management_flows (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','ready','complete','cancelled','expired','failed')),
  context TEXT NOT NULL CHECK (json_valid(context)),
  credential_ref TEXT,
  expires_at INTEGER NOT NULL,
  next_poll INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX management_one_active_flow
  ON management_flows (session_hash) WHERE state IN ('pending','ready');
CREATE INDEX management_poll_queue ON management_flows (state,next_poll);

CREATE TABLE management_flow_admission (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE TABLE management_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL,
  repository_enabled INTEGER NOT NULL CHECK (repository_enabled IN (0,1))
);

CREATE TABLE management_audit (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
