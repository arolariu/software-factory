import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDesktopSidecar } from './desktop-sidecar.js';
import { lockDataDirectory } from '../persistence/instance-lock.js';
import { openDatabase } from '../persistence/open.js';
import { migrate } from '../persistence/migrations.js';
import { openCredentialVault } from '../identity/credentials.js';

let root: string;
let dataDir: string;
let artifactDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-sidecar-'));
  dataDir = join(root, 'data');
  artifactDir = join(root, 'dist');
  mkdirSync(dataDir);
  mkdirSync(join(artifactDir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(artifactDir, 'web', 'index.html'), '<main>Portal</main>');
  writeFileSync(join(artifactDir, 'build.json'), '{"revision":null,"builtAt":null,"runUrl":null}');
});

afterEach(() => rmSync(root, { recursive: true }));

it('advertises readiness only after private startup and closes when the parent pipe closes', async () => {
  const control = new PassThrough();
  const readiness = new PassThrough();
  const token = Buffer.alloc(32, 7);
  const pending = once(readiness, 'data');
  const child = runDesktopSidecar(control, readiness, { dataDir, artifactDir });
  const chunk = Buffer.concat([token, Buffer.alloc(32, 9)]);
  control.write(chunk.subarray(0, 20));
  control.write(chunk.subarray(20));
  let url: string | undefined;
  try {
    const [frame] = await pending;
    expect(frame.toString()).toMatch(/^ready [1-9][0-9]*\n$/);
    url = `http://127.0.0.1:${frame.toString().trim().split(' ')[1]}/healthz`;
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(url, { headers: { 'x-factory-desktop-channel': token.toString('hex') } })).status).toBe(200);
  } finally {
    control.end();
    await child;
  }
  if (!url) throw new Error('Expected a ready child');
  await expect(fetch(url)).rejects.toThrow();
  expect(existsSync(join(dataDir, 'management-vault.key'))).toBe(false);
});

it.each([20, 65])('rejects a %s-byte startup frame without touching Factory data', async (size) => {
  const control = new PassThrough();
  const readiness = new PassThrough();
  const child = runDesktopSidecar(control, readiness, { dataDir, artifactDir });
  control.end(Buffer.alloc(size));
  await expect(child).rejects.toThrow('Invalid desktop startup frame');
  expect(readiness.read()).toBeNull();
  expect(existsSync(join(dataDir, 'factory.sqlite'))).toBe(false);
});

it('does not open the vault when the parent leaves startup incomplete', async () => {
  vi.useFakeTimers();
  try {
    const control = new PassThrough();
    const readiness = new PassThrough();
    const result = expect(runDesktopSidecar(control, readiness, { dataDir, artifactDir }))
      .rejects.toThrow('Invalid desktop startup frame');
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(existsSync(join(dataDir, 'factory.sqlite'))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('reports a sanitized startup reason over the private readiness pipe', async () => {
  const control = new PassThrough();
  const readiness = new PassThrough();
  const pending = once(readiness, 'data');
  const child = expect(runDesktopSidecar(control, readiness, { dataDir, artifactDir: join(root, 'missing-private-path') }))
    .rejects.toThrow();
  control.write(Buffer.alloc(64, 5));
  await child;
  expect(String((await pending)[0])).toBe('error assets\n');
});

it.each(['locked', 'owner', 'vault', 'startup'] as const)('reports only an allowlisted %s readiness failure', async (code) => {
  let release: (() => void) | undefined;
  let path = dataDir;
  if (code === 'locked') release = lockDataDirectory(dataDir);
  else if (code === 'startup') path = join(root, 'missing-private-data');
  else if (code === 'vault') openCredentialVault(join(dataDir, 'credentials.sqlite'), Buffer.alloc(32, 3)).close();
  else {
    const db = openDatabase(join(dataDir, 'factory.sqlite'));
    try {
      migrate(db);
      db.exec("INSERT INTO management_owner VALUES(1,'github','github.com','42','not-this-app')");
    } finally { db.close(); }
  }
  try {
    const control = new PassThrough();
    const readiness = new PassThrough();
    const pending = once(readiness, 'data');
    const child = expect(runDesktopSidecar(control, readiness, { dataDir: path, artifactDir, githubClientId: 'app' }))
      .rejects.toThrow();
    control.write(Buffer.alloc(64, 5));
    await child;
    expect(String((await pending)[0])).toBe(`error ${code}\n`);
  } finally { release?.(); }
});

it('drains instead of accepting any commands sent on the lifetime pipe', async () => {
  const control = new PassThrough();
  const readiness = new PassThrough();
  const pending = once(readiness, 'data');
  const result = expect(runDesktopSidecar(control, readiness, { dataDir, artifactDir, githubClientId: 'factory-client' }))
    .rejects.toThrow('Invalid desktop control stream');
  control.write(Buffer.alloc(64, 5));
  const [frame] = await pending;
  const url = `http://127.0.0.1:${frame.toString().trim().split(' ')[1]}/api/setup/status`;
  const response = await fetch(url, { headers: { 'x-factory-desktop-channel': '05'.repeat(32) } });
  expect(await response.json()).toMatchObject({ signInAvailable: true });
  control.write(Buffer.from([1]));
  await result;
  await expect(fetch(url)).rejects.toThrow();
});
