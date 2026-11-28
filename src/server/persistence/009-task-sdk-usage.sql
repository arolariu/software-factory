CREATE TABLE task_sdk_usage (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  runtime_scope TEXT NOT NULL,
  copilot_account_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  observed_at INTEGER NOT NULL CHECK (observed_at BETWEEN 0 AND 253402300799999),
  nano_aiu INTEGER CHECK (nano_aiu IS NULL OR nano_aiu BETWEEN 0 AND 9007199254740991),
  premium_requests REAL CHECK (premium_requests IS NULL OR premium_requests BETWEEN 0 AND 9007199254740991),
  CHECK (nano_aiu IS NOT NULL OR premium_requests IS NOT NULL)
) STRICT;
