import type SQLite from 'better-sqlite3';
import type { ApiDto } from '../../shared/api/schemas.js';
import { sha256Hex } from '../digest.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { createCursorCodec } from '../repositories/cursors.js';
import { verifiedCloudSessionUrl } from '../tasks/cloud-session-link.js';

type Summary = ApiDto<'activeSessions'>;
type Task = ApiDto<'task'>;
type Statistics = ApiDto<'statistics'>;
type Outcomes = Omit<Statistics, 'repositories' | 'weekly'>;
type State = Task['task']['state'];
type Connection = Summary['repositories'][number] & { connection_id: string; generation: number };
type Row = {
  id: string; repo_id: string; connection_id: string; work_item_key: string; state: State;
  sdk_session_id: string | null; draft_pr_key: string | null; draft_pr_url: string | null;
  title: string | null; issue_url: string | null; session_state: Summary['sessions'][number]['state'] | 'completed' | 'stopped' | 'failed' | null;
  blocker: Summary['sessions'][number]['blocker']; observed_at: number | null;
  question_id: string | null; question_text: string | null; terminal_at: number | null; credits: number | null;
};
type Access = (connectionId: string, requester: Requester) => 'valid' | 'denied' | 'unverified';

const active = (state: Row['session_state']): state is Summary['sessions'][number]['state'] =>
  state !== null && state !== 'completed' && state !== 'stopped' && state !== 'failed';
const observationLifetime = 15 * 60_000;
function currentObservation(row: Row, at: number) {
  return active(row.session_state) && row.observed_at !== null && row.observed_at <= at &&
    at - row.observed_at < observationLifetime ? row.session_state : null;
}
const disabled = { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' } as const;
const fields = (row: Row) => ({
  taskId: row.id, repoId: row.repo_id, workItemKey: row.work_item_key, title: row.title, issueUrl: row.issue_url,
});
const taskView = (row: Row) => ({ ...fields(row), state: row.state });

function outcomes(rows: Row[]): Outcomes {
  const result: Outcomes = { activeTasks: 0, completed: 0, stopped: 0, failed: 0, draftPrs: 0, credits: { measured: null, unmeasuredTasks: 0 } };
  for (const row of rows) {
    if (active(row.state)) result.activeTasks++;
    else result[row.state === 'completed' ? 'completed' : row.state === 'stopped' ? 'stopped' : 'failed']++;
    if (row.draft_pr_key !== null) result.draftPrs++;
    if (row.credits === null) result.credits.unmeasuredTasks++;
    else result.credits.measured = (result.credits.measured ?? 0) + row.credits;
  }
  return result;
}

function weeklyOutcomes(rows: Row[]): Statistics['weekly'] {
  const result = new Map<string, Statistics['weekly'][number]>();
  const incomplete = new Set<string>();
  for (const row of rows) {
    if (row.terminal_at === null || active(row.state)) continue;
    const date = new Date(row.terminal_at);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const weekStart = date.toISOString().slice(0, 10);
    const week = result.get(weekStart) ?? { weekStart, completed: 0, credits: null };
    if (row.state === 'completed') week.completed = (week.completed ?? 0) + 1;
    if (row.credits === null) {
      incomplete.add(weekStart);
      week.credits = null;
    } else if (!incomplete.has(weekStart)) week.credits = (week.credits ?? 0) + row.credits;
    result.set(weekStart, week);
  }
  return [...result.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function createTaskReads(db: SQLite.Database, cursorKey: Uint8Array, readAccess: Access, now = Date.now) {
  const cursor = createCursorCodec(cursorKey);
  const connections = db.prepare<[string], Connection>(`
    SELECT c.id AS connection_id, c.generation, r.id, r.provider, coalesce(nullif(r.name,''),r.canonical_url) AS name
    FROM repo_connections c JOIN repositories r ON r.id=c.repo_id
    WHERE c.user_id=? AND c.retired_at IS NULL AND c.removal_requested_at IS NULL
    ORDER BY r.name, r.id
  `);
  const projection = `
    SELECT t.*, o.title, o.issue_url, o.session_state, o.observed_at, o.blocker,
      o.question_id, o.question_text, o.terminal_at, o.credits
    FROM tasks t LEFT JOIN task_observations o ON o.task_id=t.id
  `;
  const byRequester = db.prepare<[string], Row>(`${projection} WHERE t.requester_id=?`);
  const mappedActive = db.prepare<[string, string], Row>(`${projection}
    WHERE t.requester_id=? AND t.connection_id IN (SELECT value FROM json_each(?))
      AND t.sdk_session_id IS NOT NULL AND t.state NOT IN ('completed','stopped','failed')
      AND (o.session_state IS NULL OR o.session_state NOT IN ('completed','stopped','failed'))
    ORDER BY t.created_at DESC,t.id ASC`);
  const byId = db.prepare<[string, string], Row>(`${projection} WHERE t.requester_id=? AND t.id=?`);
  const cloudForTask = db.prepare<[string], {
    session_url: string | null; observed_at: number | null; nano_aiu: number | null; premium_requests: number | null;
  }>(`
    SELECT t.session_url,u.observed_at,u.nano_aiu,u.premium_requests
    FROM tasks t JOIN repo_connections c ON c.id=t.connection_id JOIN task_starts s ON s.task_id=t.id
    JOIN repositories r ON r.id=c.repo_id
    LEFT JOIN task_sdk_usage u ON u.task_id=t.id AND u.session_id=t.sdk_session_id AND u.runtime_scope=t.runtime_scope
      AND u.copilot_account_id=s.copilot_account_id AND u.connection_generation=s.connection_generation
    WHERE t.id=? AND t.runtime_kind='github_cloud' AND c.generation=s.connection_generation
      AND r.provider='github' AND r.canonical_host='github.com'
  `);
  const byConnection = db.prepare<[string, string], Row>(`
    ${projection} WHERE t.requester_id=? AND t.connection_id=? AND t.state NOT IN ('completed','stopped','failed')
    ORDER BY t.created_at DESC,t.id ASC
  `);
  const activeForIssue = db.prepare<[string, string], { id: string; requester_id: string; connection_id: string }>(`
    SELECT id, requester_id, connection_id FROM tasks WHERE repo_id=? AND work_item_key=?
      AND state NOT IN ('completed','stopped','failed') LIMIT 1`);

  function requireConnection(requester: Requester, id: string) {
    const connection = connections.all(requester.id).find((row) => row.connection_id === id);
    if (!connection) throw new ApiFailure('NOT_FOUND');
    const access = readAccess(connection.connection_id, requester);
    if (access === 'denied') throw new ApiFailure('ACCESS_DENIED');
    if (access === 'unverified') throw new ApiFailure('ACCESS_UNVERIFIED');
    return connection;
  }

  function authorized(requester: Requester) {
    return connections.all(requester.id).filter((row) => {
      const access = readAccess(row.connection_id, requester);
      if (access === 'unverified') throw new ApiFailure('ACCESS_UNVERIFIED');
      return access === 'valid';
    });
  }

  return {
    issueTask: db.transaction((requester: Requester, connectionId: string, key: string) => {
      const { id } = requireConnection(requester, connectionId);
      const row = activeForIssue.get(id, key);
      return { busy: !!row, taskId: row?.requester_id === requester.id && row.connection_id === connectionId ? row.id : null };
    }),
    tasks: db.transaction((requester: Requester, id: string, query: ApiDto<'taskQuery'>): ApiDto<'tasks'> => {
      const connection = requireConnection(requester, id);
      const scope = JSON.stringify(['active-tasks', requester.id, id, connection.generation]);
      const rows = byConnection.all(requester.id, id).map(taskView);
      const revision = sha256Hex(JSON.stringify(rows));
      const from = cursor.decode(query.cursor, scope, revision, 0);
      const end = from + Number(query.limit ?? 50);
      return { items: rows.slice(from, end), nextCursor: end < rows.length ? cursor.encode(scope, revision, end) : null };
    }),
    activeSessions: db.transaction((requester: Requester): Summary => {
      const visible = authorized(requester);
      const rows = mappedActive.all(requester.id, JSON.stringify(visible.map(({ connection_id }) => connection_id)));
      const at = now();
      return {
        repositories: visible.map(({ id, name, provider }) => ({ id, name, provider })),
        sessions: rows.map((row) => {
          const observed = currentObservation(row, at);
          const state = row.state === 'needs_auth' || row.state === 'needs_recovery' ? row.state : observed ?? 'unverified';
          return { ...fields(row), state, blocker: state === 'needs_recovery' ? 'recovery' : observed === state ? row.blocker : null };
        }),
      };
    }),
    task: db.transaction((requester: Requester, id: string): Task => {
      const row = byId.get(requester.id, id);
      if (!row) throw new ApiFailure('NOT_FOUND');
      requireConnection(requester, row.connection_id);
      const observed = currentObservation(row, now());
      const nonterminal = active(row.state) && (row.session_state === null || active(row.session_state));
      const sample = cloudForTask.get(row.id);
      const sessionUrl = verifiedCloudSessionUrl(row.sdk_session_id, sample?.session_url);
      return {
        task: taskView(row),
        sessionState: row.sdk_session_id === null || !nonterminal ? null : observed ?? 'unverified',
        observedAt: row.observed_at === null ? null : new Date(row.observed_at).toISOString(),
        pendingQuestion: row.state === 'waiting_input' && observed === 'waiting_input' && row.question_id !== null && row.question_text !== null
          ? { id: row.question_id, text: row.question_text } : null,
        actions: { answer: disabled, archive: disabled, context: disabled },
        draftPrUrl: row.draft_pr_url,
        ...(sessionUrl && { sessionUrl }),
        ...(sample?.observed_at != null && { sdkUsage: {
          observedAt: new Date(sample.observed_at).toISOString(),
          nanoAiu: sample.nano_aiu, premiumRequests: sample.premium_requests,
        } }),
      };
    }),
    statistics: db.transaction((requester: Requester): Statistics => {
      const visible = authorized(requester);
      const connectionIds = new Set(visible.map((row) => row.connection_id));
      const rows = byRequester.all(requester.id).filter((row) => connectionIds.has(row.connection_id));
      return {
        ...outcomes(rows), weekly: weeklyOutcomes(rows),
        repositories: visible.map(({ id }) => ({ repoId: id, ...outcomes(rows.filter((row) => row.repo_id === id)) })),
      };
    }),
  };
}
