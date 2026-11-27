import { expect, it, vi } from 'vitest';
import { createCopilotCatalog, inspectCatalog } from './copilot-catalog.js';

const authenticated = async () => ({ isAuthenticated: true, authType: 'token' });
const getQuota = vi.fn(async () => ({
  quotaSnapshots: {
    premium_interactions: { isUnlimitedEntitlement: false, usedRequests: 12, entitlementRequests: 100, resetDate: '2026-12-01T00:00:00Z' },
    chat: { isUnlimitedEntitlement: true, usedRequests: 0, entitlementRequests: -1 },
  },
}));

it('preserves provider units, unlimited quota, policy-disabled models and model configuration without leaking raw fields', async () => {
  const result = await inspectCatalog({
    getAuthStatus: authenticated,
    listModels: async () => [
      { id: 'm1', name: 'Model One', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', token: 'not-for-ui' },
      { id: 'm2', name: 'Model Two', policy: { state: 'disabled' } },
    ],
    rpc: { account: { getQuota } },
  });
  expect(result).toEqual({
    models: [
      { id: 'm1', name: 'Model One', policy: 'unknown', reasoning: ['low', 'high'], defaultReasoning: 'high' },
      { id: 'm2', name: 'Model Two', policy: 'disabled', reasoning: [], defaultReasoning: null },
    ],
    quota: [
      { kind: 'chat', unit: 'requests', used: 0, limit: null, unlimited: true, resetsAt: null },
      { kind: 'premium_interactions', unit: 'requests', used: 12, limit: 100, unlimited: false, resetsAt: '2026-12-01T00:00:00.000Z' },
    ],
  });
});

it('retains the available source and distinguishes missing quota, malformed data, and an empty model inventory', async () => {
  expect(await inspectCatalog({
    getAuthStatus: authenticated, listModels: async () => [{ id: 'kept', name: 'Kept', policy: { state: 'enabled' } }],
    rpc: { account: { getQuota: async () => { throw new Error('SDK details never reach the DTO'); } } },
  })).toEqual({ models: [{ id: 'kept', name: 'Kept', policy: 'enabled', reasoning: [], defaultReasoning: null }], quota: null });
  expect(await inspectCatalog({
    getAuthStatus: authenticated, listModels: async () => [],
    rpc: { account: { getQuota: async () => ({ quotaSnapshots: { chat: { usedRequests: -2 } } }) } },
  })).toEqual({ models: [], quota: null });
  expect(await inspectCatalog({
    getAuthStatus: authenticated, listModels: async () => [{ id: 'bad' }],
    rpc: { account: { getQuota: async () => ({ quotaSnapshots: {} }) } },
  })).toEqual({ models: null, quota: [] });
  expect(await inspectCatalog({
    getAuthStatus: authenticated, listModels: async () => { throw new Error('Catalog unavailable'); },
    rpc: { account: { getQuota: async () => ({
      quotaSnapshots: { chat: { isUnlimitedEntitlement: false, usedRequests: 0, entitlementRequests: 0 } },
    }) } },
  })).toEqual({
    models: null, quota: [{ kind: 'chat', unit: 'requests', used: 0, limit: 0, unlimited: false, resetsAt: null }],
  });
  expect(await inspectCatalog({
    getAuthStatus: authenticated, listModels: async () => [{ id: 'a', name: 'Terms required', policy: { state: 'unconfigured' } }],
    rpc: { account: { getQuota: async () => ({ quotaSnapshots: null }) } },
  })).toEqual({
    models: [{ id: 'a', name: 'Terms required', policy: 'unconfigured', reasoning: [], defaultReasoning: null }], quota: null,
  });
});

it('never reads the catalog without SDK-confirmed token authentication', async () => {
  const listModels = vi.fn();
  await expect(inspectCatalog({
    getAuthStatus: async () => ({ isAuthenticated: true, authType: 'user' }), listModels, rpc: { account: { getQuota } },
  })).rejects.toThrow('COPILOT_REAUTH_REQUIRED');
  await expect(inspectCatalog({
    getAuthStatus: async () => ({ isAuthenticated: false }), listModels, rpc: { account: { getQuota } },
  })).rejects.toThrow('COPILOT_REAUTH_REQUIRED');
  expect(listModels).not.toHaveBeenCalled();
});

it('coalesces requests for one credential, caps concurrency, and rejects data after credential rotation', async () => {
  const pending = Promise.withResolvers<{ models: null; quota: null }>();
  const tokenForAccount = vi.fn(async (id: string) => `${id}-v1`);
  const inspect = vi.fn(() => pending.promise);
  const read = createCopilotCatalog(tokenForAccount, inspect);
  const user = { id: 'alice' };
  const first = read(user, 'a');
  const duplicate = read(user, 'a');
  const others = ['b', 'c', 'd'].map((id) => read(user, id));
  await expect(read(user, 'e')).rejects.toThrow('RATE_LIMITED');
  expect(inspect.mock.calls).toHaveLength(4);
  tokenForAccount.mockImplementation(async (id) => id === 'a' ? `${id}-v2` : `${id}-v1`);
  const mismatch = expect(Promise.all([first, duplicate])).rejects.toThrow('ACCESS_UNVERIFIED');
  pending.resolve({ models: null, quota: null });
  await mismatch;
  expect(await Promise.all(others)).toEqual(Array(3).fill({ models: null, quota: null }));
  expect(await read(user, 'a')).toEqual({ models: null, quota: null });
  expect(inspect.mock.calls).toHaveLength(5);
});
