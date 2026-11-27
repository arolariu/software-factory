import { readFileSync } from 'node:fs';
import type SQLite from 'better-sqlite3';

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  { version: 1, sql: readFileSync(new URL('./001-foundation.sql', import.meta.url), 'utf8') },
  { version: 2, sql: readFileSync(new URL('./002-identity.sql', import.meta.url), 'utf8') },
  { version: 3, sql: readFileSync(new URL('./003-repository-sync.sql', import.meta.url), 'utf8') },
  { version: 4, sql: readFileSync(new URL('./004-management.sql', import.meta.url), 'utf8') },
  { version: 5, sql: readFileSync(new URL('./005-management-authorization.sql', import.meta.url), 'utf8') },
];

const requiredTables = [
  'users', 'identities', 'repositories', 'repo_connections', 'repo_snapshots', 'tasks',
  'portal_sessions', 'oauth_intents', 'delegated_grants', 'connection_access', 'copilot_defaults', 'legacy_portal_claims',
  'repository_sources', 'repository_rows', 'repository_sync',
  'management_owner', 'management_pairing', 'management_claims', 'management_pair_attempts',
  'management_flows', 'management_flow_admission', 'management_settings', 'management_audit',
];
const requiredIndexes = ['one_current_connection_per_user_repo', 'one_active_task_per_repo_item', 'repository_sync_in_flight'];

export function hasCurrentSchema(db: SQLite.Database): boolean {
  if (!db.open || db.pragma('user_version', { simple: true }) !== migrations.length) return false;
  const rows = db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'index')")
    .all() as { name: string; type: string }[];
  const objects = new Map(rows.map(({ name, type }) => [name, type]));
  return requiredTables.every((name) => objects.get(name) === 'table') &&
    requiredIndexes.every((name) => objects.get(name) === 'index');
}

export function migrate(db: SQLite.Database, steps = migrations): void {
  if (steps.some(({ version }, index) => version !== index + 1)) {
    throw new Error('Migration versions must be contiguous.');
  }
  const version = () => db.pragma('user_version', { simple: true }) as number;
  if (version() > steps.length) throw new Error('The database requires a newer image.');

  const apply = db.transaction(({ version: next, sql }: Migration) => {
    if (version() >= next) return;
    db.exec(sql);
    db.pragma(`user_version = ${next}`);
  });
  for (const step of steps.slice(version())) apply.immediate(step);
}
