import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../build-app.js';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { createConfiguredPortal, openIdentityPortal } from './portal.js';
import type { StartClaim } from '../persistence/task-start.js';
import type { ApiDto } from '../../shared/api/schemas.js';
import { openCredentialVault } from './credentials.js';
import { createRegistry } from './github-hosts.js';

const origin = 'https://factory.example';

it('binds staged cloud dispatch to both real stored grants and the approved immutable repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-cloud-admission-'));
  const data = openDatabase(join(root, 'factory.sqlite'));
  migrate(data);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<main>Portal</main>');
  const registry = createRegistry([{
    hostname: 'github.com', label: 'GitHub', deviceClientId: 'staging-app', copilotEnabled: true,
  }]);
  const ownerId = '42';
  const repoId = '91';
  const repoUrl = 'https://github.com/me/disposable';
  let upstreamAccount = 42;
  let upstreamRepo = 91;
  let upstreamName = 'disposable';
  let upstreamTaskCreator = 42;
  let upstreamTerminalAt: string | undefined;
  let deferredStatus: Promise<Response> | undefined;
  const statusReads = vi.fn();
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const bearer = new Headers(init?.headers).get('authorization');
    const path = new URL(String(url)).pathname;
    expect(['Bearer ghu_repository', 'Bearer ghu_copilot']).toContain(bearer);
    if (path === '/user') {
      expect(bearer).toBe('Bearer ghu_copilot');
      return Response.json({ id: upstreamAccount, login: 'me' });
    }
    if (path === '/repos/me/disposable') {
      return Response.json({
        id: bearer === 'Bearer ghu_copilot' ? upstreamRepo : 91,
        name: bearer === 'Bearer ghu_copilot' ? upstreamName : 'disposable',
        owner: { id: 42, login: 'me' },
      });
    }
    if (path === '/user/installations') return Response.json({ installations: [{
      id: 13, account: { id: 42 }, permissions: { issues: 'read', pull_requests: 'read' },
    }] });
    if (path === '/user/installations/13/repositories') return Response.json({ repositories: [{ id: 91 }, { id: 92 }] });
    const remote = /^\/agents\/repos\/me\/disposable\/tasks\/([a-f0-9-]+)$/.exec(path)?.[1];
    if (remote) {
      expect(bearer).toBe('Bearer ghu_copilot');
      statusReads(remote);
      if (deferredStatus) return deferredStatus;
      return Response.json({
        id: remote, html_url: `https://github.com/me/disposable/copilot/tasks/${remote}`, state: 'completed',
        creator_type: 'user', creator: { id: upstreamTaskCreator }, owner: { id: 42 }, repository: { id: 91 },
        sessions: [{
          id: remote, task_id: remote, user: { id: 42 }, owner: { id: 42 }, repository: { id: 91 },
          usage: { type: 'premium_requests', amount: 0.125 }, prompt: 'Private provider transcript',
          state: 'completed', ...(upstreamTerminalAt && { completed_at: upstreamTerminalAt }),
        }],
      });
    }
    expect(bearer).toBe('Bearer ghu_repository');
    if (path.endsWith('/comments')) return Response.json([]);
    expect(path).toBe('/repositories/91/issues/17');
    return Response.json({
      number: 17, state: 'open', title: 'Update docs', user: null, body: 'Private fixture must not appear in the prompt',
      assignees: [], created_at: '2026-11-26T22:00:00.000Z', updated_at: '2026-11-26T22:00:00.000Z',
    });
  });
  const probe = vi.fn(async (_token: string, request: { requestedSessionId: string }) => ({
    sessionId: request.requestedSessionId, sessionUrl: `https://github.com/copilot/tasks/${request.requestedSessionId}`,
    usage: { nanoAiu: 0, premiumRequests: 0.125 },
  }));
  const inspect = vi.fn(async (_token: string) => ({
    models: [{ id: 'm1', name: 'Approved model', policy: 'enabled', reasoning: ['low', 'high'], defaultReasoning: 'high' }],
    quota: [],
  }));
  const auth = createConfiguredPortal(data, { origin, registry }, openCredentialVault(join(root, 'credentials.sqlite'), randomBytes(32)),
    randomBytes(32), transport, inspect, { approvedTarget: { repoId, ownerId }, probe });
  const server = await buildApp({ db: data, staticRoot: root, build: { revision: null, builtAt: null, runUrl: null }, portal: auth.portal });
  try {
    const identity = auth.identity;
    const pre = identity.csrf(undefined).sessionId!;
    const tokens = (purpose: string) => ({ accessToken: `ghu_${purpose}`, refreshToken: null, expiresAt: null });
    const person = (purpose: string) => ({ subject: ownerId, label: 'me', avatarUrl: null, tokens: tokens(purpose) });
    const signIn = identity.selectAuthorization('github', { intent: 'sign_in', hostId: 'github.com' }, pre, null);
    const signed = identity.persistAuthorization(pre, signIn.pending, signIn.registration, person('portal')).sessionId!;
    const principal = identity.resolveRequester(signed)!;
    const connect = identity.selectAuthorization('github', { intent: 'connect', repositoryUrl: repoUrl }, signed, principal);
    identity.persistAuthorization(signed, connect.pending, connect.registration, {
      ...person('repository'), repo: { id: repoId, scope: ownerId, name: 'disposable', host: 'github.com', url: repoUrl },
    });
    const link = identity.selectAuthorization('github', { intent: 'link_copilot', hostId: 'github.com' }, signed, principal);
    identity.persistAuthorization(signed, link.pending, link.registration, person('copilot'));
    const account = identity.copilotAccounts(principal).items[0]!;
    const connection = identity.connections(principal).items[0]!;
    const headers = { origin, cookie: `factory_session=${signed}`, 'x-csrf-token': identity.csrf(signed).csrfToken };
    const optionsUrl = `/api/connections/${connection.id}/task-options`;
    expect((await server.inject({ url: optionsUrl, headers })).json().launch.available).toBe(false);
    identity.setDefaultCopilotAccount(principal, account.id);
    expect((await server.inject({ url: optionsUrl, headers })).json().launch.available).toBe(true);
    expect(transport).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect((await server.inject({ url: `${optionsUrl}?includeModels=1`, headers })).json().models).toEqual({
      availability: { available: true }, items: [{ id: 'm1', name: 'Approved model', supportedEfforts: ['low', 'high'] }],
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith('ghu_copilot');
    const requestTask = () => server.inject({ method: 'POST', url: `/api/connections/${connection.id}/tasks`, headers,
      payload: { startRequestId: 'once', workItemKey: '17', copilotAccountId: account.id, overrides: { model: 'm1', reasoningEffort: 'high' } } });
    upstreamAccount = 43;
    expect((await requestTask()).json().code).toBe('ACCESS_UNVERIFIED');
    upstreamAccount = 42;
    upstreamRepo = 92;
    expect((await requestTask()).json().code).toBe('ACCESS_UNVERIFIED');
    upstreamRepo = 91;
    upstreamName = 'moved';
    expect((await requestTask()).json().code).toBe('ACCESS_UNVERIFIED');
    upstreamName = 'disposable';
    expect(data.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    transport.mockClear();
    inspect.mockClear();
    const accepted = await requestTask();
    expect(accepted.statusCode).toBe(202);
    expect(probe).not.toHaveBeenCalled();
    const location = String(accepted.headers.location);
    const statusPath = `${location}/cloud-status`;
    expect((await server.inject({ url: statusPath, headers })).json()).toEqual({ state: null });
    auth.start();
    await vi.waitFor(async () => {
      expect((await server.inject({ url: location, headers })).json()).toMatchObject({
        task: { state: 'running' }, sdkUsage: { nanoAiu: 0, premiumRequests: 0.125 },
        sessionUrl: expect.stringMatching(/^https:\/\/github\.com\/copilot\/tasks\/[a-f0-9-]+$/),
        cloudStatusAvailable: true,
      });
    }, { timeout: 3000 });
    expect(transport.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/user')).toHaveLength(2);
    expect(transport.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/repositories/91/issues/17')).toHaveLength(2);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect((await server.inject({ url: `/api/connections/${connection.id}/issues/17`, headers })).json()).toMatchObject({
      issue: { taskId: accepted.json().taskId, launch: { available: false } },
    });
    expect(statusReads).not.toHaveBeenCalled();
    expect((await server.inject(statusPath)).statusCode).toBe(401);
    expect((await server.inject({ url: '/api/tasks/unrelated/cloud-status', headers })).statusCode).toBe(404);
    const checked = await server.inject({ url: statusPath, headers });
    expect(checked.json()).toEqual({ state: 'completed', usage: { unit: 'premium_requests', amount: 0.125 } });
    expect(checked.headers['cache-control']).toBe('no-store');
    expect(statusReads).toHaveBeenCalledExactlyOnceWith(probe.mock.calls[0]?.[1].requestedSessionId);
    const record = (requestHeaders = headers, expectedState = 'completed') => server.inject({
      method: 'POST', url: `${location}/record-cloud-outcome`, headers: requestHeaders, payload: { expectedState },
    });
    expect((await record({ ...headers, origin: 'https://other.example' })).statusCode).toBe(403);
    expect((await record()).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    upstreamTaskCreator = 43;
    expect((await server.inject({ url: statusPath, headers })).json()).toEqual({ state: null });
    expect((await server.inject({ url: location, headers })).json().task.state).toBe('running');
    const pending = Promise.withResolvers<Response>();
    deferredStatus = pending.promise;
    const inFlight = record().then((response) => response);
    await vi.waitFor(() => expect(statusReads).toHaveBeenCalledTimes(4));
    data.prepare('UPDATE delegated_grants SET revoked_at=1 WHERE id=?').run(account.id);
    const id = probe.mock.calls[0]?.[1].requestedSessionId;
    pending.resolve(Response.json({
      id, html_url: `https://github.com/me/disposable/copilot/tasks/${id}`, state: 'completed',
      creator_type: 'user', creator: { id: 42 }, owner: { id: 42 }, repository: { id: 91 },
      sessions: [{ id, task_id: id, user: { id: 42 }, owner: { id: 42 }, repository: { id: 91 },
        state: 'completed', completed_at: new Date().toISOString() }],
    }));
    expect((await inFlight).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    expect((await server.inject({ url: statusPath, headers })).json()).toEqual({ state: null });
    expect(statusReads).toHaveBeenCalledTimes(4);
    expect((await server.inject({ url: location, headers })).json().task.state).toBe('running');
    data.prepare('UPDATE delegated_grants SET revoked_at=NULL WHERE id=?').run(account.id);
    deferredStatus = undefined;
    upstreamTaskCreator = 42;
    upstreamTerminalAt = '2000-01-01T00:00:00Z';
    expect((await record()).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    upstreamTerminalAt = '2099-01-01T00:00:00Z';
    expect((await record()).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    upstreamTerminalAt = new Date().toISOString();
    expect((await server.inject({ url: statusPath, headers })).json()).toMatchObject({ recordableOutcome: 'completed' });
    expect((await server.inject({ url: location, headers })).json().task.state).toBe('running');
    expect((await record(headers, 'failed')).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    const taskId = accepted.json().taskId as string;
    data.prepare(`INSERT INTO task_controls(id,task_id,request_id,request_hash,binding_hash,kind,state)
      VALUES ('pending-stop',?,'once','hash','binding','stop','needs_recovery')`).run(taskId);
    expect((await record()).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    data.exec("DELETE FROM task_controls WHERE id='pending-stop'");
    expect((await record()).json()).toEqual({ state: 'completed' });
    expect((await record()).json()).toEqual({ state: 'completed' });
    upstreamTerminalAt = new Date(Date.parse(upstreamTerminalAt) - 1).toISOString();
    expect((await record()).json().code).toBe('TASK_OUTCOME_UNVERIFIED');
    expect((await server.inject({ url: location, headers })).json()).toMatchObject({
      task: { state: 'completed' }, sdkUsage: { nanoAiu: 0, premiumRequests: 0.125 },
    });
    expect((await server.inject({ url: '/api/active-sessions', headers })).json().sessions).toEqual([]);
    expect(data.prepare('SELECT archived_at FROM tasks WHERE id=?').get(taskId)).toEqual({ archived_at: null });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe('ghu_copilot');
    expect(probe.mock.calls[0]?.[1]).toMatchObject({
      expectedLogin: 'me', repository: { owner: 'me', name: 'disposable' }, model: 'm1', reasoningEffort: 'high',
    });
    expect(JSON.stringify(probe.mock.calls[0]?.[1])).not.toContain('Private fixture');
  } finally {
    await server.close();
    await auth.close();
    data.close();
    rmSync(root, { recursive: true });
  }
});

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
    if (!enabled) expect((await server.inject({ url: '/api/tasks/fixture-task/cloud-status', headers })).json().code)
      .toBe('CAPABILITY_UNAVAILABLE');
    if (!enabled) expect((await server.inject({ method: 'POST', url: '/api/tasks/fixture-task/record-cloud-outcome', headers,
      payload: { expectedState: 'completed' } })).json().code)
      .toBe('CAPABILITY_UNAVAILABLE');
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
