import { expect, it, vi } from 'vitest';
import { createRegistry } from './github-hosts.js';
import { authorizationUrl, createOAuthTransport } from './oauth.js';

const app = (id: string) => ({ id, clientId: id, secret: 'test-app-secret' });
const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const registry = createRegistry([{
  hostname: 'tenant.ghe.com', label: 'Tenant', registrations: {
    portal: app('portal'), repository: app('repository'), copilot: { ...app('copilot'), scope: 'read:user' },
  },
}], { tenantId, registration: app('entra') });
const registration = registry.registration('tenant.ghe.com', 'repository');
const callback = 'https://factory.example/auth/github/callback';
const basic = { registration, callback, code: 'authorization-code', verifier: 'verifier', target: null };
const token = { access_token: 'ghu_delegated_fixture', token_type: 'BEARER', expires_in: 100, refresh_token: 'refresh-one' };
const tokens = { accessToken: 'ghu_delegated_fixture', refreshToken: 'refresh-one', expiresAt: 101_000 };

it('redeems only through the selected GHE.com app and verifies the exact repository using a delegated token', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(token))
    .mockResolvedValueOnce(Response.json({ id: 42, name: null, login: 'owner', avatar_url: 'https://avatar.example/a' }))
    .mockResolvedValueOnce(Response.json({ id: 234, name: 'Repo', owner: { id: 41, login: 'Org' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{
      id: 901, account: { id: 41 }, permissions: { issues: 'read', pull_requests: 'write' },
    }] }))
    .mockResolvedValueOnce(Response.json({ repositories: [{ id: 234 }] }));
  const url = new URL(authorizationUrl(registration, callback, 'opaque-state', basic.verifier));
  expect(url.origin).toBe('https://tenant.ghe.com');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).not.toBe(basic.verifier);
  expect(url.searchParams.get('redirect_uri')).toBe(callback);
  const target = registry.repository('https://tenant.ghe.com/org/repo', 'github').target;
  expect(await createOAuthTransport(fetcher, () => 1_000).redeem({ ...basic, target })).toEqual({
    subject: '42', label: 'owner', avatarUrl: 'https://avatar.example/a', tokens,
    repo: { id: '234', scope: '41', name: 'Repo', host: 'tenant.ghe.com', url: 'https://tenant.ghe.com/Org/Repo' },
  });
  expect(fetcher.mock.calls.map(([dest]) => dest)).toEqual([
    'https://tenant.ghe.com/login/oauth/access_token',
    'https://api.tenant.ghe.com/user', 'https://api.tenant.ghe.com/repos/org/repo',
    'https://api.tenant.ghe.com/user/installations?per_page=100&page=1',
    'https://api.tenant.ghe.com/user/installations/901/repositories?per_page=100&page=1',
  ]);
  const exchange = fetcher.mock.calls[0]?.[1];
  expect(exchange?.redirect).toBe('error');
  expect((exchange?.body as URLSearchParams).get('code_verifier')).toBe('verifier');
  expect((exchange?.body as URLSearchParams).get('client_id')).toBe('repository');
  expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('authorization')).toBe('Bearer ghu_delegated_fixture');
});

it('does not treat publicly readable GitHub repo metadata as proof of app installation access', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(token))
    .mockResolvedValueOnce(Response.json({ id: 42, login: 'owner' }))
    .mockResolvedValueOnce(Response.json({ id: 234, name: 'Repo', owner: { id: 41, login: 'Org' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{ id: 990, account: { id: 99 } }] }));
  const target = registry.repository('https://tenant.ghe.com/org/repo', 'github').target;
  await expect(createOAuthTransport(fetcher).redeem({ ...basic, target })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it('redeems Azure DevOps delegated authorization for the configured Entra tenant and Git project', async () => {
  const selected = registry.registration('azure-devops', 'repository');
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token_type: 'bearer', access_token: 'entra-token', expires_in: '3600' }))
    .mockResolvedValueOnce(Response.json({ id: 'identity-guid', displayName: 'Entra User' }))
    .mockResolvedValueOnce(Response.json({ id: 'repo-guid', name: 'Repo Name', project: { id: 'project-guid', name: 'One Project' } }));
  const target = registry.repository('https://dev.azure.com/org/One%20Project/_git/Repo%20Name', 'azure-devops').target;
  const result = await createOAuthTransport(fetcher, () => 1_000).redeem({ ...basic, registration: selected, target });
  expect(result.subject).toBe('identity-guid');
  expect(result.repo?.scope).toBe('project-guid');
  expect(result.repo?.url).toBe('https://dev.azure.com/org/One%20Project/_git/Repo%20Name');
  expect(result.tokens.refreshToken).toBeNull();
  expect(fetcher.mock.calls.map(([dest]) => dest)).toEqual([
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
    'https://dev.azure.com/org/One%20Project/_apis/git/repositories/Repo%20Name?api-version=7.1',
  ]);
  expect((fetcher.mock.calls[0]?.[1]?.body as URLSearchParams).get('scope')).toContain('499b84ac-1321-427f-aa17-267ca6975798/.default');
});

it('allows an OAuth user token for the Copilot registration without assigning entitlement', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ token_type: 'bearer', access_token: 'gho_fixture' }))
    .mockResolvedValueOnce(Response.json({ id: 42, name: 'User', avatar_url: 'http://unsafe.example' }));
  const selected = registry.registration('tenant.ghe.com', 'copilot');
  const result = await createOAuthTransport(fetcher).redeem({ ...basic, registration: selected });
  expect(result.avatarUrl).toBeNull();
  expect(result.tokens.expiresAt).toBeNull();
});

it.each([
  [() => new Response('', { status: 429, headers: { 'retry-after': '7' } }), 'RATE_LIMITED'],
  [() => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), 'RATE_LIMITED'],
  [() => new Response('', { status: 403, headers: { 'retry-after': '5' } }), 'RATE_LIMITED'],
  [() => new Response('', { status: 401 }), 'PROVIDER_ERROR'],
  [() => new Response('', { status: 403 }), 'PROVIDER_ERROR'],
  [() => new Response('', { status: 404 }), 'NOT_FOUND'],
  [() => new Response('', { status: 502 }), 'PROVIDER_ERROR'],
  [() => new Response('<html>private</html>'), 'PROVIDER_ERROR'],
  [() => Response.json([]), 'PROVIDER_ERROR'],
  [() => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'INVALID_REQUEST'],
  [() => Response.json({ error: 'bad_verification_code' }), 'INVALID_REQUEST'],
  [() => Response.json({ error: 'bad_refresh_token' }), 'INVALID_REQUEST'],
  [() => Response.json({ error: 'private_provider_detail' }), 'PROVIDER_ERROR'],
  [() => Response.json({ ...token, token_type: 'other' }), 'PROVIDER_ERROR'],
  [() => Response.json({ ...token, access_token: 'ghp_fixture' }), 'PROVIDER_ERROR'],
  [() => Response.json({ ...token, expires_in: 'bad' }), 'PROVIDER_ERROR'],
  [() => Response.json({ ...token, expires_in: 0 }), 'PROVIDER_ERROR'],
  [() => Response.json({ ...token, expires_in: 31536001 }), 'PROVIDER_ERROR'],
] as const)('maps failed redemption to a safe code without reading the profile (%#)', async (response, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  await expect(createOAuthTransport(fetcher).redeem(basic)).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([401, 403])('records protected profile status %s as a confirmed access denial', async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(token))
    .mockResolvedValueOnce(new Response('', { status }));
  await expect(createOAuthTransport(fetcher).redeem(basic)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it('does not report missing permission when the installation inventory cannot be verified', async () => {
  const upstream = () => vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(token))
    .mockResolvedValueOnce(Response.json({ id: 42, login: 'user' }))
    .mockResolvedValueOnce(Response.json({ id: 234, name: 'Repo', owner: { id: 41, login: 'Org' } }));
  const target = registry.repository('https://tenant.ghe.com/org/repo', 'github').target;
  const malformed = upstream().mockResolvedValueOnce(Response.json({ unexpected: [] }));
  await expect(createOAuthTransport(malformed).redeem({ ...basic, target })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: 100 + index, account: { id: 99 } }));
  const incomplete = upstream().mockImplementation(async () => Response.json({ installations: fullPage }));
  await expect(createOAuthTransport(incomplete).redeem({ ...basic, target })).rejects.toMatchObject({ code: 'ACCESS_UNVERIFIED' });
  expect(incomplete.mock.calls.at(-1)?.[0]).toContain('page=20');
});

it('does not follow redirects or propagate transport errors', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport detail'));
  await expect(createOAuthTransport(fetcher).redeem(basic)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});

it('preserves an unrotated refresh token and rejects a revoked or missing one', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'ghu_next_fixture', token_type: 'bearer', expires_in: 10 }))
    .mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  const transport = createOAuthTransport(fetcher, () => 1000);
  expect(await transport.refresh(registration, tokens)).toEqual({
    accessToken: 'ghu_next_fixture', refreshToken: 'refresh-one', expiresAt: 11_000,
  });

  await expect(transport.refresh(registration, tokens)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(() => transport.refresh(registration, { ...tokens, refreshToken: null })).toThrow('ACCESS_DENIED');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not classify a rejected app configuration as a revoked user grant', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'invalid_client' }, { status: 401 }));
  await expect(createOAuthTransport(fetcher).refresh(registration, tokens)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
});

it('denies an installation without the permissions needed by the repository grant', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(token))
    .mockResolvedValueOnce(Response.json({ id: 42, login: 'user' }))
    .mockResolvedValueOnce(Response.json({ id: 234, name: 'Repo', owner: { id: 41, login: 'Org' } }))
    .mockResolvedValueOnce(Response.json({ installations: [{ id: 901, account: { id: 41 }, permissions: { metadata: 'read' } }] }));
  const target = registry.repository('https://tenant.ghe.com/org/repo', 'github').target;
  await expect(createOAuthTransport(fetcher).redeem({ ...basic, target })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it.each([{ id: 'invalid id', login: 'user' }, { id: 0, login: 'user' }, { id: 1, login: '' }])(
  'rejects a provider profile without a safe immutable ID and label', async (person) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json(person));
    await expect(createOAuthTransport(fetcher).redeem(basic)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  },
);
