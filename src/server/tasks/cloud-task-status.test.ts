import { expect, it, vi } from 'vitest';
import { readCloudTaskStatus } from './cloud-task-status.js';

const target = {
  owner: 'my-account', repository: 'disposable', repositoryId: '81', ownerId: '42',
  sessionId: 'session-one', sessionUrl: 'https://github.com/copilot/tasks/session-one',
};
const proof = {
  id: 'session-one', html_url: target.sessionUrl, creator_type: 'user',
  creator: { id: 42 }, owner: { id: 42 }, repository: { id: 81 }, state: 'waiting_for_user',
  sessions: [{ prompt: 'Sensitive prompt', error: { message: 'Sensitive error' } }],
};

it('reads only exact repo, creator and linked task status through the GitHub App user grant', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(proof));
  expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual({ state: 'waiting_for_user' });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.github.com/agents/repos/my-account/disposable/tasks/session-one',
    expect.objectContaining({ method: 'GET', redirect: 'error', headers: expect.objectContaining({
      'X-GitHub-Api-Version': '2026-03-10', Authorization: 'Bearer ghu_fixture',
    }) }),
  );
});

it.each([
  { id: 'other-task' }, { html_url: 'https://other.example/copilot/tasks/session-one' },
  { creator_type: 'organization' }, { creator: { id: 43 } }, { owner: { id: 43 } },
  { repository: { id: 82 } }, { state: 'unknown' },
])('does not release status when the provider payload does not bind to the task (%j)', async (override) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...proof, ...override }));
  expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual({ state: null });
});

it('does not issue unverified or credential-fallback requests and does not infer a stopped task from a failed read', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const unavailable = { state: null };
  expect(await readCloudTaskStatus({ ...target, sessionUrl: 'https://github.com/copilot/tasks/other' }, 'ghu_fixture', fetcher)).toEqual(unavailable);
  for (const unsafe of [{ owner: 'other/account' }, { repository: '.' }, { repository: '..' }]) {
    expect(await readCloudTaskStatus({ ...target, ...unsafe }, 'ghu_fixture', fetcher)).toEqual(unavailable);
  }
  expect(await readCloudTaskStatus(target, 'ghp_ambient', fetcher)).toEqual(unavailable);
  expect(fetcher).not.toHaveBeenCalled();
  for (const status of [403, 404, 429, 502]) {
    fetcher.mockResolvedValueOnce(new Response('sensitive', { status }));
    expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual(unavailable);
  }
  fetcher.mockResolvedValueOnce(new Response('not json'));
  expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual(unavailable);
  fetcher.mockRejectedValueOnce(new Error('sensitive'));
  expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual(unavailable);
});
