import { accessSync, constants } from 'node:fs';
import SQLite from 'better-sqlite3';

export function openDatabase(path: string): SQLite.Database {
  const db = new SQLite(path);
  try {
    accessSync(path, constants.W_OK);
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
      throw new Error('SQLite WAL mode is required.');
    }
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
