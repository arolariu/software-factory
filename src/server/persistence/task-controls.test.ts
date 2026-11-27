import SQLite from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { migrate } from './migrations.js';
import { createTaskControls } from './task-controls.js';

const requester = { id: 'alice' };
const reply = { kind: 'answer', requestId: 'reply-1', questionId: 'q1', text: 'Keep reply text out of the ledger.' } as const;
const stop = { kind: 'stop', requestId: 'stop-1' } as const;
const databases: SQLite.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new SQLite(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.exec(`
    INSERT INTO users VALUES ('alice'), ('bob');
    INSERT INTO identities (id,user_id,provider,issuer,subject) VALUES ('ident','alice','github','github.com','14');
    INSERT INTO repositories (id,provider,canonical_host,provider_scope,provider_repo_id,canonical_url)
      VALUES ('repo','github','github.com','org','7','https://github.com/org/repo');
    INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at) VALUES ('conn','repo','alice','ident',1);
    INSERT INTO tasks (id,connection_id,repo_id,requester_id,repo_identity_id,copilot_identity_id,work_item_key,
      start_request_id,runtime_kind,runtime_scope,sdk_session_id,state,created_at,updated_at)
      VALUES ('task','conn','repo','alice','ident','ident','7','start','github_cloud','scope','session','waiting_input',10,10);
    INSERT INTO task_starts VALUES ('task','hash',1,'account');
    INSERT INTO task_observations (task_id,session_state,observed_at,question_id,question_text)
      VALUES ('task','waiting_input',10,'q1','What is your preference?');
  `);
  const key = new Uint8Array(32).fill(7);
  return { db, key, controls: createTaskControls(db, key, () => true, () => 20) };
}

it('reserves an answer only for the exact pending question and stores no reply text', () => {
  const { db, controls, key } = fixture();
  expect(() => createTaskControls(db, key).reserve(requester, 'task', reply)).toThrow('CAPABILITY_UNAVAILABLE');
  expect(() => controls.reserve({ id: 'bob' }, 'task', reply)).toThrow('NOT_FOUND');
  expect(() => controls.reserve(requester, 'task', { ...reply, questionId: 'older' })).toThrow('STALE_QUESTION');
  const first = controls.reserve(requester, 'task', reply);
  expect(controls.reserve(requester, 'task', reply)).toEqual(first);
  expect(() => controls.reserve(requester, 'task', { ...reply, text: 'Changed' })).toThrow('REQUEST_ID_REUSED');
  expect(() => controls.reserve(requester, 'task', stop)).toThrow('TASK_OPERATION_PENDING');
  expect(JSON.stringify(db.prepare('SELECT * FROM task_controls').all())).not.toContain(reply.text);
  expect(controls.claim(first.operationId, { ...reply, text: 'Changed' })).toBeUndefined();
  const claim = controls.claim(first.operationId, reply);
  expect(claim).toMatchObject({ taskId: 'task', requesterId: 'alice', scope: 'scope', sessionId: 'session' });
  if (!claim) throw new Error('Expected claimed operation');
  db.exec("UPDATE task_observations SET question_id='q2',question_text='Another question' WHERE task_id='task'");
  expect(controls.confirm({ ...claim, sessionId: 'different' })).toBe(false);
  expect(controls.confirm(claim)).toBe(true);
  expect(db.prepare('SELECT question_id FROM task_observations').get()).toEqual({ question_id: 'q2' });
});

it('does not retry an interrupted stop or mark the task stopped without exact confirmation', () => {
  const { db, controls, key } = fixture();
  const receipt = controls.reserve(requester, 'task', stop);
  const claim = controls.claim(receipt.operationId, stop);
  if (!claim) throw new Error('Expected claimed stop');
  const restarted = createTaskControls(db, key, () => true, () => 30);
  expect(restarted.recoverInterrupted()).toBe(1);
  expect(restarted.recoverInterrupted()).toBe(0);
  expect(restarted.claim(receipt.operationId, stop)).toBeUndefined();
  expect(db.prepare('SELECT state,archived_at FROM tasks').get()).toEqual({ state: 'waiting_input', archived_at: null });
  expect(restarted.confirm(claim)).toBe(true);
  expect(restarted.confirm(claim)).toBe(false);
  expect(db.prepare('SELECT state,archived_at FROM tasks').get()).toEqual({ state: 'stopped', archived_at: null });
  expect(db.prepare('SELECT session_state,terminal_at,question_id FROM task_observations').get())
    .toEqual({ session_state: 'stopped', terminal_at: 30, question_id: null });
});

it('does not claim work for stale connections or superseded questions', () => {
  const { db, controls } = fixture();
  const receipt = controls.reserve(requester, 'task', reply);
  db.exec("UPDATE task_observations SET question_id='q2' WHERE task_id='task'");
  expect(controls.claim(receipt.operationId, reply)).toBeUndefined();
  const other = controls.reserve(requester, 'task', { ...reply, requestId: 'reply-2', questionId: 'q2' });
  db.exec("UPDATE repo_connections SET generation=2 WHERE id='conn'");
  expect(controls.claim(other.operationId, { ...reply, requestId: 'reply-2', questionId: 'q2' })).toBeUndefined();
});

it('cannot apply stop evidence to a different generation or replace a terminal observation', () => {
  const { db, controls } = fixture();
  const receipt = controls.reserve(requester, 'task', stop);
  const claim = controls.claim(receipt.operationId, stop);
  if (!claim) throw new Error('Expected claimed stop');
  db.exec("UPDATE repo_connections SET generation=2 WHERE id='conn'");
  expect(controls.confirm(claim)).toBe(false);
  db.exec("UPDATE tasks SET sdk_session_id='replacement' WHERE id='task'; UPDATE repo_connections SET generation=1 WHERE id='conn'");
  expect(controls.confirm({ ...claim, sessionId: 'replacement' })).toBe(false);
  db.exec(`
    UPDATE tasks SET sdk_session_id='session' WHERE id='task';
    UPDATE task_observations SET session_state='completed',terminal_at=25,question_id=NULL,question_text=NULL;
  `);
  expect(controls.confirm(claim)).toBe(false);
  expect(db.prepare('SELECT session_state,terminal_at FROM task_observations').get())
    .toEqual({ session_state: 'completed', terminal_at: 25 });
});

it('releases an unclaimed reply after restart and consumes only the confirmed pending question', () => {
  const { db, controls, key } = fixture();
  const previous = controls.reserve(requester, 'task', reply);
  const restarted = createTaskControls(db, key, () => true);
  expect(restarted.recoverInterrupted()).toBe(1);
  expect(restarted.claim(previous.operationId, reply)).toBeUndefined();
  expect(restarted.reserve(requester, 'task', reply)).toEqual(previous);
  const answer = { ...reply, requestId: 'reply-2' };
  const receipt = restarted.reserve(requester, 'task', answer);
  const claim = restarted.claim(receipt.operationId, answer);
  if (!claim) throw new Error('Expected claimed answer');
  expect(restarted.confirm(claim)).toBe(true);
  expect(db.prepare('SELECT question_id,question_text FROM task_observations').get())
    .toEqual({ question_id: null, question_text: null });
  expect(() => restarted.reserve(requester, 'task', { ...reply, requestId: 'reply-3' })).toThrow('STALE_QUESTION');
});
