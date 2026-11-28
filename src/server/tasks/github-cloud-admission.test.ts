import { expect, it, vi } from 'vitest';
import { createGitHubCloudAdmission, type CloudConnection } from './github-cloud-admission.js';

const requester = { id: 'alice' };
const approved = { repoId: '81', ownerId: '42' };
const account = { id: 'copilot', subject: '42', identityId: 'git-user' };
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
  const probe = vi.fn(async (_token: string, request: { requestedSessionId: string }): Promise<{
    sessionId: string; usage: { nanoAiu: number | null; premiumRequests: number | null } | null;
  }> => ({
    sessionId: request.requestedSessionId, usage: { nanoAiu: 0, premiumRequests: 0.125 },
  }));
  return {
    resolveConnection, resolveAccount, verify, issue, probe,
    adapter: createGitHubCloudAdmission(approved, { resolveConnection, resolveAccount, verify, issue, probe }),
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
