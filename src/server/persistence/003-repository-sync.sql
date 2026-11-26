CREATE TABLE repository_sources (
  connection_id TEXT NOT NULL REFERENCES repo_connections(id),
  source TEXT NOT NULL CHECK (source IN ('work_items','pull_requests')),
  generation INTEGER NOT NULL,
  revision TEXT,
  fetched_at INTEGER,
  failed INTEGER NOT NULL CHECK (failed IN (0,1)),
  CHECK ((revision IS NULL) = (fetched_at IS NULL)),
  PRIMARY KEY (connection_id, source)
);

CREATE TABLE repository_rows (
  connection_id TEXT NOT NULL,
  source TEXT NOT NULL,
  view_state TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (connection_id, source, view_state, ordinal),
  FOREIGN KEY (connection_id,source) REFERENCES repository_sources(connection_id,source) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE repository_sync (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES repo_connections(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','completed','partial','failed')),
  problem_code TEXT,
  sources TEXT CHECK (sources IS NULL OR json_valid(sources)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX repository_sync_in_flight
  ON repository_sync(connection_id,generation) WHERE state IN ('queued','running');
CREATE INDEX repository_sync_queue ON repository_sync(state,created_at,id);
