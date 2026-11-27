import { ApiFailure } from '../http/problems.js';
import type { Tokens } from './credentials.js';

export const githubDeviceApproval = 'https://github.com/login/device';
const host = 'https://github.com';
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
type Poll = { kind: 'pending' | 'slow_down' | 'expired' | 'denied' } | { kind: 'authorized'; tokens: Tokens };

export function createGitHubDeviceFlow(fetcher = fetch, clock = Date.now) {
  async function post(path: string, data: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetcher(`${host}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data),
    }).catch(() => { throw new ApiFailure('PROVIDER_ERROR'); });
    if (response.status === 429) throw new ApiFailure('RATE_LIMITED');
    if (!response.ok && response.status !== 400) throw new ApiFailure('PROVIDER_ERROR');
    const body: unknown = await response.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiFailure('PROVIDER_ERROR');
    return body as Record<string, unknown>;
  }
  return {
    async start(clientId: string) {
      const body = await post('/login/device/code', { client_id: clientId, scope: 'offline_access' });
      const { device_code: deviceCode, user_code: userCode, verification_uri: uri, expires_in: expiry, interval } = body;
      if (typeof deviceCode !== 'string' || !deviceCode || typeof userCode !== 'string' ||
          !/^[A-Z0-9-]{4,32}$/.test(userCode) || uri !== githubDeviceApproval ||
          typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry < 1 ||
          typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1) {
        throw new ApiFailure('PROVIDER_ERROR');
      }
      return { deviceCode, userCode, expiresAt: clock() + Math.min(expiry, 900) * 1_000, intervalMs: interval * 1_000 };
    },
    async poll(clientId: string, deviceCode: string): Promise<Poll> {
      const body = await post('/login/oauth/access_token', {
        client_id: clientId, device_code: deviceCode, grant_type: deviceGrant,
      });
      const error = body['error'];
      if (error === 'authorization_pending') return { kind: 'pending' };
      if (error === 'slow_down') return { kind: 'slow_down' };
      if (error === 'expired_token') return { kind: 'expired' };
      if (error === 'access_denied') return { kind: 'denied' };
      const { access_token: token, refresh_token: refresh, expires_in: expiry } = body;
      if (error !== undefined || body['token_type'] !== 'bearer' || typeof token !== 'string' || !token.startsWith('ghu_') ||
          typeof refresh !== 'string' || !refresh || typeof expiry !== 'number' || !Number.isSafeInteger(expiry) ||
          expiry < 1 || expiry > 31_536_000) throw new ApiFailure('PROVIDER_ERROR');
      return { kind: 'authorized', tokens: { accessToken: token, refreshToken: refresh, expiresAt: clock() + expiry * 1_000 } };
    },
  };
}
