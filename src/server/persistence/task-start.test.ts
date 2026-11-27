import SQLite from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { migrate } from './migrations.js';
import { createTaskStarts } from './task-start.js';

const requester = { id: 'alice' };
const input = { startRequestId: 'once', workItemKey: '7', copilotAccountId: 'copilot' };
const binding = { connectionId: 'conn', repoId: 'repo', identityId: 'identity', generation: 1, scope: 'github.com:org:7' };
const databases: SQLite.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new SQLite(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.exec(`
    INSERT INTO users VALUES ('alice'), ('bob');
    INSERT INTO identities (id,user_id,provider,issuer,subject) VALUES ('identity','alice','github','github.com','14');
    INSERT INTO repositories (id,provider,canonical_host,provider_scope,provider_repo_id,canonical_url)
      VALUES ('repo','github','github.com','5','7','https://github.com/org/repo');
    INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at) VALUES ('conn','repo','alice','identity',1);
  `);
  return db;
}

it('denies the default gate and stale verification without reserving any task', () => {
  const db = fixture();
  expect(() => createTaskStarts(db).reserve(requester, binding.connectionId, input)).toThrow('CAPABILITY_UNAVAILABLE');
  const starts = createTaskStarts(db, () => binding);
  expect(() => starts.reserve({ id: 'bob' }, binding.connectionId, input)).toThrow('ACCESS_UNVERIFIED');
  db.exec("UPDATE repo_connections SET generation=2 WHERE id='conn'");
  expect(() => starts.reserve(requester, binding.connectionId, input)).toThrow('ACCESS_UNVERIFIED');
  expect(db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 0 });
});

it('replays identical requests without duplicating tasks and rejects conflicting requests', () => {
  const db = fixture();
  const starts = createTaskStarts(db, () => binding, () => 10);
  const accepted = starts.reserve(requester, binding.connectionId, input);
  expect(accepted.state).toBe('queued');
  expect(starts.reserve(requester, binding.connectionId, { ...input, overrides: {} })).toEqual(accepted);
  expect(() => starts.reserve(requester, binding.connectionId, { ...input, copilotAccountId: 'other' })).toThrow('REQUEST_ID_REUSED');
  expect(() => starts.reserve(requester, binding.connectionId, { ...input, startRequestId: 'twice' })).toThrow('TASK_ALREADY_ACTIVE');
  expect(db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 });
});

it('confirms only the exact claimed start; recovery never retries ambiguous work', () => {
  const db = fixture();
  const starts = createTaskStarts(db, () => binding);
  const { taskId } = starts.reserve(requester, binding.connectionId, input);
  expect(createTaskStarts(db).claim(taskId)).toBeUndefined();
  const claim = starts.claim(taskId);
  expect(claim).toMatchObject({ taskId, requesterId: requester.id, scope: binding.scope, copilotAccountId: input.copilotAccountId });
  if (!claim) throw new Error('Expected claimed start');
  expect(starts.claim(taskId)).toBeUndefined();
  expect(starts.confirm({ ...claim, requestedSessionId: 'foreign' }, 'actual')).toBe(false);
  const restarted = createTaskStarts(db, () => binding);
  expect(restarted.recoverInterrupted()).toBe(1);
  expect(restarted.recoverInterrupted()).toBe(0);
  expect(restarted.claim(taskId)).toBeUndefined();
  expect(restarted.confirm(claim, 'actual')).toBe(true);
  expect(restarted.confirm(claim, 'duplicate')).toBe(false);
  expect(db.prepare('SELECT state, sdk_session_id FROM tasks WHERE id=?').get(taskId)).toEqual({ state: 'running', sdk_session_id: 'actual' });
  expect(db.prepare('SELECT session_state FROM task_observations WHERE task_id=?').get(taskId)).toEqual({ session_state: 'running' });
});

it('does not claim queued work after a reconnect changes its generation', () => {
  const db = fixture();
  const starts = createTaskStarts(db, () => binding);
  const { taskId } = starts.reserve(requester, binding.connectionId, input);
  db.exec("UPDATE repo_connections SET generation=2 WHERE id='conn'");
  expect(starts.claim(taskId)).toBeUndefined();
  expect(db.prepare('SELECT state, sdk_session_id FROM tasks WHERE id=?').get(taskId)).toEqual({ state: 'needs_auth', sdk_session_id: null });
});
