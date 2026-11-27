import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../build-app.js';
import { issueOperatorCode } from '../management/operator.js';
import { openManagementRuntime } from '../management/runtime.js';
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
      state: 'unclaimed', pairingAvailable: true, signInAvailable: false,
    });
    expect((await app.inject({ method: 'POST', url: '/api/setup/code' })).statusCode).toBe(404);
    expect(() => issueOperatorCode(root, origin, false)).toThrow('interactive operator terminal');
    const { code } = issueOperatorCode(root, origin, true);
    const pre = await app.inject('/api/auth/csrf');
    const cookie = String(pre.headers['set-cookie']).split(';')[0] ?? '';
    const csrf = pre.json().csrfToken as string;
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
    .mockResolvedValueOnce(token()).mockResolvedValueOnce(profile())
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
    const response = await start(headers, signIn);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-device');
    const id = response.json().flowId as string;
    const path = `/api/authorization/flows/${id}`;
    expect((await app.inject({ url: path, headers: foreign })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${path}/complete`, headers })).statusCode).toBe(409);
    await authorization.pollNext();
    expect(wire).toHaveBeenCalledTimes(1);
    await due(id);
    expect(db.prepare('SELECT interval_ms FROM management_flows WHERE id=?').get(id)).toEqual({ interval_ms: 10000 });
    await due(id);
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
    const repo = await start(signed, { intent: 'connect', repositoryUrl: 'https://github.com/org/repo' });
    const repoId = repo.json().flowId as string;
    await due(repoId);
    expect((await app.inject({ method: 'POST', url: `/api/authorization/flows/${repoId}/complete`, headers: signed })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/connections', headers: signed })).json().items[0].repositoryUrl).toBe('https://github.com/org/repo');
  } finally {
    await app.close();
    await management.close();
    db.close();
    rmSync(root, { recursive: true });
  }
});
