import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openDatabase } from '../persistence/open.js';

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export function openCredentialVault(path: string, material: Uint8Array) {
  if (material.byteLength !== 32) throw new Error('Credential encryption requires a 32-byte key.');
  const key = Buffer.from(material);
  const db = openDatabase(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS credential_entries (
      id TEXT PRIMARY KEY NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS vault_marker (
      id INTEGER PRIMARY KEY CHECK (id=1), salt BLOB NOT NULL, mac BLOB NOT NULL
    )`);
    db.transaction(() => {
      const marker = db.prepare<[], { salt: Buffer; mac: Buffer }>('SELECT salt,mac FROM vault_marker WHERE id=1').get();
      const salt = marker?.salt ?? randomBytes(32);
      const mac = createHmac('sha256', key).update('software-factory/vault/v1').update(salt).digest();
      if (!marker) db.prepare('INSERT INTO vault_marker VALUES (1,?,?)').run(salt, mac);
      else if (marker.mac.length !== mac.length || !timingSafeEqual(marker.mac, mac)) {
        throw new Error('Credential encryption key does not match the existing vault.');
      }
    }).immediate();
  } catch (error) {
    db.close();
    key.fill(0);
    throw error;
  }

  return {
    put(binding: string, tokens: unknown): string {
      const ref = randomUUID();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([ref, binding])));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
      db.prepare('INSERT INTO credential_entries VALUES (?, ?, ?, ?)').run(ref, nonce, cipher.getAuthTag(), ciphertext);
      return ref;
    },
    get<T = Tokens>(ref: string, binding: string): T | null {
      const row = db.prepare<[string], { nonce: Buffer; tag: Buffer; ciphertext: Buffer }>(
        'SELECT nonce, tag, ciphertext FROM credential_entries WHERE id = ?',
      ).get(ref);
      if (!row) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(JSON.stringify([ref, binding])));
      decipher.setAuthTag(row.tag);
      return JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')) as T;
    },
    delete(ref: string): void {
      db.prepare('DELETE FROM credential_entries WHERE id = ?').run(ref);
    },
    close(): void {
      db.close();
      key.fill(0);
    },
  };
}

export type CredentialVault = ReturnType<typeof openCredentialVault>;
