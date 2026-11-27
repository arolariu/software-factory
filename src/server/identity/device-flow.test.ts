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
