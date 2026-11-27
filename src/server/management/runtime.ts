import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type SQLite from 'better-sqlite3';
import { openCredentialVault } from '../identity/credentials.js';
import { createSetupStore } from './setup.js';
import { loadOrInitializeVaultKey } from './vault-key.js';

export function managementOrigin(value: string): string {
  const parsed = URL.parse(value);
  if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== value) {
    throw new Error('Management mode requires a canonical HTTPS public origin.');
  }
  return parsed.origin;
}

export function assertManagementData(db: SQLite.Database) {
  const setup = createSetupStore(db);
  if (!setup.owner() && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    throw new Error('Management setup cannot claim a populated legacy instance.');
  }
  return setup;
}

export function openManagementRuntime(db: SQLite.Database, dataDir: string, publicOrigin: string) {
  const origin = managementOrigin(publicOrigin);
  const setup = assertManagementData(db);
  const vaultPath = join(dataDir, 'credentials.sqlite');
  const key = loadOrInitializeVaultKey(join(dataDir, 'management-vault.key'), existsSync(vaultPath));
  try {
    const vault = openCredentialVault(vaultPath, key);
    return { origin, setup, close: vault.close };
  } finally {
    key.fill(0);
  }
}
