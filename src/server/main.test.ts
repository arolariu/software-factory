import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCli, startServer, verifyContainerData } from './main.js';
import { openDatabase } from './persistence/open.js';
import { createSetupStore } from './management/setup.js';

let root: string;
let dataDir: string;
let artifactDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-start-'));
  dataDir = join(root, 'data');
  artifactDir = join(root, 'dist');
  mkdirSync(dataDir);
  mkdirSync(join(artifactDir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(artifactDir, 'web', 'index.html'), '<main>Portal</main>');
  writeFileSync(join(artifactDir, 'build.json'), '{"revision":null,"builtAt":null,"runUrl":null}');
});

afterEach(() => rmSync(root, { recursive: true }));

it('migrates before listening and releases the database on shutdown', async () => {
  const server = await startServer({ dataDir, artifactDir, port: 0 });
  try {
    const response = await fetch(`${server.address}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    await server.close();
  }
  await server.close();
  await expect(fetch(`${server.address}/healthz`)).rejects.toThrow();
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(10);
  } finally {
    db.close();
  }
});

it('rejects an invalid port, a file data location, and an ephemeral container location', async () => {
  await expect(startServer({ dataDir, artifactDir, port: 65536 })).rejects.toThrow('PORT');
  await expect(startServer({ dataDir, artifactDir, port: -1 })).rejects.toThrow('PORT');
  await expect(startServer({ dataDir: join(artifactDir, 'build.json'), artifactDir, port: 0 })).rejects.toThrow('directory');
  if (process.platform === 'linux') {
    await expect(startServer({ dataDir, artifactDir, port: 3000, container: true })).rejects.toThrow('private');
  }
});

it('refuses a version marker with a missing schema before binding a port', async () => {
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  db.pragma('user_version = 10');
  db.close();
  await expect(startServer({ dataDir, artifactDir, port: 0 })).rejects.toThrow('required schema objects');
});

it('refuses overlapping server listeners without disturbing the original', async () => {
  const first = await startServer({ dataDir, artifactDir, port: 0 });
  try {
    const port = Number(new URL(first.address).port);
    const otherDir = join(root, 'other');
    mkdirSync(otherDir);
    await expect(startServer({ dataDir: otherDir, artifactDir, port })).rejects.toThrow(/EADDRINUSE/);
    expect((await fetch(`${first.address}/healthz`)).ok).toBe(true);
  } finally {
    await first.close();
  }
});

const nativeKey = () => Buffer.alloc(32, 7);
const desktopOrigin = 'https://factory.localhost';
const desktop = { channelToken: 'ab'.repeat(32) };

it('serves desktop setup only on ephemeral IPv4 loopback and through the native channel', async () => {
  const server = await startServer({
    dataDir, artifactDir, port: 0, desktop, management: { publicOrigin: desktopOrigin, loadVaultKey: nativeKey },
  });
  try {
    const address = new URL(server.address);
    expect(address.hostname).toBe('127.0.0.1');
    expect(Number(address.port)).toBeGreaterThan(0);
    const channel = { 'x-factory-desktop-channel': desktop.channelToken };
    for (const [path, headers] of [
      ['/api/auth/csrf', {}],
      ['/api/setup/status', { 'x-factory-desktop-channel': '00'.repeat(32) }],
      ['/api/setup/status', { ...channel, origin: 'https://other.example' }],
    ] as const) {
      const denied = await fetch(new URL(path, address), { headers });
      expect(denied.status).toBe(404);
      expect(denied.headers.get('set-cookie')).toBeNull();
    }
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      get(new URL('/api/setup/status', address), { headers: { ...channel, host: 'factory.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(wrongHost).toBe(404);
    const allowed = await fetch(new URL('/api/setup/status', address), { headers: { ...channel, origin: desktopOrigin } });
    expect(await allowed.json()).toMatchObject({ state: 'unclaimed' });
  } finally {
    await server.close();
  }
});

it('rejects desktop startup with a fixed port, hosted identity, or no native key', async () => {
  const options = { dataDir, artifactDir, port: 0, desktop, management: { publicOrigin: desktopOrigin, loadVaultKey: nativeKey } };
  await expect(startServer({ ...options, port: 3000 })).rejects.toThrow('Desktop runtime');
  await expect(startServer({ ...options, container: true })).rejects.toThrow('Desktop runtime');
  await expect(startServer({ ...options, identity: { configFile: 'unused', keyFile: 'unused' } })).rejects.toThrow('Desktop runtime');
  await expect(startServer({ ...options, management: { publicOrigin: 'https://factory.example', loadVaultKey: nativeKey } }))
    .rejects.toThrow('Desktop runtime');
  await expect(startServer({ ...options, management: { publicOrigin: desktopOrigin } })).rejects.toThrow('Desktop runtime');
  await expect(startServer({ ...options, desktop: { channelToken: 'too short' } })).rejects.toThrow('Desktop runtime');
});

it('does not start a cloud trial against an existing Factory data directory', async () => {
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  db.close();
  await expect(startServer({
    dataDir, artifactDir, port: 0, cloudTrial: { repoId: '63', ownerId: '42' },
    management: {
      publicOrigin: 'https://factory-trial.localhost:3444', githubClientId: 'app',
      inspectCopilot: async () => ({ models: [], quota: [] }),
    },
  })).rejects.toThrow('empty data directory');
});

it('cannot combine loopback cloud trial startup with hosted, desktop or legacy modes', async () => {
  const managed = {
    publicOrigin: 'https://factory-trial.localhost:3444', githubClientId: 'app',
    inspectCopilot: async () => ({ models: [], quota: [] }),
  };
  const options = { dataDir, artifactDir, port: 0, cloudTrial: { repoId: '63', ownerId: '42' }, management: managed };
  await expect(startServer({ dataDir, artifactDir, port: 0, cloudTrial: options.cloudTrial }))
    .rejects.toThrow('Cloud trial requires isolated loopback');
  for (const override of [
    { port: 3444 }, { container: true }, { desktop, management: { ...managed, publicOrigin: desktopOrigin, loadVaultKey: nativeKey } },
    { identity: { configFile: 'config', keyFile: 'key' } }, { management: { publicOrigin: managed.publicOrigin } },
    { management: { publicOrigin: managed.publicOrigin, githubClientId: 'app' } },
    { management: { ...managed, publicOrigin: 'https://factory.example' } },
  ]) {
    await expect(startServer({ ...options, ...override })).rejects.toThrow('Cloud trial requires isolated loopback');
  }
});

it('requires an exact /data mount and private permissions for container storage', () => {
  const mount = '67 12 0:51 /factory /data rw - ext4 /dev/example rw';
  expect(() => verifyContainerData('/data', 0o700, mount)).not.toThrow();
  expect(() => verifyContainerData('/data', 0o755, mount)).toThrow('private');
  expect(() => verifyContainerData('/data', 0o700, mount.replace(' /data ', ' /data-other '))).toThrow('private');
  for (const filesystem of ['tmpfs', 'ramfs']) {
    expect(() => verifyContainerData('/data', 0o700, mount.replace('ext4', filesystem))).toThrow('private');
  }
});

it.each(['nfs', 'nfs4', 'cifs', 'fuse.sshfs'])('rejects container storage on %s before opening SQLite', (filesystem) => {
  const mount = `67 12 0:51 /factory /data rw - ${filesystem} storage.example:/factory rw`;
  expect(() => verifyContainerData('/data', 0o700, mount)).toThrow();
});

async function unusedPort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address();
  if (!port || typeof port === 'string') throw new Error('Expected a TCP port.');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return String(port.port);
}

it.each(['default', 'explicit'] as const)('starts the native CLI on loopback with the %s data directory', async (mode) => {
  rmdirSync(dataDir);
  const options: NodeJS.ProcessEnv = { PORT: await unusedPort() };
  const expected = mode === 'default' ? dataDir : join(root, 'chosen-data');
  if (mode === 'explicit') {
    mkdirSync(expected);
    options['FACTORY_DATA_DIR'] = expected;
  }
  const previous = process.exitCode;
  const server = await runCli(options, [], artifactDir);
  try {
    expect(server).toBeDefined();
    if (!server) return;
    expect(new URL(server.address).hostname).toBe('127.0.0.1');
    expect(await (await fetch(`${server.address}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(existsSync(join(expected, 'factory.sqlite'))).toBe(true);
    if (mode === 'explicit') expect(existsSync(dataDir)).toBe(false);
  } finally {
    process.exitCode = previous;
    await server?.close();
  }
});

it.each(['FACTORY_GITHUB_CLIENT_ID', 'FACTORY_GITHUB_PORTAL_CLIENT_ID'])('starts managed sign-in with %s and removes CLI shutdown handlers', async (key) => {
  const port = await unusedPort();
  const before = process.listenerCount('SIGTERM');
  const server = await runCli({
    FACTORY_DATA_DIR: dataDir, PORT: port, FACTORY_MANAGEMENT_MODE: '1',
    FACTORY_PUBLIC_ORIGIN: 'https://factory.example', [key]: 'factory-client',
  }, [], artifactDir);
  if (!server) throw new Error('Expected a running server');
  try {
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    expect(await (await fetch(`${server.address}/api/setup/status`)).json()).toMatchObject({ signInAvailable: true });
  } finally {
    await server.close();
  }
  expect(process.listenerCount('SIGTERM')).toBe(before);
});

it('returns a nonzero CLI status for unusable configuration', async () => {
  const previous = process.exitCode;
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    vi.stubEnv('PORT', 'invalid');
    expect(await runCli()).toBeUndefined();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
    vi.unstubAllEnvs();
    report.mockRestore();
  }
});

it.each(['', ' ', '0', '3e3', '0xbb8', ' 3000 '])('rejects CLI PORT=%j rather than accepting an unsupported value', async (port) => {
  const previous = process.exitCode;
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const server = await runCli({ FACTORY_DATA_DIR: dataDir, PORT: port }, [], artifactDir);
    await server?.close();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
    report.mockRestore();
  }
});

it('loads the mounted identity config at startup and publishes only configured host metadata', async () => {
  const configFile = join(root, 'identity.json');
  const keyFile = join(root, 'identity-key');
  writeFileSync(configFile, JSON.stringify({
    publicOrigin: 'https://factory.example',
    github: [{
      hostname: 'tenant.ghe.com', label: 'Tenant',
      registrations: { portal: { id: 'portal', clientId: 'client', secret: 'fixture-secret' } },
    }],
  }));
  const serverOptions = { dataDir, artifactDir, port: 0, identity: { configFile, keyFile } };
  await expect(startServer(serverOptions)).rejects.toThrow('Credential encryption key is missing or unreadable.');
  writeFileSync(keyFile, Buffer.alloc(32, 9));
  const instance = await startServer(serverOptions);
  try {
    const response = await fetch(`${instance.address}/api/auth/github/hosts`);
    expect(await response.json()).toEqual({ items: [{ id: 'tenant.ghe.com', label: 'Tenant', hostname: 'tenant.ghe.com' }] });
    expect((await fetch(`${instance.address}/api/me`)).status).toBe(401);
  } finally {
    await instance.close();
  }
  writeFileSync(configFile, '{"secret":"not-to-log"');
  await expect(startServer(serverOptions)).rejects.toThrow('Identity configuration is missing or invalid.');
});

it('starts management mode without credentials and rejects legacy mode after ownership is claimed', async () => {
  const managed = { publicOrigin: 'https://factory.example' };
  const legacy = { configFile: 'unread', keyFile: 'unread' };
  await expect(startServer({ dataDir, artifactDir, port: 0, identity: legacy, management: managed }))
    .rejects.toThrow('not both');
  const server = await startServer({ dataDir, artifactDir, port: 0, management: managed });
  try {
    const status = await fetch(`${server.address}/api/setup/status`);
    expect(await status.json()).toEqual({ state: 'unclaimed', pairingAvailable: true, paired: false, signInAvailable: false });
  } finally {
    await server.close();
  }
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  try {
    const setup = createSetupStore(db);
    setup.pair('session', setup.issueCode().code);
    setup.claimOwner('session', { provider: 'github', host: 'github.com', subject: '42', registrationId: 'fixture' });
  } finally {
    db.close();
  }
  await expect(startServer({ dataDir, artifactDir, port: 0, identity: legacy })).rejects.toThrow('claimed management instance');
});

it('does not issue a setup code outside management mode or without an interactive terminal', async () => {
  const previous = process.exitCode;
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const args = ['node', 'factory', 'setup-code'];
  try {
    await runCli({ FACTORY_DATA_DIR: dataDir }, args, artifactDir);
    expect(report.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Setup code issuance requires management mode.' });
    await runCli({ FACTORY_DATA_DIR: dataDir, FACTORY_MANAGEMENT_MODE: '1', FACTORY_IDENTITY_CONFIG_FILE: 'legacy' }, args, artifactDir);
    expect(report.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Setup code issuance requires management mode.' });
    await runCli({
      FACTORY_DATA_DIR: dataDir, FACTORY_MANAGEMENT_MODE: '1', FACTORY_PUBLIC_ORIGIN: 'http://factory.example',
      FACTORY_GITHUB_CLIENT_ID: 'factory-client',
    }, [], artifactDir);
    expect(report.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Management mode requires a canonical HTTPS public origin.' });
  } finally {
    process.exitCode = previous;
    report.mockRestore();
  }
});
