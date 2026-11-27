import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    db.pragma('user_version = 999');
    expect(() => migrate(db)).toThrow('newer image');
    expect(db.pragma('user_version', { simple: true })).toBe(999);
  } finally {
    db.close();
    expect(hasCurrentSchema(db)).toBe(false);
    rmSync(directory, { recursive: true });
  }
});

it('upgrades a foundation database without losing existing connection IDs or rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-upgrade-'));
  const db = openDatabase(join(directory, 'data.sqlite'));
  try {
    migrate(db, [{ version: 1, sql: readFileSync(new URL('./001-foundation.sql', import.meta.url), 'utf8') }]);
    db.exec(`
      INSERT INTO users VALUES ('u1');
      INSERT INTO identities VALUES ('i1','u1','github','github.com','42');
      INSERT INTO repositories VALUES ('r1','github','github.com','1','2','https://github.com/org/repo');
      INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at) VALUES ('c1','r1','u1','i1',1);
    `);
    expect(hasCurrentSchema(db)).toBe(false);
    migrate(db);
    expect(hasCurrentSchema(db)).toBe(true);
    expect(db.prepare('SELECT id, generation FROM repo_connections').all()).toEqual([{ id: 'c1', generation: 1 }]);
    expect(db.prepare('SELECT * FROM connection_access').all()).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});
