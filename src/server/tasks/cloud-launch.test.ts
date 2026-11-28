import { expect, it, vi } from 'vitest';
import { dispatchCloudTask, probeCloudTask, type CloudEvent, type CloudLaunchClient } from './cloud-launch.js';

function fixture() {
  const listeners = new Set<(event: CloudEvent) => void>();
  const emit = (event: CloudEvent) => { for (const listener of listeners) listener(event); };
  const session = {
    sessionId: 'provided-session',
    on(handler: (event: CloudEvent) => void) {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
    getEvents: vi.fn(async (): Promise<CloudEvent[]> => []),
    send: vi.fn(async (_options: { prompt: string; clientTurnId: string }) => 'not-a-delivery-receipt'),
    rpc: { usage: { getMetrics: vi.fn(async (): Promise<unknown> => ({
      aiCreditsStatus: 'complete', totalNanoAiu: 0, totalPremiumRequestCost: 0.25, raw: 'private',
    })) } },
  };
  const client = {
    getAuthStatus: vi.fn(async (): Promise<{ isAuthenticated: boolean; authType: string; login?: string }> =>
      ({ isAuthenticated: true, authType: 'token', login: 'example' })),
    createSession: vi.fn(async (_config: Parameters<CloudLaunchClient['createSession']>[0]) => session),
  };
  return { client, emit, session, listeners };
}

const request = {
  requestedSessionId: 'provided-session',
  repository: { owner: 'example', name: 'disposable' },
  turnId: 'turn-one',
  prompt: 'Summarize the README.',
};

it('waits for the remote worker and a matching consumed-turn event, not the SDK message ID', async () => {
  const { client, session, emit, listeners } = fixture();
  const pending = dispatchCloudTask(client, { ...request, expectedLogin: 'Example', model: 'm1', reasoningEffort: 'low' });
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  emit({ type: 'session.start', data: { producer: 'local-cli' } });
  expect(session.send).not.toHaveBeenCalled();
  emit({ type: 'session.start', data: { producer: 'copilot-agent' } });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledExactlyOnceWith({
    prompt: request.prompt, clientTurnId: request.turnId,
  }));
  let delivered = false;
  void pending.then(() => { delivered = true; });
  emit({ type: 'user.message', data: { clientTurnId: 'different-turn' } });
  await Promise.resolve();
  expect(delivered).toBe(false);
  emit({ type: 'user.message', data: { clientTurnId: request.turnId } });
  expect(await pending).toBe(session.sessionId);
  expect(session.rpc.usage.getMetrics).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
  expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: request.requestedSessionId, cloud: { repository: request.repository }, availableTools: [],
    model: 'm1', reasoningEffort: 'low',
  }));
  expect(client.createSession.mock.lastCall?.[0].onPermissionRequest()).toEqual({
    kind: 'denied-no-approval-rule-and-could-not-request-from-user',
  });
});

it('keeps exact remote delivery when shutdown interrupts only the optional usage sample', async () => {
  const { client, emit, session, listeners } = fixture();
  const stop = new AbortController();
  const pending = probeCloudTask(client, request, stop.signal);
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  emit({ type: 'session.start', data: { producer: 'copilot-agent' } });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  emit({ type: 'user.message', data: { clientTurnId: request.turnId } });
  stop.abort();
  await expect(pending).resolves.toEqual({ sessionId: request.requestedSessionId, usage: null });
  expect(session.rpc.usage.getMetrics).not.toHaveBeenCalled();
});

it('rechecks the prepared credential before sending the turn, not just before creating the session', async () => {
  const { client, emit, session, listeners } = fixture();
  let valid = true;
  const verifyCredential = vi.fn(() => {
    if (!valid) throw new Error('Credential replaced');
  });
  const pending = expect(dispatchCloudTask(client, { ...request, verifyCredential })).rejects.toThrow('Credential replaced');
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  valid = false;
  emit({ type: 'session.start', data: { producer: 'copilot-agent' } });
  await pending;
  expect(verifyCredential).toHaveBeenCalledTimes(2);
  expect(session.send).not.toHaveBeenCalled();
});

it('can recover a readiness event emitted before subscription using the session event history', async () => {
  const { client, session, emit, listeners } = fixture();
  session.getEvents.mockResolvedValueOnce([{ type: 'session.start', data: { producer: 'copilot-agent' } }]);
  session.send.mockImplementationOnce(async ({ clientTurnId }) => {
    emit({ type: 'user.message', data: { clientTurnId } });
    return 'message-id';
  });
  await expect(dispatchCloudTask(client, request)).resolves.toBe('provided-session');
  expect(listeners.size).toBe(0);
});

it('does not send on authentication failure, session mismatch, or interruption', async () => {
  const { client, session, listeners } = fixture();
  client.getAuthStatus.mockResolvedValueOnce({ isAuthenticated: false, authType: 'none' });
  await expect(dispatchCloudTask(client, request)).rejects.toThrow('COPILOT_REAUTH_REQUIRED');
  expect(client.createSession).not.toHaveBeenCalled();
  for (const login of ['different', undefined]) {
    client.getAuthStatus.mockResolvedValueOnce({ isAuthenticated: true, authType: 'token', ...(login && { login }) });
    await expect(dispatchCloudTask(client, { ...request, expectedLogin: 'Example' })).rejects.toThrow('ACCESS_UNVERIFIED');
    expect(client.createSession).not.toHaveBeenCalled();
  }
  client.createSession.mockResolvedValueOnce({ ...session, sessionId: 'unexpected-session' });
  await expect(dispatchCloudTask(client, request)).rejects.toThrow('ACCESS_UNVERIFIED');
  const controller = new AbortController();
  const result = expect(dispatchCloudTask(client, request, controller.signal)).rejects.toThrow();
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  controller.abort();
  await result;
  expect(session.send).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

it('cannot treat a fresh SDK message ID or history failure as evidence when the caller aborts', async () => {
  const { client, session, emit, listeners } = fixture();
  session.getEvents.mockRejectedValueOnce(new Error('History temporarily unavailable'));
  const controller = new AbortController();
  const pending = expect(dispatchCloudTask(client, request, controller.signal)).rejects.toThrow();
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  emit({ type: 'session.start', data: { producer: 'copilot-agent' } });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1));
  controller.abort();
  await pending;
  expect(listeners.size).toBe(0);
  await expect(dispatchCloudTask(client, request, controller.signal)).rejects.toThrow();
  expect(client.createSession).toHaveBeenCalledTimes(1);
});

it('reads exact session usage only after the delivered main-agent turn ends', async () => {
  const { client, emit, session, listeners } = fixture();
  const pending = probeCloudTask(client, request);
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  emit({ type: 'session.start', data: { producer: 'copilot-agent' } });
  emit({ type: 'session.info', data: { infoType: 'remote', url: 'https://github.com/copilot/tasks/provided-session' } });
  emit({ type: 'session.info', data: { infoType: 'remote', url: 'https://github.com/copilot/tasks/different' } });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  emit({ type: 'user.message', data: { clientTurnId: request.turnId, interactionId: 'interaction' } });
  emit({ type: 'assistant.turn_end', data: { turnId: 'main' } });
  emit({ type: 'assistant.turn_start', data: { interactionId: 'interaction', turnId: 'tool', parentToolCallId: 'tool-parent' } });
  emit({ type: 'assistant.turn_end', data: { turnId: 'tool' } });
  emit({ type: 'assistant.turn_start', data: { interactionId: 'different-interaction', turnId: 'other' } });
  emit({ type: 'assistant.turn_end', data: { turnId: 'other' } });
  emit({ type: 'assistant.turn_start', agentId: 'sub-agent', data: { interactionId: 'interaction', turnId: 'sub' } });
  emit({ type: 'assistant.turn_end', data: { turnId: 'sub' } });
  emit({ type: 'assistant.turn_start', data: { interactionId: 'interaction', turnId: 'main' } });
  emit({ type: 'assistant.turn_end', agentId: 'another-agent', data: { turnId: 'main' } });
  await Promise.resolve();
  expect(session.rpc.usage.getMetrics).not.toHaveBeenCalled();
  emit({ type: 'assistant.turn_end', data: { turnId: 'main' } });
  expect(await pending).toEqual({
    sessionId: session.sessionId, usage: { nanoAiu: 0, premiumRequests: 0.25 },
    sessionUrl: 'https://github.com/copilot/tasks/provided-session',
  });
  expect(session.rpc.usage.getMetrics).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});

it('does not trust links with a different origin, identifier, or event source', async () => {
  const { client, emit, session } = fixture();
  session.getEvents.mockResolvedValueOnce([
    { type: 'session.start', data: { producer: 'copilot-agent' } },
    { type: 'session.info', data: { infoType: 'remote', url: 'https://github.com.evil.example/copilot/tasks/provided-session' } },
    { type: 'session.info', data: { infoType: 'remote', url: 'https://github.com/copilot/tasks/provided-session?tracking=1' } },
    { type: 'session.info', data: { infoType: 'other', url: 'https://github.com/copilot/tasks/provided-session' } },
    { type: 'session.info', agentId: 'sub', data: { infoType: 'remote', url: 'https://github.com/copilot/tasks/provided-session' } },
  ]);
  session.send.mockImplementationOnce(async ({ clientTurnId }) => {
    emit({ type: 'user.message', data: { clientTurnId, interactionId: 'interaction' } });
    emit({ type: 'assistant.turn_start', data: { interactionId: 'interaction', turnId: 'main' } });
    emit({ type: 'assistant.turn_end', data: { turnId: 'main' } });
    return 'message-id';
  });
  expect((await probeCloudTask(client, request)).sessionUrl).toBeUndefined();
});
it.each([
  [new Error('private usage failure'), null],
  [{ aiCreditsStatus: 'partial', totalNanoAiu: 500, totalPremiumRequestCost: 0 }, { nanoAiu: null, premiumRequests: 0 }],
] as const)('reports only verified units without exposing ambiguous usage or RPC failures (%j)', async (result, usage) => {
  const { client, emit, session } = fixture();
  session.getEvents.mockResolvedValueOnce([{ type: 'session.start', data: { producer: 'copilot-agent' } }]);
  session.send.mockImplementationOnce(async ({ clientTurnId }) => {
    emit({ type: 'user.message' });
    emit({ type: 'user.message', data: { clientTurnId, interactionId: 'interaction' } });
    emit({ type: 'assistant.turn_start', data: { interactionId: 'interaction', turnId: 'main' } });
    emit({ type: 'assistant.turn_end', data: { turnId: 'main' } });
    return 'message-id';
  });
  if (result instanceof Error) session.rpc.usage.getMetrics.mockRejectedValueOnce(result);
  else session.rpc.usage.getMetrics.mockResolvedValueOnce(result);
  await expect(probeCloudTask(client, request)).resolves.toEqual({ sessionId: session.sessionId, usage });
});

it('preserves delivery when the usage wait is cancelled before a matching turn ends', async () => {
  const { client, emit, session, listeners } = fixture();
  const controller = new AbortController();
  const pending = probeCloudTask(client, request, controller.signal);
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  emit({ type: 'session.start', data: { producer: 'copilot-agent' } });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  emit({ type: 'user.message', data: { clientTurnId: request.turnId } });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();
  expect(await pending).toEqual({ sessionId: session.sessionId, usage: null });
  expect(session.rpc.usage.getMetrics).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

it('preserves delivery when usage RPC does not complete', async () => {
  const { client, emit, session, listeners } = fixture();
  const controller = new AbortController();
  session.rpc.usage.getMetrics.mockImplementationOnce(() => new Promise(() => {}));
  session.getEvents.mockResolvedValueOnce([{ type: 'session.start', data: { producer: 'copilot-agent' } }]);
  const pending = probeCloudTask(client, request, controller.signal);
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  emit({ type: 'user.message', data: { clientTurnId: request.turnId, interactionId: 'interaction' } });
  emit({ type: 'assistant.turn_start', data: { interactionId: 'interaction', turnId: 'main' } });
  emit({ type: 'assistant.turn_end', data: { turnId: 'main' } });
  await vi.waitFor(() => expect(session.rpc.usage.getMetrics).toHaveBeenCalledOnce());
  controller.abort();
  expect(await pending).toEqual({ sessionId: session.sessionId, usage: null });
  expect(listeners.size).toBe(0);
});
