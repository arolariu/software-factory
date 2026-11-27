import type SQLite from 'better-sqlite3';
import type { InstanceSettings, UpdateInstanceSettings } from '../../shared/api/management-schemas.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';

export function createManagementSettings(db: SQLite.Database, portalClientId: string, repoClientId?: string) {
  const readRow = db.prepare<[], { version: number; repository_enabled: number }>(
    'SELECT version,repository_enabled FROM management_settings WHERE singleton=1',
  );
  function state(): InstanceSettings {
    const stored = readRow.get();
    return {
      version: stored?.version ?? 0,
      repositoryEnabled: !!repoClientId && stored?.repository_enabled !== 0,
      repositoryConfigured: !!repoClientId,
      portalClientId, repositoryClientId: repoClientId ?? null,
    };
  }
  function authorize(requester: Requester): void {
    const owner = db.prepare(`SELECT 1 FROM management_owner o JOIN identities i
      ON i.provider=o.provider AND i.issuer='portal:'||o.host AND i.subject=o.subject
      JOIN delegated_grants g ON g.identity_id=i.id AND g.purpose='portal' AND
        g.registration_binding=o.registration_id AND g.revoked_at IS NULL
      WHERE i.user_id=?`).get(requester.id);
    if (!owner) throw new ApiFailure('ACCESS_DENIED');
  }
  return {
    repositoryAllowed: () => state().repositoryEnabled,
    read(requester: Requester) {
      authorize(requester);
      return state();
    },
    update(requester: Requester, input: UpdateInstanceSettings): InstanceSettings {
      return db.transaction(() => {
        authorize(requester);
        if (state().version !== input.version) throw new ApiFailure('SETTINGS_CHANGED');
        if (input.repositoryEnabled && !repoClientId) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
        db.prepare(`INSERT INTO management_settings VALUES (1,?,?)
          ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,repository_enabled=excluded.repository_enabled`)
          .run(input.version + 1, input.repositoryEnabled ? 1 : 0);
        db.prepare('INSERT INTO management_audit (actor,action,occurred_at) VALUES (?,?,?)')
          .run(requester.id, 'REPOSITORY_POLICY_UPDATED', Date.now());
        return state();
      }).immediate();
    },
  };
}

export type ManagementSettings = ReturnType<typeof createManagementSettings>;
