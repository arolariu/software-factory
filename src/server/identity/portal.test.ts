import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../build-app.js';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { openIdentityPortal } from './portal.js';
import type { StartClaim } from '../persistence/task-start.js';
import type { ApiDto } from '../../shared/api/schemas.js';

const origin = 'https://factory.example';

it.each([false, true])('signs in, connects and syncs through the app (supervised runtime supplied: %s)', async (enabled) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-live-composition-'));
  const data = openDatabase(join(root, 'factory.sqlite'));
  migrate(data);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<main>Portal</main>');
  const configFile = join(root, 'config.json');
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, randomBytes(32));
  const app = (id: string) => ({ id, clientId: id, secret: 'local-fixture' });
  writeFileSync(configFile, JSON.stringify({
    publicOrigin: origin, github: [{
      hostname: 'github.com', label: 'GitHub', registrations: { portal: app('portal'), repository: app('repository') },
    }],
  }));
  const tokens = () => Response.json({ access_token: 'ghu_fixture', token_type: 'bearer' });
  const user = () => Response.json({ id: 42, login: 'me' });
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(tokens()).mockResolvedValueOnce(user())
    .mockResolvedValueOnce(tokens()).mockResolvedValueOnce(user())
    .mockResolvedValueOnce(Response.json({ id: 91, name: 'repo', owner: { id: 13, login: 'org' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{
      id: 21, account: { id: 13 }, permissions: { issues: 'read', pull_requests: 'read' },
    }] }))
    .mockResolvedValueOnce(Response.json({ repositories: [{ id: 91 }] }));
  const authorize = vi.fn(async () => {
    const stored = data.prepare<[], {
      connectionId: string; repoId: string; identityId: string; generation: number;
    }>('SELECT id AS connectionId,repo_id AS repoId,identity_id AS identityId,generation FROM repo_connections').get();
    return stored && { ...stored, scope: 'github.com:13:91' };
  });
  const launch = vi.fn(async (claim: Readonly<StartClaim>) => ({
    claim, sessionId: 'fixture-launch',
    usage: { aiCreditsStatus: 'complete', totalNanoAiu: 10 },
  }));
  const unavailable = { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' } as const;
  const taskOptions: ApiDto<'taskOptions'> = {
    copilotAccountId: 'approved-account', launch: { available: true }, featureBranch: unavailable,
    models: { availability: unavailable, items: [] },
  };
  const describe = vi.fn(() => taskOptions);
  const auth = openIdentityPortal(data, root, { configFile, keyFile }, transport, enabled ? { authorize, launch, describe } : undefined);
  const server = await buildApp({
    db: data, staticRoot: root, build: { revision: null, builtAt: null, runUrl: null }, portal: auth.portal,
  });
  try {
    const csrf = await server.inject('/api/auth/csrf');
    const signedCookie = (value: unknown) => String(value).split(';')[0] ?? '';
    const start = (cookie: string, csrfToken: string, payload: object) => server.inject({
      method: 'POST', url: '/api/auth/github/start', headers: { cookie, origin, 'x-csrf-token': csrfToken }, payload,
    });
    const callback = async (authorizationUrl: string, cookie: string) => {
      const state = new URL(authorizationUrl).searchParams.get('state');
      return server.inject({ url: `/auth/github/callback?state=${state}&code=verify`, headers: { cookie } });
    };
    const anon = signedCookie(csrf.headers['set-cookie']);
    const login = await start(anon, csrf.json().csrfToken, { intent: 'sign_in', hostId: 'github.com' });
    const signed = await callback(login.json().authorizationUrl, anon);
    expect(signed.statusCode).toBe(303);
    const cookie = signedCookie(signed.headers['set-cookie']);
    expect(cookie).not.toBe(anon);
    expect(cookie).not.toContain('ghu_');
    expect((await server.inject({ url: '/api/me', headers: { cookie } })).json().user.displayName).toBe('me');
    const signedCsrf = (await server.inject({ url: '/api/auth/csrf', headers: { cookie } })).json().csrfToken;
    const connect = await start(cookie, signedCsrf, { intent: 'connect', repositoryUrl: 'https://github.com/org/repo' });
    const connected = await callback(connect.json().authorizationUrl, cookie);
    expect(connected.headers.location).toBe('/settings/repository');
    expect(connected.headers['set-cookie']).toBeUndefined();
    const repo = (await server.inject({ url: '/api/connections', headers: { cookie } })).json().items[0];
    expect(repo.repositoryUrl).toBe('https://github.com/org/repo');
    const headers = { cookie, origin, 'x-csrf-token': signedCsrf };
    const options = await server.inject({ url: `/api/connections/${repo.id}/task-options`, headers });
    expect(options.statusCode).toBe(enabled ? 200 : 503);
    if (enabled) expect(options.json()).toEqual(taskOptions);
    expect((await server.inject({ url: '/api/connections/unknown/task-options', headers })).statusCode)
      .toBe(enabled ? 404 : 503);
    expect(describe).toHaveBeenCalledTimes(enabled ? 1 : 0);
    const stored = data.prepare<[string], { id: string; repo_id: string; user_id: string; identity_id: string }>(
      'SELECT id,repo_id,user_id,identity_id FROM repo_connections WHERE id=?',
    ).get(repo.id);
    if (!stored) throw new Error('Missing fixture connection');
    data.prepare(`INSERT INTO tasks (id,connection_id,repo_id,requester_id,repo_identity_id,copilot_identity_id,work_item_key,
      start_request_id,runtime_kind,runtime_scope,sdk_session_id,state,created_at,updated_at)
      VALUES ('fixture-task',?,?,?,?,?,'11','fixture-request','github_cloud','fixture','fixture-session','waiting_input',0,1)`)
      .run(stored.id, stored.repo_id, stored.user_id, stored.identity_id, stored.identity_id);
    data.exec(`INSERT INTO task_observations (task_id,title,session_state,observed_at,question_id,question_text)
      VALUES ('fixture-task','Review tests','waiting_input',${Date.now()},'question-one','Which suite?')`);
    expect((await server.inject({ url: '/api/active-sessions', headers })).json()).toMatchObject({
      sessions: [{ taskId: 'fixture-task', title: 'Review tests', state: 'waiting_input' }],
    });
    expect((await server.inject({ url: '/api/tasks/fixture-task', headers })).json()).toMatchObject({
      pendingQuestion: { id: 'question-one', text: 'Which suite?' },
    });
    expect((await server.inject({ url: '/api/statistics', headers })).json()).toMatchObject({
      activeTasks: 1, credits: { measured: null, unmeasuredTasks: 1 },
    });
    expect((await server.inject('/api/tasks/fixture-task')).statusCode).toBe(401);
    expect(transport).toHaveBeenCalledTimes(7);
    const attempt = (repoId: string, requestHeaders = headers) => server.inject({
      method: 'POST', url: `/api/connections/${repoId}/tasks`, headers: requestHeaders,
      payload: { workItemKey: '1', copilotAccountId: 'not-configured', startRequestId: 'request-one' },
    });
    expect((await attempt(repo.id, { ...headers, origin: 'https://other.example' })).statusCode).toBe(403);
    expect((await attempt('unknown')).json().code).toBe('NOT_FOUND');
    expect(authorize).not.toHaveBeenCalled();
    const launched = await attempt(repo.id);
    if (enabled) {
      expect(launched.statusCode).toBe(202);
      expect((await attempt(repo.id)).json()).toEqual(launched.json());
      expect(launch).not.toHaveBeenCalled();
    } else {
      expect(launched.json().code).toBe('CAPABILITY_UNAVAILABLE');
    }
    expect((await server.inject({ method: 'POST', url: '/api/tasks/unknown/archive', headers, payload: { confirmed: true } }))
      .json().code).toBe('NOT_FOUND');
    const issues = await server.inject({ url: `/api/connections/${repo.id}/issues?state=open`, headers });
    expect(issues.json().freshness).toBe('not_synced');
    const accepted = await server.inject({ method: 'POST', url: `/api/connections/${repo.id}/sync`, headers });
    expect(accepted.statusCode).toBe(202);
    expect(transport).toHaveBeenCalledTimes(7);
    const receipt = accepted.headers.location;
    if (typeof receipt !== 'string') throw new Error('Missing receipt');
    transport.mockResolvedValueOnce(Response.json({ id: 91, name: 'repo', owner: { id: 13, login: 'org' } }))
      .mockResolvedValueOnce(Response.json({ installations: [{
        id: 21, account: { id: 13 }, permissions: { issues: 'read', pull_requests: 'read' },
      }] }))
      .mockResolvedValueOnce(Response.json({ repositories: [{ id: 91 }] }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([]));
    auth.start();
    if (enabled) {
      const location = launched.headers.location;
      if (typeof location !== 'string') throw new Error('Missing task receipt');
      await vi.waitFor(async () => {
        expect((await server.inject({ url: location, headers })).json()).toMatchObject({
          task: { state: 'running' }, sdkUsage: { nanoAiu: 10, premiumRequests: null },
        });
      }, { timeout: 3000 });
      expect(launch).toHaveBeenCalledTimes(1);
    }
    await vi.waitFor(async () => {
      expect((await server.inject({ url: receipt, headers })).json().state).toBe('completed');
    }, { timeout: 3000 });
    const cached = await server.inject({ url: `/api/connections/${repo.id}/issues?state=open`, headers });
    expect(cached.json()).toMatchObject({ freshness: 'current', items: [] });
    expect(transport).toHaveBeenCalledTimes(12);

    transport.mockResolvedValueOnce(Response.json({
      number: 42, state: 'open', title: 'Document startup', user: null, body: '', assignees: [],
      created_at: '2026-11-26T22:00:00.000Z', updated_at: '2026-11-26T22:00:00.000Z',
    })).mockResolvedValueOnce(Response.json([]));
    const issueResponse = await server.inject({ url: `/api/connections/${repo.id}/issues/42`, headers });
    expect(issueResponse.json()).toMatchObject({ issue: { launch: { available: enabled } } });

    transport.mockResolvedValueOnce(new Response('', { status: 502 }));
    const outage = await server.inject({ method: 'POST', url: `/api/connections/${repo.id}/sync`, headers });
    const outageReceipt = outage.headers.location;
    if (typeof outageReceipt !== 'string') throw new Error('Missing outage receipt');
    await vi.waitFor(async () => {
      expect((await server.inject({ url: outageReceipt, headers })).json()).toMatchObject({
        state: 'failed', problemCode: 'PROVIDER_ERROR',
      });
    }, { timeout: 3000 });
    expect((await server.inject({ url: `/api/connections/${repo.id}/issues?state=open`, headers })).statusCode).toBe(200);

    transport.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect((await server.inject({ method: 'POST', url: `/api/connections/${repo.id}/sync`, headers })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect((await server.inject({ url: `/api/connections/${repo.id}/issues?state=open`, headers })).json().code).toBe('ACCESS_DENIED');
    }, { timeout: 3000 });
    if (enabled) {
      expect((await server.inject({ url: `/api/connections/${repo.id}/task-options`, headers })).json().code)
        .toBe('ACCESS_DENIED');
    }
  } finally {
    await server.close();
    await auth.close();
    data.close();
    rmSync(root, { recursive: true });
  }
});
