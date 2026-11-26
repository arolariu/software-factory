import Value from 'typebox/value';
import { expect, it } from 'vitest';
import { ApiSchemas as s } from './schemas.js';

it('strictly validates task starts, paging, and purpose-specific authorization intents', () => {
  const start = { startRequestId: 'request-1', workItemKey: '42', copilotAccountId: 'copilot-1' };
  expect(Value.Check(s.startTask, start)).toBe(true);
  expect(Value.Check(s.startTask, { ...start, requesterId: 'user-1' })).toBe(false);
  expect(Value.Check(s.startTask, { startRequestId: 'r', workItemKey: '42' })).toBe(false);
  expect(Value.Check(s.paging, { limit: '101' })).toBe(false);
  expect(Value.Check(s.paging, { limit: '100' })).toBe(true);
  const intent = { intent: 'sign_in', hostId: 'github' };
  expect(Value.Check(s.authorizationIntent, intent)).toBe(true);
  for (const extra of ['issuer', 'authorizationUrl', 'token', 'connectionId']) {
    expect(Value.Check(s.authorizationIntent, { ...intent, [extra]: 'unexpected' })).toBe(false);
  }
  expect(Value.Check(s.authorizationIntent, { intent: 'connect', repositoryUrl: 'https://github.com/org/repo' })).toBe(true);
  expect(Value.Check(s.authorizationIntent, { intent: 'connect', repositoryUrl: 'https://user:secret@github.com/repo' })).toBe(false);
});

it('preserves nullable titles and distinguishes inaccessible data from known empty data', () => {
  expect(Value.Check(s.activeSessions, {
    repositories: [{ id: 'r', name: 'Repo', provider: 'github' }],
    sessions: [{ taskId: 't', repoId: 'r', workItemKey: '42', title: null, issueUrl: null, state: 'unverified', blocker: null }],
  })).toBe(true);
  expect(Value.Check(s.issues, { freshness: 'unavailable', items: [], nextCursor: null, fetchedAt: null })).toBe(false);
  expect(Value.Check(s.issues, { freshness: 'unavailable', items: null, nextCursor: null, fetchedAt: null })).toBe(true);
  const unavailable = { headRevision: 'rev', availability: { available: false, reasonCode: 'UNVERIFIED' } };
  expect(Value.Check(s.checks, { ...unavailable, passed: 0, total: 0, items: null })).toBe(false);
  expect(Value.Check(s.checks, { ...unavailable, passed: null, total: null, items: null })).toBe(true);
});
