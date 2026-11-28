import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRegistry } from '../identity/github-hosts.js';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { rebindManagedOwner } from './owner-rebind.js';
import { openManagementRuntime } from './runtime.js';
import { runCli, startServer } from '../main.js';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

const origin = 'https://factory.example';
const binding = (clientId: string) => createRegistry([
  { hostname: 'github.com', label: 'GitHub', deviceClientId: clientId },
]).registration('github.com', 'portal').binding;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'factory-rebind-'));
  const db = openDatabase(join(directory, 'factory.sqlite'));
  migrate(db);
  db.prepare('INSERT INTO management_owner VALUES (1,?,?,?,?)')
    .run('github', 'github.com', '42', binding('old-app'));
  db.exec(`INSERT INTO users VALUES ('owner');
    INSERT INTO identities (id,user_id,provider,issuer,subject) VALUES ('identity','owner','github','portal:github.com','42')`);
  db.prepare('INSERT INTO portal_sessions VALUES (?,?,?,?,?,?,?)')
    .run('session','csrf','owner','identity','github.com', binding('old-app'), Date.now() + 60_000);
  const readBinding = () => db.prepare('SELECT registration_id FROM management_owner').pluck().get();
  const close = () => { db.close(); rmSync(directory, { recursive: true }); };
  return { directory, db, readBinding, close };
}

it('rebinds the existing owner only after fresh approval of the replacement app', async () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO portal_sessions VALUES (?,?,?,?,?,?,?)')
      .run('anonymous','csrf',null,null,null,null,Date.now() + 60_000);
    f.db.prepare('INSERT INTO management_flows VALUES (?,?,?,?,?,?,?,?)')
      .run('old-flow','anonymous','ready',JSON.stringify({ host: 'github.com', binding: binding('old-app') }),
        'vault-ref',Date.now() + 60_000,0,5000);
    const approve = vi.fn(async () => '42');
    await rebindManagedOwner(f.directory, origin, 'old-app', 'new-app', true, vi.fn(), approve);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'new-app' }), expect.any(Function));
    expect(f.readBinding()).toBe(binding('new-app'));
    expect(f.db.prepare('SELECT count(*) AS n FROM portal_sessions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT expires_at,credential_ref FROM management_flows').get())
      .toEqual({ expires_at: 0, credential_ref: 'vault-ref' });
    expect(f.db.prepare('SELECT actor,action FROM management_audit').get()).toEqual({ actor: 'owner', action: 'GITHUB_OWNER_REBOUND' });
    expect(() => openManagementRuntime(f.db, f.directory, { publicOrigin: origin, githubClientId: 'old-app' })).toThrow('does not match');
    const restarted = openManagementRuntime(f.db, f.directory, { publicOrigin: origin, githubClientId: 'new-app' });
    await restarted.close();
  } finally { f.close(); }
});

it('holds exclusive ownership through approval and rejects rebind against a running server', async () => {
  const f = fixture();
  const artifactDir = join(f.directory, 'dist');
  mkdirSync(join(artifactDir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(artifactDir, 'web', 'index.html'), '<main>Portal</main>');
  writeFileSync(join(artifactDir, 'build.json'), '{"revision":null,"builtAt":null,"runUrl":null}');
  const start = () => startServer({ dataDir: f.directory, artifactDir, port: 0 });
  const approve = vi.fn(async () => '42');
  try {
    const server = await start();
    try { await expect(rebindManagedOwner(f.directory, origin, 'old-app', 'new-app', true, vi.fn(), approve)).rejects.toThrow('already in use'); }
    finally { await server.close(); }
    expect(approve).not.toHaveBeenCalled();
    await rebindManagedOwner(f.directory, origin, 'old-app', 'new-app', true, vi.fn(), async () => {
      await expect(start()).rejects.toThrow('already in use');
      return '42';
    });
    await (await start()).close();
  } finally { f.close(); }
});

it('does not rebind when the provider account or original operator configuration does not match', async () => {
  const f = fixture();
  try {
    const approve = vi.fn(async () => 'different-account');
    const run = (current: string, terminal = true) => rebindManagedOwner(f.directory, origin, current, 'new-app', terminal, vi.fn(), approve);
    await expect(run('old-app', false)).rejects.toThrow('interactive');
    await expect(rebindManagedOwner(f.directory, 'http://factory.example', 'old-app', 'new-app', true, vi.fn(), approve)).rejects.toThrow('HTTPS');
    await expect(rebindManagedOwner(f.directory, origin, 'old-app', 'old-app', true, vi.fn(), approve)).rejects.toThrow('different replacement');
    await expect(rebindManagedOwner(join(f.directory, 'missing'), origin, 'old-app', 'new-app', true, vi.fn(), approve)).rejects.toThrow('existing, stopped');
    await expect(run('other-app')).rejects.toThrow('current');
    expect(approve).not.toHaveBeenCalled();
    await expect(run('old-app')).rejects.toThrow('existing owner');
    expect(f.readBinding()).toBe(binding('old-app'));
  } finally { f.close(); }
});

it('verifies the GitHub identity with the replacement device grant before switching', async () => {
  const f = fixture();
  const wire = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      device_code: 'fixture-device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1,
    }))
    .mockResolvedValueOnce(Response.json({ error: 'slow_down' }))
    .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }))
    .mockResolvedValueOnce(Response.json({ access_token: 'ghu_fixture', refresh_token: 'fixture-refresh', expires_in: 600, token_type: 'bearer' }))
    .mockResolvedValueOnce(Response.json({ id: 42, login: 'owner' }));
  vi.stubGlobal('fetch', wire);
  try {
    const show = vi.fn();
    await rebindManagedOwner(f.directory, origin, 'old-app', 'new-app', true, show);
    expect(f.readBinding()).toBe(binding('new-app'));
    expect(wire.mock.calls.map(([url]) => url)).toEqual([
      'https://github.com/login/device/code', 'https://github.com/login/oauth/access_token',
      'https://github.com/login/oauth/access_token', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user',
    ]);
    expect(show).toHaveBeenCalledExactlyOnceWith('Open https://github.com/login/device and enter ABCD-EFGH.');
  } finally { vi.unstubAllGlobals(); f.close(); }
});

it.each([
  ['access_denied', 'denied replacement authorization'], ['expired_token', 'approval expired'],
] as const)('leaves the owner unchanged when GitHub reports %s', async (error, message) => {
  const f = fixture();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      device_code: 'fixture-device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1,
    }))
    .mockResolvedValueOnce(Response.json({ error })));
  try {
    await expect(rebindManagedOwner(f.directory, origin, 'old-app', 'new-app', true, vi.fn())).rejects.toThrow(message);
    expect(f.readBinding()).toBe(binding('old-app'));
  } finally { vi.unstubAllGlobals(); f.close(); }
});

it('rejects rebind from the CLI outside managed mode or without a terminal', async () => {
  const exitCode = process.exitCode;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const argv = ['node', 'factory', 'rebind-github-app'];
  try {
    await runCli({}, argv);
    expect(error.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Owner rebind requires management mode.' });
    await runCli({ FACTORY_MANAGEMENT_MODE: '1', FACTORY_IDENTITY_CONFIG_FILE: 'legacy' }, argv);
    expect(error.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Owner rebind requires management mode.' });
    await runCli({ FACTORY_MANAGEMENT_MODE: '1' }, argv);
    expect(error.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Owner rebind requires an interactive operator terminal.' });
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = exitCode; error.mockRestore(); }
});

it('does not overwrite a successful concurrent owner rebind', async () => {
  const f = fixture();
  try {
    await expect(rebindManagedOwner(f.directory, origin, 'old-app', 'new-app', true, vi.fn(), async () => {
      f.db.prepare('UPDATE management_owner SET registration_id=?').run(binding('winner'));
      return '42';
    })).rejects.toThrow('changed');
    expect(f.readBinding()).toBe(binding('winner'));
  } finally { f.close(); }
});
