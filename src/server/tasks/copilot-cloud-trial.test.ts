import { expect, it, vi } from 'vitest';
import { runCloudTrial } from './copilot-cloud-trial.js';

const url = 'https://github.com/owner/disposable';
const input = { clientId: 'Iv1.test', terminal: true, repository: url, repositoryId: '63', userId: '42' };

function fixture() {
  const fetcher = vi.fn<typeof fetch>();
  const report = vi.fn();
  const show = vi.fn();
  const authorize = vi.fn(async (_id: string, sendCode: (code: string) => void) => {
    sendCode('ABCD-EFGH');
    return 'ghu_trial';
  });
  const confirm = vi.fn(async () => 'owner/disposable');
  const dispatch = vi.fn(async (_token: string, request: { requestedSessionId: string }) => request.requestedSessionId);
  return { fetcher, report, show, authorize, confirm, dispatch };
}

function provider(f: ReturnType<typeof fixture>, githubUser = 42, githubRepo = 63, ownerId = 42) {
  f.fetcher.mockResolvedValueOnce(Response.json({ id: githubUser, login: 'owner' }))
    .mockResolvedValueOnce(Response.json({ id: githubRepo, name: 'disposable', owner: { id: ownerId, login: 'owner' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{
      id: 8, account: { id: ownerId }, permissions: { issues: 'read', pull_requests: 'read' },
    }] })).mockResolvedValueOnce(Response.json({ repositories: [{ id: githubRepo }] }));
}

it.each([
  { terminal: false }, { clientId: 'not an ID' }, { repository: 'https://other.example/owner/disposable' },
  { repository: 'https://github.com/owner/disposable?x=1' }, { repository: 'https://github.com/owner/..' },
  { repository: 'https://github.com/owner/.' }, { clientId: undefined }, { repository: undefined },
  { repositoryId: '0' }, { repositoryId: undefined }, { userId: 'person' }, { userId: undefined },
])('does not request device authorization with invalid trial input (%j)', async (override) => {
  const f = fixture();
  expect(await runCloudTrial({ ...input, ...override }, f)).toBe(2);
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('requires explicit operator confirmation of the exact repository before requesting approval', async () => {
  const f = fixture();
  f.confirm.mockResolvedValueOnce('owner/important-repo');
  expect(await runCloudTrial(input, f)).toBe(2);
  expect(f.authorize).not.toHaveBeenCalled();
  f.confirm.mockRejectedValueOnce(new Error('Terminal closed'));
  expect(await runCloudTrial(input, f)).toBe(2);
  expect(f.authorize).not.toHaveBeenCalled();
});

it.each([[43, 63, 42], [42, 64, 42], [42, 63, 43]] as const)(
  'does not dispatch on account or repository mismatch (%i, %i, %i)',
  async (person, repo, owner) => {
    const f = fixture();
    provider(f, person, repo, owner);
    expect(await runCloudTrial(input, f)).toBe(1);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledWith(expect.stringContaining('account or repository'));
  },
);

it('dispatches once with the approved account and exact repository and reports only a safe delivery receipt', async () => {
  const f = fixture();
  provider(f);
  expect(await runCloudTrial(input, f)).toBe(0);
  expect(f.authorize).toHaveBeenCalledExactlyOnceWith(input.clientId, expect.any(Function));
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('ghu_trial', {
    requestedSessionId: expect.any(String), turnId: expect.any(String), expectedLogin: 'owner',
    repository: { owner: 'owner', name: 'disposable' },
    prompt: expect.stringContaining('README.md'),
  });
  expect(f.fetcher.mock.calls.map(([endpoint]) => endpoint)).toEqual([
    'https://api.github.com/user', 'https://api.github.com/repos/owner/disposable',
    'https://api.github.com/user/installations?per_page=100&page=1',
    'https://api.github.com/user/installations/8/repositories?per_page=100&page=1',
  ]);
  expect(f.fetcher.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true);
  const output = f.show.mock.calls.flat().join('\n');
  expect(output).toContain('"state":"delivery_confirmed"');
  expect(output).not.toContain('ghu_trial');
  expect(output).not.toContain('README.md');
});

it('does not retry after an ambiguous trial and does not print raw SDK errors', async () => {
  const f = fixture();
  provider(f);
  f.dispatch.mockRejectedValueOnce(new Error('Internal provider response'));
  expect(await runCloudTrial(input, f)).toBe(1);
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledWith(expect.stringContaining('Do not retry'));
  expect(f.report.mock.calls.flat().join(' ')).not.toContain('Internal provider');
  provider(f);
  f.dispatch.mockResolvedValueOnce('other-session');
  expect(await runCloudTrial(input, f)).toBe(1);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.show.mock.calls.flat().join(' ')).not.toContain('delivery_confirmed');
});

it('cannot use a credential from a different token source or a repository outside the app installation', async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce('github_pat_fixture');
  expect(await runCloudTrial(input, f)).toBe(1);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.fetcher.mockResolvedValueOnce(Response.json({ id: 42, login: 'owner' }))
    .mockResolvedValueOnce(Response.json({ id: 63, name: 'disposable', owner: { id: 42, login: 'owner' } }))
    .mockResolvedValueOnce(Response.json({ installations: [] }));
  expect(await runCloudTrial(input, f)).toBe(1);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('does not verify a renamed repository under an obsolete spelling even when the numeric IDs match', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(Response.json({ id: 42, login: 'owner' }))
    .mockResolvedValueOnce(Response.json({ id: 63, name: 'renamed', owner: { id: 42, login: 'owner' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{
      id: 8, account: { id: 42 }, permissions: { issues: 'read', pull_requests: 'read' },
    }] })).mockResolvedValueOnce(Response.json({ repositories: [{ id: 63 }] }));
  expect(await runCloudTrial(input, f)).toBe(1);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('uses the real device flow with its fresh token before repository checks', async () => {
  const { authorize, ...f } = fixture();
  f.fetcher.mockResolvedValueOnce(Response.json({
    device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device',
    expires_in: 60, interval: 1,
  })).mockResolvedValueOnce(Response.json({
    access_token: 'ghu_device_trial', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 1_000,
  }));
  provider({ authorize, ...f });
  expect(await runCloudTrial(input, f)).toBe(0);
  expect(authorize).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('ghu_device_trial', expect.any(Object));
  const output = f.show.mock.calls.flat().join(' ');
  expect(output).toContain('ABCD-EFGH');
  expect(output).not.toContain('private-device');
  expect(output).not.toContain('private-refresh');
});
