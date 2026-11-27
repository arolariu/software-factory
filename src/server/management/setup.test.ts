import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../persistence/open.js';
import { migrate } from '../persistence/migrations.js';
import { createSetupStore } from './setup.js';
import { loadOrInitializeVaultKey } from './vault-key.js';
import { openManagementRuntime } from './runtime.js';

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
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644);
      expect(() => loadOrInitializeVaultKey(path, true)).toThrow('not a private file');
      chmodSync(path, 0o600);
    }
    writeFileSync(path, 'short');
    expect(() => loadOrInitializeVaultKey(path, true)).toThrow('Credential encryption key');
    rmSync(path);
    expect(() => loadOrInitializeVaultKey(path, true)).toThrow('Credential encryption key');
  } finally {
    rmSync(root, { recursive: true });
  }
});

it('uses supplied native key material without creating a hosted key and fails closed on a mismatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-native-key-'));
  const db = openDatabase(join(root, 'factory.sqlite'));
  try {
    migrate(db);
    const publicOrigin = 'https://factory.example';
    const first = Buffer.alloc(32, 1);
    const opened = openManagementRuntime(db, root, {
      publicOrigin, loadVaultKey: (existing) => {
        expect(existing).toBe(false);
        return first;
      },
    });
    await opened.close();
    expect(first.equals(Buffer.alloc(32))).toBe(true);

    const wrong = Buffer.alloc(32, 2);
    expect(() => openManagementRuntime(db, root, {
      publicOrigin, loadVaultKey: (existing) => {
        expect(existing).toBe(true);
        return wrong;
      },
    })).toThrow('does not match the existing vault');
    expect(wrong.equals(Buffer.alloc(32))).toBe(true);
    expect(existsSync(join(root, 'management-vault.key'))).toBe(false);
    await openManagementRuntime(db, root, {
      publicOrigin, loadVaultKey: () => Buffer.alloc(32, 1),
    }).close();
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});

it('rate limits unsuccessful pairing across browser sessions and resets the window', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-pair-limit-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    migrate(db);
    let now = 0;
    const setup = createSetupStore(db, () => now);
    const active = setup.issueCode();
    for (let i = 0; i < 20; i++) expect(() => setup.pair(`${i}`, 'invalid')).toThrow('SETUP_CODE_INVALID');
    expect(() => setup.pair('bound', active.code)).toThrow('RATE_LIMITED');
    now = 60_000;
    setup.pair('bound', active.code);
    expect(setup.hasClaim('bound')).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});
