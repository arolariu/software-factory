import { addAbortListener } from 'node:events';
import { createSdk, withCopilotRuntime } from '../identity/copilot-runtime.js';
import { ApiFailure } from '../http/problems.js';

export type CloudEvent = { type: string; data?: { producer?: string; clientTurnId?: string } };
type CloudRequest = {
  requestedSessionId: string;
  repository: { owner: string; name: string };
  expectedLogin?: string;
  turnId: string;
  prompt: string;
};
type Deny = { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
export interface CloudLaunchClient {
  getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string; login?: string }>;
  createSession(config: {
    sessionId: string; cloud: { repository: CloudRequest['repository'] }; onPermissionRequest: () => Deny;
  }): Promise<{
    sessionId: string;
    getEvents(): Promise<CloudEvent[]>;
    on(handler: (event: CloudEvent) => void): () => void;
    send(input: { prompt: string; clientTurnId: string }): Promise<string>;
  }>;
}

export async function dispatchCloudTask(client: CloudLaunchClient, request: CloudRequest, parent?: AbortSignal) {
  const deadline = AbortSignal.timeout(60_000);
  const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
  signal.throwIfAborted();
  const cancel = Promise.withResolvers<never>();
  const cancellation = addAbortListener(signal, () => cancel.reject(signal.reason));
  let unsubscribe: (() => void) | undefined;
  try {
    const status = await Promise.race([client.getAuthStatus(), cancel.promise]);
    if (!status.isAuthenticated || status.authType !== 'token') throw new ApiFailure('COPILOT_REAUTH_REQUIRED');
    if (request.expectedLogin && status.login?.toLowerCase() !== request.expectedLogin.toLowerCase()) {
      throw new ApiFailure('ACCESS_UNVERIFIED');
    }
    signal.throwIfAborted();
    const session = await Promise.race([
      client.createSession({
        sessionId: request.requestedSessionId, cloud: { repository: request.repository },
        onPermissionRequest: () => ({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' }),
      }),
      cancel.promise,
    ]);
    if (session.sessionId !== request.requestedSessionId) throw new ApiFailure('ACCESS_UNVERIFIED');
    const ready = Promise.withResolvers<void>();
    const consumed = Promise.withResolvers<void>();
    let sending = false;
    const observe = (event: CloudEvent) => {
      if (event.type === 'session.start' && event.data?.producer === 'copilot-agent') ready.resolve();
      if (sending && event.type === 'user.message' && event.data?.clientTurnId === request.turnId) consumed.resolve();
    };
    unsubscribe = session.on(observe);
    // A worker can start before createSession returns. Prefer the cached event when present.
    void session.getEvents().then((history) => history.forEach((event) => {
      if (event.type === 'session.start') observe(event);
    })).catch(() => undefined);
    await Promise.race([ready.promise, cancel.promise]);
    signal.throwIfAborted();
    sending = true;
    await Promise.race([session.send({ prompt: request.prompt, clientTurnId: request.turnId }), cancel.promise]);
    await Promise.race([consumed.promise, cancel.promise]);
    signal.throwIfAborted();
    return session.sessionId;
  } finally {
    cancellation[Symbol.dispose]();
    unsubscribe?.();
  }
}

// Not registered by any production entry point: provider behavior must be proven on the approved target.
export function dispatchCloudTaskWithSdk(token: string, request: CloudRequest, signal?: AbortSignal) {
  return withCopilotRuntime(token, createSdk, (client) => dispatchCloudTask(client, request, signal), 65_000);
}
