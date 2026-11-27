import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
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
  const management = openManagementRuntime(db, root, origin);
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
    management.close();
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
    expect(() => openManagementRuntime(db, root, 'https://factory.example')).toThrow('populated legacy instance');
    expect(() => openManagementRuntime(db, root, 'http://factory.example')).toThrow('canonical HTTPS');
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});
