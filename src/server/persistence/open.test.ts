import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from './open.js';

it('rejects an ephemeral SQLite database that cannot enable file-backed WAL', () => {
  expect(() => openDatabase(':memory:')).toThrow('WAL mode is required');
});

it('creates an online backup containing committed state while the source remains open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-backup-'));
  const source = openDatabase(join(directory, 'source.sqlite'));
  try {
    source.exec("CREATE TABLE data (value TEXT NOT NULL); INSERT INTO data VALUES ('persisted')");
    const backupPath = join(directory, 'backup.sqlite');
    await source.backup(backupPath);
    const backup = openDatabase(backupPath);
    try {
      expect(backup.prepare('SELECT value FROM data').get()).toEqual({ value: 'persisted' });
    } finally {
      backup.close();
    }
  } finally {
    source.close();
    rmSync(directory, { recursive: true });
  }
});
