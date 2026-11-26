import { readFileSync } from 'node:fs';
import type SQLite from 'better-sqlite3';

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  { version: 1, sql: readFileSync(new URL('./001-foundation.sql', import.meta.url), 'utf8') },
];

export function hasCurrentSchema(db: SQLite.Database): boolean {
  return db.open && db.pragma('user_version', { simple: true }) === migrations.length;
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
