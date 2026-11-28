import { join } from 'node:path';
import SQLite from 'better-sqlite3';

export class InstanceLockError extends Error {}

export function lockDataDirectory(dataDir: string) {
  let lock: SQLite.Database | undefined;
  try {
    const opened = new SQLite(join(dataDir, '.factory-instance.sqlite'), { timeout: 0 });
    lock = opened;
    opened.exec('BEGIN EXCLUSIVE');
    return () => opened.close();
  } catch (error) {
    lock?.close();
    if (error instanceof SQLite.SqliteError && /^(SQLITE_BUSY|SQLITE_LOCKED)/.test(error.code)) {
      throw new InstanceLockError('The Factory data directory is already in use.');
    }
    throw error;
  }
}
