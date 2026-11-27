import { randomUUID } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import type { AuthorizationIntent } from '../../shared/api/schemas.js';
import type { FlowStatus } from '../../shared/api/management-schemas.js';
import { ApiFailure } from '../http/problems.js';
import type { CredentialVault } from '../identity/credentials.js';
import { githubDeviceApproval, type createGitHubDeviceFlow } from '../identity/device-flow.js';
import type { createIdentity, Intent } from '../identity/module.js';
import type { Registry } from '../identity/github-hosts.js';
import type { createOAuthTransport, VerifiedAuthorization } from '../identity/oauth.js';
import { sessionHash, type SetupStore, type VerifiedPortalAccount } from './setup.js';

type Identity = Pick<ReturnType<typeof createIdentity>, 'resolveRequester' | 'selectAuthorization' | 'persistAuthorization'>;
type Context = { host: string; binding: string; intent: Intent; purpose: 'portal' | 'repository' };
type Row = {
  id: string; state: FlowStatus['state']; context: string; credential_ref: string | null;
  expires_at: number; next_poll: number; interval_ms: number; session_hash: string;
};
interface Options {
  db: SQLite.Database;
  vault: CredentialVault;
  setup: SetupStore;
  registry: Registry;
  identity: Identity;
  device: ReturnType<typeof createGitHubDeviceFlow>;
  transport: Pick<ReturnType<typeof createOAuthTransport>, 'verifyIdentity'>;
  clock?: () => number;
}

export function createAuthorizationService({ db, vault, setup, registry, identity, device, transport, clock = Date.now }: Options) {
  const data = (row: Row) => JSON.parse(row.context) as Context;
  const binding = (id: string) => `management-flow:${id}`;
  const find = db.prepare<[string, string], Row>('SELECT * FROM management_flows WHERE id=? AND session_hash=?');
  const active = (state: Row['state']) => state === 'pending' || state === 'ready';
  const stateOf = (row: Row) => active(row.state) && row.expires_at <= clock() ? 'expired' as const : row.state;
  function read(sessionId: string, id: string): Row {
    const flow = find.get(id, sessionHash(sessionId));
    if (!flow) throw new ApiFailure('NOT_FOUND');
    return flow;
  }
  function finish(row: Row, state: Row['state']) {
    if (db.prepare(`UPDATE management_flows SET state=?,credential_ref=NULL WHERE id=? AND credential_ref=?
      AND state IN ('pending','ready')`).run(state, row.id, row.credential_ref).changes && row.credential_ref) {
      vault.delete(row.credential_ref);
    }
  }
  function sweep() {
    const expired = db.prepare<[number], Row>(`SELECT * FROM management_flows WHERE state IN ('pending','ready')
      AND expires_at<=? LIMIT 20`).all(clock());
    for (const row of expired) finish(row, 'expired');
    db.prepare("DELETE FROM management_flows WHERE expires_at<? AND credential_ref IS NULL").run(clock() - 900_000);
  }

  return {
    async start(sessionId: string, intent: AuthorizationIntent) {
      const owner = setup.owner();
      const requester = identity.resolveRequester(sessionId);
      if (!owner && !setup.hasClaim(sessionId)) throw new ApiFailure('SETUP_CODE_INVALID');
      if (intent.intent !== 'sign_in' && intent.intent !== 'connect' && intent.intent !== 'reconnect') {
        throw new ApiFailure('CAPABILITY_UNAVAILABLE');
      }
      const purpose = intent.intent === 'sign_in' ? 'portal' : 'repository';
      const { registration, pending } = identity.selectAuthorization('github', intent, sessionId, requester);
      if (registration.flow !== 'device' || registration.hostId !== 'github.com') throw new ApiFailure('CAPABILITY_UNAVAILABLE');
      sweep();
      if (db.prepare("SELECT 1 FROM management_flows WHERE session_hash=? AND state IN ('pending','ready')").get(sessionHash(sessionId))) {
        throw new ApiFailure('AUTH_FLOW_ACTIVE');
      }
      const grant = await device.start(registration.clientId);
      const id = randomUUID();
      const ref = vault.put(binding(id), { deviceCode: grant.deviceCode });
      const result = db.prepare(`INSERT OR IGNORE INTO management_flows VALUES (?,?, 'pending', ?,?,?,?,?)`).run(
        id, sessionHash(sessionId), JSON.stringify({ host: registration.hostId, binding: registration.binding, intent: pending, purpose } satisfies Context),
        ref, grant.expiresAt, clock() + grant.intervalMs, grant.intervalMs,
      );
      if (result.changes !== 1) {
        vault.delete(ref);
        throw new ApiFailure('AUTH_FLOW_ACTIVE');
      }
      return { flowId: id, expiresAt: grant.expiresAt, browserInstructions: { url: githubDeviceApproval, userCode: grant.userCode } };
    },
    status(sessionId: string, id: string): FlowStatus {
      return { state: stateOf(read(sessionId, id)) };
    },
    cancel(sessionId: string, id: string) {
      const row = read(sessionId, id);
      if (active(row.state)) finish(row, 'cancelled');
    },
    complete(sessionId: string, id: string) {
      const row = read(sessionId, id);
      if (stateOf(row) !== 'ready' || !row.credential_ref) throw new ApiFailure('AUTH_FLOW_NOT_READY');
      const context = data(row);
      const registration = registry.bound(context.host, context.purpose, context.binding);
      const proof = vault.get<VerifiedAuthorization>(row.credential_ref, binding(id));
      if (!registration || !proof) throw new ApiFailure('AUTH_FLOW_NOT_READY');
      const completed = identity.persistAuthorization(sessionId, context.intent, registration, proof, () => {
        const matched = db.prepare(`UPDATE management_flows SET state='complete',credential_ref=NULL
          WHERE id=? AND state='ready' AND expires_at>? AND credential_ref=?`).run(id, clock(), row.credential_ref);
        if (!matched.changes) throw new ApiFailure('AUTH_FLOW_NOT_READY');
        if (context.purpose !== 'portal') return;
        const account = { provider: 'github', host: registration.hostId, subject: proof.subject,
          registrationId: registration.binding } satisfies VerifiedPortalAccount;
        const owner = setup.owner();
        if (!owner) setup.claimOwner(sessionId, account);
        else if (owner.provider !== account.provider || owner.host !== account.host ||
          owner.subject !== account.subject || owner.registrationId !== account.registrationId) throw new ApiFailure('ACCESS_DENIED');
      });
      vault.delete(row.credential_ref);
      return completed;
    },
    async pollNext() {
      sweep();
      const row = db.prepare<[number], Row>("SELECT * FROM management_flows WHERE state='pending' AND next_poll<=? ORDER BY next_poll LIMIT 1")
        .get(clock());
      if (!row || !row.credential_ref) return;
      const context = data(row);
      const registration = registry.bound(context.host, context.purpose, context.binding);
      const deviceSecret = vault.get<{ deviceCode: string }>(row.credential_ref, binding(row.id));
      if (!registration || !deviceSecret) { finish(row, 'failed'); return; }
      const retry = (delay: number) => db.prepare("UPDATE management_flows SET next_poll=?,interval_ms=? WHERE id=? AND state='pending'")
        .run(clock() + delay, delay, row.id);
      try {
        retry(row.interval_ms);
        const result = await device.poll(registration.clientId, deviceSecret.deviceCode);
        if (result.kind === 'pending') return;
        if (result.kind === 'slow_down') { retry(row.interval_ms + 5_000); return; }
        if (result.kind !== 'authorized') {
          finish(row, result.kind === 'expired' ? 'expired' : 'failed');
          return;
        }
        const proof = await transport.verifyIdentity(registration, result.tokens, context.intent.target);
        const ref = vault.put(binding(row.id), proof);
        const changed = db.prepare(`UPDATE management_flows SET state='ready',credential_ref=?
          WHERE id=? AND state='pending' AND expires_at>?`).run(ref, row.id, clock());
        vault.delete(changed.changes ? row.credential_ref : ref);
      } catch (error) {
        if (error instanceof ApiFailure && error.code === 'RATE_LIMITED') retry(row.interval_ms + 5_000);
        else finish(row, 'failed');
      }
    },
  };
}

export type AuthorizationService = ReturnType<typeof createAuthorizationService>;
