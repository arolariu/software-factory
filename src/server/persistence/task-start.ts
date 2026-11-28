import { randomUUID } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import type { StartTask } from '../../shared/api/schemas.js';
import { sha256Hex } from '../digest.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { verifiedCloudSessionUrl } from '../tasks/cloud-session-link.js';
import { launchPreferences, type LaunchPreferences } from '../tasks/launch-preferences.js';

export type StartBinding = { connectionId: string; repoId: string; identityId: string; generation: number; scope: string };
type Gate = (requester: Requester, connectionId: string, input: StartTask) => StartBinding | undefined;
export type StartClaim = StartBinding & {
  taskId: string; requesterId: string; requestedSessionId: string; copilotAccountId: string; workItemKey: string; startRequestId: string;
  overrides?: LaunchPreferences;
};

// This store does not authorize or perform effects. Its caller must prove live
// capability and identity before reservation, and verify exact runtime receipts.
export function createTaskStarts(db: SQLite.Database, authorize: Gate = () => undefined, now = Date.now) {
  const connection = db.prepare(`
    SELECT 1 FROM repo_connections c JOIN repositories r ON r.id=c.repo_id
    WHERE c.id=? AND c.user_id=? AND c.repo_id=? AND c.identity_id=? AND c.generation=?
      AND c.retired_at IS NULL AND c.removal_requested_at IS NULL
      AND r.provider='github' AND r.canonical_host='github.com'
  `);
  const eligible = (binding: StartBinding, requesterId: string) =>
    connection.get(binding.connectionId, requesterId, binding.repoId, binding.identityId, binding.generation) !== undefined;
  const load = db.prepare<[string], StartClaim & {
    state: string; observedState: string | null; model: string | null; reasoningEffort: string | null;
  }>(`
    SELECT t.id AS taskId, t.connection_id AS connectionId, t.requester_id AS requesterId, t.repo_id AS repoId,
      t.repo_identity_id AS identityId, t.work_item_key AS workItemKey, t.runtime_scope AS scope,
      t.requested_session_id AS requestedSessionId, s.copilot_account_id AS copilotAccountId, t.start_request_id AS startRequestId,
      s.connection_generation AS generation, t.state, o.session_state AS observedState, p.model, p.reasoning_effort AS reasoningEffort
    FROM tasks t JOIN task_starts s ON s.task_id=t.id LEFT JOIN task_observations o ON o.task_id=t.id
    LEFT JOIN task_start_options p ON p.task_id=t.id WHERE t.id=?
  `);
  const bindingFields = (claim: StartClaim) => [
    claim.taskId, claim.requesterId, claim.connectionId, claim.repoId, claim.identityId, claim.generation,
    claim.scope, claim.workItemKey, claim.requestedSessionId, claim.copilotAccountId, claim.startRequestId,
    claim.overrides?.model, claim.overrides?.reasoningEffort,
  ];
  function toClaim(row: NonNullable<ReturnType<typeof load.get>>): StartClaim {
    const { state: _state, observedState: _observedState, model, reasoningEffort, ...claim } = row;
    return model === null ? claim : { ...claim, overrides: reasoningEffort === null ? { model } : { model, reasoningEffort } };
  }
  function matching(verified: StartClaim) {
    const stored = load.get(verified.taskId);
    const expected = bindingFields(verified);
    return stored && ['starting', 'needs_recovery'].includes(stored.state) &&
      bindingFields(toClaim(stored)).every((part, index) => part === expected[index]) ? stored : undefined;
  }

  const commandChoices = (overrides: ReturnType<typeof launchPreferences>) => overrides ? [overrides.model, overrides.reasoningEffort ?? null] : [];
  const previousStart = db.prepare<[string, string], {
    id: string; connection_id: string; request_hash: string | null; generation: number; scope: string;
  }>(`SELECT t.id, t.connection_id, s.request_hash, s.connection_generation AS generation, t.runtime_scope AS scope
      FROM tasks t LEFT JOIN task_starts s ON s.task_id=t.id
      WHERE t.requester_id=? AND t.start_request_id=?`);
  const currentBinding = db.prepare<[string, string, string, string], { generation: number }>(`
    SELECT generation FROM repo_connections WHERE id=? AND user_id=? AND repo_id=? AND identity_id=?
      AND retired_at IS NULL AND removal_requested_at IS NULL`);
  function replay(requester: Requester, id: string, input: StartTask) {
    const previous = previousStart.get(requester.id, input.startRequestId);
    if (!previous) return undefined;
    const choices = commandChoices(launchPreferences(input.overrides));
    const digest = sha256Hex(JSON.stringify([id, input.workItemKey, input.copilotAccountId, ...choices]));
    const legacy = sha256Hex(JSON.stringify([id, previous.generation, previous.scope, input.workItemKey, input.copilotAccountId, ...choices]));
    if (previous.connection_id !== id || (previous.request_hash !== digest && previous.request_hash !== legacy)) throw new ApiFailure('REQUEST_ID_REUSED');
    const claimed = load.get(previous.id);
    if (!claimed) throw new ApiFailure('ACCESS_UNVERIFIED');
    const current = currentBinding.get(id, requester.id, claimed.repoId, claimed.identityId);
    if (!current || !eligible({ ...claimed, generation: current.generation }, requester.id)) throw new ApiFailure('ACCESS_UNVERIFIED');
    return { taskId: previous.id, state: 'queued' } as const;
  }
  const reserve = db.transaction((requester: Requester, id: string, input: StartTask, proof?: StartBinding) => {
    const binding = proof ?? authorize(requester, id, input);
    if (!binding) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
    if (binding.connectionId !== id || !eligible(binding, requester.id)) throw new ApiFailure('ACCESS_UNVERIFIED');
    if (!/^[1-9][0-9]*$/.test(input.workItemKey)) throw new ApiFailure('INVALID_REQUEST');
    const previous = replay(requester, id, input);
    if (previous) return previous;
    const overrides = launchPreferences(input.overrides);
    const digest = sha256Hex(JSON.stringify([id, input.workItemKey, input.copilotAccountId, ...commandChoices(overrides)]));
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
    if (overrides) {
      db.prepare('INSERT INTO task_start_options(task_id,model,reasoning_effort) VALUES (?,?,?)')
        .run(taskId, overrides.model, overrides.reasoningEffort ?? null);
    }
    return { taskId, state: 'queued' } as const;
  });

  const claim = db.transaction((id: string, proof?: StartBinding) => {
    const stored = load.get(id);
    if (stored?.state !== 'queued') return undefined;
    const current = toClaim(stored);
    if (!eligible(current, current.requesterId)) {
      db.prepare("UPDATE tasks SET state='failed',updated_at=? WHERE id=?").run(now(), id);
      return undefined;
    }
    const binding = proof ?? authorize({ id: current.requesterId }, current.connectionId, {
      workItemKey: current.workItemKey, copilotAccountId: current.copilotAccountId, startRequestId: current.startRequestId,
      ...(current.overrides && { overrides: current.overrides }),
    });
    if (binding?.connectionId !== current.connectionId || binding.repoId !== current.repoId ||
      binding.identityId !== current.identityId || binding.generation !== current.generation || binding.scope !== current.scope) return undefined;
    db.prepare("UPDATE tasks SET state='starting',updated_at=? WHERE id=?").run(now(), id);
    return current;
  });

  const confirm = db.transaction((verified: StartClaim, sessionId: string, sessionUrl?: string) => {
    const stored = matching(verified);
    if (!stored || !eligible(verified, verified.requesterId)) return false;
    const observed = stored.observedState;
    const terminal = observed === 'completed' || observed === 'stopped' || observed === 'failed';
    const at = now();
    const applied = db.prepare(`UPDATE tasks SET sdk_session_id=?,session_url=?,state=?,updated_at=?
        WHERE id=? AND runtime_kind='github_cloud' AND sdk_session_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM tasks other WHERE other.runtime_kind=tasks.runtime_kind
            AND other.runtime_scope=tasks.runtime_scope AND other.sdk_session_id=?)
      `).run(sessionId, verifiedCloudSessionUrl(sessionId, sessionUrl) ?? null,
      terminal ? observed : 'running', at, verified.taskId, sessionId).changes === 1;
    if (applied && !terminal) {
      db.prepare(`INSERT INTO task_observations(task_id,session_state,observed_at) VALUES (?,'running',?)
        ON CONFLICT(task_id) DO UPDATE SET session_state=excluded.session_state, observed_at=excluded.observed_at`).run(verified.taskId, at);
    }
    return applied;
  });
  const fail = db.transaction((verified: StartClaim) => {
    const stored = matching(verified);
    if (!stored) return false;
    const observed = stored.observedState;
    const state = observed === 'completed' || observed === 'stopped' ? observed : 'failed';
    return db.prepare("UPDATE tasks SET state=?,updated_at=? WHERE id=? AND sdk_session_id IS NULL AND runtime_kind='github_cloud'")
      .run(state, now(), verified.taskId).changes === 1;
  });

  return {
    reserve: reserve.immediate,
    replay: db.transaction(replay),
    claim: claim.immediate,
    confirm: confirm.immediate,
    fail: fail.immediate,
    recovery(requester: Requester, taskId: string): StartClaim | undefined {
      const current = load.get(taskId);
      if (current?.state !== 'needs_recovery' || current.requesterId !== requester.id) return undefined;
      return toClaim(current);
    },
    next(excluded: string[] = []) {
      const row = db.prepare<[string], { id: string }>(`
        SELECT t.id FROM tasks t JOIN task_starts s ON s.task_id=t.id WHERE t.state='queued'
          AND t.id NOT IN (SELECT value FROM json_each(?)) ORDER BY t.created_at,t.id LIMIT 1
      `).get(JSON.stringify(excluded));
      const current = row && load.get(row.id);
      return current && toClaim(current);
    },
    failUnclaimed(candidate: StartClaim) {
      return db.prepare(`UPDATE tasks SET state='failed',updated_at=?
        WHERE id=? AND state='queued' AND requested_session_id=?`).run(now(), candidate.taskId, candidate.requestedSessionId).changes === 1;
    },
    requireRecovery(claimed: StartClaim) {
      return db.prepare(`UPDATE tasks SET state='needs_recovery',updated_at=?
        WHERE id=? AND state='starting' AND requested_session_id=?`).run(now(), claimed.taskId, claimed.requestedSessionId).changes === 1;
    },
    recoverInterrupted: db.transaction(() => {
      db.prepare(`UPDATE tasks SET state='failed',updated_at=?
        WHERE state='needs_auth' AND sdk_session_id IS NULL
          AND EXISTS (SELECT 1 FROM task_starts WHERE task_id=tasks.id)
          AND NOT EXISTS (SELECT 1 FROM task_observations WHERE task_id=tasks.id)`).run(now());
      return db.prepare(`UPDATE tasks SET state='needs_recovery',updated_at=?
        WHERE state='starting' AND EXISTS (SELECT 1 FROM task_starts WHERE task_id=tasks.id)`).run(now()).changes;
    }).immediate,
  };
}
