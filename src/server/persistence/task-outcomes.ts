import type SQLite from 'better-sqlite3';
import { ApiFailure } from '../http/problems.js';
import type { CloudOutcome } from '../tasks/cloud-task-status.js';

export function createTaskOutcomes(db: SQLite.Database) {
  const read = db.prepare<[string], { state: string; created_at: number; terminal_at: number | null }>(`
    SELECT t.state,t.created_at,o.terminal_at FROM tasks t LEFT JOIN task_observations o ON o.task_id=t.id WHERE t.id=?
  `);
  const write = db.prepare(`
    UPDATE tasks SET state=?,updated_at=? WHERE id=? AND state IN ('running','waiting_input','publishing','stopping')
      AND NOT EXISTS (SELECT 1 FROM task_controls WHERE task_id=tasks.id AND state IN ('queued','claimed','needs_recovery'))
      AND NOT EXISTS (SELECT 1 FROM task_observations WHERE task_id=tasks.id
        AND (terminal_at IS NOT NULL OR session_state IN ('completed','stopped','failed')))
  `);
  const observe = db.prepare(`
    INSERT INTO task_observations(task_id,session_state,observed_at,terminal_at) VALUES (?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET session_state=excluded.session_state,
      observed_at=excluded.observed_at,terminal_at=excluded.terminal_at,question_id=NULL,question_text=NULL,blocker=NULL
  `);
  // The caller must revalidate the session and grants inside its write transaction.
  return (taskId: string, outcome: CloudOutcome, now: number) => {
    const task = read.get(taskId);
    if (task?.state === outcome.state && task.terminal_at === outcome.terminalAt) return { state: outcome.state };
    if (!task || outcome.terminalAt < task.created_at || outcome.terminalAt > now ||
        write.run(outcome.state, now, taskId).changes !== 1) throw new ApiFailure('TASK_OUTCOME_UNVERIFIED');
    observe.run(taskId, outcome.state, now, outcome.terminalAt);
    return { state: outcome.state };
  };
}
