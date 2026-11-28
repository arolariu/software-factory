import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import type SQLite from 'better-sqlite3';
import type { ApiDto } from '../../shared/api/schemas.js';
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
import { createSupervisedLaunch, type LaunchRuntime } from '../tasks/supervised-launch.js';
import { createGitHubCloudAdmission, type TrialTarget } from '../tasks/github-cloud-admission.js';
import { probeCloudTaskWithSdk } from '../tasks/cloud-launch.js';
import { createTaskUsage } from '../persistence/task-usage.js';
import { readCloudTaskEvidence } from '../tasks/cloud-task-status.js';
import { createTaskOutcomes } from '../persistence/task-outcomes.js';

export interface IdentityFiles { configFile: string; keyFile: string }
type LaunchOptions = LaunchRuntime | { approvedTarget: TrialTarget; probe?: typeof probeCloudTaskWithSdk };

const workerIntervalMs = 500;

export function openIdentityPortal(db: SQLite.Database, dataDir: string, files: IdentityFiles, fetcher = fetch, launch?: LaunchOptions) {
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
  return createConfiguredPortal(db, setup, vault, cursorKey, fetcher, undefined, launch);
}

export function createConfiguredPortal(db: SQLite.Database, setup: ReturnType<typeof parseIdentityConfig>,
  vault: CredentialVault, cursorKey: Buffer, fetcher = fetch, inspectCopilot?: CatalogInspection, launch?: LaunchOptions) {
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
  const trialTarget = launch && 'approvedTarget' in launch ? launch.approvedTarget : undefined;
  const taskUsage = trialTarget && createTaskUsage(db, identity.readGrant);
  const taskOutcomes = createTaskOutcomes(db);
  const catalog = inspectCopilot && createCopilotCatalog(identity.readCopilotToken, inspectCopilot);
  const launchRuntime = launch && 'approvedTarget' in launch ? createGitHubCloudAdmission(launch.approvedTarget, {
    resolveConnection: identity.repositoryContext,
    resolveAccount: identity.copilotLaunchAccount,
    async verify(connection, account, requester) {
      const registration = setup.registry.registration('github.com', 'copilot');
      const token = await identity.readCopilotToken(account.id, requester);
      const [copilot] = await Promise.all([
        transport.verifyIdentity(registration, { accessToken: token, refreshToken: null, expiresAt: null }, connection.target),
        verifyConnection(connection, requester),
      ]);
      const { host, scope, name } = connection.target;
      const matchingUrl = `https://${host}/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
      if (copilot.subject !== account.subject || copilot.repo?.id !== connection.repositoryId ||
        copilot.repo.scope !== connection.scope || copilot.repo.url !== matchingUrl) throw new ApiFailure('ACCESS_UNVERIFIED');
      return { token, login: scope };
    },
    async issue(id, key, requester) { return (await repositories.issue(requester, id, key, { limit: '1' })).issue; },
    probe: launch.probe ?? probeCloudTaskWithSdk,
    ...(catalog && { async models(requester: Requester, accountId: string) { return (await catalog(requester, accountId)).models; } }),
  }) : launch;
  const launcher = launchRuntime && createSupervisedLaunch(db, launchRuntime, identity.readGrant);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let launching: Promise<void> | undefined;
  const worker = new AbortController();
  const stop = () => {
    clearInterval(timer);
    worker.abort();
  };
  const unavailable = () => { throw new ApiFailure('TEMPORARILY_UNAVAILABLE'); };
  const disabled = () => { throw new ApiFailure('CAPABILITY_UNAVAILABLE'); };
  function cloudContext(requester: Requester, taskId: string) {
    const { sessionUrl } = taskReads.task(requester, taskId);
    const binding = taskUsage?.target(requester, taskId);
    if (!sessionUrl || !binding || !trialTarget) return undefined;
    const connection = identity.repositoryContext(binding.connectionId, requester);
    const account = identity.copilotLaunchAccount(requester, binding.copilotAccountId);
    if (!connection || connection.repositoryId !== trialTarget.repoId || connection.scope !== trialTarget.ownerId ||
      account?.identityId !== connection.identityId || account.subject !== trialTarget.ownerId) return undefined;
    return { binding, credentialVersion: account.credentialVersion, target: {
      sessionId: binding.sessionId, sessionUrl, owner: connection.target.scope, repository: connection.target.name,
      repositoryId: trialTarget.repoId, ownerId: trialTarget.ownerId,
    } };
  }
  async function cloudEvidence(requester: Requester, taskId: string) {
    const scoped = cloudContext(requester, taskId);
    if (!scoped) return undefined;
    const grantId = scoped.binding.copilotAccountId;
    const token = await identity.readCopilotToken(grantId, requester).catch(() => undefined);
    if (!token) return undefined;
    const evidence = await readCloudTaskEvidence(scoped.target, token, request);
    if (JSON.stringify(cloudContext(requester, taskId)) !== JSON.stringify(scoped)) return undefined;
    return { ...evidence, scoped };
  }
  async function cloudStatus(requester: Requester, taskId: string): Promise<ApiDto<'cloudTaskStatus'>> {
    const evidence = await cloudEvidence(requester, taskId);
    if (!evidence) return { state: null };
    return { ...evidence.status, ...(evidence.outcome && { recordableOutcome: evidence.outcome.state }) };
  }
  async function recordCloudOutcome(requester: Requester, taskId: string, input: ApiDto<'recordCloudOutcome'>): Promise<ApiDto<'recordedCloudOutcome'>> {
    const evidence = await cloudEvidence(requester, taskId);
    if (!evidence?.outcome || evidence.outcome.state !== input.expectedState) throw new ApiFailure('TASK_OUTCOME_UNVERIFIED');
    const { outcome } = evidence;
    return db.transaction(() => {
      if (JSON.stringify(cloudContext(requester, taskId)) !== JSON.stringify(evidence.scoped)) {
        throw new ApiFailure('TASK_OUTCOME_UNVERIFIED');
      }
      return taskOutcomes(taskId, outcome, Date.now());
    }).immediate();
  }
  function taskOptions(requester: Requester, id: string, query: ApiDto<'optionsQuery'>) {
    const describe = launchRuntime?.describe;
    if (!describe) return unavailable();
    const connection = identity.repositoryContext(id, requester);
    if (!connection) throw new ApiFailure('NOT_FOUND');
    if (connection.provider !== 'github' || connection.target.host !== 'github.com') return disabled();
    const access = identity.readGrant(id, requester);
    if (access === 'denied') throw new ApiFailure('ACCESS_DENIED');
    if (access !== 'valid') throw new ApiFailure('ACCESS_UNVERIFIED');
    return describe(requester, id, query);
  }
  const portal = {
    publicOrigin: setup.origin,
    modules: {
      identity: { ...identity, ...(catalog && { copilotCatalog: catalog }) },
      repositories: {
        connections: identity.connections, issues: repositories.issues,
        async issue(requester, id, key, query) {
          const result = await repositories.issue(requester, id, key, query);
          if (!launchRuntime?.describe || result.issue.state !== 'open') return result;
          const connection = identity.repositoryContext(id, requester);
          if (connection?.provider !== 'github' || connection.target.host !== 'github.com') return result;
          const association = taskReads.issueTask(requester, id, key);
          const launch = association.busy ? { available: false as const, reasonCode: 'CAPABILITY_UNAVAILABLE' } : taskOptions(requester, id, {}).launch;
          return { ...result, issue: { ...result.issue, taskId: association.taskId, launch } };
        },
        pullRequests: repositories.pullRequests, checks: repositories.checks, closeIssue: disabled,
      },
      tasks: {
        ...taskReads, unlinkedSessions: unavailable,
        task(requester, id) {
          const task = taskReads.task(requester, id);
          return trialTarget && task.sessionUrl ? { ...task, cloudStatusAvailable: true as const } : task;
        },
        ...(trialTarget && { cloudStatus, recordCloudOutcome }),
        activity: unavailable,
        options(requester, id, query) {
          const base = taskOptions(requester, id, query);
          return query.includeModels === '1' && launchRuntime?.modelOptions
            ? launchRuntime.modelOptions(requester, id, query) : base;
        },
        start: launcher?.reserve ?? disabled,
      },
      operations: {
        read: repositories.read, sync: repositories.sync, input: disabled, archive: disabled, remove: disabled,
        authorizeEffect(requester, effect) {
          if (!('connectionId' in effect) || !identity.connections(requester).items.some(({ id }) => id === effect.connectionId)) {
            throw new ApiFailure('NOT_FOUND');
          }
          if (effect.kind === 'start' && launcher) return;
          disabled();
        },
      },
    },
  } satisfies PortalOptions;
  return {
    portal, identity, transport,
    start() {
      repositories.recoverInterrupted();
      launcher?.recoverInterrupted();
      timer = setInterval(() => {
        if (launcher && !launching) {
          launching = workerSignal.run(worker.signal, () => launcher.runNext(worker.signal))
            .catch(() => { console.error('Supervised task worker failed.'); })
            .finally(() => { launching = undefined; });
        }
        if (running) return;
        running = workerSignal.run(worker.signal, () => repositories.runNextOperation(worker.signal))
          .then(() => undefined, () => { console.error('Repository Sync worker failed.'); })
          .finally(() => { running = undefined; });
      }, workerIntervalMs).unref();
    },
    stop,
    async close() {
      stop();
      await Promise.all([running, launching]);
      cursorKey.fill(0);
      vault.close();
    },
  };
}
