import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import ActiveSessions from './ActiveSessions.svelte';

let target: HTMLDivElement;
let app: ReturnType<typeof mount> | undefined;
let originalUrl: string;

beforeEach(() => {
  originalUrl = location.href;
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  vi.unstubAllGlobals();
  history.replaceState(null, '', originalUrl);
  target.remove();
});

function browse(path: string, handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const previous = location.href;
  history.replaceState(null, '', path);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
  try { app = mount(ActiveSessions, { target }); }
  finally { history.replaceState(null, '', previous); }
}

async function press(label: string) {
  await vi.waitFor(() => {
    const button = [...target.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    expect(button?.disabled).toBe(false);
    button?.click();
  });
}

it('does not present unavailable session data as an empty queue, and lets users retry', async () => {
  let calls = 0;
  browse('/active-sessions', (url) => {
    expect(url).toBe('/api/active-sessions');
    return calls++ === 0 ? new Response(null, { status: 503 }) : Response.json({ repositories: [], sessions: [] });
  });
  await vi.waitFor(() => expect(target.textContent).toContain('Active Sessions are unavailable'));
  expect(target.textContent).not.toContain('No active sessions');
  await press('Retry');
  await vi.waitFor(() => expect(target.textContent).toContain('No active sessions'));
});

it('shows scoped attention and keeps last-good sessions only for transient failures', async () => {
  let calls = 0;
  const cloud = vi.fn()
    .mockReturnValueOnce(Response.json({ state: 'completed' }))
    .mockReturnValueOnce(Response.json({ state: null }));
  browse('/active-sessions?repository=r1', (url) => {
    if (url === '/api/tasks/a/cloud-status') return cloud() as Response;
    if (url === '/api/tasks/a') return Response.json({
      task: { state: 'waiting_input' }, pendingQuestion: { text: 'Which approach?' },
      sessionUrl: 'https://github.com/copilot/tasks/session-fixture',
      cloudStatusAvailable: true,
      sdkUsage: { observedAt: '2026-11-28T00:00:00.000Z', nanoAiu: 0, premiumRequests: 1.25 },
    });
    if (calls++ === 0) return Response.json({
      repositories: [{ id: 'r1', name: 'Factory', provider: 'github' }, { id: 'r2', name: 'Other', provider: 'azure_devops' }],
      sessions: [
        { repoId: 'r1', workItemKey: '3', taskId: 'a', title: 'Answer me', state: 'waiting_input', issueUrl: 'https://github.com/a/b/issues/3' },
        { repoId: 'r1', workItemKey: '4', taskId: 'b', title: 'Already running', state: 'running' },
        { repoId: 'r2', workItemKey: '1', taskId: 'c', title: 'Other repo', state: 'needs_recovery' },
      ],
    });
    return calls === 2 ? new Response(null, { status: 503 })
      : Response.json({ code: 'ACCESS_UNVERIFIED' }, { status: 503 });
  });
  await vi.waitFor(() => expect(target.textContent).toContain('Answer me'));
  expect(target.textContent).not.toContain('Other repo');
  await press('Needs your answer 1');
  expect(target.textContent).not.toContain('Already running');
  await press('View task');
  await vi.waitFor(() => {
    expect(target.textContent).toContain('Which approach?');
    expect(target.textContent).toContain('0 nano-AI units');
    expect(target.textContent).toContain('1.25 premium requests');
  });
  const handoff = page.getByRole('link', { name: 'Open in GitHub Copilot' });
  await expect.element(handoff).toHaveAttribute('href', 'https://github.com/copilot/tasks/session-fixture');
  expect(cloud).not.toHaveBeenCalled();
  await press('Check GitHub status');
  await vi.waitFor(() => expect(target.textContent).toContain('GitHub status: Completed'));
  expect(target.textContent).toContain('Task state: waiting_input');
  await press('Check GitHub status');
  await vi.waitFor(() => expect(target.textContent).toContain('GitHub status unavailable'));
  expect(target.textContent).not.toContain('GitHub status: Completed');
  await press('View task');
  expect(target.textContent).not.toContain('Which approach?');
  await page.getByLabelText('Status').selectOptions('needs_recovery', { timeout: 1500 });
  expect(target.textContent).toContain('No sessions match this status');
  await page.getByLabelText('Status').selectOptions('waiting_input');
  await press('Refresh');
  await vi.waitFor(() => expect(target.textContent).toContain('Showing the last successful read'));
  expect(target.textContent).toContain('Answer me');
  await press('Refresh');
  await vi.waitFor(() => expect(target.textContent).toContain('Open Repositories and run Sync'));
  expect(target.textContent).not.toContain('Answer me');
});

it('recovers from invalid filters and does not describe a failed task read as successful', async () => {
  let taskReads = 0;
  browse('/active-sessions?repository=unknown&status=unknown', (url) => {
    if (url === '/api/tasks/a') return taskReads++ === 0 ? new Response(null, { status: 503 })
      : Response.json({ task: { state: 'starting' }, pendingQuestion: null });
    return Response.json({
      repositories: [{ id: 'r1', name: 'Factory', provider: 'github' }],
      sessions: [{ repoId: 'r1', workItemKey: '3', taskId: 'a', title: null, state: 'starting', issueUrl: null }],
    });
  });
  await press('View task');
  await vi.waitFor(() => expect(target.textContent).toContain('Task details are unavailable'));
  await press('View task');
  await press('View task');
  await vi.waitFor(() => expect(target.textContent).toContain('Task state: starting'));
  await page.getByLabelText('Repository').selectOptions('r1', { timeout: 1500 });
  expect(target.textContent).toContain('Untitled task');
  await page.getByLabelText('Repository').selectOptions('');
  expect(location.search).toBe('');
});

it('allows just one GitHub status check and drops its late response when task detail closes', async () => {
  const delayed = Promise.withResolvers<Response>();
  const parsed = Promise.withResolvers<void>();
  const row = Response.json({ state: 'completed' });
  const json = row.json.bind(row);
  vi.spyOn(row, 'json').mockImplementation(async () => { const body = await json(); parsed.resolve(); return body; });
  const cloud = vi.fn(() => delayed.promise);
  browse('/active-sessions', (url) => {
    if (url === '/api/tasks/a/cloud-status') return cloud();
    if (url === '/api/tasks/a') return Response.json({
      task: { state: 'running' }, cloudStatusAvailable: true, sessionUrl: 'https://github.com/copilot/tasks/s',
    });
    return Response.json({
      repositories: [{ id: 'r1', name: 'Factory', provider: 'github' }],
      sessions: [{ repoId: 'r1', workItemKey: '3', taskId: 'a', title: 'Review', state: 'running', issueUrl: null }],
    });
  });
  await press('View task');
  await vi.waitFor(() => {
    const button = [...target.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Check GitHub status');
    expect(button).toBeDefined();
    button?.click();
    button?.click();
  });
  await expect.element(page.getByRole('button', { name: 'Check GitHub status' })).toBeDisabled();
  expect(cloud).toHaveBeenCalledOnce();
  await press('View task');
  delayed.resolve(row);
  await parsed.promise;
  await tick();
  await press('View task');
  await expect.element(page.getByRole('button', { name: 'Check GitHub status' })).toBeEnabled();
  expect(target.textContent).not.toContain('GitHub status: Completed');
});

it.each([502, 403])('distinguishes a provider status outage from lost Factory authorization (%i)', async (status) => {
  browse('/active-sessions', (url) => {
    if (url === '/api/tasks/a/cloud-status') return Response.json({ code: status === 403 ? 'ACCESS_DENIED' : 'PROVIDER_ERROR' }, { status });
    if (url === '/api/tasks/a') return Response.json({ task: { state: 'running' }, cloudStatusAvailable: true });
    return Response.json({
      repositories: [{ id: 'r1', name: 'Factory', provider: 'github' }],
      sessions: [{ repoId: 'r1', workItemKey: '3', taskId: 'a', title: 'Review', state: 'running', issueUrl: null }],
    });
  });
  await press('View task');
  await press('Check GitHub status');
  if (status === 502) {
    await vi.waitFor(() => expect(target.textContent).toContain('GitHub status unavailable'));
    expect(target.textContent).toContain('Task state: running');
  } else {
    await vi.waitFor(() => expect(target.textContent).not.toContain('Task state: running'));
    expect(target.textContent).not.toContain('Check GitHub status');
  }
});

it('discards a task detail that resolves after access is revoked', async () => {
  const response = Promise.withResolvers<Response>();
  let reads = 0;
  browse('/active-sessions', (url) => {
    if (url === '/api/tasks/a') return response.promise;
    return reads++ === 0 ? Response.json({
      repositories: [], sessions: [{ repoId: 'r1', taskId: 'a', workItemKey: '7', title: 'Factory task', state: 'running', issueUrl: null }],
    }) : new Response(null, { status: 403 });
  });
  await press('View task');
  await vi.waitFor(() => expect(target.textContent).toContain('Loading task details'));
  await press('Refresh');
  await vi.waitFor(() => expect(target.textContent).toContain('Access to this view is no longer authorized'));
  response.resolve(Response.json({ task: { state: 'running' }, pendingQuestion: null }));
  await response.promise;
  await tick();
  expect(target.textContent).not.toContain('Factory task');
  expect(target.textContent).not.toContain('Task state');
});

it.each([401, 403, 503])('clears reporting rows when a task read loses access (%s)', async (status) => {
    const pending = Promise.withResolvers<Response>();
    browse('/active-sessions', (url) => url === '/api/tasks/a' ? pending.promise : Response.json({
      repositories: [{ id: 'r1', name: 'Factory', provider: 'github' }],
      sessions: [{ repoId: 'r1', title: 'Private session', taskId: 'a', workItemKey: '7', state: 'running', issueUrl: null }],
    }));
    await press('View task');
    await press('View task');
    pending.resolve(Response.json({ code: status === 503 ? 'ACCESS_UNVERIFIED' : 'ACCESS_DENIED' }, { status }));
    await vi.waitFor(() => expect(target.textContent).not.toContain('Private session'));
    if (status === 503) expect(target.textContent).toContain('Sync');
    expect(target.textContent).not.toContain('No active sessions');
  });

it('keeps focus and fits the session filters and first row at 1080 by 720', async () => {
    await page.viewport(1080, 720);
    browse('/active-sessions', () => Response.json({
      repositories: [{ id: 'r1', name: 'Factory', provider: 'github' }],
      sessions: [{ repoId: 'r1', title: 'Needs context', taskId: 'a', workItemKey: '7', state: 'waiting_input', issueUrl: null }],
    }));
    const filter = page.getByRole('button', { name: 'Needs your answer 1' });
    await expect.element(filter).toBeVisible();
    (filter.element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    expect(filter.element().getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(filter.element());
    expect(page.getByText('Needs context', { exact: false }).element().getBoundingClientRect().bottom).toBeLessThan(720);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1080);
  });

it('cannot restore a late summary after a detail read reports unverified access', async () => {
    const pending = Promise.withResolvers<Response>();
    const summary = { repositories: [], sessions: [
      { repoId: 'r1', title: 'Private session', taskId: 'a', workItemKey: '7', state: 'running', issueUrl: null },
    ] };
    let reads = 0;
    browse('/active-sessions', (url) => url === '/api/tasks/a'
      ? Response.json({ code: 'ACCESS_UNVERIFIED' }, { status: 503 })
      : reads++ === 0 ? Response.json(summary) : pending.promise);
    await vi.waitFor(() => expect(target.textContent).toContain('Private session'));
    await press('Refresh');
    await press('View task');
    await vi.waitFor(() => expect(target.textContent).toContain('Open Repositories and run Sync'));
    pending.resolve(Response.json(summary));
    await pending.promise;
    await tick();
    expect(target.textContent).not.toContain('Private session');
  });
