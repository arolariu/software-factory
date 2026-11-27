import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import type SQLite from 'better-sqlite3';
import type { PortalOptions, Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { openCredentialVault, type CredentialVault } from './credentials.js';
import { parseIdentityConfig } from './github-hosts.js';
import { createIdentity } from './module.js';
import { createOAuthTransport } from './oauth.js';
import { createRepositoryProvider } from '../repositories/adapters.js';
import type { RepositoryAccess } from '../repositories/provider.js';
import { createRepositoryService } from '../repositories/sync.js';
import { createTaskReads } from '../persistence/task-reads.js';
import { createCopilotCatalog, type CatalogInspection } from './copilot-catalog.js';

export interface IdentityFiles { configFile: string; keyFile: string }

const workerIntervalMs = 500;

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
  const cursorKey = createHmac('sha256', key).update('software-factory/repository-cursors/v1').digest();
  const vault = (() => {
    try { return openCredentialVault(join(dataDir, 'credentials.sqlite'), key); }
    finally { key.fill(0); }
  })();
  return createConfiguredPortal(db, setup, vault, cursorKey, fetcher);
}

export function createConfiguredPortal(db: SQLite.Database, setup: ReturnType<typeof parseIdentityConfig>,
  vault: CredentialVault, cursorKey: Buffer, fetcher = fetch, inspectCopilot?: CatalogInspection) {
  const workerSignal = new AsyncLocalStorage<AbortSignal>();
  const request: typeof fetch = (input, options) => {
    const worker = workerSignal.getStore();
    return worker ? fetcher(input, { ...options, signal: AbortSignal.any(options?.signal ? [worker, options.signal] : [worker]) })
      : fetcher(input, options);
  };
  const transport = createOAuthTransport(request);
  const identity = createIdentity({ db, vault, ...setup, ...transport });

  async function verifyConnection(connection: RepositoryAccess, requester: Requester) {
    const host = connection.provider === 'github' ? connection.target.host : 'azure-devops';
    const registration = setup.registry.registration(host, 'repository');
    const tokens = await identity.readTokens(connection.grantId, requester);
    const proof = await transport.verifyRepository(registration, connection.target, tokens.accessToken)
      .catch((error: unknown) => {
        if (error instanceof ApiFailure && error.code === 'NOT_FOUND') throw new ApiFailure('ACCESS_DENIED');
        throw error;
      });
    if (proof.id !== connection.repositoryId || proof.host !== connection.target.host || proof.scope !== connection.scope) {
      throw new ApiFailure('ACCESS_DENIED');
    }
  }

  const repositories = createRepositoryService({
    db, cursorKey,
    access: {
      resolve: identity.repositoryContext, readGrant: identity.readGrant, deny: identity.markConnectionDenied,
      recordVerification: identity.markConnectionVerified, verify: verifyConnection,
    },
    async provider(connection, requester) {
      const tokens = await identity.readTokens(connection.grantId, requester);
      return createRepositoryProvider(connection, tokens.accessToken, request);
    },
  });
  const taskReads = createTaskReads(db, cursorKey, identity.readGrant);
  const catalog = inspectCopilot && createCopilotCatalog(identity.readCopilotToken, inspectCopilot);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const worker = new AbortController();
  const stop = () => {
    clearInterval(timer);
    worker.abort();
  };
  const unavailable = () => { throw new ApiFailure('TEMPORARILY_UNAVAILABLE'); };
  const disabled = () => { throw new ApiFailure('CAPABILITY_UNAVAILABLE'); };
  const portal = {
    publicOrigin: setup.origin,
    modules: {
      identity: { ...identity, ...(catalog && { copilotCatalog: catalog }) },
      repositories: {
        connections: identity.connections, issues: repositories.issues, issue: repositories.issue,
        pullRequests: repositories.pullRequests, checks: repositories.checks, closeIssue: disabled,
      },
      tasks: {
        ...taskReads, unlinkedSessions: unavailable,
        activity: unavailable, options: unavailable, start: disabled,
      },
      operations: {
        read: repositories.read, sync: repositories.sync, input: disabled, archive: disabled, remove: disabled,
        authorizeEffect(requester, effect) {
          if (!('connectionId' in effect) || !identity.connections(requester).items.some(({ id }) => id === effect.connectionId)) {
            throw new ApiFailure('NOT_FOUND');
          }
          disabled();
        },
      },
    },
  } satisfies PortalOptions;
  return {
    portal, identity, transport,
    start() {
      repositories.recoverInterrupted();
      timer = setInterval(() => {
        if (running) return;
        running = workerSignal.run(worker.signal, () => repositories.runNextOperation(worker.signal))
          .then(() => undefined, () => { console.error('Repository Sync worker failed.'); })
          .finally(() => { running = undefined; });
      }, workerIntervalMs).unref();
    },
    stop,
    async close() {
      stop();
      await running;
      cursorKey.fill(0);
      vault.close();
    },
  };
}
