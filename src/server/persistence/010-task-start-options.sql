CREATE TABLE task_start_options (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES task_starts(task_id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR length(reasoning_effort) BETWEEN 1 AND 128)
) STRICT;
