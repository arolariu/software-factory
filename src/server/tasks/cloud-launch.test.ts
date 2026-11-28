import { expect, it, vi } from 'vitest';
import { dispatchCloudTask, type CloudEvent, type CloudLaunchClient } from './cloud-launch.js';

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
  const pending = dispatchCloudTask(client, { ...request, expectedLogin: 'Example' });
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
  expect(listeners.size).toBe(0);
  expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: request.requestedSessionId, cloud: { repository: request.repository },
  }));
  expect(client.createSession.mock.lastCall?.[0].onPermissionRequest()).toEqual({
    kind: 'denied-no-approval-rule-and-could-not-request-from-user',
  });
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
