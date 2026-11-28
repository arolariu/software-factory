import { createHmac, randomUUID } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import type { TaskInput } from '../../shared/api/schemas.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';

type Command = Extract<TaskInput, { kind: 'answer' }> | { kind: 'stop'; requestId: string };
type Binding = {
  taskId: string; requesterId: string; connectionId: string; identityId: string; generation: number;
  scope: string; sessionId: string; copilotAccountId: string;
};
type Current = Binding & { eligible: 0 | 1; state: string; observedState: string | null; pendingQuestionId: string | null };
type Claim = Binding & {
  operationId: string; requestId: string; requestHash: string; kind: Command['kind']; questionId: string | null;
};
type Gate = (binding: Readonly<Binding>, kind: Command['kind']) => boolean;

const active = ['running', 'waiting_input', 'publishing', 'stopping'];
const terminal = ['completed', 'stopped', 'failed'];

// The caller must authorize and verify provider effects. No reply content or
// provider credentials are persisted, and an ambiguous effect is never retried.
export function createTaskControls(db: SQLite.Database, digestKey: Uint8Array, authorize: Gate = () => false, now = Date.now) {
  const task = db.prepare<[string], Current>(`
    SELECT t.id AS taskId, t.requester_id AS requesterId, t.connection_id AS connectionId, t.repo_identity_id AS identityId,
      c.generation AS generation, t.runtime_scope AS scope, t.sdk_session_id AS sessionId,
      s.copilot_account_id AS copilotAccountId, t.state, o.session_state AS observedState, o.question_id AS pendingQuestionId,
      (c.user_id=t.requester_id AND c.repo_id=t.repo_id AND c.identity_id=t.repo_identity_id
        AND c.retired_at IS NULL AND c.removal_requested_at IS NULL) AS eligible
    FROM tasks t JOIN task_starts s ON s.task_id=t.id JOIN repo_connections c ON c.id=t.connection_id
    JOIN repositories r ON r.id=t.repo_id LEFT JOIN task_observations o ON o.task_id=t.id
    WHERE t.id=? AND t.runtime_kind='github_cloud' AND r.provider='github' AND r.canonical_host='github.com'
      AND t.sdk_session_id IS NOT NULL AND t.repo_identity_id=t.copilot_identity_id
  `);
  const operation = db.prepare<[string], {
    taskId: string; requestId: string; requestHash: string; bindingHash: string;
    kind: Command['kind']; questionId: string | null; state: string;
  }>(`SELECT task_id AS taskId, request_id AS requestId, request_hash AS requestHash, binding_hash AS bindingHash,
    kind, question_id AS questionId, state
    FROM task_controls WHERE id=?`);
  const digest = (value: readonly unknown[]) => createHmac('sha256', digestKey).update(JSON.stringify(value)).digest('hex');
  const bindingDigest = (t: Binding) => digest([
    'binding', t.taskId, t.requesterId, t.connectionId, t.identityId, t.generation, t.scope, t.sessionId, t.copilotAccountId,
  ]);
  const savedDigest = (value: string) => value.slice(0, 64);
  function bindingFrom(value: string, fallback: Current | undefined): Binding | undefined {
    if (value.length === 64) return fallback && bindingDigest(fallback) === value ? fallback : undefined;
    const binding = JSON.parse(value.slice(65)) as Binding;
    return bindingDigest(binding) === savedDigest(value) ? binding : undefined;
  }
  const bindingFields = ({ taskId, requesterId, connectionId, identityId, generation, scope, sessionId, copilotAccountId }: Binding) =>
    ({ taskId, requesterId, connectionId, identityId, generation, scope, sessionId, copilotAccountId });
  const requestDigest = (bindingHash: string, input: Command) => digest([
    'request', bindingHash, input.kind, input.requestId, input.kind === 'answer' ? [input.questionId, input.text] : null,
  ]);
  const pending = (t: Current, kind: Command['kind'], question: string | null) => kind === 'answer'
    ? t.state === 'waiting_input' && t.observedState === 'waiting_input' && t.pendingQuestionId === question
    : active.includes(t.state) && !terminal.includes(t.observedState ?? '');

  const reserve = db.transaction((requester: Requester, taskId: string, input: Command) => {
    const current = task.get(taskId);
    if (!current || current.requesterId !== requester.id) throw new ApiFailure('NOT_FOUND');
    if (!current.eligible) throw new ApiFailure('ACCESS_UNVERIFIED');
    if (!authorize(current, input.kind)) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
    const bindingHash = bindingDigest(current);
    const requestHash = requestDigest(bindingHash, input);
    const previous = db.prepare<[string, string], { id: string; request_hash: string; binding_hash: string }>(
      'SELECT id, request_hash, binding_hash FROM task_controls WHERE task_id=? AND request_id=?',
    ).get(taskId, input.requestId);
    if (previous) {
      if (previous.request_hash !== requestDigest(savedDigest(previous.binding_hash), input)) throw new ApiFailure('REQUEST_ID_REUSED');
      return { operationId: previous.id };
    }
    const questionId = input.kind === 'answer' ? input.questionId : null;
    if (!pending(current, input.kind, questionId)) {
      throw new ApiFailure(input.kind === 'answer' ? 'STALE_QUESTION' : 'CAPABILITY_UNAVAILABLE');
    }
    if (db.prepare(`SELECT 1 FROM task_controls WHERE task_id=?
      AND state IN ('queued','claimed','needs_recovery')`).get(taskId)) throw new ApiFailure('TASK_OPERATION_PENDING');
    const operationId = randomUUID();
    db.prepare(`INSERT INTO task_controls(id,task_id,request_id,request_hash,binding_hash,kind,question_id,state)
      VALUES (?,?,?,?,?,?,?,'queued')`).run(operationId, taskId, input.requestId, requestHash,
      `${bindingHash}:${JSON.stringify(bindingFields(current))}`, input.kind, questionId);
    return { operationId };
  });

  const claim = db.transaction((operationId: string, input: Command): Claim | undefined => {
    const row = operation.get(operationId);
    if (row?.state !== 'queued') return undefined;
    const current = task.get(row.taskId);
    if (!current?.eligible || bindingDigest(current) !== savedDigest(row.bindingHash) || !pending(current, row.kind, row.questionId)) {
      db.prepare("UPDATE task_controls SET state='failed' WHERE id=?").run(operationId);
      return undefined;
    }
    if (requestDigest(savedDigest(row.bindingHash), input) !== row.requestHash) return undefined;
    if (!authorize(current, row.kind)) {
      db.prepare("UPDATE task_controls SET state='failed' WHERE id=?").run(operationId);
      return undefined;
    }
    db.prepare("UPDATE task_controls SET state='claimed' WHERE id=?").run(operationId);
    return { ...bindingFields(current), operationId,
      requestId: row.requestId, requestHash: row.requestHash, kind: row.kind, questionId: row.questionId };
  });

  function matches(verified: Claim) {
    const row = operation.get(verified.operationId);
    if (!row || (row.state !== 'claimed' && row.state !== 'needs_recovery') ||
      row.taskId !== verified.taskId || row.requestId !== verified.requestId || row.requestHash !== verified.requestHash ||
      row.kind !== verified.kind || row.questionId !== verified.questionId ||
      bindingDigest(verified) !== savedDigest(row.bindingHash)) return undefined;
    return row;
  }

  const confirm = db.transaction((verified: Claim) => {
    const row = matches(verified);
    if (!row) return false;
    const current = task.get(row.taskId);
    if (!current?.eligible || bindingDigest(current) !== savedDigest(row.bindingHash)) return false;

    if (row.kind === 'stop') {
      if (current.state === 'completed' || current.state === 'failed' ||
        (!pending(current, row.kind, null) && current.observedState !== 'stopped')) return false;
      const at = now();
      db.prepare("UPDATE tasks SET state='stopped',updated_at=? WHERE id=?").run(at, row.taskId);
      db.prepare(`INSERT INTO task_observations(task_id,session_state,observed_at,terminal_at) VALUES (?,'stopped',?,?)
        ON CONFLICT(task_id) DO UPDATE SET session_state='stopped',
          observed_at=CASE WHEN session_state='stopped' THEN coalesce(observed_at,excluded.observed_at) ELSE excluded.observed_at END,
          terminal_at=CASE WHEN session_state='stopped' THEN coalesce(terminal_at,excluded.terminal_at) ELSE excluded.terminal_at END,
          question_id=NULL,question_text=NULL,blocker=NULL`).run(row.taskId, at, at);
    } else {
      db.prepare(`UPDATE task_observations SET session_state='unverified',question_id=NULL,question_text=NULL
        WHERE task_id=? AND session_state='waiting_input' AND question_id=?`).run(row.taskId, row.questionId);
    }
    db.prepare("UPDATE task_controls SET state='confirmed' WHERE id=?").run(verified.operationId);
    return true;
  });

  const fail = db.transaction((verified: Claim) =>
    !!matches(verified) && db.prepare("UPDATE task_controls SET state='failed' WHERE id=?").run(verified.operationId).changes === 1);
  const cancel = db.prepare(`UPDATE task_controls SET state='failed' WHERE id=? AND state='queued'
    AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id=task_controls.task_id AND requester_id=?)`);
  return {
    reserve: reserve.immediate,
    claim: claim.immediate,
    confirm: confirm.immediate,
    fail: fail.immediate,
    cancel(requester: Requester, operationId: string) { return cancel.run(operationId, requester.id).changes === 1; },
    recovery(requester: Requester, operationId: string): Claim | undefined {
      const row = operation.get(operationId);
      if (row?.state !== 'needs_recovery') return undefined;
      const binding = bindingFrom(row.bindingHash, task.get(row.taskId));
      if (binding?.requesterId !== requester.id) return undefined;
      return { ...bindingFields(binding), operationId, requestId: row.requestId, requestHash: row.requestHash,
        kind: row.kind, questionId: row.questionId };
    },
    recoverInterrupted() {
      return db.prepare(`UPDATE task_controls SET state=CASE state WHEN 'claimed' THEN 'needs_recovery' ELSE 'failed' END
        WHERE state IN ('queued','claimed')`).run().changes;
    },
  };
}
