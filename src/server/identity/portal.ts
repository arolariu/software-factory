import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type SQLite from 'better-sqlite3';
import type { PortalOptions } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { openCredentialVault } from './credentials.js';
import { parseIdentityConfig } from './github-hosts.js';
import { createIdentity } from './module.js';
import { createOAuthTransport } from './oauth.js';

export interface IdentityFiles { configFile: string; keyFile: string }

export function openIdentityPortal(db: SQLite.Database, dataDir: string, files: IdentityFiles, fetcher = fetch) {
  let setup: ReturnType<typeof parseIdentityConfig>;
  try {
    setup = parseIdentityConfig(JSON.parse(readFileSync(files.configFile, 'utf8')) as unknown);
  } catch {
    throw new Error('Identity configuration is missing or invalid.');
  }
  let key: Buffer;
  try { key = readFileSync(files.keyFile); }
  catch { throw new Error('Credential encryption key is missing or unreadable.'); }
  const vault = (() => {
    try { return openCredentialVault(join(dataDir, 'credentials.sqlite'), key); }
    finally { key.fill(0); }
  })();
  const identity = createIdentity({ db, vault, ...setup, ...createOAuthTransport(fetcher) });
  const unavailable = () => { throw new ApiFailure('TEMPORARILY_UNAVAILABLE'); };
  const disabled = () => { throw new ApiFailure('CAPABILITY_UNAVAILABLE'); };
  const portal = {
    publicOrigin: setup.origin,
    modules: {
      identity,
      repositories: {
        connections: identity.connections, issues: unavailable, issue: unavailable, pullRequests: unavailable,
        checks: unavailable, closeIssue: disabled,
      },
      tasks: {
        tasks: unavailable, activeSessions: unavailable, unlinkedSessions: unavailable, task: unavailable,
        activity: unavailable, options: unavailable, statistics: unavailable, start: disabled,
      },
      operations: {
        read: unavailable, sync: unavailable, input: disabled, archive: disabled, remove: disabled,
        authorizeEffect(requester, effect) {
          if (!('connectionId' in effect) || !identity.connections(requester).items.some(({ id }) => id === effect.connectionId)) {
            throw new ApiFailure('NOT_FOUND');
          }
          disabled();
        },
      },
    },
  } satisfies PortalOptions;
  return { portal, close: vault.close };
}
