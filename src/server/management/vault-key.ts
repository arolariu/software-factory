import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export function loadOrInitializeVaultKey(path: string, vaultExists: boolean): Buffer {
  function read(): Buffer {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
      throw new Error('Credential encryption key is not a private file.');
    }
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('Credential encryption key must contain 32 bytes.');
    return key;
  }
  if (existsSync(path)) return read();
  if (vaultExists) throw new Error('Credential encryption key is missing for the existing vault.');
  const secret = randomBytes(32);
  const temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, secret, { mode: 0o600, flag: 'wx', flush: true });
  try {
    try { linkSync(temp, path); }
    catch (error) { if (!existsSync(path)) throw error; }
    return read();
  } finally {
    secret.fill(0);
    unlinkSync(temp);
  }
}
