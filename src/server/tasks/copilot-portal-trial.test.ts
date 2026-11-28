import { mkdirSync, mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runPortalTrial } from './copilot-portal-trial.js';
import * as main from '../main.js';

const publicOrigin = 'https://factory-trial.localhost:3444';
const input = { terminal: true, clientId: 'Iv1.test', publicOrigin, repositoryId: '63', userId: '42' };
const confirmation = '63:42';

it.each([
  { terminal: false }, { clientId: '' }, { clientId: 'not an ID' },
  { publicOrigin: 'https://localhost:3444' }, { publicOrigin: 'https://factory-trial.localhost:3444/' },
  { publicOrigin: 'http://factory-trial.localhost:3444' },
  { repositoryId: '0' }, { repositoryId: undefined }, { userId: 'owner' }, { userId: undefined },
])('does not open a trial with invalid input (%j)', async (override) => {
  const confirm = vi.fn();
  const show = vi.fn();
  expect(await runPortalTrial({ ...input, ...override }, { confirm, show, report: vi.fn() }, 'unused', new AbortController().signal))
    .toBe(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
});

it('requires explicit operator confirmation before opening a listener', async () => {
  const confirm = vi.fn(async () => 'different-target');
  const show = vi.fn();
  expect(await runPortalTrial(input, { confirm, show, report: vi.fn() }, 'unused', new AbortController().signal)).toBe(2);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(confirmation);
  expect(show).not.toHaveBeenCalled();
});

it('does not open a trial when the operator closes the terminal, and reports missing artifacts without leaking paths', async () => {
  const report = vi.fn();
  const show = vi.fn();
  const abort = new AbortController();
  const signal = abort.signal;
  const closedTerminal = async () => { throw new Error('terminal closed'); };
  expect(await runPortalTrial(input, { confirm: closedTerminal, show, report }, 'unused', signal)).toBe(2);
  expect(await runPortalTrial(input, { confirm: async () => { abort.abort(); return confirmation; }, show, report }, 'unused', signal))
    .toBe(2);
  expect(await runPortalTrial(input, { confirm: async () => confirmation, show, report }, 'unused', signal)).toBe(2);
  using empty = mkdtempDisposableSync(join(tmpdir(), 'factory-trial-missing-artifacts-'));
  expect(await runPortalTrial(input, { confirm: async () => confirmation, show, report }, empty.path, new AbortController().signal))
    .toBe(1);
  expect(show).not.toHaveBeenCalled();
  expect(JSON.stringify(report.mock.calls)).not.toContain(empty.path);
});

function call(address: string, path: string, headers: Record<string, string>, payload?: object) {
  return new Promise<{ status: number | undefined; body: string; cookie: string | undefined }>((resolve, reject) => {
    const body = payload && JSON.stringify(payload);
    const req = request(new URL(path, address), {
      headers: { ...headers, ...(body && { 'Content-Type': 'application/json' }) }, method: body ? 'POST' : 'GET',
    }, (response) => {
      response.setEncoding('utf8');
      let output = '';
      response.on('data', (text: string) => { output += text; });
      response.on('end', () => resolve({
        status: response.statusCode, body: output, cookie: response.headers['set-cookie']?.[0]?.split(';')[0],
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function portalArtifacts(path: string) {
  mkdirSync(join(path, 'web', 'assets'), { recursive: true });
  writeFileSync(join(path, 'web', 'index.html'), '<main>Portal</main>');
  writeFileSync(join(path, 'build.json'), '{"revision":null,"builtAt":null,"runUrl":null}');
}

it('does not disclose a pairing code if shutdown arrives while Factory is opening', async () => {
  using root = mkdtempDisposableSync(join(tmpdir(), 'factory-trial-fixtures-'));
  portalArtifacts(root.path);
  const abort = new AbortController();
  const original = main.startServer;
  let address: string | undefined;
  const listener = vi.spyOn(main, 'startServer').mockImplementationOnce(async (options) => {
    const server = await original(options);
    address = server.address;
    abort.abort();
    return server;
  });
  const show = vi.fn();
  try {
    expect(await runPortalTrial(input, { confirm: async () => confirmation, show, report: vi.fn() }, root.path, abort.signal)).toBe(0);
    expect(show).not.toHaveBeenCalled();
    if (!address) throw new Error('Expected the backend to open before cancellation');
    await expect(call(address, '/healthz', {})).rejects.toThrow();
  } finally { listener.mockRestore(); }
});

it('opens only an isolated loopback portal, pairs a browser and closes on shutdown without provider traffic', async () => {
  using root = mkdtempDisposableSync(join(tmpdir(), 'factory-trial-fixtures-'));
  portalArtifacts(root.path);
  const ready = Promise.withResolvers<{ backend: string; origin: string; pairingCode: string }>();
  const abort = new AbortController();
  const run = runPortalTrial(input, {
    confirm: async () => confirmation,
    show: (details) => ready.resolve(details),
    report: (error) => ready.reject(new Error(error)),
  }, root.path, abort.signal);
  let backend: string | undefined;
  try {
    const details = await ready.promise;
    ({ backend } = details);
    expect(backend).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
    expect(details.origin).toBe(publicOrigin);
    expect((await call(backend, '/healthz', { host: new URL(backend).host })).status).toBe(404);
    const host = { host: new URL(publicOrigin).host };
    expect(JSON.parse((await call(backend, '/api/setup/status', host)).body)).toMatchObject({
      state: 'unclaimed', signInAvailable: true, paired: false,
    });
    const csrf = await call(backend, '/api/auth/csrf', host);
    const pair = { ...host, cookie: csrf.cookie!, 'x-csrf-token': JSON.parse(csrf.body).csrfToken as string };
    expect((await call(backend, '/api/setup/pair', { ...pair, origin: 'https://other.example' }, { code: details.pairingCode })).status).toBe(403);
    expect((await call(backend, '/api/setup/pair', { ...pair, origin: publicOrigin }, { code: details.pairingCode })).status).toBe(204);
  } finally {
    abort.abort();
    expect(await run).toBe(0);
  }
  await expect(call(backend!, '/healthz', {})).rejects.toThrow();
});
