import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../persistence/open.js';
import { migrate } from '../persistence/migrations.js';
import { createSetupStore } from './setup.js';
import { loadOrInitializeVaultKey } from './vault-key.js';

const proof = { provider: 'github' as const, host: 'github.com', subject: '42', registrationId: 'portal' };

it('pairs once, supersedes unspent codes, and allows only the paired session to claim ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-setup-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    migrate(db);
    let now = 0;
    const setup = createSetupStore(db, () => now);
    expect(setup.status()).toEqual({ state: 'unclaimed' });
    const expired = setup.issueCode();
    now = expired.expiresAt;
    expect(() => setup.pair('a', expired.code)).toThrow('SETUP_CODE_INVALID');
    const old = setup.issueCode();
    const active = setup.issueCode();
    expect(() => setup.pair('a', old.code)).toThrow('SETUP_CODE_INVALID');
    setup.pair('a', active.code);
    expect(() => setup.pair('b', active.code)).toThrow('SETUP_CODE_INVALID');
    expect(() => setup.claimOwner('b', proof)).toThrow('SETUP_CODE_INVALID');
    const another = setup.issueCode();
    setup.pair('b', another.code);
    setup.claimOwner('a', proof);
    expect(setup.status()).toEqual({ state: 'claimed' });
    expect(() => setup.claimOwner('b', proof)).toThrow('SETUP_ALREADY_CLAIMED');
    expect(() => setup.issueCode()).toThrow('SETUP_ALREADY_CLAIMED');
    expect(db.prepare('SELECT count(*) AS count FROM management_owner').get()).toEqual({ count: 1 });
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});

it('keeps the generated vault key across restart and refuses to replace a missing or bad key', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-key-'));
  try {
    const path = join(root, 'identity-key');
    const first = loadOrInitializeVaultKey(path, false);
    expect(first).toHaveLength(32);
    expect(loadOrInitializeVaultKey(path, true)).toEqual(first);
    writeFileSync(path, 'short');
    expect(() => loadOrInitializeVaultKey(path, true)).toThrow('Credential encryption key');
    rmSync(path);
    expect(() => loadOrInitializeVaultKey(path, true)).toThrow('Credential encryption key');
  } finally {
    rmSync(root, { recursive: true });
  }
});
