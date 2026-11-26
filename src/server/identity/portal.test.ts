import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../build-app.js';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { openIdentityPortal } from './portal.js';

const origin = 'https://factory.example';

it('signs in, connects and syncs read-only through the app, without enabling mutations', async () => {
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
  const auth = openIdentityPortal(data, root, { configFile, keyFile }, transport);
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
    const attempt = (repoId: string) => server.inject({
      method: 'POST', url: `/api/connections/${repoId}/tasks`, headers,
      payload: { workItemKey: '1', copilotAccountId: 'not-configured', startRequestId: 'request-one' },
    });
    expect((await attempt(repo.id)).json().code).toBe('CAPABILITY_UNAVAILABLE');
    expect((await attempt('unknown')).json().code).toBe('NOT_FOUND');
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
    await vi.waitFor(async () => {
      expect((await server.inject({ url: receipt, headers })).json().state).toBe('completed');
    }, { timeout: 3000 });
    const cached = await server.inject({ url: `/api/connections/${repo.id}/issues?state=open`, headers });
    expect(cached.json()).toMatchObject({ freshness: 'current', items: [] });
    expect(transport).toHaveBeenCalledTimes(12);

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
  } finally {
    await server.close();
    await auth.close();
    data.close();
    rmSync(root, { recursive: true });
  }
});
