CREATE TABLE task_observations (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT,
  issue_url TEXT,
  session_state TEXT CHECK (session_state IS NULL OR session_state IN (
    'queued', 'starting', 'running', 'waiting_input', 'publishing', 'stopping',
    'needs_auth', 'needs_recovery', 'unverified', 'completed', 'stopped', 'failed'
  )),
  observed_at INTEGER CHECK (observed_at IS NULL OR observed_at >= 0),
  blocker TEXT CHECK (blocker IS NULL OR blocker IN ('repo_auth', 'copilot_auth', 'recovery')),
  question_id TEXT,
  question_text TEXT,
  terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0),
  credits REAL CHECK (credits IS NULL OR (credits >= 0 AND credits <= 9007199254740991)),
  CHECK ((question_id IS NULL) = (question_text IS NULL))
) STRICT;
