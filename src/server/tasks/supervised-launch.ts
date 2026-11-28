import type SQLite from 'better-sqlite3';
import type { ApiDto, StartTask } from '../../shared/api/schemas.js';
import { opaqueIdSegment } from '../../shared/api/opaque-id.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import { createTaskStarts, type StartBinding, type StartClaim } from '../persistence/task-start.js';
import { createTaskUsage } from '../persistence/task-usage.js';

type UsageAccess = Parameters<typeof createTaskUsage>[1];
type Receipt = { claim: Readonly<StartClaim>; sessionId: string; sessionUrl?: string; usage?: unknown };
type PreparedLaunch = { binding: StartBinding; stillAuthorized?: () => boolean; dispatch(claim: Readonly<StartClaim>): Promise<Receipt> };
export interface LaunchRuntime {
  describe?(requester: Requester, connectionId: string, query: ApiDto<'optionsQuery'>): ApiDto<'taskOptions'>;
  modelOptions?(requester: Requester, connectionId: string, query: ApiDto<'optionsQuery'>): Promise<ApiDto<'taskOptions'>>;
  authorize(requester: Requester, connectionId: string, input: StartTask, signal?: AbortSignal): Promise<StartBinding | undefined>;
  canReplay?(requester: Requester, connectionId: string, accountId: string): boolean;
  prepare?(candidate: Readonly<StartClaim>, signal?: AbortSignal): Promise<PreparedLaunch | undefined>;
  launch(claim: Readonly<StartClaim>, signal?: AbortSignal): Promise<Receipt>;
}

const sessionId = new RegExp(`^${opaqueIdSegment}$`);
const keys = [
  'taskId', 'requesterId', 'connectionId', 'repoId', 'identityId', 'generation', 'scope',
  'requestedSessionId', 'copilotAccountId', 'workItemKey', 'startRequestId',
] as const satisfies readonly (keyof StartClaim)[];

export function startClaimKey(claim: Readonly<StartClaim>) {
  return JSON.stringify([...keys.map((key) => claim[key]), claim.overrides?.model, claim.overrides?.reasoningEffort]);
}

export function createSupervisedLaunch(db: SQLite.Database, runtime: LaunchRuntime, readAccess: UsageAccess, now = Date.now) {
  const starts = createTaskStarts(db, undefined, now);
  const usage = createTaskUsage(db, readAccess);
  let running: Promise<void> | undefined;
  const delays = new Map<string, { count: number; due: number }>();
  const definitive = new Set(['AUTH_REQUIRED', 'ACCESS_DENIED', 'COPILOT_REAUTH_REQUIRED', 'CAPABILITY_UNAVAILABLE', 'NOT_FOUND', 'INVALID_REQUEST']);
  function failUnclaimed(candidate: StartClaim) {
    delays.delete(candidate.taskId);
    starts.failUnclaimed(candidate);
  }
  function defer(candidate: StartClaim, reason?: unknown) {
    const count = (delays.get(candidate.taskId)?.count ?? 0) + 1;
    if (count >= 3) return failUnclaimed(candidate);
    const retryAfter = reason instanceof ApiFailure && reason.code === 'RATE_LIMITED' ? reason.retryAfter : undefined;
    delays.set(candidate.taskId, { count, due: now() + 1_000 * Math.max(count, Math.min(60, retryAfter ?? 0)) });
  }
  const confirm = db.transaction((claim: StartClaim, receipt: Receipt, stillAuthorized?: () => boolean) => {
    if (!sessionId.test(receipt.sessionId) || startClaimKey(receipt.claim) !== startClaimKey(claim) ||
      stillAuthorized?.() === false ||
      readAccess(claim.connectionId, { id: claim.requesterId }) !== 'valid' ||
      !starts.confirm(claim, receipt.sessionId, receipt.sessionUrl)) return false;
    if (receipt.usage !== undefined) {
      const target = usage.target({ id: claim.requesterId }, claim.taskId);
      if (target) usage.record(target, receipt.usage, now());
    }
    return true;
  });

  async function runNext(signal?: AbortSignal) {
    const candidate = starts.next([...delays].filter(([, value]) => value.due > now()).map(([id]) => id));
    if (!candidate || signal?.aborted) return;
    const requester = { id: candidate.requesterId };
    let proof: StartBinding | undefined;
    let prepared: PreparedLaunch | undefined;
    try {
      if (runtime.prepare) {
        prepared = await runtime.prepare(candidate, signal);
        proof = prepared?.binding;
      } else {
        proof = await runtime.authorize(requester, candidate.connectionId, {
          startRequestId: candidate.startRequestId, workItemKey: candidate.workItemKey, copilotAccountId: candidate.copilotAccountId,
          ...(candidate.overrides && { overrides: candidate.overrides }),
        }, signal);
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiFailure && definitive.has(error.code)) failUnclaimed(candidate);
      else defer(candidate, error);
      return;
    }
    if (signal?.aborted) return;
    const access = readAccess(candidate.connectionId, requester);
    if (!proof || access === 'denied') return failUnclaimed(candidate);
    if (access === 'unverified') return defer(candidate);
    const claim = starts.claim(candidate.taskId, proof);
    if (!claim) return failUnclaimed(candidate);
    delays.delete(candidate.taskId);
    if (prepared?.stillAuthorized?.() === false) {
      starts.fail(claim);
      return;
    }
    try {
      const { overrides } = claim;
      const bound = Object.freeze({ ...claim, ...(overrides && { overrides: Object.freeze({ ...overrides }) }) });
      const receipt = await (prepared ? prepared.dispatch(bound) : runtime.launch(bound, signal));
      if (confirm.immediate(claim, receipt, prepared?.stillAuthorized)) return;
    } catch {
      // The runtime may have started work even when its reply is lost.
    }
    starts.requireRecovery(claim);
  }

  return {
    async reserve(requester: Requester, connectionId: string, input: StartTask) {
      const access = readAccess(connectionId, requester);
      if (access === 'denied') throw new ApiFailure('ACCESS_DENIED');
      if (access === 'valid' && (!runtime.canReplay || runtime.canReplay(requester, connectionId, input.copilotAccountId))) {
        const previous = starts.replay(requester, connectionId, input);
        if (previous) return previous;
      }
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
