import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { ApiFailure } from '../http/problems.js';
import { openCredentialVault } from './credentials.js';
import { createIdentity } from './module.js';
import { createRegistry } from './github-hosts.js';
import { RepositoryAuthorizationDenied, type VerifiedAuthorization } from './oauth.js';

const origin = 'https://factory.example';
const reg = (id: string) => ({ id, clientId: id, secret: 'test-app-secret' });
const profile = (host: string) => ({
  hostname: host, label: host, registrations: { portal: reg(`${host}-portal`), copilot: reg(`${host}-copilot`), repository: reg(`${host}-repo`) },
});
const github = profile('github.com');
const enterprise = profile('tenant.ghe.com');
const authorization: VerifiedAuthorization = {
  subject: '42', label: 'Test User', avatarUrl: null,
  tokens: { accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: 10_000_000 },
};
const repo = {
  id: '101', host: 'github.com', scope: 'org', name: 'Repo', url: 'https://github.com/org/repo',
};
let directory: string;
let db: ReturnType<typeof openDatabase>;
let vault: ReturnType<typeof openCredentialVault>;
let now: number;
const redeem = vi.fn(async (): Promise<VerifiedAuthorization> => authorization);
const refresh = vi.fn(async () => authorization.tokens);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'factory-identity-'));
  db = openDatabase(join(directory, 'factory.sqlite'));
  migrate(db);
  vault = openCredentialVault(join(directory, 'credentials.sqlite'), randomBytes(32));
  now = 1_000;
  redeem.mockReset().mockResolvedValue(authorization);
  refresh.mockReset().mockResolvedValue(authorization.tokens);
});

afterEach(() => {
  vault.close();
  db.close();
  rmSync(directory, { recursive: true });
});

function service(hosts = [github, enterprise]) {
  return createIdentity({ db, vault, origin, registry: createRegistry(hosts), redeem, refresh, now: () => now });
}

async function signIn(identity = service(), hostId = 'github.com') {
  const anonymous = identity.csrf(undefined);
  if (!anonymous.sessionId) throw new Error('Expected pre-session');
  const { authorizationUrl } = identity.beginAuthorization('github', { intent: 'sign_in', hostId }, anonymous.sessionId, null);
  const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
  const callback = await identity.completeAuthorization('github', anonymous.sessionId, { state, code: 'code' });
  if (!callback.sessionId) throw new Error('Expected rotated session');
  const requester = identity.resolveRequester(callback.sessionId);
  if (!requester) throw new Error('Expected requester');
  return { requester, session: callback.sessionId, anonymous, state };
}

it('uses an exact tenant registration, rotates the session and never replays an OAuth state', async () => {
  const identity = service();
  const signed = await signIn(identity, 'tenant.ghe.com');
  expect(identity.resolveRequester(signed.anonymous.sessionId ?? '')).toBeNull();
  expect(identity.me(signed.requester).user.displayName).toBe('Test User');
  expect(redeem).toHaveBeenCalledTimes(1);
  expect(redeem.mock.calls).toHaveLength(1);
  await expect(identity.completeAuthorization('github', signed.session, { state: signed.state, code: 'again' }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(redeem).toHaveBeenCalledTimes(1);
  const other = await signIn(identity);
  expect(other.requester.id).not.toBe(signed.requester.id);
  expect(service([github]).resolveRequester(signed.session)).toBeNull();
  expect(service([github]).resolveRequester(other.session)).toEqual(other.requester);
});

it('rejects unknown and changed hosts or registrations and the wrong browser without upstream requests', async () => {
  const identity = service();
  const { sessionId } = identity.csrf(undefined);
  if (!sessionId) throw new Error('Missing session');
  expect(() => identity.beginAuthorization('github', { intent: 'sign_in', hostId: 'unknown.ghe.com' }, sessionId, null))
    .toThrow('INVALID_REQUEST');
  const { authorizationUrl } = identity.beginAuthorization('github', { intent: 'sign_in', hostId: 'tenant.ghe.com' }, sessionId, null);
  const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
  await expect(identity.completeAuthorization('azure-devops', sessionId, { state, code: 'wrong' }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(identity.completeAuthorization('github', 'other-browser', { state, code: 'wrong' }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const changed = service([{ ...enterprise, registrations: { ...enterprise.registrations, portal: reg('different') } }]);
  await expect(changed.completeAuthorization('github', sessionId, { state, code: 'wrong' }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(redeem).not.toHaveBeenCalled();
});

it('keeps Copilot grants separate and expires repository access at exactly 15 minutes', async () => {
  const identity = service();
  const { requester, session } = await signIn(identity);
  const begin = (intent: Parameters<typeof identity.beginAuthorization>[1]) => {
    const { authorizationUrl } = identity.beginAuthorization('github', intent, session, requester);
    return new URL(authorizationUrl).searchParams.get('state') ?? '';
  };
  const complete = (state: string, code: string | null = 'code') =>
    identity.completeAuthorization('github', session, { state, code });
  redeem.mockResolvedValueOnce({ ...authorization, repo });
  await complete(begin({ intent: 'connect', repositoryUrl: repo.url }));
  const connection = identity.connections(requester).items[0];
  if (!connection) throw new Error('Missing repo connection');
  expect(identity.readGrant(connection.id, requester, now + 899_999)).toBe('valid');
  expect(identity.readGrant(connection.id, requester, now + 900_000)).toBe('unverified');
  now += 900_000;
  const changed = await complete(begin({ intent: 'link_copilot', hostId: 'github.com' }));
  expect(changed.sessionId).toBeUndefined();
  const copilot = identity.copilotAccounts(requester).items[0];
  if (!copilot) throw new Error('Missing Copilot account');
  identity.setDefaultCopilotAccount(requester, copilot.id);
  expect(identity.copilotAccounts(requester).defaultAccountId).toBe(copilot.id);
  expect(identity.readGrant(connection.id, requester, now)).toBe('unverified');
  expect(identity.resolveRequester(session)).toEqual(requester);
  expect((await complete(begin({ intent: 'reconnect', connectionId: connection.id }), null)).redirectTo).toBe('/settings/repository');
  expect(identity.readGrant(connection.id, requester, now)).toBe('unverified');
  expect(identity.markConnectionDenied(connection.id, requester, 1)).toBe(true);
  expect(identity.readGrant(connection.id, requester, now)).toBe('denied');
  expect(identity.readGrant(connection.id, { id: 'other' }, now)).toBe('denied');
  expect(readFileSync(join(directory, 'factory.sqlite-wal')).includes('test-access-token')).toBe(false);
  expect(readFileSync(join(directory, 'credentials.sqlite-wal')).includes('test-access-token')).toBe(false);
});

function start(
  identity: ReturnType<typeof service>, signed: Awaited<ReturnType<typeof signIn>>,
  intent: Parameters<ReturnType<typeof service>['beginAuthorization']>[1],
) {
  const url = new URL(identity.beginAuthorization('github', intent, signed.session, signed.requester).authorizationUrl);
  return (code: string | null = 'code') =>
    identity.completeAuthorization('github', signed.session, { state: url.searchParams.get('state') ?? '', code });
}

it('does not promote delegated identities to portal principals and never rebinds a connection to another account', async () => {
  const identity = service();
  const signed = await signIn(identity);
  const open = { intent: 'connect', repositoryUrl: repo.url } as const;
  const other = { ...authorization, subject: 'another-account', repo };
  redeem.mockResolvedValueOnce(other);
  await start(identity, signed, open)();
  const connection = identity.connections(signed.requester).items[0];
  if (!connection) throw new Error('Missing connection');
  redeem.mockResolvedValueOnce(other);
  await start(identity, signed, open)();
  expect(identity.connections(signed.requester).items.map(({ id }) => id)).toEqual([connection.id]);
  expect(identity.markConnectionDenied(connection.id, signed.requester, 1)).toBe(false);

  await expect(start(identity, signed, open)()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  redeem.mockResolvedValueOnce({ ...authorization, repo });
  await expect(start(identity, signed, open)()).rejects.toMatchObject({ code: 'CONNECTION_ACCOUNT_CONFLICT' });
  const reconnect = { intent: 'reconnect', connectionId: connection.id } as const;
  redeem.mockResolvedValueOnce({ ...other, repo: { ...repo, id: 'another-repo' } });
  await expect(start(identity, signed, reconnect)()).rejects.toMatchObject({ code: 'CONNECTION_ACCOUNT_CONFLICT' });
  redeem.mockResolvedValueOnce(other);
  await start(identity, signed, reconnect)();
  expect(identity.markConnectionDenied(connection.id, signed.requester, 1)).toBe(false);
  expect(identity.readGrant(connection.id, signed.requester, now)).toBe('valid');
  expect(identity.readGrant(connection.id, signed.requester, now - 1)).toBe('unverified');

  redeem.mockResolvedValueOnce(other);
  const otherPortal = await signIn(identity);
  expect(otherPortal.requester.id).not.toBe(signed.requester.id);
  expect(identity.connections(otherPortal.requester).items).toEqual([]);
  expect(() => start(identity, otherPortal, reconnect)).toThrow('NOT_FOUND');
  redeem.mockResolvedValueOnce(other);
  await expect(start(identity, otherPortal, open)()).rejects.toMatchObject({ code: 'CONNECTION_ACCOUNT_CONFLICT' });
  expect(identity.me(signed.requester).accounts).toHaveLength(2);
});

it('does not revive unverified sibling repositories or allow grants to cross purpose boundaries', async () => {
  const identity = service();
  const signed = await signIn(identity);
  const secondRepo = { ...repo, id: '102', name: 'Second', url: 'https://github.com/org/second' };
  const connect = async (verified: typeof repo, expiresAt: number) => {
    redeem.mockResolvedValueOnce({ ...authorization, tokens: { ...authorization.tokens, expiresAt }, repo: verified });
    await start(identity, signed, { intent: 'connect', repositoryUrl: verified.url })();
  };
  await connect(repo, now + 1);
  await connect(secondRepo, now + 1);
  const [first, second] = identity.connections(signed.requester).items;
  if (!first || !second) throw new Error('Missing connection');
  const grant = (db.prepare("SELECT id FROM delegated_grants WHERE purpose='repository'").get() as { id: string }).id;
  now += 2;
  refresh.mockRejectedValueOnce(new ApiFailure('ACCESS_DENIED'));
  await expect(identity.readTokens(grant, signed.requester)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(identity.readGrant(second.id, signed.requester)).toBe('denied');
  await connect(repo, now + 60_000);
  expect(identity.readGrant(first.id, signed.requester)).toBe('valid');
  expect(identity.readGrant(second.id, signed.requester)).not.toBe('valid');
  await start(identity, signed, { intent: 'link_copilot', hostId: 'github.com' })();
  const copilot = identity.copilotAccounts(signed.requester).items[0];
  if (!copilot) throw new Error('Missing account');
  expect(() => db.prepare('UPDATE connection_access SET grant_id=? WHERE connection_id=?').run(copilot.id, first.id)).toThrow(/FOREIGN KEY/);
  expect(() => db.prepare('INSERT INTO copilot_defaults (user_id,account_id) VALUES (?,?)').run(signed.requester.id, grant))
    .toThrow(/FOREIGN KEY/);
});

it('does not bind a repository redirect or a changed generation after authorization began', async () => {
  const identity = service();
  const signed = await signIn(identity);
  const open = { intent: 'connect', repositoryUrl: repo.url } as const;
  redeem.mockResolvedValueOnce({ ...authorization, repo: { ...repo, host: 'tenant.ghe.com', url: 'https://tenant.ghe.com/org/repo' } });
  await expect(start(identity, signed, open)()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  expect(identity.connections(signed.requester).items).toEqual([]);
  redeem.mockResolvedValueOnce({ ...authorization, repo });
  await start(identity, signed, open)();
  const connection = identity.connections(signed.requester).items[0];
  if (!connection) throw new Error('Missing connection');
  const reconnect = start(identity, signed, { intent: 'reconnect', connectionId: connection.id });
  db.prepare('UPDATE repo_connections SET generation=generation+1 WHERE id=?').run(connection.id);
  redeem.mockResolvedValueOnce({ ...authorization, repo });
  await expect(reconnect()).rejects.toMatchObject({ code: 'CONNECTION_ACCOUNT_CONFLICT' });
  expect(identity.readGrant(connection.id, signed.requester)).toBe('unverified');
});

it.each([false, true])('rejects a connect callback after a newer authorization (initially connected: %s)', async (initiallyConnected) => {
  const identity = service();
  const signed = await signIn(identity);
  const connect = { intent: 'connect', repositoryUrl: repo.url } as const;
  const proof = { ...authorization, repo };
  if (initiallyConnected) {
    redeem.mockResolvedValueOnce(proof);
    await start(identity, signed, connect)();
  }
  const delayed = start(identity, signed, { ...connect, repositoryUrl: 'https://GITHUB.com/ORG/Repo/' });
  const connection = identity.connections(signed.requester).items[0];
  redeem.mockResolvedValueOnce(proof);
  await start(identity, signed, connection ? { intent: 'reconnect', connectionId: connection.id } : connect)();
  redeem.mockResolvedValueOnce(proof);
  await expect(delayed()).rejects.toMatchObject({ code: 'CONNECTION_ACCOUNT_CONFLICT' });
  expect(identity.connections(signed.requester).items).toHaveLength(1);
  if (connection) expect(identity.readGrant(connection.id, signed.requester)).toBe('valid');
});

it('serializes exact-grant refresh and persists rotation without changing portal or repository access', async () => {
  const identity = service();
  const signed = await signIn(identity);
  await start(identity, signed, { intent: 'link_copilot', hostId: 'github.com' })();
  const account = identity.copilotAccounts(signed.requester).items[0];
  if (!account) throw new Error('Missing account');
  const owner = signed.requester;
  await expect(identity.readTokens(account.id, { id: 'other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await identity.readTokens(account.id, owner)).toEqual(authorization.tokens);
  now = 10_000_001;
  const next = { accessToken: 'rotated', refreshToken: 'new-refresh', expiresAt: now + 30_000 };
  refresh.mockResolvedValueOnce(next);
  expect(await Promise.all([identity.readTokens(account.id, owner), identity.readTokens(account.id, owner)])).toEqual([next, next]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(await service().readTokens(account.id, owner)).toEqual(next);
  const reconnect = { intent: 'reconnect_copilot', copilotAccountId: account.id } as const;
  redeem.mockResolvedValueOnce({ ...authorization, subject: 'wrong-account' });
  await expect(start(identity, signed, reconnect)()).rejects.toMatchObject({ code: 'COPILOT_REAUTH_REQUIRED' });
  expect(() => start(identity, signed, { ...reconnect, copilotAccountId: 'missing' })).toThrow('NOT_FOUND');
  expect(() => identity.setDefaultCopilotAccount(owner, 'missing')).toThrow('NOT_FOUND');
  identity.setDefaultCopilotAccount(owner, account.id);
  identity.setDefaultCopilotAccount(owner, null);
  expect(identity.copilotAccounts(owner).defaultAccountId).toBeNull();
  now += 30_001;
  refresh.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
  await expect(identity.readTokens(account.id, owner)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  refresh.mockRejectedValueOnce(new ApiFailure('ACCESS_DENIED'));
  await expect(identity.readTokens(account.id, owner)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await expect(identity.readTokens(account.id, owner)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(identity.copilotAccounts(owner).items[0]?.state).toBe('needs_auth');
  expect(() => identity.setDefaultCopilotAccount(owner, account.id)).toThrow('COPILOT_REAUTH_REQUIRED');
  expect(identity.resolveRequester(signed.session)).toEqual(owner);
});

it('rejects late callbacks and revoked sessions without stealing the original principal', async () => {
  const identity = service();
  const signed = await signIn(identity);
  const same = identity.csrf(signed.session);
  expect(same.sessionId).toBeUndefined();
  expect(identity.verifyCsrf(signed.session, same.csrfToken)).toBe(true);
  expect(identity.verifyCsrf(signed.session, 'wrong')).toBe(false);
  expect(identity.verifyCsrf('unknown', same.csrfToken)).toBe(false);
  expect(() => identity.beginAuthorization('github', { intent: 'link_copilot', hostId: 'github.com' }, signed.session, null))
    .toThrow('AUTH_REQUIRED');
  expect(() => identity.beginAuthorization('azure-devops', { intent: 'sign_in', hostId: 'github.com' }, signed.session, signed.requester))
    .toThrow('INVALID_REQUEST');
  const stale = start(identity, signed, { intent: 'link_copilot', hostId: 'github.com' });
  now += 900_000;
  await expect(stale()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const inflight = start(identity, signed, { intent: 'link_copilot', hostId: 'github.com' });
  redeem.mockImplementationOnce(async () => {
    identity.logout(signed.requester, signed.session);
    return authorization;
  });
  await expect(inflight()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(identity.resolveRequester(signed.session)).toBeNull();
  expect(identity.copilotAccounts(signed.requester).items).toEqual([]);
  expect(() => identity.me({ id: 'unknown' })).toThrow('AUTH_REQUIRED');
});

it('reauthorizes the same Copilot account under a new registration, preserving its selected default', async () => {
  const identity = service();
  const signed = await signIn(identity);
  await start(identity, signed, { intent: 'link_copilot', hostId: 'github.com' })();
  const old = identity.copilotAccounts(signed.requester).items[0];
  if (!old) throw new Error('Missing Copilot account');
  identity.setDefaultCopilotAccount(signed.requester, old.id);
  const replacement = service([{ ...github, registrations: { ...github.registrations, copilot: reg('replacement-copilot') } }]);
  expect(replacement.copilotAccounts(signed.requester).items[0]?.state).toBe('needs_auth');
  await start(replacement, signed, { intent: 'reconnect_copilot', copilotAccountId: old.id })();
  const result = replacement.copilotAccounts(signed.requester);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.state).toBe('connected');
  expect(result.defaultAccountId).toBe(result.items[0]?.id);
  await expect(replacement.readTokens(old.id, signed.requester)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  const active = result.items[0];
  if (!active) throw new Error('Missing replacement account');
  await start(identity, signed, { intent: 'reconnect_copilot', copilotAccountId: active.id })();
  expect(identity.copilotAccounts(signed.requester)).toMatchObject({
    items: [{ id: old.id, state: 'connected' }], defaultAccountId: old.id,
  });
});

it('invalidates a reconnect denial only for the verified bound account and generation', async () => {
  const identity = service();
  const signed = await signIn(identity);
  redeem.mockResolvedValueOnce({ ...authorization, repo });
  await start(identity, signed, { intent: 'connect', repositoryUrl: repo.url })();
  const connection = identity.connections(signed.requester).items[0];
  if (!connection) throw new Error('Missing connection');
  const reconnect = { intent: 'reconnect', connectionId: connection.id } as const;
  redeem.mockRejectedValueOnce(new RepositoryAuthorizationDenied('different'));
  await expect(start(identity, signed, reconnect)()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(identity.readGrant(connection.id, signed.requester)).toBe('valid');
  redeem.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
  await expect(start(identity, signed, reconnect)()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  expect(identity.readGrant(connection.id, signed.requester)).toBe('valid');
  const replacement = service([{ ...github, registrations: { ...github.registrations, repository: reg('replacement-repo') } }]);
  expect(replacement.connections(signed.requester).items[0]?.state).toBe('needs_auth');
  expect(replacement.readGrant(connection.id, signed.requester)).toBe('denied');
  redeem.mockRejectedValueOnce(new RepositoryAuthorizationDenied('42'));
  await expect(start(identity, signed, reconnect)()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(identity.readGrant(connection.id, signed.requester)).toBe('denied');
});

it('preserves v1 connection ownership after exact portal proof without adopting later delegated links', async () => {
  const legacyDb = openDatabase(join(directory, 'legacy.sqlite'));
  try {
    migrate(legacyDb, [{ version: 1, sql: readFileSync(new URL('../persistence/001-foundation.sql', import.meta.url), 'utf8') }]);
    legacyDb.exec(`
      INSERT INTO users VALUES ('legacy-owner');
      INSERT INTO identities VALUES ('legacy-identity','legacy-owner','github','github.com','42');
      INSERT INTO repositories VALUES ('legacy-repo','github','github.com','org','101','https://github.com/org/repo');
      INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at)
        VALUES ('legacy-connection','legacy-repo','legacy-owner','legacy-identity',0);
    `);
    migrate(legacyDb);
    const identity = createIdentity({ db: legacyDb, vault, origin, registry: createRegistry([github]), redeem, refresh, now: () => now });
    const signed = await signIn(identity);
    expect(signed.requester.id).toBe('legacy-owner');
    expect(identity.connections(signed.requester).items[0]?.id).toBe('legacy-connection');
    redeem.mockResolvedValueOnce({ ...authorization, repo });
    await start(identity, signed, { intent: 'reconnect', connectionId: 'legacy-connection' })();
    expect(identity.readGrant('legacy-connection', signed.requester)).toBe('valid');
  } finally {
    legacyDb.close();
  }
});
