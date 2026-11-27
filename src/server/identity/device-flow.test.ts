import { expect, it, vi } from 'vitest';
import { createGitHubDeviceFlow } from './device-flow.js';

it('uses a pinned GitHub endpoint and never sends a client secret', async () => {
  const wire = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      device_code: 'private-fixture', user_code: 'CODE-ONE', verification_uri: 'https://github.com/login/device',
      expires_in: 900, interval: 5,
    }))
    .mockResolvedValueOnce(Response.json({ error: 'slow_down' }))
    .mockResolvedValueOnce(Response.json({
      access_token: 'ghu_fixture', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-fixture',
    }));
  const flow = createGitHubDeviceFlow(wire, () => 1_000);
  expect(await flow.start('public-id')).toEqual({
    deviceCode: 'private-fixture', userCode: 'CODE-ONE', expiresAt: 901_000, intervalMs: 5_000,
  });
  expect(await flow.poll('public-id', 'private-fixture')).toEqual({ kind: 'slow_down' });
  expect(await flow.poll('public-id', 'private-fixture')).toEqual({
    kind: 'authorized', tokens: { accessToken: 'ghu_fixture', refreshToken: 'refresh-fixture', expiresAt: 3_601_000 },
  });
  for (const [url, options] of wire.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/github\.com\/login\//);
    expect(options?.redirect).toBe('error');
    expect((options?.body as URLSearchParams).has('client_secret')).toBe(false);
  }
});

  it.each([
    ['authorization_pending', 'pending'], ['expired_token', 'expired'], ['access_denied', 'denied'],
  ])('maps GitHub status %s without leaking an upstream payload', async (error, kind) => {
    const wire = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error, error_description: 'private' }));
    expect(await createGitHubDeviceFlow(wire).poll('public-id', 'device-code')).toEqual({ kind });
  });

  it('rejects network failure, rate limiting, non-JSON and unauthorized token shapes', async () => {
    const wire = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('private upstream message'))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({
        access_token: 'other', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-fixture',
      }))
      .mockResolvedValueOnce(Response.json({
        device_code: 'fixture', user_code: 'CODE-ONE', verification_uri: 'https://other.example/', expires_in: 900, interval: 5,
      }));
    const client = createGitHubDeviceFlow(wire);
    for (const code of ['PROVIDER_ERROR', 'RATE_LIMITED', 'PROVIDER_ERROR', 'PROVIDER_ERROR', 'PROVIDER_ERROR', 'PROVIDER_ERROR']) {
      await expect(client.poll('public-id', 'device-code')).rejects.toThrow(code);
    }
    await expect(client.start('public-id')).rejects.toThrow('PROVIDER_ERROR');
  });
