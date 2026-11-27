import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openCredentialVault } from './credentials.js';

it('reads only the encrypted credential under its original key and binding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-credentials-'));
  const path = join(directory, 'credentials.sqlite');
  const key = randomBytes(32);
  const value = { accessToken: 'fixture', refreshToken: null, expiresAt: null };
  try {
    expect(() => openCredentialVault(path, Buffer.alloc(31))).toThrow('32-byte key');
    const original = openCredentialVault(path, key);
    const ref = original.put('repository:account-one', value);
    original.close();
    const differentKey = randomBytes(32);
    expect(() => {
      const wrongKey = openCredentialVault(path, differentKey);
      wrongKey.close();
    }).toThrow('Credential encryption key does not match');
    const reopened = openCredentialVault(path, key);
    try {
      expect(reopened.get(ref, 'repository:account-one')).toEqual(value);
      expect(() => reopened.get(ref, 'copilot:account-one')).toThrow();
      reopened.delete(ref);
      expect(reopened.get(ref, 'repository:account-one')).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
