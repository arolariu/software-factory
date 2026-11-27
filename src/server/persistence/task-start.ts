import { randomUUID } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import type { StartTask } from '../../shared/api/schemas.js';
import { sha256Hex } from '../digest.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';

type Binding = { connectionId: string; repoId: string; identityId: string; generation: number; scope: string };
type Gate = (requester: Requester, connectionId: string, input: StartTask) => Binding | undefined;
type Claim = Binding & { taskId: string; requesterId: string; requestedSessionId: string; copilotAccountId: string; workItemKey: string; startRequestId: string };

// This store does not authorize or perform effects. Its caller must prove live
// capability and identity before reservation, and verify exact runtime receipts.
export function createTaskStarts(db: SQLite.Database, authorize: Gate = () => undefined, now = Date.now) {
  const connection = db.prepare(`
    SELECT 1 FROM repo_connections c JOIN repositories r ON r.id=c.repo_id
    WHERE c.id=? AND c.user_id=? AND c.repo_id=? AND c.identity_id=? AND c.generation=?
      AND c.retired_at IS NULL AND c.removal_requested_at IS NULL
      AND r.provider='github' AND r.canonical_host='github.com'
  `);
  const eligible = (binding: Binding, requesterId: string) =>
    connection.get(binding.connectionId, requesterId, binding.repoId, binding.identityId, binding.generation) !== undefined;
  const queued = db.prepare<[string], Claim>(`
    SELECT t.id AS taskId, t.connection_id AS connectionId, t.requester_id AS requesterId, t.repo_id AS repoId,
      t.repo_identity_id AS identityId, t.work_item_key AS workItemKey, t.runtime_scope AS scope,
      t.requested_session_id AS requestedSessionId, s.copilot_account_id AS copilotAccountId, t.start_request_id AS startRequestId,
      s.connection_generation AS generation
    FROM tasks t JOIN task_starts s ON s.task_id=t.id WHERE t.id=? AND t.state='queued'
  `);

  const reserve = db.transaction((requester: Requester, id: string, input: StartTask) => {
    const binding = authorize(requester, id, input);
    if (!binding) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
    if (binding.connectionId !== id || !eligible(binding, requester.id)) throw new ApiFailure('ACCESS_UNVERIFIED');
    if (!/^[1-9][0-9]*$/.test(input.workItemKey)) throw new ApiFailure('INVALID_REQUEST');
    if (input.overrides && Object.keys(input.overrides).length) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
    const digest = sha256Hex(JSON.stringify([id, binding.generation, binding.scope, input.workItemKey, input.copilotAccountId]));
    const previous = db.prepare<[string, string], { id: string; request_hash: string }>(`
      SELECT t.id, s.request_hash FROM tasks t LEFT JOIN task_starts s ON s.task_id=t.id
      WHERE t.requester_id=? AND t.start_request_id=?
    `).get(requester.id, input.startRequestId);
    if (previous) {
      if (previous.request_hash !== digest) throw new ApiFailure('REQUEST_ID_REUSED');
      return { taskId: previous.id, state: 'queued' } as const;
    }
    if (db.prepare(`SELECT 1 FROM tasks WHERE repo_id=? AND work_item_key=?
      AND state NOT IN ('completed','stopped','failed')`).get(binding.repoId, input.workItemKey)) {
      throw new ApiFailure('TASK_ALREADY_ACTIVE');
    }
    const taskId = randomUUID();
    const at = now();
    db.prepare(`INSERT INTO tasks (
      id,connection_id,repo_id,requester_id,repo_identity_id,copilot_identity_id,work_item_key,start_request_id,
      runtime_kind,runtime_scope,requested_session_id,state,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,'github_cloud',?,?,'queued',?,?)`).run(
      taskId, id, binding.repoId, requester.id, binding.identityId, binding.identityId, input.workItemKey,
      input.startRequestId, binding.scope, randomUUID(), at, at,
    );
    db.prepare('INSERT INTO task_starts VALUES (?,?,?,?)').run(taskId, digest, binding.generation, input.copilotAccountId);
    return { taskId, state: 'queued' } as const;
  });

  const claim = db.transaction((id: string) => {
    const current = queued.get(id);
    if (!current) return undefined;
    if (!eligible(current, current.requesterId)) {
      db.prepare("UPDATE tasks SET state='needs_auth',updated_at=? WHERE id=?").run(now(), id);
      return undefined;
    }
    const binding = authorize({ id: current.requesterId }, current.connectionId, {
      workItemKey: current.workItemKey, copilotAccountId: current.copilotAccountId, startRequestId: current.startRequestId,
    });
    if (binding?.connectionId !== current.connectionId || binding.repoId !== current.repoId ||
      binding.identityId !== current.identityId || binding.generation !== current.generation || binding.scope !== current.scope) return undefined;
    db.prepare("UPDATE tasks SET state='starting',updated_at=? WHERE id=?").run(now(), id);
    return current;
  });

  const confirm = db.transaction((verified: Claim, sessionId: string) => {
    const at = now();
    const applied = db.prepare(`
        UPDATE tasks SET sdk_session_id=?,state='running',updated_at=?
        WHERE id=? AND requester_id=? AND connection_id=? AND repo_id=? AND work_item_key=?
          AND repo_identity_id=? AND runtime_kind='github_cloud' AND runtime_scope=? AND requested_session_id=? AND start_request_id=?
          AND state IN ('starting','needs_recovery') AND sdk_session_id IS NULL
          AND EXISTS (SELECT 1 FROM task_starts s WHERE s.task_id=tasks.id AND s.copilot_account_id=? AND s.connection_generation=?)
          AND NOT EXISTS (SELECT 1 FROM tasks other WHERE other.runtime_kind=tasks.runtime_kind
            AND other.runtime_scope=tasks.runtime_scope AND other.sdk_session_id=?)
      `).run(sessionId, at, verified.taskId, verified.requesterId, verified.connectionId, verified.repoId, verified.workItemKey,
      verified.identityId, verified.scope, verified.requestedSessionId, verified.startRequestId,
      verified.copilotAccountId, verified.generation, sessionId).changes === 1;
    if (applied) {
      db.prepare(`INSERT INTO task_observations(task_id,session_state,observed_at) VALUES (?,'running',?)
        ON CONFLICT(task_id) DO UPDATE SET session_state=excluded.session_state, observed_at=excluded.observed_at`).run(verified.taskId, at);
    }
    return applied;
  });

  return {
    reserve: reserve.immediate,
    claim: claim.immediate,
    confirm: confirm.immediate,
    recoverInterrupted() {
      return db.prepare(`UPDATE tasks SET state='needs_recovery',updated_at=?
        WHERE state='starting' AND EXISTS (SELECT 1 FROM task_starts WHERE task_id=tasks.id)`).run(now()).changes;
    },
  };
}
