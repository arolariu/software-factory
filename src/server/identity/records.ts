import { randomBytes } from 'node:crypto';
import type { AuthorizationIntent } from '../../shared/api/schemas.js';
import type { IdentityProvider, Purpose, RepoTarget } from './github-hosts.js';

export const fifteenMinutes = 900_000;
export const sessionAge = 28_800_000;
export const destination = { portal: '/', copilot: '/settings/copilot', repository: '/settings/repository' } as const;

export const token = () => randomBytes(32).toString('base64url');
export const purposeOf = (intent: AuthorizationIntent): Purpose =>
  intent.intent === 'sign_in' ? 'portal' :
    intent.intent === 'link_copilot' || intent.intent === 'reconnect_copilot' ? 'copilot' : 'repository';

export const connectionQuery = `
  SELECT c.id, c.repo_id, c.identity_id, c.generation, r.canonical_host, r.provider,
         r.provider_repo_id, r.provider_scope, r.canonical_url, r.name, i.display_name, i.subject,
         a.grant_id, a.generation AS verified_generation, a.access_verified_at, a.denied_at
  FROM repo_connections c JOIN repositories r ON r.id = c.repo_id
  JOIN identities i ON i.id = c.identity_id LEFT JOIN connection_access a ON a.connection_id = c.id
  WHERE c.user_id = ? AND c.retired_at IS NULL`;

export interface Connection {
  id: string; repo_id: string; identity_id: string; generation: number; canonical_host: string;
  provider: IdentityProvider; provider_repo_id: string; provider_scope: string;
  canonical_url: string; name: string; display_name: string; subject: string; grant_id: string | null;
  verified_generation: number | null; access_verified_at: number | null; denied_at: number | null;
}
export interface Person {
  id: string; user_id: string; issuer: string; subject: string;
  provider: IdentityProvider; display_name: string; avatar_url: string | null;
}
export interface Session {
  user_id: string | null; identity_id: string | null; csrf_token: string;
  host_id: string | null; registration_binding: string | null;
}
export interface Grant {
  id: string; host_id: string; purpose: Purpose; identity_id: string; user_id: string;
  registration_binding: string; credential_ref: string; revoked_at: number | null; superseded_by: string | null;
}
export interface Intent {
  intent: AuthorizationIntent; target: RepoTarget | null; connection: { id: string; generation: number } | null;
}
export interface Pending { host_id: string; registration_binding: string; intent_json: string; verifier: string }

export const vaultBinding = (grant: Omit<Grant, 'credential_ref' | 'revoked_at' | 'superseded_by'>) => JSON.stringify([
  grant.user_id, grant.purpose, grant.host_id, grant.identity_id, grant.registration_binding, grant.id,
]);
