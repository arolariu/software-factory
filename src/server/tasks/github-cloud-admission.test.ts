import { expect, it, vi } from 'vitest';
import { createGitHubCloudAdmission, type CloudConnection } from './github-cloud-admission.js';
import type { ApiDto } from '../../shared/api/schemas.js';

const requester = { id: 'alice' };
const approved = { repoId: '81', ownerId: '42' };
const account = { id: 'copilot', subject: '42', identityId: 'git-user', credentialVersion: 'original' };
const connection: CloudConnection = {
  id: 'conn', repoId: 'local-repo', generation: 1, grantId: 'repository-grant', provider: 'github', identityId: 'git-user',
  repositoryId: '81', scope: '42', subject: '42', target: { host: 'github.com', scope: 'owner', project: null, name: 'disposable' },
};
const input = { startRequestId: 'start-once', copilotAccountId: 'copilot', workItemKey: '17' };
const binding = { connectionId: 'conn', repoId: 'local-repo', identityId: 'git-user', generation: 1, scope: 'github.com:42:81' };

function fixture() {
  const resolveConnection = vi.fn((): CloudConnection | undefined => connection);
  const resolveAccount = vi.fn((): typeof account | undefined => account);
  const verify = vi.fn(async () => ({ token: 'ghu_fixture', login: 'owner' }));
  const issue = vi.fn(async () => ({ key: '17', state: 'open' as 'open' | 'closed' }));
  const models = vi.fn(async (): Promise<ApiDto<'copilotCatalog'>['models']> => [
    { id: 'm1', name: 'Approved model', policy: 'enabled', reasoning: ['low', 'high'], defaultReasoning: 'high' },
    { id: 'm2', name: 'Denied model', policy: 'disabled', reasoning: ['high'], defaultReasoning: 'high' },
  ]);
  const probe = vi.fn(async (_token: string, request: { requestedSessionId: string }): Promise<{
    sessionId: string; usage: { nanoAiu: number | null; premiumRequests: number | null } | null;
  }> => ({
    sessionId: request.requestedSessionId, usage: { nanoAiu: 0, premiumRequests: 0.125 },
  }));
  return {
    resolveConnection, resolveAccount, verify, issue, probe, models,
    adapter: createGitHubCloudAdmission(approved, { resolveConnection, resolveAccount, verify, issue, probe, models }),
  };
}

it('advertises only the approved repository and its matching Copilot grant without provider calls', () => {
  const { adapter, resolveAccount, resolveConnection, verify } = fixture();
  expect(adapter.describe(requester, 'conn', {})).toMatchObject({
    copilotAccountId: 'copilot', launch: { available: true },
    featureBranch: { available: false }, models: { availability: { available: false } },
  });

  resolveAccount.mockReturnValueOnce({ ...account, subject: '43' });
  expect(adapter.describe(requester, 'conn', {})).toMatchObject({ copilotAccountId: null, launch: { available: false } });
  resolveConnection.mockReturnValueOnce({ ...connection, repositoryId: '82' });
  expect(adapter.describe(requester, 'conn', {})).toMatchObject({ launch: { available: false } });
  expect(verify).not.toHaveBeenCalled();
});

it('loads only enabled models on demand and validates the selected effort against a fresh catalog', async () => {
  const { adapter, models, probe } = fixture();
  expect(adapter.describe(requester, 'conn', {}).models.availability.available).toBe(false);
  expect(models).not.toHaveBeenCalled();
  const options = await adapter.modelOptions(requester, 'conn', {});
  expect(options.models).toEqual({
    availability: { available: true }, items: [{ id: 'm1', name: 'Approved model', supportedEfforts: ['low', 'high'] }],
  });
  const configured = { ...input, overrides: { model: 'm1', reasoningEffort: 'high' } };
  models.mockResolvedValueOnce(null);
  expect((await adapter.modelOptions(requester, 'conn', {})).models.availability.available).toBe(false);
  models.mockResolvedValueOnce(null);
  await expect(adapter.authorize(requester, 'conn', configured)).rejects.toThrow('TEMPORARILY_UNAVAILABLE');
  expect(await adapter.authorize(requester, 'conn', configured)).toEqual(binding);
  await expect(adapter.authorize(requester, 'conn', { ...configured, overrides: { model: 'm2' } })).resolves.toBeUndefined();
  await expect(adapter.authorize(requester, 'conn', { ...configured, overrides: { model: 'm1', reasoningEffort: 'max' } }))
    .resolves.toBeUndefined();
  const claim = { ...binding, ...configured, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  await adapter.launch(claim);
  expect(probe.mock.lastCall?.[1]).toMatchObject({ model: 'm1', reasoningEffort: 'high' });
  models.mockResolvedValueOnce([]);
  await expect(adapter.launch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).toHaveBeenCalledOnce();
});

it('does not silently downgrade an explicit model when catalog access is unavailable', async () => {
  const { resolveConnection, resolveAccount, verify, issue, probe } = fixture();
  const adapter = createGitHubCloudAdmission(approved, { resolveConnection, resolveAccount, verify, issue, probe });
  expect(await adapter.modelOptions(requester, 'conn', {})).toMatchObject({
    launch: { available: true }, models: { availability: { available: false } },
  });
  await expect(adapter.authorize(requester, 'conn', { ...input, overrides: { model: 'requested' } })).resolves.toBeUndefined();
  expect(verify).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
});

it('does not disclose the catalog if the selected consent or repository changes while models are loading', async () => {
  const { adapter, models, resolveAccount } = fixture();
  models.mockImplementationOnce(async () => {
    resolveAccount.mockReturnValue(undefined);
    return [{ id: 'm1', name: 'Approved model', policy: 'enabled', reasoning: [], defaultReasoning: 'low' }];
  });
  expect(await adapter.modelOptions(requester, 'conn', {})).toMatchObject({
    copilotAccountId: null, launch: { available: false }, models: { items: [] },
  });
});

it('cannot become eligible on a different provider, namespace, owner or account', async () => {
  const { adapter, resolveAccount, resolveConnection, verify } = fixture();
  for (const candidate of [
    undefined, { ...connection, provider: 'azure_devops' as const }, { ...connection, target: { ...connection.target, host: 'corp.ghe.com' } },
    { ...connection, scope: '43' }, { ...connection, subject: '43' },
  ]) {
    resolveConnection.mockReturnValueOnce(candidate);
    await expect(adapter.authorize(requester, 'conn', input)).resolves.toBeUndefined();
  }
  for (const candidate of [undefined, { ...account, identityId: 'other' }, { ...account, id: 'other-grant' }]) {
    resolveAccount.mockReturnValueOnce(candidate);
    await expect(adapter.authorize(requester, 'conn', input)).resolves.toBeUndefined();
  }
  await expect(adapter.authorize(requester, 'conn', { ...input, workItemKey: '17/pulls' })).resolves.toBeUndefined();
  expect(verify).not.toHaveBeenCalled();
});

it('rejects invalid targets and cancels before or after provider verification without dispatch', async () => {
  const { adapter, resolveAccount, resolveConnection, verify, issue, probe } = fixture();
  for (const target of [{ ...approved, repoId: '01' }, { ...approved, ownerId: 'owner' }]) {
    expect(() => createGitHubCloudAdmission(target, { resolveAccount, resolveConnection, verify, issue, probe }))
      .toThrow('canonical GitHub numeric IDs');
  }
  await expect(adapter.authorize(requester, 'conn', input, AbortSignal.abort())).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
  const controller = new AbortController();
  issue.mockImplementationOnce(async () => {
    controller.abort();
    return { key: '17', state: 'open' };
  });
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  await expect(adapter.launch(claim, controller.signal)).rejects.toThrow();
  expect(probe).not.toHaveBeenCalled();
});

it('reverifies a bound claim before dispatch, sends no issue body, and retains measured units', async () => {
  const { adapter, verify, issue, probe } = fixture();
  expect(await adapter.authorize(requester, 'conn', input)).toEqual(binding);
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  expect(await adapter.launch(claim)).toEqual({
    claim, sessionId: 'exact-session', usage: { aiCreditsStatus: 'complete', totalNanoAiu: 0, totalPremiumRequestCost: 0.125 },
  });
  expect(verify).toHaveBeenCalledTimes(2);
  expect(issue).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenCalledExactlyOnceWith('ghu_fixture', {
    requestedSessionId: 'exact-session', expectedLogin: 'owner', repository: { owner: 'owner', name: 'disposable' },
    turnId: 'start-once', prompt: expect.stringContaining('https://github.com/owner/disposable/issues/17'),
    verifyCredential: expect.any(Function),
  }, undefined);
  expect(probe.mock.calls[0]?.[1]).toMatchObject({ prompt: expect.stringContaining('Do not edit') });
});

it('rejects closed issues, claims from an obsolete generation, and grants that change during verification', async () => {
  const { adapter, verify, resolveAccount, issue, probe } = fixture();
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  issue.mockResolvedValueOnce({ key: '17', state: 'closed' });
  await expect(adapter.authorize(requester, 'conn', input)).resolves.toBeUndefined();
  await expect(adapter.launch({ ...claim, generation: 2 })).rejects.toThrow('ACCESS_UNVERIFIED');
  resolveAccount.mockReturnValueOnce(account).mockReturnValueOnce(undefined);
  await expect(adapter.launch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  await expect(adapter.authorize(requester, 'conn', { ...input, overrides: { model: 'not-proven' } })).resolves.toBeUndefined();
  expect(verify).toHaveBeenCalledTimes(2);
  expect(probe).not.toHaveBeenCalled();
});

it('rejects changed repository coordinates, a substituted issue and an unrelated session receipt', async () => {
  const { adapter, issue, probe, resolveConnection } = fixture();
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  for (const different of [{ repoId: 'other' }, { identityId: 'other' }, { scope: 'different' }]) {
    await expect(adapter.launch({ ...claim, ...different })).rejects.toThrow('ACCESS_UNVERIFIED');
  }
  for (const move of [
    { generation: 2 }, { grantId: 'rotated' }, { target: { ...connection.target, scope: 'renamed' } },
    { target: { ...connection.target, name: 'renamed' } },
  ]) {
    resolveConnection.mockReturnValueOnce(connection).mockReturnValueOnce({ ...connection, ...move });
    await expect(adapter.launch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  }
  issue.mockResolvedValueOnce({ key: '18', state: 'open' });
  await expect(adapter.launch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).not.toHaveBeenCalled();
  probe.mockResolvedValueOnce({ sessionId: 'unrelated', usage: null });
  await expect(adapter.launch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  probe.mockResolvedValueOnce({ sessionId: 'exact-session', usage: null });
  expect(await adapter.launch(claim)).toEqual({ claim, sessionId: 'exact-session' });
  probe.mockResolvedValueOnce({ sessionId: 'exact-session', usage: { nanoAiu: null, premiumRequests: 0.25 } });
  expect(await adapter.launch(claim)).toMatchObject({ usage: { totalPremiumRequestCost: 0.25 } });
  probe.mockResolvedValueOnce({ sessionId: 'exact-session', usage: { nanoAiu: 10, premiumRequests: null } });
  expect(await adapter.launch(claim)).toMatchObject({ usage: { totalNanoAiu: 10 } });
});

it('discards the receipt if the Copilot grant is revoked during the remote call', async () => {
  const { adapter, probe, resolveAccount } = fixture();
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  probe.mockImplementationOnce(async () => {
    resolveAccount.mockReturnValue(undefined);
    return { sessionId: 'exact-session', usage: { nanoAiu: 2, premiumRequests: 1 } };
  });

  await expect(adapter.launch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).toHaveBeenCalledOnce();
});

it('rejects same-account credential replacement between prepare and SDK dispatch', async () => {
  const { adapter, probe, resolveAccount } = fixture();
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  const prepared = (await adapter.prepare(claim))!;
  resolveAccount.mockReturnValue({ ...account, credentialVersion: 'replacement' });
  await expect(prepared.dispatch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).not.toHaveBeenCalled();
});

it('binds a prepared dispatch to one exact claim and rejects revocation before contacting the SDK', async () => {
  const { adapter, probe, resolveAccount, verify } = fixture();
  const claim = { ...binding, ...input, taskId: 'task', requesterId: 'alice', requestedSessionId: 'exact-session' };
  const cancelled = await adapter.prepare(claim);
  if (!cancelled) throw new Error('Expected prepared dispatch');
  resolveAccount.mockReturnValueOnce(undefined);
  await expect(cancelled.dispatch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).not.toHaveBeenCalled();

  const prepared = await adapter.prepare(claim);
  if (!prepared) throw new Error('Expected prepared dispatch');
  claim.workItemKey = '18';
  await expect(prepared.dispatch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  claim.workItemKey = '17';
  await expect(prepared.dispatch({ ...claim, requestedSessionId: 'substituted' })).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).not.toHaveBeenCalled();
  await expect(prepared.dispatch(claim)).resolves.toMatchObject({ sessionId: 'exact-session' });
  await expect(prepared.dispatch(claim)).rejects.toThrow('ACCESS_UNVERIFIED');
  expect(probe).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledTimes(2);
});
