import { randomUUID, timingSafeEqual } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import type { ApiDto, AuthorizationIntent } from '../../shared/api/schemas.js';
import { sha256Hex } from '../digest.js';
import { ApiFailure } from '../http/problems.js';
import type { AuthorizationProvider, PortalModules, Requester } from '../http/portal-modules.js';
import type { CredentialVault, Tokens } from './credentials.js';
import { apiProvider, type Registration, type Registry, type RepoTarget } from './github-hosts.js';
import { authorizationUrl, RepositoryAuthorizationDenied, type createOAuthTransport, type VerifiedAuthorization } from './oauth.js';
import type { RepositoryAccess } from '../repositories/provider.js';
import {
  destination, fifteenMinutes, purposeOf, token, vaultBinding,
  type Grant, type Intent, type Pending, type Person,
} from './records.js';
import { createIdentityStore } from './store.js';

type Transport = Pick<ReturnType<typeof createOAuthTransport>, 'redeem' | 'refresh'>;
interface Options extends Transport {
  db: SQLite.Database;
  vault: CredentialVault;
  origin: string;
  registry: Registry;
  now?: () => number;
}

export function createIdentity({ db, vault, origin, registry, redeem, refresh, now = Date.now }: Options) {
  const inFlight = new Map<string, Promise<Tokens>>();
  const store = createIdentityStore({ db, registry, now });
  const { getSession, getGrant, getConnection, bound } = store;
  const callbackUrl = (provider: AuthorizationProvider) => `${origin}/auth/${provider}/callback`;

  function selectAuthorization(
    provider: AuthorizationProvider, intent: AuthorizationIntent, sessionId: string, requester: Requester | null,
  ) {
    const session = getSession(sessionId);
    const owner = requester?.id ?? null;
    const purpose = purposeOf(intent);
    if (!session || session.user_id !== owner || (purpose !== 'portal' && owner === null)) throw new ApiFailure('AUTH_REQUIRED');
    let hostId: string;
    let target: RepoTarget | null = null;
    let connection: Intent['connection'] = null;
    if ('hostId' in intent) hostId = intent.hostId;
    else if (intent.intent === 'reconnect_copilot') {
      const existing = getGrant(intent.copilotAccountId, owner ?? '');
      if (existing?.purpose !== 'copilot' || existing.superseded_by !== null) throw new ApiFailure('NOT_FOUND');
      hostId = existing.host_id;
    } else {
      const reconnect = intent.intent === 'reconnect' ? getConnection(intent.connectionId, owner ?? '') : undefined;
      if (intent.intent === 'reconnect' && !reconnect) throw new ApiFailure('NOT_FOUND');
      const selection = registry.repository(reconnect?.canonical_url ?? ('repositoryUrl' in intent ? intent.repositoryUrl : ''), provider);
      hostId = selection.hostId;
      target = selection.target;
      const { host, scope, project, name } = target;
      const repoPath = [scope, ...(project === null ? [] : [project, '_git']), name].map(encodeURIComponent).join('/');
      const existing = reconnect ?? store.findConnection(owner ?? '', provider, `https://${host}/${repoPath}`);
      if (existing) connection = { id: existing.id, generation: existing.generation };
    }
    const registration = registry.registration(hostId, purpose);
    if (registration.provider !== provider) throw new ApiFailure('INVALID_REQUEST');
    return { registration, pending: { intent, target, connection } satisfies Intent };
  }

  function beginAuthorization(
    provider: AuthorizationProvider, intent: AuthorizationIntent, sessionId: string, requester: Requester | null,
  ) {
    const { registration, pending } = selectAuthorization(provider, intent, sessionId, requester);
    if (registration.flow === 'device') throw new ApiFailure('CAPABILITY_UNAVAILABLE');
    const state = token();
    const verifier = token();
    db.prepare('DELETE FROM oauth_intents WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO oauth_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256Hex(state), sha256Hex(sessionId), provider, registration.hostId, registration.binding,
        JSON.stringify(pending), verifier, now() + fifteenMinutes);
    return { authorizationUrl: authorizationUrl(registration, callbackUrl(provider), state, verifier) };
  }

  async function completeAuthorization(provider: AuthorizationProvider, sessionId: string, input: { state: string; code: string | null }) {
    const session = getSession(sessionId);
    if (!session) throw new ApiFailure('INVALID_REQUEST');
    const pending = db.prepare<[string, string, string, number], Pending>(`DELETE FROM oauth_intents
      WHERE state_hash=? AND session_hash=? AND provider=? AND expires_at>?
      RETURNING host_id, registration_binding, intent_json, verifier`)
      .get(sha256Hex(input.state), sha256Hex(sessionId), provider, now());
    if (!pending) throw new ApiFailure('INVALID_REQUEST');
    const intent = JSON.parse(pending.intent_json) as Intent;
    const purpose = purposeOf(intent.intent);
    const registration = registry.bound(pending.host_id, purpose, pending.registration_binding);
    if (!registration || registration.provider !== provider) throw new ApiFailure('INVALID_REQUEST');
    if (input.code === null) return { redirectTo: destination[purpose] };
    const proof = await redeem({
      registration, callback: callbackUrl(provider), code: input.code, verifier: pending.verifier, target: intent.target,
    }).catch((error: unknown) => {
      if (error instanceof RepositoryAuthorizationDenied && session.user_id && getSession(sessionId)) {
        store.recordRepositoryDenial({ id: session.user_id }, intent, error.subject);
      }
      throw error;
    });
    return persistAuthorization(sessionId, intent, registration, proof);
  }

  function persistAuthorization(sessionId: string, intent: Intent, registration: Registration,
    proof: VerifiedAuthorization, authorize?: () => void) {
    const session = getSession(sessionId);
    if (!session) throw new ApiFailure('AUTH_REQUIRED');
    const purpose = purposeOf(intent.intent);
    if (!registry.bound(registration.hostId, purpose, registration.binding)) throw new ApiFailure('ACCESS_DENIED');
    const reconnectCopilot = intent.intent.intent === 'reconnect_copilot' ? intent.intent.copilotAccountId : null;
    let newRef: string | undefined;
    let previousRef: string | undefined;
    let supersededRef: string | undefined;
    let result: { redirectTo: string; sessionId?: string };
    try {
      result = db.transaction(() => {
        authorize?.();
        const person = store.persistPerson(purpose === 'portal' ? null : session.user_id, registration, proof);
        const old = db.prepare<[string, string, string, string], Grant>(
          'SELECT * FROM delegated_grants WHERE user_id=? AND identity_id=? AND purpose=? AND registration_binding=?',
        ).get(person.user_id, person.id, purpose, registration.binding);
        const previousAccount = reconnectCopilot ? getGrant(reconnectCopilot, person.user_id) : undefined;
        if (reconnectCopilot && (previousAccount?.purpose !== 'copilot' || previousAccount.superseded_by !== null ||
            previousAccount.identity_id !== person.id || previousAccount.host_id !== registration.hostId)) {
          throw new ApiFailure('COPILOT_REAUTH_REQUIRED');
        }
        const grant = {
          id: old?.id ?? randomUUID(), user_id: person.user_id, identity_id: person.id, purpose,
          host_id: registration.hostId, registration_binding: registration.binding,
        };
        if (purpose === 'repository') {
          if (!proof.repo) throw new ApiFailure('PROVIDER_ERROR');
          if (old) store.persistConnection(person, registration, intent, proof.repo, old.id);
        }
        newRef = vault.put(vaultBinding(grant), proof.tokens);
        previousRef = old?.credential_ref;
        db.prepare(`INSERT INTO delegated_grants
          (id,user_id,identity_id,host_id,purpose,registration_binding,credential_ref,revoked_at) VALUES (?,?,?,?,?,?,?,NULL)
          ON CONFLICT(id) DO UPDATE SET credential_ref=excluded.credential_ref,revoked_at=NULL,superseded_by=NULL`)
          .run(grant.id, grant.user_id, grant.identity_id, grant.host_id, grant.purpose, grant.registration_binding, newRef);
        if (purpose === 'repository' && proof.repo && !old) store.persistConnection(person, registration, intent, proof.repo, grant.id);
        if (previousAccount && previousAccount.id !== grant.id) {
          db.prepare('UPDATE delegated_grants SET superseded_by=?,revoked_at=? WHERE id=?')
            .run(grant.id, now(), previousAccount.id);
          db.prepare('UPDATE copilot_defaults SET account_id=? WHERE user_id=? AND account_id=?')
            .run(grant.id, grant.user_id, previousAccount.id);
          supersededRef = previousAccount.credential_ref;
        }
        if (purpose !== 'portal') return { redirectTo: destination[purpose] };
        db.prepare('DELETE FROM portal_sessions WHERE session_hash=?').run(sha256Hex(sessionId));
        return { redirectTo: '/', sessionId: store.createSession(person.user_id, person.id, registration).sessionId };
      }).immediate();
    } catch (error) {
      if (newRef) vault.delete(newRef);
      throw error;
    }
    if (previousRef) vault.delete(previousRef);
    if (supersededRef) vault.delete(supersededRef);
    return result;
  }

  async function readTokens(grantId: string, requester: Requester): Promise<Tokens> {
    const key = JSON.stringify([requester.id, grantId]);
    const current = inFlight.get(key);
    if (current) return current;
    const grant = getGrant(grantId, requester.id);
    if (!grant) throw new ApiFailure('NOT_FOUND');
    const registration = bound(grant);
    if (!registration || grant.revoked_at !== null) throw new ApiFailure('ACCESS_DENIED');
    const prior = vault.get(grant.credential_ref, vaultBinding(grant));
    if (!prior) throw new ApiFailure('ACCESS_UNVERIFIED');
    if (prior.expiresAt === null || prior.expiresAt > now()) return prior;
    const rotate = async () => {
      try {
        const next = await refresh(registration, prior);
        const ref = vault.put(vaultBinding(grant), next);
        const changed = db.prepare(`UPDATE delegated_grants SET credential_ref=? WHERE id=? AND user_id=?
          AND credential_ref=? AND revoked_at IS NULL`).run(ref, grant.id, requester.id, grant.credential_ref);
        if (changed.changes === 0) {
          vault.delete(ref);
          throw new ApiFailure('ACCESS_UNVERIFIED');
        }
        vault.delete(grant.credential_ref);
        return next;
      } catch (error) {
        if (error instanceof ApiFailure && error.code === 'ACCESS_DENIED') {
          db.transaction(() => {
            const changed = db.prepare('UPDATE delegated_grants SET revoked_at=? WHERE id=? AND credential_ref=?')
              .run(now(), grant.id, grant.credential_ref);
            if (changed.changes !== 0) db.prepare('UPDATE connection_access SET access_verified_at=NULL, denied_at=? WHERE grant_id=?')
              .run(now(), grant.id);
          }).immediate();
        }
        throw error;
      } finally {
        inFlight.delete(key);
      }
    };
    const result = Promise.resolve().then(rotate);
    inFlight.set(key, result);
    return result;
  }

  const identity = {
    resolveRequester(sessionId: string): Requester | null {
      const session = getSession(sessionId);
      return session?.user_id ? { id: session.user_id } : null;
    },
    csrf(sessionId: string | undefined): { csrfToken: string; sessionId?: string } {
      const session = sessionId ? getSession(sessionId) : undefined;
      return session ? { csrfToken: session.csrf_token } : store.createSession(null, null);
    },
    verifyCsrf(sessionId: string, csrf: string) {
      const session = getSession(sessionId);
      return !!session && timingSafeEqual(Buffer.from(sha256Hex(csrf)), Buffer.from(sha256Hex(session.csrf_token)));
    },
    githubHosts: registry.githubHosts,
    beginAuthorization,
    completeAuthorization,
    logout(requester: Requester, sessionId: string): void {
      db.prepare('DELETE FROM portal_sessions WHERE user_id=? AND session_hash=?').run(requester.id, sha256Hex(sessionId));
    },
    me(requester: Requester): ApiDto<'me'> {
      const person = db.prepare<[string], Person>("SELECT * FROM identities WHERE user_id=? AND issuer LIKE 'portal:%'").get(requester.id);
      if (!person) throw new ApiFailure('AUTH_REQUIRED');
      const accounts = db.prepare<[string], Person>(`SELECT DISTINCT i.* FROM identities i
        JOIN delegated_grants g ON g.identity_id=i.id WHERE i.user_id=? AND g.purpose IN ('portal','repository')`).all(requester.id);
      return {
        user: { id: requester.id, displayName: person.display_name, avatarUrl: person.avatar_url },
        accounts: accounts.map((item) => ({
          id: item.id, provider: item.provider, host: item.issuer.replace(/^portal:/, ''),
          accountLabel: item.display_name, avatarUrl: item.avatar_url,
        })),
      };
    },
    copilotAccounts(requester: Requester): ApiDto<'copilotAccounts'> {
      const rows = db.prepare<[string], Grant & { display_name: string }>(`SELECT g.*, i.display_name FROM delegated_grants g
        JOIN identities i ON i.id=g.identity_id WHERE g.user_id=? AND g.purpose='copilot' AND g.superseded_by IS NULL
        ORDER BY i.display_name,g.id`).all(requester.id);
      const selected = db.prepare<[string], { account_id: string }>('SELECT account_id FROM copilot_defaults WHERE user_id=?').get(requester.id);
      return {
        items: rows.map((g) => ({
          id: g.id, host: g.host_id, accountLabel: g.display_name, entitlement: 'unverified',
          state: g.revoked_at === null && bound(g) ? 'connected' : 'needs_auth',
        })),
        defaultAccountId: selected?.account_id ?? null,
      };
    },
    setDefaultCopilotAccount(requester: Requester, accountId: string | null): void {
      if (accountId === null) {
        db.prepare('DELETE FROM copilot_defaults WHERE user_id=?').run(requester.id);
        return;
      }
      const grant = getGrant(accountId, requester.id);
      if (grant?.purpose !== 'copilot') throw new ApiFailure('NOT_FOUND');
      if (!bound(grant) || grant.revoked_at !== null) throw new ApiFailure('COPILOT_REAUTH_REQUIRED');
      db.prepare(`INSERT INTO copilot_defaults (user_id,account_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET account_id=excluded.account_id`)
        .run(requester.id, accountId);
    },
  } satisfies PortalModules['identity'];

  return {
    ...identity,
    readGrant: store.readGrant,
    readTokens,
    selectAuthorization,
    persistAuthorization,
    isRequesterSession(sessionHash: string, requester: Requester): boolean {
      return store.getSessionByHash(sessionHash)?.user_id === requester.id;
    },
    recordRepositoryDenial: store.recordRepositoryDenial,
    disconnectRepository: store.disconnectRepository,
    repositoryContext(connectionId: string, requester: Requester): RepositoryAccess | undefined {
      const row = getConnection(connectionId, requester.id);
      if (!row?.grant_id) return undefined;
      const grant = getGrant(row.grant_id, requester.id);
      if (!grant || !bound(grant)) throw new ApiFailure('ACCESS_DENIED');
      const { target } = registry.repository(row.canonical_url, apiProvider(row.provider));
      return {
        id: row.id, repoId: row.repo_id, grantId: row.grant_id, generation: row.generation, provider: row.provider,
        repositoryId: row.provider_repo_id, scope: row.provider_scope, target, subject: row.subject,
      };
    },
    markConnectionVerified: store.markConnectionVerified,
    connections(requester: Requester): ApiDto<'connections'> {
      return {
        items: store.listConnections(requester.id).map((row) => ({
          id: row.id, repoId: row.repo_id, name: row.name || row.canonical_url, provider: row.provider, host: row.canonical_host,
          repositoryUrl: row.canonical_url, accountLabel: row.display_name || row.identity_id,
          state: store.readGrant(row.id, requester) === 'denied' ? 'needs_auth' : 'connected',
        })),
      };
    },
    markConnectionDenied: store.markConnectionDenied,
  };
}
