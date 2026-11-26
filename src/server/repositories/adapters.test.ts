import { expect, it, vi } from 'vitest';
import { createRepositoryProvider } from './adapters.js';
import type { RepositoryAccess } from './provider.js';

const date = '2026-11-27T01:00:00Z';
const github: RepositoryAccess = {
  id: 'c', repoId: 'r', generation: 1, grantId: 'g', provider: 'github', repositoryId: '17', scope: '16', subject: '42',
  target: { host: 'tenant.ghe.com', scope: 'org', project: null, name: 'repo' },
};
const ado: RepositoryAccess = {
  ...github, provider: 'azure_devops', scope: 'project-guid', repositoryId: 'repo-guid',
  target: { host: 'dev.azure.com', scope: 'organization', project: 'Project Name', name: 'Repo Name' },
};
const user = { id: 42, login: 'me' };
const other = { id: 43, displayName: 'Other' };
const ghIssue = {
  number: 99, title: 'Bug report', state: 'open', user, created_at: date, assignees: [user], updated_at: date,
  body: 'Details',
};
const ghPull = {
  number: 18, title: 'PR', state: 'open', user, head: { ref: 'topic', sha: 'head-1' }, base: { ref: 'main' }, draft: true,
};
const workItem = { id: 221, rev: 9, fields: {
  'System.TeamProject': 'Project Name', 'System.Title': 'Task', 'System.WorkItemType': 'Bug',
  'System.State': 'Custom Complete', 'System.CreatedDate': date, 'System.CreatedBy': other, 'System.Description': '<p>Task</p>',
} };
const next = { headers: { link: '<https://example.invalid/ignored>; rel="next"' } };

function adapter(responses: Response[], connection = github) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return { fetcher, client: createRepositoryProvider(connection, 'local-fixture', fetcher) };
}

it('uses exact GitHub tenant paths, ignores link destinations and excludes PRs from complete issue pages', async () => {
  const { fetcher, client } = adapter([
    Response.json([ghIssue, { ...ghIssue, pull_request: {} }], next),
    Response.json([{ ...ghIssue, number: 100, state: 'closed', user: null, assignees: [] }]),
  ]);
  expect((await client.issues()).map(({ key, state }) => [key, state])).toEqual([['99', 'open'], ['100', 'closed']]);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://api.tenant.ghe.com/repositories/17/issues?state=all&per_page=100&page=1',
    'https://api.tenant.ghe.com/repositories/17/issues?state=all&per_page=100&page=2',
  ]);
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});

it.each([
  [new Response('', { status: 401 }), 'ACCESS_DENIED'],
  [new Response('', { status: 403 }), 'ACCESS_DENIED'],
  [new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), 'RATE_LIMITED'],
  [new Response('', { status: 403, headers: { 'retry-after': '1' } }), 'RATE_LIMITED'],
  [new Response('', { status: 429, headers: { 'retry-after': '1' } }), 'RATE_LIMITED'],
  [new Response('', { status: 404 }), 'NOT_FOUND'],
  [new Response('', { status: 502 }), 'PROVIDER_ERROR'],
  [new Response('invalid json'), 'PROVIDER_ERROR'],
  [Response.json({ bad: [] }), 'PROVIDER_ERROR'],
  [Response.json([null]), 'PROVIDER_ERROR'],
  [Response.json([{ ...ghIssue, state: 'unknown' }]), 'PROVIDER_ERROR'],
  [Response.json([{ ...ghIssue, number: '{}' }]), 'PROVIDER_ERROR'],
])('fails a source rather than publishing a partial or malformed page (%#)', async (response, code) => {
  await expect(adapter([response]).client.issues()).rejects.toMatchObject({ code });
});

it('bounds pagination, and maps failed network requests without revealing upstream content', async () => {
  const { fetcher, client } = adapter([]);
  fetcher.mockImplementation(async () => Response.json([ghIssue], next));
  await expect(client.issues()).rejects.toMatchObject({ code: 'ACCESS_UNVERIFIED' });
  expect(fetcher).toHaveBeenCalledTimes(20);
  fetcher.mockRejectedValueOnce(new Error('private'));
  await expect(client.issues()).rejects.toThrow('PROVIDER_ERROR');
});

it('normalizes active, closed and merged pull requests and distinguishes authors', async () => {
  const { client, fetcher } = adapter([Response.json([
    ghPull,
    { ...ghPull, number: 19, state: 'closed', merged_at: date, user: other },
    { ...ghPull, number: 20, state: 'closed', user: null },
  ])], { ...github, target: { ...github.target, host: 'github.com' } });
  const pulls = await client.pullRequests();
  expect(pulls.map(({ state, origin }) => [state, origin])).toEqual([
    ['active', 'mine'], ['merged', 'other'], ['closed', 'unknown'],
  ]);
  expect(pulls[0]?.checks).toMatchObject({ headRevision: 'head-1', total: null });
  expect(fetcher.mock.calls[0]?.[0]).toContain('https://api.github.com/');
  await expect(adapter([Response.json([{ ...ghPull, state: 'invalid' }])]).client.pullRequests())
    .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
});

it('fetches exact GitHub issue detail and only the requested comments page', async () => {
  const { client, fetcher } = adapter([
    Response.json(ghIssue),
    Response.json([{ id: 1, user, created_at: date, body: 'Reply' }], next),
  ]);
  expect(await client.issue('99', 5, '2')).toMatchObject({
    issue: { key: '99' }, description: { format: 'markdown', content: 'Details' },
    comments: { nextCursor: '3', items: [{ id: '1', body: { format: 'markdown', content: 'Reply' } }] },
  });
  expect(fetcher.mock.calls[1]?.[0]).toContain('/issues/99/comments?per_page=5&page=2');
  await expect(client.issue('not-id', 5, null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(adapter([Response.json({ ...ghIssue, pull_request: {} })]).client.issue('99', 5, null))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
  const plain = adapter([Response.json({ ...ghIssue, body: null }), Response.json([])]);
  expect((await plain.client.issue('99', 5, null)).description.content).toBe('');
});

it('uses project WIQL and state categories instead of localized Azure Boards state names', async () => {
  const { client, fetcher } = adapter([
    Response.json({ workItems: [{ id: 221 }, { id: 999 }] }),
    Response.json({ value: [workItem, { ...workItem, id: 999, fields: { ...workItem.fields, 'System.State': 'Started', 'System.AssignedTo': other } }] }),
    Response.json({ value: [{ name: 'Custom Complete', category: 'Completed' }, { name: 'Started', category: 'InProgress' }] }),
  ], ado);
  expect((await client.issues()).map(({ state }) => state)).toEqual(['closed', 'open']);
  expect(fetcher.mock.calls).toHaveLength(3);
  expect(fetcher.mock.calls[0]?.[0]).toContain('/organization/project-guid/_apis/wit/wiql');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  expect(fetcher.mock.calls[1]?.[0]).toContain('ids=221,999');
});

it.each([
  [[{ id: 221 }, { id: 221 }], [], 'PROVIDER_ERROR'],
  [[{ id: 221 }], [{ ...workItem, id: 50 }], 'PROVIDER_ERROR'],
  [[{ id: 221 }], [], 'ACCESS_UNVERIFIED'],
  [[{ id: 221 }], [{ ...workItem, fields: { ...workItem.fields, 'System.TeamProject': 'Private elsewhere' } }], 'NOT_FOUND'],
] as const)('rejects inconsistent project-scope Azure Boards pages (%#)', async (workItems, value, code) => {
  await expect(adapter([Response.json({ workItems }), Response.json({ value })], ado).client.issues())
    .rejects.toMatchObject({ code });
});

it('normalizes Azure pull requests, work item detail and the next opaque comment token', async () => {
  const { client, fetcher } = adapter([
    Response.json({ value: [{ pullRequestId: 12, title: 'PR', status: 'completed', sourceRefName: 'refs/heads/work', targetRefName: 'refs/heads/main', createdBy: other }] }),
    Response.json(workItem),
    Response.json({ value: [{ name: 'Custom Complete', category: 'Completed' }] }),
    Response.json({ comments: [{ id: 1, createdBy: other, createdDate: date, text: '<p>Comment</p>' }], continuationToken: 'continue' }),
  ], ado);
  expect((await client.pullRequests())[0]).toMatchObject({ state: 'merged', origin: 'other' });
  const detail = await client.issue('221', 10, 'opaque+cursor');
  expect(detail.description).toEqual({ format: 'html', content: '<p>Task</p>' });
  expect(detail.comments.nextCursor).toBe('continue');
  expect(fetcher.mock.calls[3]?.[0]).toContain('continuationToken=opaque%2Bcursor');
});

it('invalidates a changed head and merges check runs with the latest status in each context', async () => {
  const head = Response.json({ head: { sha: 'head-2' } });
  await expect(adapter([head]).client.checks('12', 'head-1')).rejects.toMatchObject({ code: 'PR_REVISION_CHANGED' });
  const { client } = adapter([
    Response.json({ head: { sha: 'head-2' } }),
    Response.json({ check_runs: [
      { id: 1, name: 'Passed', status: 'completed', conclusion: 'success', html_url: 'https://github.com/summary' },
      { id: 2, name: 'Failed', status: 'completed', conclusion: 'failure' },
      { id: 3, name: 'Queued', status: 'queued' },
      { id: 4, name: 'Skipped', status: 'completed', conclusion: 'skipped' },
    ] }),
    Response.json([
      { id: 1, context: 'lint', state: 'success' },
      { id: 2, context: 'lint', state: 'failure' },
      { id: 3, context: 'build', state: 'failure' },
      { id: 4, context: 'deploy', state: 'pending' },
      { id: 5, context: 'unknown', state: 'unrecognized' },
    ]),
  ]);
  const result = await client.checks('12', 'head-2');
  expect(result).toMatchObject({ headRevision: 'head-2', passed: 2, total: 8 });
  expect(result.items?.items.map(({ state }) => state)).toEqual([
    'passed', 'failed', 'pending', 'not_run', 'passed', 'failed', 'pending', 'unknown',
  ]);
});

it('reports unsupported or unauthorized CI sources as unavailable, never as zero', async () => {
  const missing = adapter([
    Response.json({ head: { sha: 'h' } }), new Response('', { status: 403 }), Response.json([]),
  ]);
  expect(await missing.client.checks('12', 'h')).toMatchObject({ total: null, items: null });
  const denied = adapter([
    Response.json({ head: { sha: 'h' } }), new Response('', { status: 403 }), new Response('', { status: 401 }),
  ]);
  await expect(denied.client.checks('12', 'h')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await expect(adapter([
    Response.json({ head: { sha: 'h' } }), Response.json({ check_runs: [] }), new Response('', { status: 404 }),
  ]).client.checks('12', 'h')).resolves.toMatchObject({ total: null });
  const supported = adapter([
    Response.json({ lastMergeSourceCommit: { commitId: 'h' } }),
  ], ado);
  expect(await supported.client.checks('12', 'h')).toMatchObject({ total: null, items: null });
  await expect(adapter([
    Response.json({ head: { sha: 'h' } }), new Response('', { status: 500 }), Response.json([]),
  ]).client.checks('12', 'h')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
});
