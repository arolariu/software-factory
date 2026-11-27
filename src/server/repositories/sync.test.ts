import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiFailure } from '../http/problems.js';
import { migrate } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { createRepositoryService } from './sync.js';
import type { RepositoryAccess, RepositoryProvider } from './provider.js';

const requester = { id: 'user' };
const row = (key: string) => ({
  key, title: `Issue ${key}`, url: `https://github.com/org/repo/issues/${key}`, state: 'open' as const,
  author: null, createdAt: '2026-11-27T00:00:00Z', assignees: [], revision: null, taskId: null, linkedPr: null,
  launch: { available: false as const, reasonCode: 'CAPABILITY_UNAVAILABLE' },
});
const connection: RepositoryAccess = {
  id: 'conn', repoId: 'repo', generation: 1, grantId: 'grant', provider: 'github',
  repositoryId: '17', scope: '16', target: { host: 'github.com', scope: 'org', project: null, name: 'repo' },
};
let root: string;
let db: ReturnType<typeof openDatabase>;
let current: RepositoryAccess;
let grant: 'valid' | 'denied' | 'unverified';
let clock: number;
const resolve = vi.fn((id: string, owner: { id: string }) => id === current.id && owner.id === requester.id ? current : undefined);
const readGrant = vi.fn(() => grant);
const verify = vi.fn(async () => undefined);
const deny = vi.fn(() => { grant = 'denied'; });
const recordVerification = vi.fn(() => { grant = 'valid'; });
const issues = vi.fn<RepositoryProvider['issues']>();
const pullRequests = vi.fn<RepositoryProvider['pullRequests']>();
const issue = vi.fn<RepositoryProvider['issue']>();
const checks = vi.fn<RepositoryProvider['checks']>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  db = openDatabase(join(root, 'db.sqlite'));
  migrate(db);
  db.exec(`INSERT INTO users VALUES ('user');
    INSERT INTO identities (id,user_id,provider,issuer,subject) VALUES ('identity','user','github','github.com','42');
    INSERT INTO repositories (id,provider,canonical_host,provider_scope,provider_repo_id,canonical_url) VALUES ('repo','github','github.com','16','17','https://github.com/org/repo');
    INSERT INTO repo_connections (id,repo_id,user_id,identity_id,connected_at) VALUES ('conn','repo','user','identity',0);`);
  current = { ...connection };
  grant = 'valid';
  clock = 1_800_000_000_000;
  vi.clearAllMocks();
  issues.mockReset().mockResolvedValue([row('1'), row('2')]);
  pullRequests.mockReset().mockResolvedValue([]);
  issue.mockReset();
  checks.mockReset();
});
afterEach(() => { db.close(); rmSync(root, { recursive: true }); });

function service(provider = () => ({ issues, pullRequests, issue, checks })) {
  return createRepositoryService({
    db, cursorKey: Buffer.alloc(32), now: () => clock,
    access: { resolve, readGrant, verify, deny, recordVerification },
    provider,
  });
}

  it('immediately hides cached rows when one provider source denies access before its sibling settles', async () => {
    const api = service();
    api.sync(requester, 'conn');
    await api.runNextOperation();
    let release: () => void = () => {};
    pullRequests.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    issues.mockRejectedValueOnce(new ApiFailure('ACCESS_DENIED'));
    api.sync(requester, 'conn');
    const running = api.runNextOperation();
    try {
      await vi.waitFor(() => expect(deny).toHaveBeenCalled());
      expect(() => api.issues(requester, 'conn', { state: 'open' })).toThrow('ACCESS_DENIED');
    } finally {
      release();
      await running;
    }
  });

  it('does not refresh an expired work-item snapshot after live Git checks or after a failed work-item refresh', async () => {
    const api = service();
    api.sync(requester, 'conn');
    await api.runNextOperation();
    clock += 900_000;
    expect(() => api.issues(requester, 'conn', { state: 'open' })).toThrow('ACCESS_UNVERIFIED');
    checks.mockResolvedValueOnce({
      headRevision: 'head', availability: { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' }, passed: null, total: null, items: null,
    });
    grant = 'unverified';
    await api.checks(requester, 'conn', '1', { headRevision: 'head' });
    expect(grant).toBe('valid');
    expect(() => api.issues(requester, 'conn', { state: 'open' })).toThrow('ACCESS_UNVERIFIED');
    issues.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
    api.sync(requester, 'conn');
    await api.runNextOperation();
    expect(() => api.issues(requester, 'conn', { state: 'open' })).toThrow('ACCESS_UNVERIFIED');
    expect(api.pullRequests(requester, 'conn', { state: 'active' }).items).toEqual([]);
  });
it('coalesces explicit Sync, reads indexed cached pages without a provider, and rejects a stale cursor', async () => {
  const api = service();
  expect(api.issues(requester, 'conn', { state: 'open' }).freshness).toBe('not_synced');
  expect(issues).not.toHaveBeenCalled();
  const first = api.sync(requester, 'conn');
  expect(api.sync(requester, 'conn')).toEqual(first);
  expect(api.read(requester, first.operationId).state).toBe('queued');
  expect(await api.runNextOperation()).toBe(true);
  const page = api.issues(requester, 'conn', { state: 'open', limit: '1' });
  expect(page.items).toEqual([row('1')]);
  expect(page.nextCursor).toBeTruthy();
  if (!page.nextCursor) throw new Error('Expected cursor');
  expect(api.issues(requester, 'conn', { state: 'open', cursor: page.nextCursor }).items).toEqual([row('2')]);
  expect(api.read(requester, first.operationId).state).toBe('completed');
  expect(issues).toHaveBeenCalledTimes(1);
  issues.mockResolvedValueOnce([]);
  api.sync(requester, 'conn');
  await api.runNextOperation();
  expect(api.issues(requester, 'conn', { state: 'open' }).items).toEqual([]);
  const cursor = page.nextCursor;
  expect(() => api.issues(requester, 'conn', { state: 'open', cursor })).toThrow('SNAPSHOT_CHANGED');
});

it('retains the last complete source on a partial fetch but hides it after a confirmed denial', async () => {
  const api = service();
  api.sync(requester, 'conn');
  await api.runNextOperation();
  issues.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
  const partial = api.sync(requester, 'conn');
  await api.runNextOperation();
  expect(api.read(requester, partial.operationId).state).toBe('partial');
  expect(api.issues(requester, 'conn', { state: 'open' })).toMatchObject({ freshness: 'stale', items: [row('1'), row('2')] });
  issues.mockRejectedValueOnce(new ApiFailure('ACCESS_DENIED'));
  api.sync(requester, 'conn');
  await api.runNextOperation();
  expect(() => api.issues(requester, 'conn', { state: 'open' })).toThrow('ACCESS_DENIED');
});

it.each([false, true])('marks both sources failed when Sync setup fails (previous snapshot: %s)', async (previous) => {
  let failProvider = false;
  const api = service(() => {
    if (failProvider) throw new ApiFailure('PROVIDER_ERROR');
    return { issues, pullRequests, issue, checks };
  });
  if (previous) {
    api.sync(requester, 'conn');
    await api.runNextOperation();
    failProvider = true;
  } else verify.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
  const operation = api.sync(requester, 'conn');
  await api.runNextOperation();
  expect(api.read(requester, operation.operationId)).toMatchObject({
    state: 'failed', problemCode: 'PROVIDER_ERROR', sources: [
      { name: 'work_items', state: previous ? 'unchanged' : 'failed' },
      { name: 'pull_requests', state: previous ? 'unchanged' : 'failed' },
      { name: 'sessions', state: 'unavailable' },
    ],
  });
  const freshness = previous ? 'stale' : 'unavailable';
  expect(api.issues(requester, 'conn', { state: 'open' })).toMatchObject({ freshness, items: previous ? [row('1'), row('2')] : null });
  expect(api.pullRequests(requester, 'conn', { state: 'active' })).toMatchObject({ freshness, items: previous ? [] : null });
});

it('does not publish delayed pages or renew verification after the connection generation changes', async () => {
  const api = service();
  const result = api.sync(requester, 'conn');
  issues.mockImplementationOnce(async () => {
    current = { ...current, generation: 2 };
    return [row('1')];
  });
  await api.runNextOperation();
  expect(recordVerification).not.toHaveBeenCalled();
  expect(api.issues(requester, 'conn', { state: 'open' })).toMatchObject({ freshness: 'not_synced', items: null });
  expect(() => api.read(requester, result.operationId)).toThrow('NOT_FOUND');
  expect(db.prepare('SELECT state FROM repository_sync WHERE id=?').get(result.operationId)).toEqual({ state: 'failed' });
});

  it('rejects unknown, denied, expired, or differently scoped cached reads without a provider request', async () => {
    const api = service();
    expect(await api.runNextOperation()).toBe(false);
    expect(() => api.read(requester, 'missing')).toThrow('NOT_FOUND');
    expect(() => api.issues({ id: 'other' }, 'conn', { state: 'open' })).toThrow('NOT_FOUND');
    expect(() => api.issues(requester, 'conn', { state: 'open', cursor: 'arbitrary' })).toThrow('SNAPSHOT_CHANGED');
    const op = api.sync(requester, 'conn');
    expect(() => api.read({ id: 'other' }, op.operationId)).toThrow('NOT_FOUND');
    await api.runNextOperation();
    const cursor = api.issues(requester, 'conn', { state: 'open', limit: '1' }).nextCursor ?? '';
    for (const tampered of ['malformed', `${cursor}.extra`, `${cursor.split('.')[0]}.xyz`, `${cursor.slice(0, -4)}zzzz`]) {
      expect(() => api.issues(requester, 'conn', { state: 'open', cursor: tampered })).toThrow('SNAPSHOT_CHANGED');
    }
    expect(() => api.issues(requester, 'conn', { state: 'closed', cursor })).toThrow('SNAPSHOT_CHANGED');
    grant = 'unverified';
    expect(() => api.issues(requester, 'conn', { state: 'open' })).toThrow('ACCESS_UNVERIFIED');
    grant = 'denied';
    expect(() => api.sync(requester, 'conn')).toThrow('ACCESS_DENIED');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('recovers interrupted read-only Sync and represents complete failure as unavailable', async () => {
    const api = service();
    const job = api.sync(requester, 'conn');
    db.prepare("UPDATE repository_sync SET state='running' WHERE id=?").run(job.operationId);
    api.recoverInterrupted();
    expect(api.read(requester, job.operationId).state).toBe('queued');
    issues.mockRejectedValueOnce(new Error('private'));
    pullRequests.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
    await api.runNextOperation();
    expect(api.issues(requester, 'conn', { state: 'open' })).toMatchObject({ freshness: 'unavailable', items: null });
    expect(api.read(requester, job.operationId).state).toBe('failed');
    expect(recordVerification).not.toHaveBeenCalled();
    const later = api.sync(requester, 'conn');
    current = { ...current, generation: 2 };
    await api.runNextOperation();
    expect(db.prepare('SELECT state FROM repository_sync WHERE id=?').get(later.operationId)).toEqual({ state: 'failed' });
  });

  it('only resolves the selected issue, uses scoped comment cursors and re-verifies expired access', async () => {
    const api = service();
    const detail = {
      issue: row('1'), description: { format: 'text' as const, content: '' }, fields: [], related: [],
      comments: { items: [], nextCursor: 'second-page' },
    };
    issue.mockResolvedValueOnce(detail).mockResolvedValueOnce({ ...detail, comments: { items: [], nextCursor: null } });
    grant = 'unverified';
    const first = await api.issue(requester, 'conn', '1', { limit: '1' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(recordVerification).toHaveBeenCalledTimes(1);
    const nextCursor = first.comments.nextCursor ?? '';
    await expect(api.issue(requester, 'conn', '2', { limit: '1', commentCursor: nextCursor })).rejects.toThrow('SNAPSHOT_CHANGED');
    expect((await api.issue(requester, 'conn', '1', { limit: '1', commentCursor: nextCursor })).comments.nextCursor).toBeNull();
    expect(issue).toHaveBeenLastCalledWith('1', 1, 'second-page');
    grant = 'unverified';
    verify.mockRejectedValueOnce(new ApiFailure('PROVIDER_ERROR'));
    await expect(api.issue(requester, 'conn', '1', {})).rejects.toThrow('ACCESS_UNVERIFIED');
    verify.mockRejectedValueOnce(new ApiFailure('ACCESS_DENIED'));
    await expect(api.issue(requester, 'conn', '1', {})).rejects.toThrow('ACCESS_DENIED');
    expect(deny).toHaveBeenCalledWith('conn', requester, 1);
  });

  it('validates check results against the requested revision and pages details without changing totals', async () => {
    const api = service();
    const check = (id: string) => ({ id, name: id, state: 'passed' as const, url: null });
    checks.mockResolvedValue({
      headRevision: 'head', availability: { available: true }, passed: 2, total: 2,
      items: { items: [check('one'), check('two')], nextCursor: null },
    });
    await expect(api.checks(requester, 'conn', '1', { headRevision: 'other' })).rejects.toThrow('PR_REVISION_CHANGED');
    const first = await api.checks(requester, 'conn', '1', { headRevision: 'head', limit: '1' });
    expect(first.items?.items).toEqual([check('one')]);
    const second = await api.checks(requester, 'conn', '1', { headRevision: 'head', cursor: first.items?.nextCursor ?? '' });
    expect(second.items?.items).toEqual([check('two')]);
    expect(second.total).toBe(2);
    checks.mockResolvedValueOnce({
      headRevision: 'head', availability: { available: true }, passed: 1, total: 1,
      items: { items: [check('two')], nextCursor: null },
    });
    await expect(api.checks(requester, 'conn', '1', { headRevision: 'head', cursor: first.items?.nextCursor ?? '' }))
      .rejects.toThrow('SNAPSHOT_CHANGED');
    checks.mockResolvedValueOnce({
      headRevision: 'head', availability: { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' }, passed: null, total: null, items: null,
    });

    await expect(api.checks(requester, 'conn', '1', { headRevision: 'head', cursor: first.items?.nextCursor ?? '' }))
      .rejects.toThrow('SNAPSHOT_CHANGED');
    checks.mockResolvedValueOnce({
      headRevision: 'head', availability: { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' }, passed: null, total: null, items: null,
    });
    expect((await api.checks(requester, 'conn', '1', { headRevision: 'head' })).total).toBeNull();
  });

it('leaves interrupted work recoverable and does not claim new work during shutdown', async () => {
  const api = service();
  const op = api.sync(requester, 'conn');
  const stop = new AbortController();
  issues.mockImplementationOnce(async () => { stop.abort(); return []; });
  expect(await api.runNextOperation(stop.signal)).toBe(true);
  expect(api.read(requester, op.operationId).state).toBe('running');
  expect(await api.runNextOperation(stop.signal)).toBe(false);
  api.recoverInterrupted();
  expect(await api.runNextOperation()).toBe(true);
  expect(api.read(requester, op.operationId).state).toBe('completed');
});

  it('uses the exact task publication key for Factory provenance and indexes merged PRs with closed PRs', async () => {
    const api = service();
    db.exec(`INSERT INTO tasks (id,connection_id,repo_id,requester_id,repo_identity_id,copilot_identity_id,work_item_key,
      start_request_id,runtime_kind,runtime_scope,state,created_at,updated_at,draft_pr_key)
      VALUES ('task','conn','repo','user','identity','identity','42','req','github_cloud','github.com','completed',0,0,'test-pr')`);
    pullRequests.mockResolvedValueOnce([{
      key: 'test-pr', state: 'merged', origin: 'mine', title: 'PR', url: 'https://github.com/org/repo/pull/1',
      sourceBranch: 'topic', targetBranch: 'main', draft: false, author: null, checks: null, session: null,
    }]);
    api.sync(requester, 'conn');
    await api.runNextOperation();
    expect(api.pullRequests(requester, 'conn', { state: 'closed' }).items?.[0]).toMatchObject({ state: 'merged', origin: 'factory' });
    expect(api.pullRequests(requester, 'conn', { state: 'active' }).items).toEqual([]);
  });
