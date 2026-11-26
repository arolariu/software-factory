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
  const forbidden = () => { throw new Error('Unexpected fixture access'); };
  const hosts = [{ id: 'enterprise-one', label: 'Enterprise', hostname: 'tenant.ghe.com' }];
  const identity = {
    resolveRequester: vi.fn((sessionId: string) => sessionId === 'session-one' ? requester : null),
    csrf: vi.fn(() => ({ csrfToken: 'test-token', sessionId: 'anonymous-one' })),
    verifyCsrf: vi.fn((sessionId: string, token: string) => sessionId === 'session-one' && token === 'test-token'),
    githubHosts: vi.fn(() => hosts),
    me: vi.fn(() => ({ user: { id: requester.id, displayName: 'User', avatarUrl: null }, accounts: [] })),
    beginAuthorization: vi.fn(() => ({ authorizationUrl: 'https://github.com/login/oauth/authorize?state=state-one' })),
    completeAuthorization: vi.fn(() => ({ redirectTo: '/settings/copilot' })),
    logout: vi.fn(() => undefined),
    copilotAccounts: vi.fn(() => ({ items: [], defaultAccountId: null })),
    setDefaultCopilotAccount: vi.fn(() => undefined),
  };
  const repositories = {
    connections: vi.fn(() => ({ items: [] })),
    issues: vi.fn(() => ({ freshness: 'not_synced' as const, items: null, nextCursor: null, fetchedAt: null })),
    issue: vi.fn(forbidden),
    pullRequests: vi.fn(() => ({ freshness: 'unavailable' as const, items: null, nextCursor: null, fetchedAt: null })),
    checks: vi.fn(() => ({
      headRevision: 'head-1', availability: { available: false as const, reasonCode: 'UNVERIFIED' },
      passed: null, total: null, items: null,
    })),
  };
  const tasks = {
    activeSessions: vi.fn(() => empty),
    tasks: vi.fn(() => ({ items: [], nextCursor: null })),
    unlinkedSessions: vi.fn(() => ({ availability: { available: true as const }, items: [], nextCursor: null })),
    task: vi.fn(() => { throw new ApiFailure('NOT_FOUND'); }),
    activity: vi.fn(() => ({ availability: { available: true as const }, items: [], nextCursor: null })),
    options: vi.fn(forbidden),
    statistics: vi.fn(() => ({
      activeTasks: 0, completed: 0, stopped: 0, failed: 0, draftPrs: 0,
      credits: { measured: null, unmeasuredTasks: 0 }, repositories: [], weekly: [],
    })),
  };
  const operations = { read: vi.fn(forbidden) };
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

it('leaves production unconfigured and never serves SPA content for missing API or auth routes', async () => {
  const app = await server();
  expect((await app.inject('/api/auth/github/hosts')).statusCode).toBe(503);
  expect((await app.inject('/api/active-sessions')).statusCode).toBe(401);
  for (const url of ['/api/missing', '/auth/github/missing']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  }
});
