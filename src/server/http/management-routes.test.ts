import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../build-app.js';
import { issueOperatorCode } from '../management/operator.js';
import { openManagementRuntime } from '../management/runtime.js';
import { createManagementSettings } from '../management/settings.js';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';

it('hosts credential-free setup, accepts only a same-origin pre-session, and has no remote code issuer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-management-http-'));
  const db = openDatabase(join(root, 'factory.sqlite'));
  migrate(db);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<main>Fixture</main>');
  const origin = 'https://factory.example';
  const management = openManagementRuntime(db, root, { publicOrigin: origin });
  const app = await buildApp({
    db, management, staticRoot: root, build: { revision: null, builtAt: null, runUrl: null },
  });
  try {
    expect((await app.inject('/api/setup/status')).json()).toEqual({
      state: 'unclaimed', pairingAvailable: true, paired: false, signInAvailable: false,
    });
    expect((await app.inject({ method: 'POST', url: '/api/setup/code' })).statusCode).toBe(404);
    expect(() => issueOperatorCode(root, origin, false)).toThrow('interactive operator terminal');
    const { code } = issueOperatorCode(root, origin, true);
    const pre = await app.inject('/api/auth/csrf');
    const cookie = String(pre.headers['set-cookie']).split(';')[0] ?? '';
    const csrf = pre.json().csrfToken as string;
    expect((await app.inject({ url: '/api/auth/csrf', headers: { cookie } })).json().csrfToken).toBe(csrf);
    expect(() => issueOperatorCode(join(root, 'missing'), origin, true)).toThrow('Start the Factory instance');
    const pair = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/setup/pair', headers, payload: { code } });
    expect((await pair({ cookie, origin: 'https://other.example', 'x-csrf-token': csrf })).statusCode).toBe(403);
    expect((await pair({ cookie, origin, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await pair({ origin, 'x-csrf-token': csrf })).statusCode).toBe(403);
    expect((await pair({ cookie, origin, 'x-csrf-token': csrf })).statusCode).toBe(204);
    expect((await pair({ cookie, origin, 'x-csrf-token': csrf })).json().code).toBe('SETUP_CODE_INVALID');
    expect((await app.inject({ url: '/setup', headers: { accept: 'text/html' } })).body).toContain('Fixture');
  } finally {
    await app.close();
    await management.close();
    db.close();
    rmSync(root, { recursive: true });
  }
});

it('refuses management takeover of a populated legacy database or an unsafe public origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-legacy-'));
  const db = openDatabase(join(root, 'legacy.sqlite'));
  try {
    migrate(db);
    db.exec("INSERT INTO users VALUES ('legacy')");
    expect(() => openManagementRuntime(db, root, { publicOrigin: 'https://factory.example' })).toThrow('populated legacy instance');
    expect(() => openManagementRuntime(db, root, { publicOrigin: 'http://factory.example' })).toThrow('canonical HTTPS');
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});

it('claims only via the initiating browser and completes verified GitHub repository authorization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-device-http-'));
  const db = openDatabase(join(root, 'factory.sqlite'));
  migrate(db);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<main>Fixture</main>');
  const origin = 'https://factory.example';
  const wire = vi.fn<typeof fetch>();
  const device = () => Response.json({
    device_code: 'private-device-fixture', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device',
    expires_in: 900, interval: 5,
  });
  const token = () => Response.json({
    access_token: 'ghu_fixture', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600,
  });
  const profile = () => Response.json({ id: 42, login: 'owner' });
  wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(Response.json({ error: 'slow_down' }))
    .mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(profile())
    .mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(profile())
    .mockResolvedValueOnce(Response.json({ id: 99, name: 'repo', owner: { id: 12, login: 'org' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{
      id: 11, account: { id: 12 }, permissions: { issues: 'read', pull_requests: 'read' },
    }] }))
    .mockResolvedValueOnce(Response.json({ repositories: [{ id: 99 }] }));
  const management = openManagementRuntime(db, root, {
    publicOrigin: origin, githubPortalClientId: 'portal-client', githubRepositoryClientId: 'repo-client',
  }, wire);
  const authorization = management.authorization;
  if (!authorization || !management.portal) throw new Error('Missing management service');
  const app = await buildApp({
    db, management, portal: management.portal, staticRoot: root, build: { revision: null, builtAt: null, runUrl: null },
  });
  const init = async () => {
    const response = await app.inject('/api/auth/csrf');
    return {
      cookie: String(response.headers['set-cookie']).split(';')[0] ?? '',
      origin, 'x-csrf-token': response.json().csrfToken as string,
    };
  };
  const signIn = { intent: 'sign_in', hostId: 'github.com' };
  const start = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'POST', url: '/api/authorization/flows', headers, payload });
  const due = async (id: string) => {
    db.prepare('UPDATE management_flows SET next_poll=0 WHERE id=?').run(id);
    await authorization.pollNext();
  };
  try {
    const headers = await init();
    const foreign = await init();
    expect((await start(headers, signIn)).statusCode).toBe(400);
    const code = management.setup.issueCode().code;
    expect((await app.inject({ method: 'POST', url: '/api/setup/pair', headers, payload: { code } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/setup/status', headers })).json().paired).toBe(true);
    const response = await start(headers, signIn);
    expect(response.statusCode).toBe(200);
    expect((await start(headers, signIn)).json().code).toBe('AUTH_FLOW_ACTIVE');
    expect(response.body).not.toContain('private-device');
    const id = response.json().flowId as string;
    const path = `/api/authorization/flows/${id}`;
    const active = await app.inject({ url: '/api/authorization/flows', headers });
    expect(active.json().flow.browserInstructions.userCode).toBe('ABCD-EFGH');
    expect(active.body).not.toContain('private-device-fixture');
    expect((await app.inject({ url: '/api/authorization/flows', headers: foreign })).json()).toEqual({ flow: null });
    expect((await app.inject({ url: path, headers: foreign })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${path}/complete`, headers })).statusCode).toBe(409);
    await authorization.pollNext();
    expect(wire).toHaveBeenCalledTimes(1);
    await due(id);
    expect(db.prepare('SELECT interval_ms FROM management_flows WHERE id=?').get(id)).toEqual({ interval_ms: 10000 });
    await due(id);
    expect((await app.inject({ url: path, headers })).json()).toEqual({ state: 'pending' });
    const checkpoint = wire.mock.calls.length;
    await due(id);
    expect(wire.mock.calls.slice(checkpoint).map(([url]) => url)).toEqual(['https://api.github.com/user']);
    expect((await app.inject({ url: path, headers })).json()).toEqual({ state: 'ready' });
    expect(management.setup.owner()).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: `${path}/complete`, headers: foreign })).statusCode).toBe(404);
    const completion = await app.inject({ method: 'POST', url: `${path}/complete`, headers });
    expect(completion.statusCode).toBe(204);
    expect(completion.body).toBe('');
    expect(management.setup.owner()?.subject).toBe('42');
    expect((await app.inject({ method: 'POST', url: `${path}/complete`, headers })).statusCode).toBe(403);
    const cookie = String(completion.headers['set-cookie']).split(';')[0] ?? '';
    const csrf = (await app.inject({ url: '/api/auth/csrf', headers: { cookie } })).json().csrfToken as string;
    const signed = { cookie, origin, 'x-csrf-token': csrf };
    expect((await app.inject({ url: '/api/me', headers: signed })).statusCode).toBe(200);
    expect((await app.inject('/api/settings/instance')).statusCode).toBe(401);
    const update = (version: number, repositoryEnabled: boolean) => app.inject({
      method: 'PUT', url: '/api/settings/instance', headers: signed, payload: { version, repositoryEnabled },
    });
    const info = await app.inject({ url: '/api/settings/instance', headers: signed });
    expect(info.json()).toMatchObject({ version: 0, repositoryEnabled: true });
    expect(info.body).not.toContain('ghu_');
    expect((await update(0, false)).statusCode).toBe(200);
    expect((await update(0, true)).statusCode).toBe(409);
    expect((await start(signed, { intent: 'connect', repositoryUrl: 'https://github.com/org/repo' })).statusCode).toBe(409);
    expect((await update(1, true)).statusCode).toBe(200);
    const owner = await management.portal.modules.identity.resolveRequester(cookie.split('=')[1] ?? '');
    if (!owner) throw new Error('Expected signed in owner');
    expect(() => management.settings?.read({ id: 'another-user' })).toThrow('ACCESS_DENIED');
    const noRepo = createManagementSettings(db, 'portal-client');
    expect(noRepo.read(owner).repositoryClientId).toBeNull();
    expect(() => noRepo.update(owner, { version: 2, repositoryEnabled: true })).toThrow('CAPABILITY_UNAVAILABLE');
    expect((await app.inject({ url: '/api/settings/instance', headers: foreign })).statusCode).toBe(401);
    expect((await start(signed, { intent: 'link_copilot', hostId: 'github.com' })).statusCode).toBe(409);
    const repo = await start(signed, { intent: 'connect', repositoryUrl: 'https://github.com/org/repo' });
    const repoId = repo.json().flowId as string;
    await due(repoId);
    expect((await app.inject({ method: 'POST', url: `/api/authorization/flows/${repoId}/complete`, headers: signed })).statusCode).toBe(204);
    const connection = (await app.inject({ url: '/api/connections', headers: signed })).json().items[0];
    expect(connection.repositoryUrl).toBe('https://github.com/org/repo');
    expect((await app.inject({ url: `/api/connections/${connection.id}/issues?state=open`, headers: signed })).statusCode).toBe(200);
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(profile());
    const secondPre = await init();
    const second = await start(secondPre, signIn);
    const secondId = second.json().flowId as string;
    await due(secondId);
    const secondLogin = await app.inject({ method: 'POST', url: `/api/authorization/flows/${secondId}/complete`, headers: secondPre });
    expect(secondLogin.statusCode).toBe(204);
    const secondCookie = String(secondLogin.headers['set-cookie']).split(';')[0] ?? '';
    const secondCsrf = (await app.inject({ url: '/api/auth/csrf', headers: { cookie: secondCookie } })).json().csrfToken as string;
    const secondSession = { cookie: secondCookie, origin, 'x-csrf-token': secondCsrf };
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(profile())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const unrelated = await start(signed, { intent: 'connect', repositoryUrl: 'https://github.com/org/other' });
    const unrelatedId = unrelated.json().flowId as string;
    await due(unrelatedId);
    expect((await app.inject({ url: `/api/authorization/flows/${unrelatedId}`, headers: signed })).json().state).toBe('failed');
    expect((await app.inject({ url: `/api/connections/${connection.id}/issues?state=open`, headers: signed })).statusCode).toBe(200);
    for (const stop of ['cancel', 'expire', 'logout', 'cancel-success'] as const) {
      const headers = stop === 'logout' ? secondSession : signed;
      const started = Promise.withResolvers<void>();
      const provider = Promise.withResolvers<Response>();
      wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(profile())
        .mockImplementationOnce(() => { started.resolve(); return provider.promise; });
      const success = stop === 'cancel-success';
      if (success) {
        wire.mockResolvedValueOnce(Response.json({ installations: [{
          id: 11, account: { id: 12 }, permissions: { issues: 'read', pull_requests: 'read' },
        }] })).mockResolvedValueOnce(Response.json({ repositories: [{ id: 99 }] }));
      }
      const reconnect = await start(headers, { intent: 'reconnect', connectionId: connection.id });
      expect(reconnect.statusCode).toBe(200);
      const flowId = reconnect.json().flowId as string;
      const flowPath = `/api/authorization/flows/${flowId}`;
      const polling = due(flowId);
      await started.promise;
      try {
        if (stop === 'cancel' || success) {
          expect((await app.inject({ method: 'DELETE', url: flowPath, headers })).statusCode).toBe(204);
        } else if (stop === 'expire') {
          db.prepare('UPDATE management_flows SET expires_at=? WHERE id=?').run(Date.now() - 1, flowId);
        } else {
          expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(204);
        }
      } finally {
        provider.resolve(success ? Response.json({ id: 99, name: 'repo', owner: { id: 12, login: 'org' } })
          : new Response(null, { status: 404 }));
        await polling;
      }
      if (stop === 'cancel' || success) expect((await app.inject({ url: flowPath, headers })).json().state).toBe('cancelled');
      expect((await app.inject({
        url: `/api/connections/${connection.id}/issues?state=open`, headers: signed,
      })).statusCode, stop).toBe(200);
    }
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(profile())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const revoke = await start(signed, { intent: 'reconnect', connectionId: connection.id });
    await due(revoke.json().flowId);
    expect((await app.inject({ url: `/api/connections/${connection.id}/issues?state=open`, headers: signed })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'DELETE', url: `/api/connections/${connection.id}/authorization`, headers: signed,
    })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/connections/${connection.id}/issues?state=open`, headers: signed })).statusCode).toBe(403);
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }));
    const reconnect = await start(signed, { intent: 'reconnect', connectionId: connection.id });
    const reconnectId = reconnect.json().flowId as string;
    await due(reconnectId);
    const reconnectPath = `/api/authorization/flows/${reconnectId}`;
    expect((await app.inject({ url: reconnectPath, headers: signed })).json().state).toBe('pending');
    expect((await app.inject({ method: 'DELETE', url: reconnectPath, headers: foreign })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: reconnectPath, headers: signed })).statusCode).toBe(204);
    expect((await app.inject({ url: reconnectPath, headers: signed })).json().state).toBe('cancelled');
    wire.mockResolvedValueOnce(device());
    const expired = await start(signed, { intent: 'reconnect', connectionId: connection.id });
    db.prepare('UPDATE management_flows SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.json().flowId);
    const calls = wire.mock.calls.length;
    await authorization.pollNext();
    expect(wire.mock.calls).toHaveLength(calls);
    expect((await app.inject({ url: `/api/authorization/flows/${expired.json().flowId}`, headers: signed })).json().state).toBe('expired');
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(Response.json({ error: 'access_denied' }));
    const denied = await start(signed, { intent: 'reconnect', connectionId: connection.id });
    await due(denied.json().flowId);
    expect((await app.inject({ url: `/api/authorization/flows/${denied.json().flowId}`, headers: signed })).json().state).toBe('failed');
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    const limited = await start(signed, { intent: 'reconnect', connectionId: connection.id });
    const limitedId = limited.json().flowId as string;
    await due(limitedId);
    expect(db.prepare('SELECT interval_ms FROM management_flows WHERE id=?').get(limitedId)).toEqual({ interval_ms: 10_000 });
    await due(limitedId);
    expect((await app.inject({ url: `/api/authorization/flows/${limitedId}`, headers: signed })).json().state).toBe('failed');
    wire.mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ id: 77, login: 'other' }));
    const afterClaim = await start(foreign, signIn);
    await due(afterClaim.json().flowId);
    expect((await app.inject({ method: 'POST', url: `/api/authorization/flows/${afterClaim.json().flowId}/complete`, headers: foreign }))
      .statusCode).toBe(403);
    expect(management.setup.owner()?.subject).toBe('42');
    for (let index = 0; index < 3; index++) {
      wire.mockResolvedValueOnce(device());
      expect((await start(await init(), signIn)).statusCode).toBe(200);
    }
    const beforeLimit = wire.mock.calls.length;
    expect((await start(await init(), signIn)).statusCode).toBe(429);
    expect(wire).toHaveBeenCalledTimes(beforeLimit);
    wire.mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(device()).mockResolvedValueOnce(token()).mockResolvedValueOnce(profile());
    expect((await start(signed, signIn)).statusCode).toBe(502);
    const relogin = await start(signed, signIn);
    expect(relogin.statusCode).toBe(200);
    await due(relogin.json().flowId);
    expect((await app.inject({
      method: 'POST', url: `/api/authorization/flows/${relogin.json().flowId}/complete`, headers: signed,
    })).statusCode).toBe(204);
    expect(management.setup.owner()?.subject).toBe('42');
  } finally {
    await app.close();
    await management.close();
    db.close();
    rmSync(root, { recursive: true });
  }
});

it('polls a durable flow in its worker and does not poll after it stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-device-worker-'));
  const db = openDatabase(join(root, 'factory.sqlite'));
  migrate(db);
  const wire = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    device_code: 'private-worker-fixture', user_code: 'ABCD-EFGH',
    verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
  })).mockResolvedValueOnce(Response.json({ error: 'expired_token' }));
  const management = openManagementRuntime(db, root, {
    publicOrigin: 'https://factory.example', githubPortalClientId: 'portal-client',
  }, wire);
  const { sessionId } = management.setup.preSession();
  if (!sessionId || !management.authorization) throw new Error('Expected initial session');
  try {
    management.setup.pair(sessionId, management.setup.issueCode().code);
    const flow = await management.authorization.start(sessionId, { intent: 'sign_in', hostId: 'github.com' });
    db.prepare('UPDATE management_flows SET next_poll=0 WHERE id=?').run(flow.flowId);
    management.start();
    await vi.waitFor(() => {
      expect(management.authorization?.status(sessionId, flow.flowId).state).toBe('expired');
    }, { timeout: 2500 });
    expect(wire).toHaveBeenCalledTimes(2);
  } finally {
    await management.close();
    db.close();
    rmSync(root, { recursive: true });
  }
});
