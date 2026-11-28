import type SQLite from 'better-sqlite3';
import type { ApiDto, StartTask } from '../../shared/api/schemas.js';
import { opaqueIdSegment } from '../../shared/api/opaque-id.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { createTaskStarts, type StartBinding, type StartClaim } from '../persistence/task-start.js';
import { createTaskUsage } from '../persistence/task-usage.js';

type UsageAccess = Parameters<typeof createTaskUsage>[1];
type Receipt = { claim: Readonly<StartClaim>; sessionId: string; sessionUrl?: string; usage?: unknown };
export interface LaunchRuntime {
  describe?(requester: Requester, connectionId: string, query: ApiDto<'optionsQuery'>): ApiDto<'taskOptions'>;
  modelOptions?(requester: Requester, connectionId: string, query: ApiDto<'optionsQuery'>): Promise<ApiDto<'taskOptions'>>;
  authorize(requester: Requester, connectionId: string, input: StartTask, signal?: AbortSignal): Promise<StartBinding | undefined>;
  launch(claim: Readonly<StartClaim>, signal?: AbortSignal): Promise<Receipt>;
}

const sessionId = new RegExp(`^${opaqueIdSegment}$`);
const keys = [
  'taskId', 'requesterId', 'connectionId', 'repoId', 'identityId', 'generation', 'scope',
  'requestedSessionId', 'copilotAccountId', 'workItemKey', 'startRequestId',
] as const satisfies readonly (keyof StartClaim)[];

export function createSupervisedLaunch(db: SQLite.Database, runtime: LaunchRuntime, readAccess: UsageAccess, now = Date.now) {
  const starts = createTaskStarts(db, undefined, now);
  const usage = createTaskUsage(db, readAccess);
  let running: Promise<void> | undefined;
  const confirm = db.transaction((claim: StartClaim, receipt: Receipt) => {
    if (!sessionId.test(receipt.sessionId) || !keys.every((key) => receipt.claim[key] === claim[key]) ||
      receipt.claim.overrides?.model !== claim.overrides?.model || receipt.claim.overrides?.reasoningEffort !== claim.overrides?.reasoningEffort ||
      readAccess(claim.connectionId, { id: claim.requesterId }) !== 'valid' ||
      !starts.confirm(claim, receipt.sessionId, receipt.sessionUrl)) return false;
    if (receipt.usage !== undefined) {
      const target = usage.target({ id: claim.requesterId }, claim.taskId);
      if (target) usage.record(target, receipt.usage, now());
    }
    return true;
  });

  async function runNext(signal?: AbortSignal) {
    const candidate = starts.next();
    if (!candidate || signal?.aborted) return;
    const requester = { id: candidate.requesterId };
    let proof: StartBinding | undefined;
    try {
      proof = await runtime.authorize(requester, candidate.connectionId, {
        startRequestId: candidate.startRequestId, workItemKey: candidate.workItemKey, copilotAccountId: candidate.copilotAccountId,
        ...(candidate.overrides && { overrides: candidate.overrides }),
      }, signal);
    } catch {
      // Unverified admission is held without calling the launch runtime or blocking the queue.
    }
    if (signal?.aborted) return;
    if (!proof || readAccess(candidate.connectionId, requester) !== 'valid') {
      starts.requireAuthorization(candidate);
      return;
    }
    const claim = starts.claim(candidate.taskId, proof);
    if (!claim) {
      starts.requireAuthorization(candidate);
      return;
    }
    try {
      const { overrides } = claim;
      const receipt = await runtime.launch(Object.freeze({ ...claim, ...(overrides && { overrides: Object.freeze({ ...overrides }) }) }), signal);
      if (!signal?.aborted && confirm.immediate(claim, receipt)) return;
    } catch {
      // The runtime may have started work even when its reply is lost.
    }
    starts.requireRecovery(claim);
  }

  return {
    async reserve(requester: Requester, connectionId: string, input: StartTask) {
      const proof = await runtime.authorize(requester, connectionId, input);
      if (!proof) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
      if (readAccess(connectionId, requester) !== 'valid') throw new ApiFailure('ACCESS_UNVERIFIED');
      return starts.reserve(requester, connectionId, input, proof);
    },
    runNext(signal?: AbortSignal) {
      running ??= runNext(signal).finally(() => { running = undefined; });
      return running;
    },
    recoverInterrupted: starts.recoverInterrupted,
  };
}
