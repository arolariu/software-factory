import type { ApiDto } from '../shared/api/schemas.js';

class PortalReadError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function readPortal<T>(url: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as ApiDto<'problem'> | undefined;
    throw new PortalReadError(body?.code ?? '', response.status);
  }
  return await response.json() as T;
}

export function accessProblem(error: unknown) {
  if (!(error instanceof PortalReadError)) return;
  if (error.status === 401 || error.code === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (error.code === 'ACCESS_UNVERIFIED') return 'ACCESS_UNVERIFIED';
  if (error.status === 403 || error.code === 'ACCESS_DENIED') return 'ACCESS_DENIED';
  return undefined;
}

export function problemCode(error: unknown) {
  return error instanceof PortalReadError ? error.code : undefined;
}

export function requestVersion() {
  let version = 0;
  return { next: () => ++version, current: (ticket: number) => version === ticket };
}
