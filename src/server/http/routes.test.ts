import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../build-app.js';
import { openDatabase } from '../persistence/open.js';
import { ApiFailure } from './problems.js';
import type { PortalModules } from './portal-modules.js';

const origin = 'https://factory.example';
const cookie = 'factory_session=session-one';
const headers = { cookie, origin, 'x-csrf-token': 'test-token' };
const requester = { id: 'user-one' };
const empty = { repositories: [], sessions: [] };
const issue = {
  key: '42', title: 'Sample', url: 'https://github.com/org/repo/issues/42', state: 'open' as 'open' | 'closed',
  author: null, createdAt: '2026-11-26T21:32:00Z', assignees: [], revision: 'head-1', taskId: null,
  linkedPr: null, launch: { available: false as const, reasonCode: 'UNVERIFIED' },
};
let directory: string;
let db: ReturnType<typeof openDatabase>;
let app: FastifyInstance | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'factory-api-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<main>Portal</main>');
  db = openDatabase(join(directory, 'factory.sqlite'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
  rmSync(directory, { recursive: true });
});

function fixtures() {
  const hosts = [{ id: 'enterprise-one', label: 'Enterprise', hostname: 'tenant.ghe.com' }];
  const identity = {
    resolveRequester: vi.fn((sessionId: string) => sessionId === 'session-one' ? requester : null),
    csrf: vi.fn((sessionId: string | undefined) => ({
      csrfToken: 'test-token', ...(sessionId === undefined && { sessionId: 'anonymous-one' }),
    })),
    verifyCsrf: vi.fn((sessionId: string, token: string) => ['session-one', 'anonymous-one'].includes(sessionId) && token === 'test-token'),
    githubHosts: vi.fn(() => hosts),
    me: vi.fn(() => ({ user: { id: requester.id, displayName: 'User', avatarUrl: null }, accounts: [] })),
    beginAuthorization: vi.fn(() => ({ authorizationUrl: 'https://github.com/login/oauth/authorize?state=state-one' })),
    completeAuthorization: vi.fn((): { redirectTo: string; sessionId?: string } => ({ redirectTo: '/settings/copilot' })),
    logout: vi.fn(() => undefined),
    copilotAccounts: vi.fn(() => ({ items: [], defaultAccountId: null })),
    setDefaultCopilotAccount: vi.fn(() => undefined),
  };
  const repositories = {
    closeIssue: vi.fn(() => ({ issue: { ...issue, state: 'closed' as const } })),
    connections: vi.fn(() => ({ items: [] })),
    issues: vi.fn(() => ({ freshness: 'not_synced' as const, items: null, nextCursor: null, fetchedAt: null })),
    issue: vi.fn(() => ({
      issue, description: { format: 'text' as const, content: 'Details' }, fields: [], related: [],
      comments: { items: [], nextCursor: null },
    })),
    pullRequests: vi.fn(() => ({ freshness: 'unavailable' as const, items: null, nextCursor: null, fetchedAt: null })),
    checks: vi.fn(() => ({
      headRevision: 'head-1', availability: { available: false as const, reasonCode: 'UNVERIFIED' },
      passed: null, total: null, items: null,
    })),
  };
  const tasks = {
    start: vi.fn(() => ({ taskId: 'task_fixture', state: 'queued' as const })),
    activeSessions: vi.fn(() => empty),
    tasks: vi.fn(() => ({ items: [], nextCursor: null })),
    unlinkedSessions: vi.fn(() => ({ availability: { available: true as const }, items: [], nextCursor: null })),
    task: vi.fn(() => { throw new ApiFailure('NOT_FOUND'); }),
    activity: vi.fn(() => ({ availability: { available: true as const }, items: [], nextCursor: null })),
    options: vi.fn(() => ({
      copilotAccountId: 'explicit-one',
      launch: issue.launch, featureBranch: issue.launch, models: { availability: issue.launch, items: [] },
    })),
    statistics: vi.fn(() => ({
      activeTasks: 0, completed: 0, stopped: 0, failed: 0, draftPrs: 0,
      credits: { measured: null, unmeasuredTasks: 0 }, repositories: [], weekly: [],
    })),
  };
  const operations = {
    read: vi.fn(() => ({
      id: 'remove-one', kind: 'remove_connection' as const, state: 'completed' as const, problemCode: null,
    })),
    authorizeEffect: vi.fn((): void => undefined),
    sync: vi.fn(() => ({ operationId: 'sync-one' })),
    input: vi.fn(() => ({ operationId: 'input-one' })),
    archive: vi.fn(() => ({ operationId: 'archive-one' })),
    remove: vi.fn(() => ({ operationId: 'remove-one' })),
  };
  return { identity, repositories, tasks, operations } satisfies PortalModules;
}

async function server(modules?: PortalModules) {
  app = await buildApp({
    db, staticRoot: directory, build: { revision: null, builtAt: null, runUrl: null },
    ...(modules && { portal: { modules, publicOrigin: origin } }),
  });
  return app;
}

it('rejects anonymous and inaccessible reads without returning provider data', async () => {
  const f = fixtures();
  const app = await server(f);
  for (const [url, requestHeaders, status, code] of [
    ['/api/me', {}, 401, 'AUTH_REQUIRED'],
    ['/api/tasks/out-of-scope', { cookie }, 404, 'NOT_FOUND'],
  ] as const) {
    const response = await app.inject({ url, headers: requestHeaders });
    expect(response.statusCode).toBe(status);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status, code });
  }
  expect(f.identity.me).not.toHaveBeenCalled();
});

it('reads only the summary port and does not represent expired access as empty results', async () => {
  const f = fixtures();
  const app = await server(f);
  expect((await app.inject({ url: '/api/active-sessions', headers: { cookie } })).json()).toEqual(empty);
  f.tasks.activeSessions.mockImplementationOnce(() => { throw new ApiFailure('ACCESS_UNVERIFIED'); });
  const error = await app.inject({ url: '/api/active-sessions', headers: { cookie } });
  expect(error.statusCode).toBe(503);
  expect(error.json()).toMatchObject({ code: 'ACCESS_UNVERIFIED' });
  expect(error.json()).not.toHaveProperty('sessions');
  expect(error.json()).not.toHaveProperty('repositories');
  expect(f.tasks.activeSessions).toHaveBeenCalledWith(requester);
  expect(f.repositories.connections).not.toHaveBeenCalled();
});

it('registers authenticated browser reads and strictly validates paging', async () => {
  const f = fixtures();
  const app = await server(f);
  for (const url of [
    '/api/me', '/api/copilot/accounts', '/api/connections', '/api/connections/c/issues?state=open',
    '/api/connections/c/pull-requests?state=active', '/api/connections/c/pull-requests/p/checks?headRevision=head-1',
    '/api/connections/c/tasks?state=active', '/api/unlinked-sessions', '/api/tasks/t/activity', '/api/statistics',
    '/api/connections/c/issues/42', '/api/connections/c/task-options?copilotAccountId=explicit-one', '/api/operations/remove-one',
  ]) {
    const result = await app.inject({ url, headers: { cookie } });
    expect(result.statusCode, `${url}: ${result.body}`).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
  }
  for (const query of ['state=open&limit=101', 'state=open&limit=1&limit=2', 'state=open&requesterId=user-two']) {
    const bad = await app.inject({ url: `/api/connections/c/issues?${query}`, headers: { cookie } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_REQUEST');
  }
  expect(f.repositories.issues).toHaveBeenCalledTimes(1);
});

it('keeps authorization purpose-specific and cookies opaque', async () => {
  const f = fixtures();
  const app = await server(f);
  expect((await app.inject('/api/auth/github/hosts')).json()).toEqual({ items: f.identity.githubHosts() });
  const csrf = await app.inject('/api/auth/csrf');
  expect(csrf.json()).toEqual({ csrfToken: 'test-token' });
  expect(csrf.headers['set-cookie']).toMatch(/factory_session=anonymous-one.*HttpOnly.*Secure.*SameSite=Lax/i);
  const signedCsrf = await app.inject({ url: '/api/auth/csrf', headers: { cookie } });
  expect(signedCsrf.headers['set-cookie']).toBeUndefined();
  expect(f.identity.csrf).toHaveBeenLastCalledWith('session-one');
  for (const [provider, payload, expected] of [
    ['github', { intent: 'sign_in', hostId: 'unknown' }, 400],
    ['azure-devops', { intent: 'link_copilot', hostId: 'enterprise-one' }, 400],
    ['github', { intent: 'link_copilot', hostId: 'enterprise-one', requesterId: 'user-two' }, 400],
  ] as const) {
    expect((await app.inject({ method: 'POST', url: `/api/auth/${provider}/start`, headers, payload })).statusCode).toBe(expected);
  }
  expect(f.identity.beginAuthorization).not.toHaveBeenCalled();
  const start = await app.inject({
    method: 'POST', url: '/api/auth/github/start', headers, payload: { intent: 'link_copilot', hostId: 'enterprise-one' },
  });
  expect(start.statusCode, start.body).toBe(200);
  const callback = await app.inject({ url: '/auth/github/callback?state=state-one&code=temporary', headers: { cookie } });
  expect(callback.statusCode).toBe(303);
  expect(callback.headers.location).toBe('/settings/copilot');
  expect(callback.headers['set-cookie']).toBeUndefined();
});

it('never redeems OAuth state on HEAD and ignores unused provider callback parameters', async () => {
  const f = fixtures();
  const app = await server(f);
  const url = '/auth/azure-devops/callback?state=state-one&code=temporary&session_state=provider-extra';
  expect((await app.inject({ method: 'HEAD', url, headers: { cookie } })).statusCode).toBe(404);
  expect(f.identity.completeAuthorization).not.toHaveBeenCalled();
  expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(303);
  expect(f.identity.completeAuthorization).toHaveBeenCalledWith('azure-devops', 'session-one', {
    state: 'state-one', code: 'temporary',
  });
  const ambiguous = await app.inject({ url: `${url}&error=access_denied`, headers: { cookie } });
  expect(ambiguous.statusCode).toBe(400);
  expect(f.identity.completeAuthorization).toHaveBeenCalledTimes(1);
});

it('leaves production unconfigured and never serves SPA content for missing API or auth routes', async () => {
  const app = await server();
  expect((await app.inject('/api/auth/github/hosts')).statusCode).toBe(503);
  expect((await app.inject('/api/active-sessions')).statusCode).toBe(401);
  for (const url of ['/api/missing', '/auth/github/missing']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  }
  const malformed = await app.inject('/api/tasks/%zz');
  expect(malformed.statusCode).toBe(400);
  expect(malformed.headers['content-type']).toContain('application/problem+json');
  expect(malformed.headers['cache-control']).toBe('no-store');
  expect(malformed.json()).toMatchObject({ code: 'INVALID_REQUEST' });
});

const startBody = { workItemKey: '42', startRequestId: 'request-one', copilotAccountId: 'explicit-one' };

it('requires origin and CSRF before any command and before capability or replay checks', async () => {
  const f = fixtures();
  const app = await server(f);
  const url = '/api/connections/repo-one/tasks';
  for (const invalidHeaders of [
    { ...headers, origin: 'https://other.example' },
    { ...headers, 'x-csrf-token': 'wrong' },
    { cookie, origin },
  ]) {
    expect((await app.inject({ method: 'POST', url, headers: invalidHeaders, payload: startBody })).statusCode).toBe(403);
  }
  const defaultAccount = await app.inject({
    method: 'PUT', url: '/api/copilot/accounts/default', headers: { cookie, origin }, payload: { accountId: null },
  });
  expect(defaultAccount.statusCode).toBe(403);
  expect(f.operations.authorizeEffect).not.toHaveBeenCalled();
  expect(f.identity.setDefaultCopilotAccount).not.toHaveBeenCalled();
  expect(f.tasks.start).not.toHaveBeenCalled();
});

it.each(['CAPABILITY_UNAVAILABLE', 'COPILOT_REAUTH_REQUIRED', 'COPILOT_REPO_IDENTITY_MISMATCH', 'ACCESS_DENIED'] as const)(
  'rejects %s from the authority before reserving work',
  async (code) => {
    const f = fixtures();
    f.operations.authorizeEffect.mockImplementation(() => { throw new ApiFailure(code); });
    const app = await server(f);
    const result = await app.inject({ method: 'POST', url: '/api/connections/c/tasks', headers, payload: startBody });
    expect(result.statusCode).toBe(code === 'ACCESS_DENIED' ? 403 : 409);
    expect(result.json()).toMatchObject({ code });
    expect(result.headers.location).toBeUndefined();
    expect(f.tasks.start).not.toHaveBeenCalled();
  },
);

it('returns stable task and Sync receipts delegated to the durable ports, then denies replay on access loss', async () => {
  const f = fixtures();
  const app = await server(f);
  const post = () => app.inject({ method: 'POST', url: '/api/connections/c/tasks', headers, payload: startBody });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await post();
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe('/api/tasks/task_fixture');
    expect(response.json()).toEqual({ taskId: 'task_fixture', state: 'queued' });
    const sync = await app.inject({ method: 'POST', url: '/api/connections/c/sync', headers });
    expect(sync.statusCode).toBe(202);
    expect(sync.headers.location).toBe('/api/operations/sync-one');
  }
  expect(f.tasks.start).toHaveBeenCalledWith(requester, 'c', startBody);
  expect(f.operations.sync).toHaveBeenCalledWith(requester, 'c');
  f.operations.authorizeEffect.mockImplementationOnce(() => { throw new ApiFailure('ACCESS_DENIED'); });
  expect((await post()).statusCode).toBe(403);
  expect(f.tasks.start).toHaveBeenCalledTimes(2);
});

it('requires confirmation and delegates stale question and normalized-request conflicts', async () => {
  const f = fixtures();
  const app = await server(f);
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
  expect((await post('/api/tasks/t/archive', { confirmed: false })).statusCode).toBe(400);
  expect(f.operations.archive).not.toHaveBeenCalled();
  const payload = { requestId: 'r', kind: 'answer', questionId: 'question-one', text: 'yes' };
  const reply = await post('/api/tasks/t/inputs', payload);
  expect(reply.statusCode).toBe(202);
  expect(reply.headers.location).toBe('/api/operations/input-one');
  f.operations.input.mockImplementationOnce(() => { throw new ApiFailure('REQUEST_ID_REUSED'); });
  expect((await post('/api/tasks/t/inputs', { ...payload, text: 'no' })).json().code).toBe('REQUEST_ID_REUSED');
  f.operations.input.mockImplementationOnce(() => { throw new ApiFailure('STALE_QUESTION'); });
  expect((await post('/api/tasks/t/inputs', { ...payload, questionId: 'old' })).json().code).toBe('STALE_QUESTION');
  expect((await post('/api/tasks/t/archive', { confirmed: true })).headers.location).toBe('/api/operations/archive-one');
  expect((await post('/api/connections/c/remove', { confirmed: true })).headers.location).toBe('/api/operations/remove-one');
});

it('limits OAuth callbacks to the portal and establishes a session only when the identity port rotates it', async () => {
  const f = fixtures();
  const app = await server(f);
  const callback = (query: string, signed = true) => app.inject({
    url: `/auth/github/callback?${query}`, ...(signed && { headers: { cookie } }),
  });
  const anonymous = { ...headers, cookie: 'factory_session=anonymous-one' };
  const start = (intent: 'sign_in' | 'link_copilot') => app.inject({
    method: 'POST', url: '/api/auth/github/start', headers: anonymous,
    payload: { intent, hostId: 'enterprise-one' },
  });
  expect((await start('sign_in')).statusCode).toBe(200);
  expect(f.identity.beginAuthorization).toHaveBeenCalledWith('github', { intent: 'sign_in', hostId: 'enterprise-one' }, 'anonymous-one', null);
  expect((await start('link_copilot')).statusCode).toBe(401);
  expect((await callback('state=s&code=c', false)).statusCode).toBe(401);
  const cancel = await callback('state=s&error=access_denied&error_description=private');
  expect(cancel.statusCode).toBe(303);
  expect(f.identity.completeAuthorization).toHaveBeenLastCalledWith('github', 'session-one', { state: 's', code: null });
  expect(cancel.body).not.toContain('private');
  expect(cancel.headers['set-cookie']).toBeUndefined();
  f.identity.completeAuthorization.mockReturnValueOnce({ redirectTo: '//other.example', sessionId: 'rotated' });
  const invalid = await callback('state=s&code=c');
  expect(invalid.statusCode).toBe(500);
  expect(invalid.headers.location).toBeUndefined();
  expect(invalid.headers['set-cookie']).toBeUndefined();
  f.identity.completeAuthorization.mockReturnValueOnce({ redirectTo: '/', sessionId: 'rotated' });
  expect((await callback('state=s&code=c')).headers['set-cookie']).toContain('factory_session=rotated');
  f.identity.completeAuthorization.mockReturnValueOnce({ redirectTo: '/', sessionId: 'not an opaque session' });
  const badSession = await callback('state=s&code=c');
  expect(badSession.statusCode).toBe(500);
  expect(badSession.headers['set-cookie']).toBeUndefined();
});

it('follows a callback to a dotted connection ID but rejects dot-segment destinations', async () => {
  const f = fixtures();
  const app = await server(f);
  const path = '/connections/repo.one/issues';
  const callback = () => app.inject({ url: '/auth/github/callback?state=s&code=c', headers: { cookie } });
  f.identity.completeAuthorization.mockReturnValueOnce({ redirectTo: path });
  const done = await callback();
  expect(done.headers.location).toBe(path);
  expect((await app.inject({ url: path, headers: { accept: 'text/html' } })).body).toContain('<main>Portal</main>');
  expect((await app.inject({ url: '/connections/repo.one/missing.js', headers: { accept: 'text/html' } })).statusCode).toBe(404);
  for (const invalid of ['/connections/../issues', '/connections/./tasks']) {
    f.identity.completeAuthorization.mockReturnValueOnce({ redirectTo: invalid });
    expect((await callback()).headers.location).toBeUndefined();
  }
});

it('updates only the selected Copilot default, returns a confirmed close, and scopes removal receipts', async () => {
  const f = fixtures();
  const app = await server(f);
  const updated = await app.inject({
    method: 'PUT', url: '/api/copilot/accounts/default', headers, payload: { accountId: null },
  });
  expect(updated.statusCode).toBe(204);
  expect(f.identity.setDefaultCopilotAccount).toHaveBeenCalledWith(requester, null);
  const close = await app.inject({
    method: 'POST', url: '/api/connections/c/issues/42/close', headers, payload: { confirmed: true, expectedRevision: 'head-1' },
  });
  expect(close.statusCode).toBe(200);
  expect(close.json().issue.state).toBe('closed');
  expect(f.repositories.closeIssue).toHaveBeenCalledWith(requester, 'c', '42', { confirmed: true, expectedRevision: 'head-1' });
  f.repositories.closeIssue.mockReturnValueOnce({ issue: { ...issue, state: 'open' as 'closed' } });
  const unconfirmed = await app.inject({
    method: 'POST', url: '/api/connections/c/issues/42/close', headers, payload: { confirmed: true },
  });
  expect(unconfirmed.statusCode).toBe(500);
  const receipt = '/api/operations/remove-one';
  expect((await app.inject({ url: receipt, headers: { cookie } })).json().state).toBe('completed');
  f.identity.resolveRequester.mockReturnValueOnce({ id: 'other-user' });
  f.operations.read.mockImplementationOnce(() => { throw new ApiFailure('NOT_FOUND'); });
  expect((await app.inject({ url: receipt, headers: { cookie } })).statusCode).toBe(404);
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
  expect(logout.statusCode).toBe(204);
  expect(logout.headers['set-cookie']).toContain('factory_session=');
  expect(f.identity.logout).toHaveBeenCalledWith(requester, 'session-one');
  expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers, payload: {} })).statusCode).toBe(204);
});

it('never leaks invalid output, invalid receipts, or upstream error strings', async () => {
  const f = fixtures();
  const app = await server(f);
  f.tasks.activeSessions.mockReturnValueOnce({ ...empty, providerToken: 'secret-value' } as typeof empty);
  const response = await app.inject({ url: '/api/active-sessions', headers: { cookie, 'request-id': 'secret-id' } });
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toMatch(/secret/);
  f.tasks.start.mockReturnValueOnce({ taskId: '../escape', state: 'queued' });
  expect((await app.inject({ method: 'POST', url: '/api/connections/c/tasks', headers, payload: startBody })).headers.location).toBeUndefined();
  f.tasks.start.mockReturnValueOnce(JSON.parse('{"operationId":"wrong-kind"}'));
  const wrongKind = await app.inject({ method: 'POST', url: '/api/connections/c/tasks', headers, payload: startBody });
  expect(wrongKind.statusCode).toBe(500);
  expect(wrongKind.headers.location).toBeUndefined();
  f.tasks.activeSessions.mockImplementationOnce(() => { throw new ApiFailure('RATE_LIMITED', 17); });
  const rate = await app.inject({ url: '/api/active-sessions', headers: { cookie } });
  expect(rate.statusCode).toBe(429);
  expect(rate.headers['retry-after']).toBe('17');
  f.tasks.activeSessions.mockImplementationOnce(() => { throw new Error('upstream secret'); });
  expect((await app.inject({ url: '/api/active-sessions', headers: { cookie } })).body).not.toContain('upstream');
  const prototype = await app.inject({
    method: 'POST', url: '/api/connections/c/tasks', headers: { ...headers, 'content-type': 'application/json' },
    payload: '{"startRequestId":"r","workItemKey":"42","copilotAccountId":"c","__proto__":{"requesterId":"someone"}}',
  });
  expect(prototype.statusCode).toBe(400);
  expect(prototype.json().code).toBe('INVALID_REQUEST');
});
