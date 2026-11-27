import { randomUUID } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import { sha256Hex } from '../digest.js';
import type { AuthorizationProvider, Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { storedProvider, type Registration, type Registry } from './github-hosts.js';
import type { VerifiedAuthorization, VerifiedRepository } from './oauth.js';
import {
  connectionQuery, fifteenMinutes, sessionAge, token,
  type Connection, type Grant, type Intent, type Person, type Session,
} from './records.js';

interface StoreOptions {
  db: SQLite.Database;
  registry: Registry;
  now: () => number;
}

export function createIdentityStore({ db, registry, now }: StoreOptions) {
  function getSession(id: string) {
    const row = db.prepare<[string, number], Session>(`SELECT s.* FROM portal_sessions s
      WHERE session_hash=? AND expires_at>? AND (user_id IS NULL OR EXISTS (
        SELECT 1 FROM delegated_grants g WHERE g.user_id=s.user_id AND g.identity_id=s.identity_id
          AND g.purpose='portal' AND g.registration_binding=s.registration_binding AND g.revoked_at IS NULL
      ))`).get(sha256Hex(id), now());
    if (row?.host_id && !registry.bound(row.host_id, 'portal', row.registration_binding ?? '')) return undefined;
    return row;
  }
  const getGrant = (id: string, owner: string) => db.prepare<[string, string], Grant>(
    'SELECT * FROM delegated_grants WHERE id = ? AND user_id = ?',
  ).get(id, owner);
  const getConnection = (id: string, owner: string) => db.prepare<[string, string], Connection>(
    `${connectionQuery} AND c.id = ?`,
  ).get(owner, id);
  const findConnection = (owner: string, provider: AuthorizationProvider, canonicalUrl: string) =>
    db.prepare<[string, string, string], Connection>(
      `${connectionQuery} AND r.provider = ? AND r.canonical_url = ? COLLATE NOCASE`,
    ).get(owner, storedProvider(provider), canonicalUrl);
  const listConnections = (owner: string) =>
    db.prepare<[string], Connection>(`${connectionQuery} ORDER BY r.name,c.id`).all(owner);
  const bound = (grant: Grant) => registry.bound(grant.host_id, grant.purpose, grant.registration_binding);

  function createSession(owner: string | null, person: string | null, registration?: Registration) {
    const id = token();
    const csrfToken = token();
    db.prepare('DELETE FROM portal_sessions WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO portal_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha256Hex(id), csrfToken, owner, person, registration?.hostId ?? null, registration?.binding ?? null,
        now() + (owner === null ? fifteenMinutes : sessionAge));
    return { sessionId: id, csrfToken };
  }

  function readGrant(connectionId: string, requester: Requester, at = now()): 'valid' | 'denied' | 'unverified' {
    const connection = getConnection(connectionId, requester.id);
    if (!connection || connection.denied_at !== null) return 'denied';
    const grant = connection.grant_id ? getGrant(connection.grant_id, requester.id) : undefined;
    if (!grant || grant.purpose !== 'repository' || !bound(grant) || grant.revoked_at !== null) return 'denied';
    if (connection.verified_generation !== connection.generation ||
        connection.access_verified_at === null || at < connection.access_verified_at) return 'unverified';
    return at - connection.access_verified_at < fifteenMinutes ? 'valid' : 'unverified';
  }

  function markConnectionDenied(connectionId: string, requester: Requester, generation: number): boolean {
    return db.prepare(`UPDATE connection_access SET denied_at=? WHERE connection_id=? AND user_id=? AND generation=?
      AND EXISTS (SELECT 1 FROM repo_connections c WHERE c.id=connection_id AND c.retired_at IS NULL AND c.generation=?)`)
      .run(now(), connectionId, requester.id, generation, generation).changes === 1;
  }

  function markConnectionVerified(connectionId: string, requester: Requester, generation: number): void {
    db.prepare(`UPDATE connection_access SET access_verified_at=?
      WHERE connection_id=? AND user_id=? AND generation=? AND denied_at IS NULL
      AND EXISTS (SELECT 1 FROM repo_connections c WHERE c.id=connection_id AND c.retired_at IS NULL AND c.generation=?)`)
      .run(now(), connectionId, requester.id, generation, generation);
  }

  function recordRepositoryDenial(requester: Requester, intent: Intent, subject: string): void {
    if (!intent.connection) return;
    const original = getConnection(intent.connection.id, requester.id);
    if (original?.subject === subject) markConnectionDenied(original.id, requester, intent.connection.generation);
  }

  function persistPerson(owner: string | null, registration: Registration, proof: VerifiedAuthorization): Person {
    const provider = storedProvider(registration.provider);
    // Delegated accounts do not become portal sign-in identities merely by being linked.
    const issuer = registration.purpose === 'portal' ? `portal:${registration.issuer}` : registration.issuer;
    const current = db.prepare<[string, string, string], Person>(
      'SELECT * FROM identities WHERE provider = ? AND issuer = ? AND subject = ?',
    ).get(provider, issuer, proof.subject);
    if (current && owner !== null && current.user_id !== owner) throw new ApiFailure('CONNECTION_ACCOUNT_CONFLICT');
    const legacy = registration.purpose === 'portal' && !current ? db.prepare<[string, string], { id: string; user_id: string }>(`
      SELECT i.id,i.user_id FROM legacy_portal_claims c JOIN identities i ON i.id=c.identity_id
      WHERE i.provider='github' AND i.issuer=? AND i.subject=?`).get(registration.issuer, proof.subject) : undefined;
    const userId = current?.user_id ?? owner ?? legacy?.user_id ?? randomUUID();
    if (!current && owner === null && !legacy) db.prepare('INSERT INTO users VALUES (?)').run(userId);
    if (legacy) db.prepare('DELETE FROM legacy_portal_claims WHERE identity_id=?').run(legacy.id);
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
    const existing = db.prepare<[string, string], { id: string; generation: number }>(
      'SELECT id, generation FROM repo_connections WHERE user_id=? AND repo_id=? AND retired_at IS NULL',
    ).get(person.user_id, row.id);
    if (existing?.id !== pending.connection?.id) throw new ApiFailure('CONNECTION_ACCOUNT_CONFLICT');
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

  return {
    getSession, createSession, getGrant, getConnection, findConnection, listConnections, bound, readGrant,
    markConnectionDenied, markConnectionVerified, recordRepositoryDenial, persistPerson, persistConnection,
  };
}
