import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import type { ApiDto, AuthorizationIntent } from '../../shared/api/schemas.js';
import { ApiFailure } from '../http/problems.js';
import type { AuthorizationProvider, PortalModules, Requester } from '../http/portal-modules.js';
import type { CredentialVault, Tokens } from './credentials.js';
import type { Purpose, Registration, Registry, RepoTarget } from './github-hosts.js';
import { authorizationUrl, type createOAuthTransport, type VerifiedAuthorization, type VerifiedRepository } from './oauth.js';

const fifteenMinutes = 900_000;
const sessionAge = 28_800_000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const purposeOf = (intent: AuthorizationIntent): Purpose =>
  intent.intent === 'sign_in' ? 'portal' :
    intent.intent === 'link_copilot' || intent.intent === 'reconnect_copilot' ? 'copilot' : 'repository';
const destination = { portal: '/', copilot: '/settings/copilot', repository: '/settings/repository' } as const;
const connectionQuery = `
  SELECT c.id, c.repo_id, c.identity_id, c.generation, r.canonical_host, r.provider,
         r.provider_repo_id, r.provider_scope, r.canonical_url, r.name, i.display_name,
         a.grant_id, a.generation AS verified_generation, a.access_verified_at, a.denied_at
  FROM repo_connections c JOIN repositories r ON r.id = c.repo_id
  JOIN identities i ON i.id = c.identity_id LEFT JOIN connection_access a ON a.connection_id = c.id
  WHERE c.user_id = ? AND c.retired_at IS NULL`;
interface Connection {
  id: string; repo_id: string; identity_id: string; generation: number; canonical_host: string;
  provider: 'github' | 'azure_devops'; provider_repo_id: string; provider_scope: string;
  canonical_url: string; name: string; display_name: string; grant_id: string | null;
  verified_generation: number | null; access_verified_at: number | null; denied_at: number | null;
}
interface Person {
  id: string; user_id: string; issuer: string; subject: string;
  provider: 'github' | 'azure_devops'; display_name: string; avatar_url: string | null;
}
interface Session {
  user_id: string | null; identity_id: string | null; csrf_token: string;
  host_id: string | null; registration_binding: string | null;
}
interface Grant {
  id: string; host_id: string; purpose: Purpose; identity_id: string; user_id: string;
  registration_binding: string; credential_ref: string; revoked_at: number | null;
}
interface Intent {
  intent: AuthorizationIntent; target: RepoTarget | null; connection: { id: string; generation: number } | null;
}
interface Pending { host_id: string; registration_binding: string; intent_json: string; verifier: string }
type Transport = ReturnType<typeof createOAuthTransport>;
interface Options extends Transport {
  db: SQLite.Database;
  vault: CredentialVault;
  origin: string;
  registry: Registry;
  now?: () => number;
}
const vaultBinding = (grant: Omit<Grant, 'credential_ref' | 'revoked_at'>) => JSON.stringify([
  grant.user_id, grant.purpose, grant.host_id, grant.identity_id, grant.registration_binding, grant.id,
]);

export function createIdentity({ db, vault, origin, registry, redeem, refresh, now = Date.now }: Options) {
  const inFlight = new Map<string, Promise<Tokens>>();
  function getSession(id: string) {
    const row = db.prepare<[string, number], Session>(`SELECT s.* FROM portal_sessions s
      WHERE session_hash=? AND expires_at>? AND (user_id IS NULL OR EXISTS (
        SELECT 1 FROM delegated_grants g WHERE g.user_id=s.user_id AND g.identity_id=s.identity_id
          AND g.purpose='portal' AND g.registration_binding=s.registration_binding AND g.revoked_at IS NULL
      ))`).get(hash(id), now());
    if (row?.host_id && !registry.bound(row.host_id, 'portal', row.registration_binding ?? '')) return undefined;
    return row;
  }
  const getGrant = (id: string, owner: string) => db.prepare<[string, string], Grant>(
    'SELECT * FROM delegated_grants WHERE id = ? AND user_id = ?',
  ).get(id, owner);
  const getConnection = (id: string, owner: string) => db.prepare<[string, string], Connection>(
    `${connectionQuery} AND c.id = ?`,
  ).get(owner, id);
  const bound = (grant: Grant) => registry.bound(grant.host_id, grant.purpose, grant.registration_binding);
  const callbackUrl = (provider: AuthorizationProvider) => `${origin}/auth/${provider}/callback`;

  function createSession(owner: string | null, person: string | null, registration?: Registration) {
    const id = token();
    const csrfToken = token();
    db.prepare('DELETE FROM portal_sessions WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO portal_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hash(id), csrfToken, owner, person, registration?.hostId ?? null, registration?.binding ?? null,
        now() + (owner === null ? fifteenMinutes : sessionAge));
    return { sessionId: id, csrfToken };
  }

  function readGrant(connectionId: string, requester: Requester, at = now()): 'valid' | 'denied' | 'unverified' {
    const connection = getConnection(connectionId, requester.id);
    if (!connection || connection.denied_at !== null) return 'denied';
    const grant = connection.grant_id ? getGrant(connection.grant_id, requester.id) : undefined;
    if (!grant || grant.purpose !== 'repository' || !bound(grant) || connection.verified_generation !== connection.generation ||
        connection.access_verified_at === null || at < connection.access_verified_at) return 'unverified';
    if (grant.revoked_at !== null) return 'denied';
    return at - connection.access_verified_at < fifteenMinutes ? 'valid' : 'unverified';
  }

  function beginAuthorization(
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
      if (existing?.purpose !== 'copilot') throw new ApiFailure('NOT_FOUND');
      hostId = existing.host_id;
    } else {
      const existing = intent.intent === 'reconnect' ? getConnection(intent.connectionId, owner ?? '') : undefined;
      if (intent.intent === 'reconnect' && !existing) throw new ApiFailure('NOT_FOUND');
      const selection = registry.repository(existing?.canonical_url ?? ('repositoryUrl' in intent ? intent.repositoryUrl : ''), provider);
      hostId = selection.hostId;
      target = selection.target;
      if (existing) connection = { id: existing.id, generation: existing.generation };
    }
    const registration = registry.registration(hostId, purpose);
    if (registration.provider !== provider) throw new ApiFailure('INVALID_REQUEST');
    const state = token();
    const verifier = token();
    db.prepare('DELETE FROM oauth_intents WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO oauth_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(hash(state), hash(sessionId), provider, hostId, registration.binding,
        JSON.stringify({ intent, target, connection } satisfies Intent), verifier, now() + fifteenMinutes);
    return { authorizationUrl: authorizationUrl(registration, callbackUrl(provider), state, verifier) };
  }

  function persistPerson(owner: string | null, registration: Registration, proof: VerifiedAuthorization): Person {
    const provider = registration.provider === 'github' ? 'github' : 'azure_devops';
    // Delegated accounts do not become portal sign-in identities merely by being linked.
    const issuer = registration.purpose === 'portal' ? `portal:${registration.issuer}` : registration.issuer;
    const current = db.prepare<[string, string, string], Person>(
      'SELECT * FROM identities WHERE provider = ? AND issuer = ? AND subject = ?',
    ).get(provider, issuer, proof.subject);
    if (current && owner !== null && current.user_id !== owner) throw new ApiFailure('CONNECTION_ACCOUNT_CONFLICT');
    const userId = current?.user_id ?? owner ?? randomUUID();
    if (!current && owner === null) db.prepare('INSERT INTO users VALUES (?)').run(userId);
    const id = current?.id ?? randomUUID();
    db.prepare(`INSERT INTO identities (id,user_id,provider,issuer,subject,display_name,avatar_url) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, avatar_url=excluded.avatar_url`)
      .run(id, userId, provider, issuer, proof.subject, proof.label, proof.avatarUrl);
    return { id, user_id: userId, provider, issuer, subject: proof.subject, display_name: proof.label, avatar_url: proof.avatarUrl };
  }

  function persistConnection(person: Person, registration: Registration, pending: Intent, repo: VerifiedRepository, grantId: string) {
    const original = pending.connection && getConnection(pending.connection.id, person.user_id);
    if (pending.connection && (!original || original.generation !== pending.connection.generation ||
        original.identity_id !== person.id || original.canonical_host !== repo.host ||
        original.provider_repo_id !== repo.id || original.provider_scope !== repo.scope)) {
      throw new ApiFailure('CONNECTION_ACCOUNT_CONFLICT');
    }
    const canonical = registry.repository(repo.url, registration.provider);
    if (repo.host !== pending.target?.host || canonical.hostId !== registration.hostId) throw new ApiFailure('PROVIDER_ERROR');
    db.prepare(`INSERT INTO repositories (id,provider,canonical_host,provider_scope,provider_repo_id,canonical_url,name)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,canonical_host,provider_scope,provider_repo_id)
      DO UPDATE SET canonical_url=excluded.canonical_url, name=excluded.name`)
      .run(randomUUID(), person.provider, repo.host, repo.scope, repo.id, repo.url, repo.name);
    const row = db.prepare<[string, string, string, string], { id: string }>(
      'SELECT id FROM repositories WHERE provider=? AND canonical_host=? AND provider_scope=? AND provider_repo_id=?',
    ).get(person.provider, repo.host, repo.scope, repo.id);
    if (!row) throw new ApiFailure('INTERNAL_ERROR');
    const existing = db.prepare<[string, string], { id: string; identity_id: string; generation: number }>(
      'SELECT id, identity_id, generation FROM repo_connections WHERE user_id=? AND repo_id=? AND retired_at IS NULL',
    ).get(person.user_id, row.id);
    if (existing && existing.identity_id !== person.id) throw new ApiFailure('CONNECTION_ACCOUNT_CONFLICT');
    const id = existing?.id ?? randomUUID();
    const generation = existing ? existing.generation + 1 : 1;
    if (!existing) db.prepare('INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at) VALUES (?,?,?,?,?)')
      .run(id, row.id, person.user_id, person.id, now());
    else db.prepare('UPDATE repo_connections SET generation=? WHERE id=?').run(generation, id);
    db.prepare(`INSERT INTO connection_access
      (connection_id,repo_id,user_id,identity_id,grant_id,generation,access_verified_at,denied_at)
      VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(connection_id)
      DO UPDATE SET grant_id=excluded.grant_id,generation=excluded.generation,access_verified_at=excluded.access_verified_at,denied_at=NULL`)
      .run(id, row.id, person.user_id, person.id, grantId, generation, now());
  }

  async function completeAuthorization(provider: AuthorizationProvider, sessionId: string, input: { state: string; code: string | null }) {
    const session = getSession(sessionId);
    if (!session) throw new ApiFailure('INVALID_REQUEST');
    const pending = db.prepare<[string, string, string, number], Pending>(`DELETE FROM oauth_intents
      WHERE state_hash=? AND session_hash=? AND provider=? AND expires_at>?
      RETURNING host_id, registration_binding, intent_json, verifier`)
      .get(hash(input.state), hash(sessionId), provider, now());
    if (!pending) throw new ApiFailure('INVALID_REQUEST');
    const intent = JSON.parse(pending.intent_json) as Intent;
    const purpose = purposeOf(intent.intent);
    const registration = registry.bound(pending.host_id, purpose, pending.registration_binding);
    if (!registration || registration.provider !== provider) throw new ApiFailure('INVALID_REQUEST');
    if (input.code === null) return { redirectTo: destination[purpose] };
    const proof = await redeem({ registration, callback: callbackUrl(provider), code: input.code, verifier: pending.verifier, target: intent.target });
    if (!getSession(sessionId)) throw new ApiFailure('AUTH_REQUIRED');
    const reconnectCopilot = intent.intent.intent === 'reconnect_copilot' ? intent.intent.copilotAccountId : null;
    let newRef: string | undefined;
    let previousRef: string | undefined;
    let result: { redirectTo: string; sessionId?: string };
    try {
      result = db.transaction(() => {
        const person = persistPerson(purpose === 'portal' ? null : session.user_id, registration, proof);
        const old = db.prepare<[string, string, string, string], Grant>(
          'SELECT * FROM delegated_grants WHERE user_id=? AND identity_id=? AND purpose=? AND registration_binding=?',
        ).get(person.user_id, person.id, purpose, registration.binding);
        if (reconnectCopilot && reconnectCopilot !== old?.id) throw new ApiFailure('COPILOT_REAUTH_REQUIRED');
        const grant = {
          id: old?.id ?? randomUUID(), user_id: person.user_id, identity_id: person.id, purpose,
          host_id: registration.hostId, registration_binding: registration.binding,
        };
        if (purpose === 'repository') {
          if (!proof.repo) throw new ApiFailure('PROVIDER_ERROR');
          if (old) persistConnection(person, registration, intent, proof.repo, old.id);
        }
        newRef = vault.put(vaultBinding(grant), proof.tokens);
        previousRef = old?.credential_ref;
        db.prepare(`INSERT INTO delegated_grants VALUES (?,?,?,?,?,?,?,NULL)
          ON CONFLICT(id) DO UPDATE SET credential_ref=excluded.credential_ref,revoked_at=NULL`)
          .run(grant.id, grant.user_id, grant.identity_id, grant.host_id, grant.purpose, grant.registration_binding, newRef);
        if (purpose === 'repository' && proof.repo && !old) persistConnection(person, registration, intent, proof.repo, grant.id);
        if (purpose !== 'portal') return { redirectTo: destination[purpose] };
        db.prepare('DELETE FROM portal_sessions WHERE session_hash=?').run(hash(sessionId));
        return { redirectTo: '/', sessionId: createSession(person.user_id, person.id, registration).sessionId };
      }).immediate();
    } catch (error) {
      if (newRef) vault.delete(newRef);
      throw error;
    }
    if (previousRef) vault.delete(previousRef);
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
      return session ? { csrfToken: session.csrf_token } : createSession(null, null);
    },
    verifyCsrf(sessionId: string, csrf: string) {
      const session = getSession(sessionId);
      return !!session && timingSafeEqual(Buffer.from(hash(csrf)), Buffer.from(hash(session.csrf_token)));
    },
    githubHosts: registry.githubHosts,
    beginAuthorization,
    completeAuthorization,
    logout(requester: Requester, sessionId: string): void {
      db.prepare('DELETE FROM portal_sessions WHERE user_id=? AND session_hash=?').run(requester.id, hash(sessionId));
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
        JOIN identities i ON i.id=g.identity_id WHERE g.user_id=? AND g.purpose='copilot' ORDER BY i.display_name,g.id`).all(requester.id);
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
    readGrant,
    readTokens,
    connections(requester: Requester): ApiDto<'connections'> {
      return {
        items: db.prepare<[string], Connection>(`${connectionQuery} ORDER BY r.name,c.id`).all(requester.id).map((row) => ({
          id: row.id, repoId: row.repo_id, name: row.name || row.canonical_url, provider: row.provider, host: row.canonical_host,
          repositoryUrl: row.canonical_url, accountLabel: row.display_name || row.identity_id,
          state: readGrant(row.id, requester) === 'denied' ? 'needs_auth' : 'connected',
        })),
      };
    },
    markConnectionDenied(connectionId: string, requester: Requester, generation: number): boolean {
      return db.prepare(`UPDATE connection_access SET denied_at=? WHERE connection_id=? AND user_id=? AND generation=?
        AND EXISTS (SELECT 1 FROM repo_connections c WHERE c.id=connection_id AND c.retired_at IS NULL AND c.generation=?)`)
        .run(now(), connectionId, requester.id, generation, generation).changes === 1;
    },
  };
}
