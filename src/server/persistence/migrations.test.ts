import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hasCurrentSchema, migrate } from './migrations.js';
import { openDatabase } from './open.js';

it('rejects migration gaps and downgrades without overwriting the existing version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-migration-'));
  const db = openDatabase(join(directory, 'data.sqlite'));
  try {
    expect(() => migrate(db, [{ version: 2, sql: 'SELECT 1' }])).toThrow('contiguous');
    db.pragma('user_version = 2');
    expect(() => migrate(db)).toThrow('newer image');
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  } finally {
    db.close();
    expect(hasCurrentSchema(db)).toBe(false);
    rmSync(directory, { recursive: true });
  }
});
