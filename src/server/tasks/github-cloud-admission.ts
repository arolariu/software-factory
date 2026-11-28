import type { ApiDto, StartTask } from '../../shared/api/schemas.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import type { StartBinding, StartClaim } from '../persistence/task-start.js';
import type { RepositoryAccess } from '../repositories/provider.js';
import type { probeCloudTaskWithSdk } from './cloud-launch.js';
import { startClaimKey, type LaunchRuntime } from './supervised-launch.js';
import { isLaunchChoice, launchPreferences } from './launch-preferences.js';

export type CloudConnection = RepositoryAccess & { identityId: string; subject: string };
export type TrialTarget = { repoId: string; ownerId: string };
export type CloudAccount = { id: string; subject: string; identityId: string; credentialVersion: string };
interface AdmissionPorts {
  resolveConnection(id: string, requester: Requester): CloudConnection | undefined;
  resolveAccount(requester: Requester, id?: string): CloudAccount | undefined;
  verify(connection: CloudConnection, account: CloudAccount, requester: Requester): Promise<{ token: string; login: string }>;
  issue(connectionId: string, key: string, requester: Requester): Promise<Pick<ApiDto<'issue'>['issue'], 'key' | 'state'>>;
  probe: typeof probeCloudTaskWithSdk;
  models?(requester: Requester, accountId: string): Promise<ApiDto<'copilotCatalog'>['models']>;
}

const disabled = { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' } as const;
const decimal = /^[1-9][0-9]{0,19}$/;
export const cloudTrialOrigin = 'https://factory-trial.localhost:3444';

export function createGitHubCloudAdmission(approved: TrialTarget, ports: AdmissionPorts) {
  const { repoId, ownerId } = approved;
  if (!decimal.test(repoId) || !decimal.test(ownerId)) throw new Error('The trial target requires canonical GitHub numeric IDs.');

  function local(requester: Requester, connectionId: string, accountId?: string) {
    const connection = ports.resolveConnection(connectionId, requester);
    if (!connection || connection.provider !== 'github' || connection.target.host !== 'github.com' ||
      connection.repositoryId !== repoId || connection.scope !== ownerId || connection.subject !== ownerId) return undefined;
    const account = ports.resolveAccount(requester, accountId);
    if (!account || account.identityId !== connection.identityId || account.subject !== connection.subject ||
      (accountId !== undefined && accountId !== account.id)) return undefined;
    const binding: StartBinding = {
      connectionId, repoId: connection.repoId, identityId: connection.identityId,
      generation: connection.generation, scope: `github.com:${ownerId}:${repoId}`,
    };
    return { connection, account, binding };
  }

  const sameBinding = (left: StartBinding, right: StartBinding) =>
    left.connectionId === right.connectionId && left.repoId === right.repoId && left.identityId === right.identityId &&
    left.generation === right.generation && left.scope === right.scope;

  function stillBound(requester: Requester, candidate: NonNullable<ReturnType<typeof local>>) {
    const { binding, account, connection } = candidate;
    const current = local(requester, binding.connectionId, account.id);
    return current !== undefined && sameBinding(binding, current.binding) && current.connection.grantId === connection.grantId &&
      current.account.credentialVersion === account.credentialVersion &&
      current.connection.target.scope === connection.target.scope && current.connection.target.name === connection.target.name;
  }

  async function allowedModels(requester: Requester, accountId: string) {
    const models = await ports.models?.(requester, accountId);
    return models?.filter((model) => model.policy === 'enabled' && isLaunchChoice(model.id))
      .map((model) => ({ id: model.id, name: model.name, supportedEfforts: model.reasoning.filter(isLaunchChoice) }));
  }

  function optionSummary(current: ReturnType<typeof local>): ApiDto<'taskOptions'> {
    return {
      copilotAccountId: current?.account.id ?? null,
      launch: current ? { available: true } : disabled,
      featureBranch: disabled, models: { availability: disabled, items: [] },
      ...(current && ports.models && { modelPicker: true as const }),
    };
  }

  async function verify(requester: Requester, connectionId: string, input: StartTask, signal?: AbortSignal, claim?: StartClaim) {
    signal?.throwIfAborted();
    if (!decimal.test(input.workItemKey)) return undefined;
    const overrides = launchPreferences(input.overrides);
    const candidate = local(requester, connectionId, input.copilotAccountId);
    if (!candidate || (claim && !sameBinding(candidate.binding, claim))) return undefined;
    const { connection, account } = candidate;
    if (overrides) {
      if (!ports.models) return undefined;
      const models = await allowedModels(requester, account.id);
      signal?.throwIfAborted();
      if (!models) throw new ApiFailure('TEMPORARILY_UNAVAILABLE');
      const model = models.find((item) => item.id === overrides.model);
      if (!model || (overrides.reasoningEffort && !model.supportedEfforts.includes(overrides.reasoningEffort))) return undefined;
    }
    const [credential, issue] = await Promise.all([
      ports.verify(connection, account, requester),
      ports.issue(connectionId, input.workItemKey, requester),
    ]);
    signal?.throwIfAborted();
    if (!stillBound(requester, candidate) || issue.state !== 'open' || issue.key !== input.workItemKey) return undefined;
    return { ...candidate, credential, overrides };
  }

  async function prepare(candidate: Readonly<StartClaim>, signal?: AbortSignal) {
    const requester = { id: candidate.requesterId };
    const key = startClaimKey(candidate);
    const current = await verify(requester, candidate.connectionId, candidate, signal, candidate);
    if (!current) return undefined;
    let used = false;
    return {
      binding: current.binding,
      stillAuthorized: () => stillBound(requester, current),
      async dispatch(claim: Readonly<StartClaim>) {
        if (used || startClaimKey(claim) !== key) throw new ApiFailure('ACCESS_UNVERIFIED');
        used = true;
        signal?.throwIfAborted();
        if (!stillBound(requester, current)) throw new ApiFailure('ACCESS_UNVERIFIED');
        const { connection, credential } = current;
        const verifyCredential = () => {
          if (!stillBound(requester, current)) throw new ApiFailure('ACCESS_UNVERIFIED');
        };
        const repository = { owner: connection.target.scope, name: connection.target.name };
        const issueUrl = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${claim.workItemKey}`;
        const result = await ports.probe(credential.token, {
          requestedSessionId: claim.requestedSessionId, expectedLogin: credential.login, repository, turnId: claim.startRequestId,
          verifyCredential,
          ...current.overrides,
          prompt: `Review the issue at ${issueUrl} and propose an implementation and tests. Do not edit files, run shell commands, or create branches, commits, issues, or pull requests.`,
        }, signal);
        if (result.sessionId !== claim.requestedSessionId || !stillBound(requester, current)) throw new ApiFailure('ACCESS_UNVERIFIED');
        const { usage } = result;
        return {
          claim, sessionId: result.sessionId,
          ...(result.sessionUrl && { sessionUrl: result.sessionUrl }),
          ...(usage && { usage: {
            ...(usage.nanoAiu === null ? {} : { aiCreditsStatus: 'complete', totalNanoAiu: usage.nanoAiu }),
            ...(usage.premiumRequests === null ? {} : { totalPremiumRequestCost: usage.premiumRequests }),
          } }),
        };
      },
    };
  }

  return {
    describe(requester, connectionId, query) {
      return optionSummary(local(requester, connectionId, query.copilotAccountId));
    },
    async modelOptions(requester, connectionId, query) {
      const current = local(requester, connectionId, query.copilotAccountId);
      const options = optionSummary(current);
      if (!current || !ports.models) return options;
      const items = await allowedModels(requester, current.account.id);
      if (!stillBound(requester, current)) return optionSummary(undefined);
      return items ? { ...options, models: { availability: { available: true }, items } } : options;
    },
    async authorize(requester, connectionId, input, signal?: AbortSignal) {
      return (await verify(requester, connectionId, input, signal))?.binding;
    },
    canReplay: (requester, connectionId, accountId) => !!local(requester, connectionId, accountId),
    prepare,
    async launch(claim, signal?: AbortSignal) {
      const current = await prepare(claim, signal);
      if (!current) throw new ApiFailure('ACCESS_UNVERIFIED');
      return current.dispatch(claim);
    },
  } satisfies LaunchRuntime;
}
