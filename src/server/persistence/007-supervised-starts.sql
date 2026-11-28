CREATE TABLE task_starts (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  copilot_account_id TEXT NOT NULL
) STRICT;
