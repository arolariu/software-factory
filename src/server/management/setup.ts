import { createHash, randomBytes } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import { ApiFailure } from '../http/problems.js';

export interface VerifiedPortalAccount {
  provider: 'github';
  host: string;
  subject: string;
  registrationId: string;
}

export const sessionHash = (value: string) => createHash('sha256').update(value).digest('hex');
const pairingAge = 600_000;
const randomToken = () => randomBytes(32).toString('base64url');

export function createSetupStore(db: SQLite.Database, clock = Date.now) {
  const readOwner = db.prepare<[], VerifiedPortalAccount>(
    'SELECT provider, host, subject, registration_id AS registrationId FROM management_owner',
  );
  const owner = () => readOwner.get();
  const unclaimed = () => {
    if (owner()) throw new ApiFailure('SETUP_ALREADY_CLAIMED');
  };
  const claimExpires = db.prepare<[string, number], { expires_at: number }>(
    'SELECT expires_at FROM management_claims WHERE session_hash=? AND expires_at>?',
  );
  return {
    owner,
    status: () => ({ state: owner() ? 'claimed' as const : 'unclaimed' as const }),
    hasClaim: (sessionId: string) => claimExpires.get(sessionHash(sessionId), clock()) !== undefined,
    issueCode() {
      return db.transaction(() => {
        unclaimed();
        const code = randomBytes(16).toString('base64url');
        const expiresAt = clock() + pairingAge;
        db.prepare('INSERT OR REPLACE INTO management_pairing VALUES (1, ?, ?)').run(sessionHash(code), expiresAt);
        db.prepare('DELETE FROM management_pair_attempts').run();
        return { code, expiresAt };
      }).immediate();
    },
    pair(sessionId: string, code: string): void {
      const result = db.transaction(() => {
        unclaimed();
        const now = clock();
        const attempt = db.prepare<[number], { attempts: number }>(`INSERT INTO management_pair_attempts VALUES (1, ?, 1)
          ON CONFLICT(singleton) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END,
          window=excluded.window RETURNING attempts`).get(Math.floor(now / 60_000));
        if (attempt && attempt.attempts > 20) return 'rate';
        const match = db.prepare<[string, number], { expires_at: number }>(
          'DELETE FROM management_pairing WHERE digest=? AND expires_at>? RETURNING expires_at',
        ).get(sessionHash(code), now);
        if (!match) return 'invalid';
        db.prepare('DELETE FROM management_claims WHERE expires_at<=?').run(now);
        db.prepare('INSERT OR REPLACE INTO management_claims VALUES (?, ?)').run(sessionHash(sessionId), match.expires_at);
        return 'paired';
      }).immediate();
      if (result === 'rate') throw new ApiFailure('RATE_LIMITED', 60);
      if (result === 'invalid') throw new ApiFailure('SETUP_CODE_INVALID');
    },
    claimOwner(sessionId: string, account: VerifiedPortalAccount): void {
      db.transaction(() => {
        unclaimed();
        if (!claimExpires.get(sessionHash(sessionId), clock())) throw new ApiFailure('SETUP_CODE_INVALID');
        db.prepare('INSERT INTO management_owner VALUES (1, ?, ?, ?, ?)')
          .run(account.provider, account.host, account.subject, account.registrationId);
        db.exec('DELETE FROM management_claims; DELETE FROM management_pairing; DELETE FROM management_pair_attempts');
      }).immediate();
    },
    preSession(sessionId?: string): { csrfToken: string; sessionId?: string } {
      const existing = sessionId && db.prepare<[string, number], { csrf_token: string }>(
        'SELECT csrf_token FROM portal_sessions WHERE session_hash=? AND user_id IS NULL AND expires_at>?',
      ).get(sessionHash(sessionId), clock());
      if (existing) return { csrfToken: existing.csrf_token };
      const csrfToken = randomToken();
      const id = randomToken();
      db.transaction(() => {
        db.prepare('DELETE FROM portal_sessions WHERE expires_at<=?').run(clock());
        db.prepare('INSERT INTO portal_sessions (session_hash,csrf_token,expires_at) VALUES (?,?,?)')
          .run(sessionHash(id), csrfToken, clock() + 900_000);
      }).immediate();
      return { csrfToken, sessionId: id };
    },
    validateAnonymous(sessionId: string, csrfToken: string) {
      return !!db.prepare(`SELECT 1 FROM portal_sessions WHERE session_hash=? AND csrf_token=?
        AND user_id IS NULL AND expires_at>?`).get(sessionHash(sessionId), csrfToken, clock());
    },
  };
}

export type SetupStore = ReturnType<typeof createSetupStore>;
