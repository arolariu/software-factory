import type SQLite from 'better-sqlite3';
import Type from 'typebox';
import Value from 'typebox/value';
import type { Requester } from '../http/portal-modules.js';

type UsageTarget = {
  taskId: string; requesterId: string; connectionId: string; sessionId: string;
  scope: string; copilotAccountId: string; generation: number;
};
type Access = (connectionId: string, requester: Requester) => 'valid' | 'denied' | 'unverified';

const measures = Type.Object({
  aiCreditsStatus: Type.Optional(Type.Unknown()),
  totalNanoAiu: Type.Optional(Type.Unknown()),
  totalPremiumRequestCost: Type.Optional(Type.Unknown()),
});
const amount = { minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const whole = Type.Integer(amount);
const fractional = Type.Number(amount);
const observedAt = Type.Integer({ minimum: 0, maximum: 253402300799999 });

export function createTaskUsage(db: SQLite.Database, readAccess: Access) {
  const mapping = db.prepare<[string, string], UsageTarget>(`
    SELECT t.id AS taskId, t.requester_id AS requesterId, t.connection_id AS connectionId, t.sdk_session_id AS sessionId,
      t.runtime_scope AS scope, s.copilot_account_id AS copilotAccountId, s.connection_generation AS generation
    FROM tasks t JOIN task_starts s ON s.task_id=t.id JOIN repo_connections c ON c.id=t.connection_id
    JOIN repositories r ON r.id=t.repo_id
    WHERE t.id=? AND t.requester_id=? AND t.runtime_kind='github_cloud' AND t.sdk_session_id IS NOT NULL
      AND t.repo_identity_id=t.copilot_identity_id AND c.generation=s.connection_generation
      AND c.retired_at IS NULL AND c.removal_requested_at IS NULL
      AND r.provider='github' AND r.canonical_host='github.com'
  `);
  const upsert = db.prepare(`
    INSERT INTO task_sdk_usage (
      task_id,session_id,runtime_scope,copilot_account_id,connection_generation,observed_at,nano_aiu,premium_requests
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET
      session_id=excluded.session_id,runtime_scope=excluded.runtime_scope,copilot_account_id=excluded.copilot_account_id,
      connection_generation=excluded.connection_generation,observed_at=excluded.observed_at,
      nano_aiu=excluded.nano_aiu,premium_requests=excluded.premium_requests
    WHERE excluded.observed_at>task_sdk_usage.observed_at
  `);
  const target = (requester: Requester, taskId: string) => {
    const current = mapping.get(taskId, requester.id);
    return current && readAccess(current.connectionId, requester) === 'valid' ? current : undefined;
  };
  const record = db.transaction((evidence: UsageTarget, raw: unknown, at: number) => {
    if (!Value.Check(measures, raw) || !Value.Check(observedAt, at)) return false;
    const nanoAiu = raw.aiCreditsStatus === 'complete' && Value.Check(whole, raw.totalNanoAiu) ? raw.totalNanoAiu : null;
    const premiumRequests = Value.Check(fractional, raw.totalPremiumRequestCost) ? raw.totalPremiumRequestCost : null;
    if (nanoAiu === null && premiumRequests === null) return false;
    const current = target({ id: evidence.requesterId }, evidence.taskId);
    if (!current || current.connectionId !== evidence.connectionId || current.sessionId !== evidence.sessionId ||
      current.scope !== evidence.scope || current.copilotAccountId !== evidence.copilotAccountId ||
      current.generation !== evidence.generation) return false;
    return upsert.run(current.taskId, current.sessionId, current.scope, current.copilotAccountId, current.generation,
      at, nanoAiu, premiumRequests).changes === 1;
  });
  return { target, record: record.immediate };
}
