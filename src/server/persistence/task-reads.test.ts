import { expect, it } from 'vitest';
import SQLite from 'better-sqlite3';
import Value from 'typebox/value';
import { ApiSchemas } from '../../shared/api/schemas.js';
import { migrate } from './migrations.js';
import { createTaskReads } from './task-reads.js';

const requester = { id: 'alice' };

function fixture() {
  const db = new SQLite(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.exec(`
    INSERT INTO users VALUES ('alice'), ('bob');
    INSERT INTO identities (id,user_id,provider,issuer,subject) VALUES
      ('a','alice','github','github.com','1'), ('b','bob','github','github.com','2');
    INSERT INTO repositories (id,provider,canonical_host,provider_scope,provider_repo_id,canonical_url,name) VALUES
      ('r','github','github.com','1','10','https://github.com/org/public','Published'),
      ('h','github','github.com','1','11','https://github.com/org/hidden','Hidden');
    INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at) VALUES
      ('alice-r','r','alice','a',0), ('alice-h','h','alice','a',0), ('bob-r','r','bob','b',0);
    INSERT INTO tasks (id,connection_id,repo_id,requester_id,repo_identity_id,copilot_identity_id,work_item_key,
      start_request_id,runtime_kind,runtime_scope,sdk_session_id,state,created_at,updated_at) VALUES
      ('ask','alice-r','r','alice','a','a','1','ask','github_cloud','staging','s1','waiting_input',10,20),
      ('queued','alice-r','r','alice','a','a','2','queued','github_cloud','staging',NULL,'queued',12,20),
      ('done','alice-r','r','alice','a','a','3','done','github_cloud','staging','s3','completed',5,20),
      ('unknown','alice-r','r','alice','a','a','4','unknown','github_cloud','staging','s4','running',11,20),
      ('hidden','alice-h','h','alice','a','a','5','hidden','github_cloud','staging','s5','running',13,20),
      ('foreign','bob-r','r','bob','b','b','6','foreign','github_cloud','staging','s6','running',14,20),
      ('older','alice-r','r','alice','a','a','7','older','github_cloud','staging',NULL,'failed',1,20);
    INSERT INTO task_observations (task_id,title,issue_url,session_state,observed_at,question_id,question_text)
      VALUES ('ask','Review the tests','https://github.com/org/public/issues/1','waiting_input',20,'q1','Which tests?');
    INSERT INTO task_observations (task_id,terminal_at,credits) VALUES ('done',1795737600000,4);
  `);
  const grants = new Map<string, 'valid' | 'denied' | 'unverified'>([
    ['alice-r', 'valid'], ['alice-h', 'denied'],
  ]);
  return { db, grants, reads: createTaskReads(db, new Uint8Array(32), (connectionId) => grants.get(connectionId) ?? 'denied') };
}

it('projects only owned, authorized, mapped nonterminal sessions and separates observed state', () => {
  const { db, reads } = fixture();
  try {
    const summary = reads.activeSessions(requester);
    expect(Value.Check(ApiSchemas.activeSessions, summary)).toBe(true);
    expect(summary.repositories).toEqual([{ id: 'r', name: 'Published', provider: 'github' }]);
    expect(summary.sessions.map(({ taskId, state }) => [taskId, state])).toEqual([['ask', 'waiting_input'], ['unknown', 'unverified']]);
    expect(reads.task(requester, 'ask')).toMatchObject({
      task: { state: 'waiting_input', title: 'Review the tests' }, sessionState: 'waiting_input',
      observedAt: '1970-01-01T00:00:00.020Z', pendingQuestion: { id: 'q1', text: 'Which tests?' },
      actions: { answer: { available: false } },
    });
    expect(reads.task(requester, 'queued').sessionState).toBeNull();
    expect(reads.task(requester, 'unknown').sessionState).toBe('unverified');
    db.exec("UPDATE task_observations SET session_state='stopped' WHERE task_id='ask'");
    expect(reads.activeSessions(requester).sessions.map((row) => row.taskId)).toEqual(['unknown']);
    expect(reads.task(requester, 'ask')).toMatchObject({ sessionState: null, pendingQuestion: null });
    expect(() => reads.task(requester, 'foreign')).toThrow('NOT_FOUND');
    expect(() => reads.task(requester, 'hidden')).toThrow('ACCESS_DENIED');
    db.exec("UPDATE repo_connections SET retired_at=30 WHERE id='alice-r'");
    expect(() => reads.task(requester, 'ask')).toThrow('NOT_FOUND');
  } finally { db.close(); }
});

it('fails closed for an unverified eligible connection even if it has no tasks', () => {
  const { db, grants, reads } = fixture();
  try {
    db.exec("DELETE FROM tasks WHERE id='hidden'");
    grants.set('alice-h', 'unverified');
    expect(() => reads.activeSessions(requester)).toThrow('ACCESS_UNVERIFIED');
    expect(() => reads.statistics(requester)).toThrow('ACCESS_UNVERIFIED');
    grants.set('alice-r', 'unverified');
    expect(() => reads.task(requester, 'ask')).toThrow('ACCESS_UNVERIFIED');
    expect(() => reads.tasks(requester, 'alice-r', { state: 'active' })).toThrow('ACCESS_UNVERIFIED');
  } finally { db.close(); }
});

it('uses terminal timestamps and preserves unknown usage instead of counting it as zero', () => {
  const { db, reads } = fixture();
  try {
    const stats = reads.statistics(requester);
    expect(Value.Check(ApiSchemas.statistics, stats)).toBe(true);
    expect(stats).toMatchObject({
      activeTasks: 3, completed: 1, failed: 1, stopped: 0, credits: { measured: 4, unmeasuredTasks: 4 },
      repositories: [{ repoId: 'r', completed: 1 }],
      weekly: [{ weekStart: '2026-11-23', completed: 1, credits: 4 }],
    });
    db.exec("UPDATE task_observations SET credits=NULL WHERE task_id='done'");
    expect(reads.statistics(requester)).toMatchObject({ credits: { measured: null }, weekly: [{ credits: null }] });
  } finally { db.close(); }
});

it('pages active tasks and invalidates a cursor when its source changes', () => {
  const { db, reads } = fixture();
  try {
    const first = reads.tasks(requester, 'alice-r', { state: 'active', limit: '1' });
    expect(first.items.map((row) => row.taskId)).toEqual(['queued']);
    if (!first.nextCursor) throw new Error('Missing continuation');
    const query = { state: 'active', limit: '1', cursor: first.nextCursor } as const;
    expect(reads.tasks(requester, 'alice-r', query).items[0]?.taskId).toBe('unknown');
    expect(() => reads.tasks(requester, 'foreign', query)).toThrow('NOT_FOUND');
    db.exec("UPDATE tasks SET state='stopped' WHERE id='queued'");
    expect(() => reads.tasks(requester, 'alice-r', query)).toThrow('SNAPSHOT_CHANGED');
    expect(reads.statistics(requester).stopped).toBe(1);
    expect(reads.tasks(requester, 'alice-r', { state: 'active' }).nextCursor).toBeNull();
  } finally { db.close(); }
});
