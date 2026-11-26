import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCli, startServer, verifyContainerData } from './main.js';
import { openDatabase } from './persistence/open.js';

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
    expect(db.pragma('user_version', { simple: true })).toBe(2);
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
  db.pragma('user_version = 2');
  db.close();
  await expect(startServer({ dataDir, artifactDir, port: 0 })).rejects.toThrow('required schema objects');
});

it('refuses overlapping server listeners without disturbing the original', async () => {
  const first = await startServer({ dataDir, artifactDir, port: 0 });
  try {
    const port = Number(new URL(first.address).port);
    await expect(startServer({ dataDir, artifactDir, port })).rejects.toThrow(/EADDRINUSE/);
    expect((await fetch(`${first.address}/healthz`)).ok).toBe(true);
  } finally {
    await first.close();
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

it('registers and removes process shutdown handlers for the CLI server', async () => {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address();
  if (!port || typeof port === 'string') throw new Error('Expected a TCP port.');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const before = process.listenerCount('SIGTERM');
  const server = await runCli({ FACTORY_DATA_DIR: dataDir, PORT: String(port.port) }, [], artifactDir);
  expect(server).toBeDefined();
  try {
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  } finally {
    await server?.close();
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
