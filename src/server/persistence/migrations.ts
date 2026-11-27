import { readFileSync } from 'node:fs';
import type SQLite from 'better-sqlite3';

interface Migration {
  version: number;
  sql: string;
}

const readMigration = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

const migrations: readonly Migration[] = [
  { version: 1, sql: readMigration('./001-foundation.sql') },
  { version: 2, sql: readMigration('./002-identity.sql') },
];

const requiredTables = [
  'users', 'identities', 'repositories', 'repo_connections', 'repo_snapshots', 'tasks',
  'portal_sessions', 'oauth_intents', 'delegated_grants', 'connection_access', 'copilot_defaults', 'legacy_portal_claims',
];
const requiredIndexes = ['one_current_connection_per_user_repo', 'one_active_task_per_repo_item'];

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
