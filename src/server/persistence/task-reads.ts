import type SQLite from 'better-sqlite3';
import type { ApiDto } from '../../shared/api/schemas.js';
import { sha256Hex } from '../digest.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { createCursorCodec } from '../repositories/cursors.js';

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
  for (const row of rows) {
    if (row.terminal_at === null || active(row.state)) continue;
    const date = new Date(row.terminal_at);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const weekStart = date.toISOString().slice(0, 10);
    const week = result.get(weekStart) ?? { weekStart, completed: 0, credits: null };
    if (row.state === 'completed') week.completed = (week.completed ?? 0) + 1;
    if (row.credits !== null) week.credits = (week.credits ?? 0) + row.credits;
    result.set(weekStart, week);
  }
  return [...result.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function createTaskReads(db: SQLite.Database, cursorKey: Uint8Array, readAccess: Access) {
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
  const byRequester = db.prepare<[string], Row>(`${projection} WHERE t.requester_id=? ORDER BY t.created_at ASC, t.id ASC`);
  const byId = db.prepare<[string, string], Row>(`${projection} WHERE t.requester_id=? AND t.id=?`);
  const byConnection = db.prepare<[string, string], Row>(`
    ${projection} WHERE t.requester_id=? AND t.connection_id=? AND t.state NOT IN ('completed','stopped','failed')
    ORDER BY t.created_at DESC,t.id ASC
  `);

  function requireConnection(requester: Requester, id: string) {
    const connection = connections.all(requester.id).find((row) => row.connection_id === id);
    if (!connection) throw new ApiFailure('NOT_FOUND');
    const access = readAccess(connection.connection_id, requester);
    if (access === 'denied') throw new ApiFailure('ACCESS_DENIED');
    if (access === 'unverified') throw new ApiFailure('ACCESS_UNVERIFIED');
    return connection;
  }

  function authorized(requester: Requester) {
    const visible = connections.all(requester.id).filter((row) => {
      const access = readAccess(row.connection_id, requester);
      if (access === 'unverified') throw new ApiFailure('ACCESS_UNVERIFIED');
      return access === 'valid';
    });
    const connectionIds = new Set(visible.map((row) => row.connection_id));
    return { visible, rows: byRequester.all(requester.id).filter((row) => connectionIds.has(row.connection_id)) };
  }

  return {
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
      const { visible, rows } = authorized(requester);
      return {
        repositories: visible.map(({ id, name, provider }) => ({ id, name, provider })),
        sessions: rows.filter((row) => active(row.state) && row.sdk_session_id !== null && (row.session_state === null || active(row.session_state)))
          .map((row) => ({
            ...fields(row), state: (row.session_state ?? 'unverified') as Summary['sessions'][number]['state'], blocker: row.blocker,
          })),
      };
    }),
    task: db.transaction((requester: Requester, id: string): Task => {
      const row = byId.get(requester.id, id);
      if (!row) throw new ApiFailure('NOT_FOUND');
      requireConnection(requester, row.connection_id);
      const observed = active(row.session_state) ? row.session_state : null;
      return {
        task: taskView(row),
        sessionState: row.sdk_session_id === null ? null : observed ?? (row.session_state === null && active(row.state) ? 'unverified' : null),
        observedAt: row.observed_at === null ? null : new Date(row.observed_at).toISOString(),
        pendingQuestion: row.state === 'waiting_input' && observed === 'waiting_input' && row.question_id !== null && row.question_text !== null
          ? { id: row.question_id, text: row.question_text } : null,
        actions: { answer: disabled, archive: disabled, context: disabled },
        draftPrUrl: row.draft_pr_url,
      };
    }),
    statistics: db.transaction((requester: Requester): Statistics => {
      const { visible, rows } = authorized(requester);
      return {
        ...outcomes(rows), weekly: weeklyOutcomes(rows),
        repositories: visible.map(({ id }) => ({ repoId: id, ...outcomes(rows.filter((row) => row.repo_id === id)) })),
      };
    }),
  };
}
