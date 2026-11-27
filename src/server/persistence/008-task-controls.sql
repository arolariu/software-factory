CREATE TABLE task_controls (
  id TEXT NOT NULL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('answer', 'stop')),
  question_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'confirmed', 'failed', 'needs_recovery')),
  CHECK ((kind = 'answer') = (question_id IS NOT NULL)),
  UNIQUE (task_id, request_id)
) STRICT;

CREATE UNIQUE INDEX one_pending_control_per_task ON task_controls(task_id)
  WHERE state IN ('queued', 'claimed', 'needs_recovery');
