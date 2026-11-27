import { afterEach, expect, it, vi } from 'vitest';
import { authorizeCopilotCheck, inspectCopilotAccess, inspectWithSdk, runCopilotAccessCheck } from './copilot-access.js';

const runtime = {
  start: vi.fn(async () => {}),
  getAuthStatus: vi.fn(),
  listModels: vi.fn(),
  forceStop: vi.fn(async () => {}),
};
const create = vi.fn(async (_options: { env: NodeJS.ProcessEnv }) => runtime);

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reports only authentication and model policy evidence, not a personal license', async () => {
  const client = {
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: 'token', login: 'fixture', statusMessage: 'private' })),
    listModels: vi.fn(async () => [
      { policy: { state: 'enabled' } }, { policy: { state: 'disabled' } }, { policy: { state: 'unconfigured' } }, {},
    ]),
  };
  expect(await inspectCopilotAccess(client)).toEqual({
    state: 'authenticated', login: 'fixture', models: 4, disabledByPolicy: 1,
  });
});

it.each([
  { isAuthenticated: false, authType: 'token' },
  { isAuthenticated: true, authType: 'oauth' },
])('never lists models with missing authentication or a fallback identity (%j)', async (status) => {
  const listModels = vi.fn(async () => []);
  expect(await inspectCopilotAccess({ getAuthStatus: async () => status, listModels })).toEqual({ state: 'unverified' });
  expect(listModels).not.toHaveBeenCalled();
});

it('polls no sooner than GitHub allows and returns an explicit device grant only', async () => {
  const approval = vi.fn();
  const wait = vi.fn(async (_ms: number) => {});
  const tokens = { accessToken: 'ghu_fixture', refreshToken: null, expiresAt: 10000 };
  const device = {
    start: async () => ({ deviceCode: 'private-device', userCode: 'ABCD-EFGH', expiresAt: 10000, intervalMs: 100 }),
    poll: vi.fn().mockResolvedValueOnce({ kind: 'slow_down' }).mockResolvedValueOnce({ kind: 'pending' })
      .mockResolvedValueOnce({ kind: 'authorized', tokens }),
  };
  expect(await authorizeCopilotCheck('fixture-client', device, approval, wait, () => 0)).toBe(tokens.accessToken);
  expect(approval).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH');
  expect(wait.mock.calls).toEqual([[100], [5100], [5100]]);
  expect(device.poll).toHaveBeenLastCalledWith('fixture-client', 'private-device');
});

it.each(['denied', 'expired'] as const)('does not proceed to Copilot when GitHub device approval is %s', async (kind) => {
  const device = {
    start: async () => ({ deviceCode: 'private-device', userCode: 'ABCD-EFGH', expiresAt: 1000, intervalMs: 100 }),
    poll: async () => ({ kind }),
  };
  await expect(authorizeCopilotCheck('fixture-client', device, () => {}, async () => {}, () => 0)).rejects.toThrow();
});

it('does not poll GitHub once the device grant has expired', async () => {
  const poll = vi.fn();
  const device = { start: async () => ({ deviceCode: 'private-device', userCode: 'ABCD-EFGH', expiresAt: 50, intervalMs: 100 }), poll };
  await expect(authorizeCopilotCheck('fixture-client', device, () => {}, async () => {}, () => 0)).rejects.toThrow('expired');
  expect(poll).not.toHaveBeenCalled();
});

it('does not poll if a wait ran past the deadline', async () => {
  let now = 0;
  const poll = vi.fn();
  const device = { start: async () => ({ deviceCode: 'private-device', userCode: 'ABCD-EFGH', expiresAt: 150, intervalMs: 100 }), poll };
  await expect(authorizeCopilotCheck('factory', device, () => {}, async () => { now = 150; }, () => now)).rejects.toThrow('expired');
  expect(poll).not.toHaveBeenCalled();
});

it.each([[undefined, true], ['fixture', false], ['not an ID', true]] as const)('requires a terminal and a public Client ID (%s, %s)', async (id, terminal) => {
  const authorize = vi.fn();
  expect(await runCopilotAccessCheck(id, terminal, vi.fn(), vi.fn(), authorize)).toBe(2);
  expect(authorize).not.toHaveBeenCalled();
});

it('uses only the fresh token and discloses no credentials in the report', async () => {
  runtime.getAuthStatus.mockResolvedValueOnce({ isAuthenticated: true, authType: 'token' });
  runtime.listModels.mockResolvedValueOnce([{ policy: { state: 'enabled' } }]);
  const output = vi.fn();
  const error = vi.fn();
  const status = await runCopilotAccessCheck('fixture-client', true, output, error, async (_id, show) => {
    show('ABCD-EFGH');
    return 'ghu_fixture';
  }, (token) => inspectWithSdk(token, create));
  expect(status).toBe(0);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ gitHubToken: 'ghu_fixture', useLoggedInUser: false }));
  expect(create.mock.calls[0]?.[0].env).not.toHaveProperty('GH_TOKEN');
  expect(runtime.start).toHaveBeenCalledBefore(runtime.getAuthStatus);
  expect(runtime.forceStop).toHaveBeenCalledOnce();
  expect(output.mock.calls).toEqual([
    ['Open https://github.com/login/device and enter ABCD-EFGH.'],
    ['{"state":"authenticated","login":null,"models":1,"disabledByPolicy":0}'],
  ]);
  expect(error).not.toHaveBeenCalled();
});

it.each([
  { state: 'unverified' },
  { state: 'authenticated', login: 'fixture', models: 0, disabledByPolicy: 0 },
  { state: 'authenticated', login: 'fixture', models: 2, disabledByPolicy: 2 },
] as const)('does not report verification for inconclusive evidence (%j)', async (result) => {
  expect(await runCopilotAccessCheck('fixture-client', true, vi.fn(), vi.fn(), async () => 'ghu_fixture', async () => result)).toBe(1);
});

it('accepts a legacy dotted GitHub App Client ID', async () => {
  const authorize = vi.fn(async () => 'ghu_fixture');
  const inspect = async () => ({ state: 'authenticated', login: 'fixture', models: 2, disabledByPolicy: 1 } as const);
  expect(await runCopilotAccessCheck('Iv1.0123456789abcdef', true, vi.fn(), vi.fn(), authorize, inspect)).toBe(0);
  expect(authorize).toHaveBeenCalledWith('Iv1.0123456789abcdef', expect.any(Function));
});

it('times out and stops a stuck Copilot runtime without printing raw provider errors', async () => {
  vi.useFakeTimers();
  runtime.getAuthStatus.mockReturnValueOnce(new Promise(() => {}));
  const report = vi.fn();
  const running = runCopilotAccessCheck('fixture-client', true, vi.fn(), report, async () => 'ghu_fixture',
    (token) => inspectWithSdk(token, create));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await running).toBe(1);
  expect(runtime.forceStop).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(expect.stringContaining('not verified'));
});

it('does not expose upstream error details when device authorization fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream detail', { status: 502 })));
  const output = vi.fn();
  const report = vi.fn();
  expect(await runCopilotAccessCheck('fixture-client', true, output, report)).toBe(1);
  expect(output).not.toHaveBeenCalled();
  expect(report.mock.calls.flat().join(' ')).not.toContain('private');
  expect(create).not.toHaveBeenCalled();
});
