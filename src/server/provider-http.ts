import { ApiFailure } from './http/problems.js';

export const bearerHeaders = (accessToken: string) => ({
  Accept: 'application/json',
  Authorization: `Bearer ${accessToken}`,
  'User-Agent': 'software-factory',
});

export function rateLimitFailure(response: Response): ApiFailure | undefined {
  const limited = response.status === 429 || (response.status === 403 &&
    (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
  return limited ? new ApiFailure('RATE_LIMITED', Number(response.headers.get('retry-after') ?? NaN)) : undefined;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiFailure('PROVIDER_ERROR');
  return value as Record<string, unknown>;
}

export function publicHttpsUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s/@\\?#]+(?:[/?#][^\s\\]*)?$/.test(value) ? value : null;
}
