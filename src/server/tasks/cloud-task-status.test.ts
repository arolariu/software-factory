import { expect, it, vi } from 'vitest';
import { readCloudTaskEvidence } from './cloud-task-status.js';

async function readCloudTaskStatus(...args: Parameters<typeof readCloudTaskEvidence>) {
  return (await readCloudTaskEvidence(...args)).status;
}

const target = {
  owner: 'my-account', repository: 'disposable', repositoryId: '81', ownerId: '42',
  sessionId: 'session-one', sessionUrl: 'https://github.com/copilot/tasks/session-one',
};
const proof = {
  id: 'session-one', html_url: 'https://github.com/my-account/disposable/copilot/tasks/session-one', creator_type: 'user',
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
  { html_url: 'https://github.com/my-account/another/copilot/tasks/session-one' },
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

const linked = {
  id: target.sessionId, task_id: target.sessionId, user: { id: 42 }, owner: { id: 42 }, repository: { id: 81 },
  usage: { type: 'ai_credits', amount: 0 },
};

it.each([
  ['completed', 'completed'], ['failed', 'failed'], ['timed_out', 'failed'], ['cancelled', 'stopped'],
] as const)('records evidence only for an exact terminal session (%s)', async (state, localState) => {
  const completedAt = '2026-11-28T10:00:00Z';
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    ...proof, state, sessions: [{ ...linked, state, completed_at: completedAt }],
  }));
  expect(await readCloudTaskEvidence(target, 'ghu_fixture', fetcher)).toMatchObject({
    status: { state }, outcome: { state: localState, terminalAt: Date.parse(completedAt) },
  });
});

it.each([
  { state: 'idle', completed_at: '2026-11-28T10:00:00.000Z' },
  { state: 'completed', completed_at: 'not a timestamp' },
  { state: 'completed', completed_at: '2026-02-31T10:00:00.000Z' },
  { state: 'completed' },
])('does not infer a terminal outcome from missing or inconsistent session evidence (%j)', async (fields) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    ...proof, state: 'completed', sessions: [{ ...linked, ...fields }],
  }));
  expect(await readCloudTaskEvidence(target, 'ghu_fixture', fetcher)).toEqual({
    status: { state: 'completed', usage: { unit: 'ai_credits', amount: 0 } },
  });
});

it.each([
  ['ai_credits', 0], ['premium_requests', 1.25],
] as const)('reports exact GitHub session usage in %s without importing transcripts or adding units', async (unit, amount) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    ...proof, sessions: [
      { ...linked, id: 'other-session', usage: { type: 'ai_credits', amount: 700 } },
      { ...linked, usage: { type: unit, amount }, prompt: 'Sensitive prompt' },
    ],
  }));
  expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual({
    state: 'waiting_for_user', usage: { unit, amount },
  });
});

it.each([
  { sessions: [{ ...linked, id: 'another' }] }, { sessions: [linked, { ...linked, usage: null }] },
  { sessions: [{ ...linked, task_id: 'another' }] }, { sessions: [{ ...linked, user: { id: 43 } }] },
  { sessions: [{ ...linked, owner: { id: 43 } }] }, { sessions: [{ ...linked, repository: { id: 82 } }] },
  { sessions: [{ ...linked, usage: { type: 'unknown', amount: 0 } }] }, { sessions: [{ ...linked, usage: { type: 'ai_credits', amount: -1 } }] },
  { sessions: null }, { sessions: [] },
])('omits missing or ambiguous GitHub usage without discarding independently verified status (%j)', async ({ sessions }) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...proof, sessions }));
  expect(await readCloudTaskStatus(target, 'ghu_fixture', fetcher)).toEqual({ state: 'waiting_for_user' });
});
