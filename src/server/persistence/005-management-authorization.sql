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
