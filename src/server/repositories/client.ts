import { ApiFailure } from '../http/problems.js';
import { bearerHeaders, rateLimitFailure, record } from '../provider-http.js';
import type { IssueRow, PullRequestRow } from './provider.js';

export type RecordValue = Record<string, unknown>;
export const invalid = () => new ApiFailure('PROVIDER_ERROR');
export const encoded = encodeURIComponent;
export const disabled = { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' } as const;
const notLoaded = { available: false, reasonCode: 'CHECKS_NOT_LOADED' } as const;
export const maxPages = 20;

export const optionalText = (value: unknown) => typeof value === 'string' ? value : '';

export function list(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map(record);
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw invalid();
  return value;
}

export function id(value: unknown): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) throw invalid();
  return result;
}

export function numeric(key: string): number {
  const value = Number(key);
  if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(value)) throw new ApiFailure('INVALID_REQUEST');
  return value;
}

export function account(value: RecordValue): NonNullable<IssueRow['author']> {
  return { id: id(value['id']), displayName: text(value['login'] ?? value['displayName']) };
}

export function person(value: unknown): IssueRow['author'] {
  return value ? account(record(value)) : null;
}

export function pullOrigin(author: PullRequestRow['author'], subject: string | undefined): PullRequestRow['origin'] {
  if (!author || !subject) return 'unknown';
  return author.id === subject ? 'mine' : 'other';
}

export function unloadedChecks(head: unknown): PullRequestRow['checks'] {
  return head ? { headRevision: id(head), availability: notLoaded, passed: null, total: null } : null;
}

interface GetOptions {
  query?: string;
  optionalCi?: boolean;
}

export function createProviderClient(origin: string, token: string, fetcher: typeof fetch) {
  async function get(path: string, { query, optionalCi = false }: GetOptions = {}) {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        headers: { ...bearerHeaders(token), ...(query !== undefined && { 'Content-Type': 'application/json' }) },
        ...(query !== undefined && { method: 'POST', body: JSON.stringify({ query }) }),
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw invalid();
    }
    const limited = rateLimitFailure(response);
    if (limited) throw limited;
    if (response.status === 401 || response.status === 403) {
      throw new ApiFailure(response.status === 403 && optionalCi ? 'CAPABILITY_UNAVAILABLE' : 'ACCESS_DENIED');
    }
    if (response.status === 404) throw new ApiFailure('NOT_FOUND');
    if (!response.ok) throw invalid();
    try {
      return { data: await response.json() as unknown, next: /\brel="next"/.test(response.headers.get('link') ?? '') };
    } catch {
      throw invalid();
    }
  }

  async function pages(path: (page: number) => string, read: (data: unknown) => RecordValue[],
    more: (length: number, next: boolean) => boolean, optionalCi = false) {
    const rows: RecordValue[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = await get(path(page), { optionalCi });
      const batch = read(response.data);
      rows.push(...batch);
      if (!more(batch.length, response.next)) return rows;
    }
    throw new ApiFailure('ACCESS_UNVERIFIED');
  }

  return { get, pages };
}
