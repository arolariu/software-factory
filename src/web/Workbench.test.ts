import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import Workbench from './Workbench.svelte';

let target: HTMLDivElement;
let app: ReturnType<typeof mount> | undefined;
let originalUrl: string;
const builtAt = '2026-11-26T22:00:00.000Z';

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

const repo = { id: 'r.1', name: 'Factory', provider: 'github', state: 'connected' };
const issue = { key: '42', title: 'Document startup', url: 'https://github.com/org/repo/issues/42', state: 'open', author: { displayName: 'Issue author' }, createdAt: builtAt, assignees: [] };
const pull = { key: '8', title: 'Improve startup', url: 'https://github.com/org/repo/pull/8', state: 'active', sourceBranch: 'change', targetBranch: 'main', draft: true, origin: 'mine', checks: { availability: { available: true }, passed: 1, total: 3 } };
const snapshot = (items: object[], nextCursor: string | null = null) => ({ items, fetchedAt: builtAt, freshness: 'current', nextCursor });

function browse(path: string, handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const previous = location.href;
  history.replaceState(null, '', path);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
  try { app = mount(Workbench, { target }); }
  finally { history.replaceState(null, '', previous); }
}

async function press(label: string) {
  await vi.waitFor(() => {
    const button = [...target.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    expect(button?.disabled).toBe(false);
    button?.click();
  });
}

it('lists open issues by default and keeps inline evidence inert', async () => {
  browse('/', (path) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    if (path === '/api/connections/r.1/issues?state=open') return Response.json(snapshot([issue], 'next'));
    if (path === '/api/connections/r.1/issues?state=open&cursor=next') return Response.json(snapshot([{ ...issue, key: '43', title: 'More evidence' }]));
    if (path === '/api/connections/r.1/issues/42') return Response.json({
      description: { format: 'markdown', content: '**Instructions**' },
      comments: { items: [{ id: 'one', body: { format: 'html', content: '<p>Provider comment</p><img alt="decorative">' } }], nextCursor: 'comments' },
    });
    if (path === '/api/connections/r.1/issues/42?commentCursor=comments') return Response.json({
      comments: { items: [{ id: 'two', body: { format: 'text', content: 'Second page' } }], nextCursor: null },
    });
    return new Response(null, { status: 404 });
  });
  await press('Document startup');
  await vi.waitFor(() => expect(target.querySelector('.evidence strong')?.textContent).toBe('Instructions'));
  expect(target.textContent).toContain('Provider comment');
  expect(target.textContent).toContain('Issue author');
  expect(target.textContent).toContain('Unassigned');
  expect(target.querySelector('img')).toBeNull();
  await press('Load more comments');
  await vi.waitFor(() => expect(target.textContent).toContain('Second page'));
  expect(target.textContent).toContain('Provider comment');
  expect(target.querySelector('a[href="/connections/r.1/pull-requests?state=active"]')).not.toBeNull();
  await press('Document startup');
  expect(target.textContent).not.toContain('Instructions');
  await press('Load more');
  await vi.waitFor(() => expect(target.textContent).toContain('More evidence'));
});

it('retains the snapshot after a transient list failure but clears it on a late detail access denial', async () => {
  const delayed = Promise.withResolvers<Response>();
  let reads = 0;
  browse('/', (url) => {
    if (url === '/api/connections') return Response.json({ items: [repo] });
    if (url.endsWith('?state=open')) {
      return reads++ === 0 ? Response.json(snapshot([issue])) : new Response(null, { status: 502 });
    }
    return delayed.promise;
  });
  await vi.waitFor(() => expect(target.textContent).toContain('Document startup'));
  await press('Refresh list');
  await vi.waitFor(() => expect(target.textContent).toContain('Stale snapshot'));
  expect(target.textContent).toContain('Document startup');
  await press('Document startup');
  await press('Document startup');
  delayed.resolve(Response.json({ code: 'ACCESS_UNVERIFIED' }, { status: 503 }));
  await vi.waitFor(() => expect(target.textContent).toContain('Repository access could not be verified'));
  expect(target.textContent).not.toContain('Document startup');
});

it('keeps Sync tracking when switching repository panes with the keyboard', async () => {
  const receipt = Promise.withResolvers<Response>();
  browse('/', (url) => {
    if (url === '/api/connections') return Response.json({ items: [repo] });
    if (url.endsWith('?state=open')) return Response.json(snapshot([issue]));
    if (url.endsWith('?state=active')) return Response.json(snapshot([pull]));
    if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'token' });
    if (url.endsWith('/sync')) return Response.json({ operationId: 'running' }, { status: 202 });
    return receipt.promise;
  });
  await press('Sync');
  const tab = page.getByRole('link', { name: 'Active PRs' });
  await userEvent.tab();
  await vi.waitFor(() => expect(tab.element()).toBeDefined());
  (tab.element() as HTMLElement).focus();
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(target.textContent).toContain('Improve startup'));
  expect(target.textContent).toContain('1/3 passed');
  expect(target.textContent).toContain('Draft');
  expect(target.textContent).toContain('Mine');
  receipt.resolve(Response.json({ state: 'completed' }));
  await vi.waitFor(() => expect(target.textContent).toContain('Sync complete'));
  expect(location.pathname).toBe('/connections/r.1/pull-requests');
});

it('keeps the selected repository visible when the initial repository read fails late', async () => {
  const first = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const other = { ...repo, id: 'r2', name: 'Other repo' };
  browse('/', (url) => {
    if (url === '/api/connections') return Response.json({ items: [repo, other] });
    if (url === '/api/connections/r.1/issues?state=open') {
      started.resolve();
      return first.promise;
    }
    return Response.json(snapshot([{ ...issue, title: 'Other repo issue' }]));
  });
  await started.promise;
  await page.getByRole('link', { name: other.name }).click();
  await vi.waitFor(() => expect(target.textContent).toContain('Other repo issue'));
  const response = Response.json({ code: 'ACCESS_DENIED' }, { status: 403 });
  const bodyRead = Promise.withResolvers<void>();
  const json = response.json.bind(response);
  vi.spyOn(response, 'json').mockImplementation(async () => {
    const body = await json();
    bodyRead.resolve();
    return body;
  });
  first.resolve(response);
  await bodyRead.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(target.textContent).toContain('Other repo issue');
  expect(target.textContent).not.toContain('Repository access was denied');
});

it('only displays Sync progress and completion in the repository that owns the receipt', async () => {
  const receipt = Promise.withResolvers<Response>();
  const other = { ...repo, id: 'r2', name: 'Other repo' };
  browse('/', (url) => {
    if (url === '/api/connections') return Response.json({ items: [repo, other] });
    if (url.endsWith('?state=open')) return Response.json(snapshot([issue]));
    if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'token' });
    if (url === '/api/connections/r.1/sync') return Response.json({ operationId: 'running' }, { status: 202 });
    return receipt.promise;
  });
  await press('Sync');
  await page.getByRole('link', { name: other.name }).click();
  expect(target.textContent).not.toContain('Sync requested');
  receipt.resolve(Response.json({ state: 'completed' }));
  await expect.element(page.getByRole('button', { name: 'Sync', exact: true })).toBeEnabled();
  expect(target.textContent).not.toContain('Sync complete');
  await page.getByRole('link', { name: repo.name, exact: true }).click();
  await expect.element(page.getByText('Sync complete.', { exact: true })).toBeVisible();
});

it('keeps authorized rows when Sync is rejected for invalid CSRF', async () => {
  browse('/', (url) => {
    if (url === '/api/connections') return Response.json({ items: [repo] });
    if (url.endsWith('?state=open')) return Response.json(snapshot([issue]));
    if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'token' });
    return Response.json({ code: 'CSRF_INVALID' }, { status: 403 });
  });
  await press('Sync');
  await vi.waitFor(() => expect(target.textContent).toContain('Sync could not be checked'));
  expect(target.textContent).toContain(issue.title);
  expect(target.textContent).not.toContain('Repository access was denied');
});

it('opens a PR deep link and refreshes the snapshot through an explicit Sync receipt', async () => {
  let synced = false;
  let checked = false;
  browse('/connections/r.1/pull-requests?state=closed', (path, init) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    if (path === '/api/connections/r.1/pull-requests?state=closed') return Response.json(synced ? snapshot([
      { ...pull, state: 'merged', draft: false, checks: null },
      { ...pull, key: '9', title: 'Closed without publication', state: 'closed', checks: { total: 0 } },
    ])
      : { items: null, freshness: 'not_synced', fetchedAt: null, nextCursor: null });
    if (path === '/api/auth/csrf') return Response.json({ csrfToken: 'fixture' });
    if (path === '/api/connections/r.1/sync' && init?.method === 'POST') return Response.json({ operationId: 'op' }, { status: 202 });
    if (path === '/api/operations/op') {
      if (!checked) {
        checked = true;
        return Response.json({ state: 'running' });
      }
      synced = true;
      return Response.json({ state: 'completed' });
    }
    return new Response(null, { status: 404 });
  });
  await vi.waitFor(() => expect(target.textContent).toContain('Sync to load'));
  await press('Sync');
  await vi.waitFor(() => expect(target.textContent).toContain('Improve startup'), { timeout: 3000 });
  expect(target.textContent).toContain('Merged');
  expect(target.textContent).toContain('Closed without merge');
  expect(target.textContent).toContain('Checks unavailable');
  expect(target.textContent).toContain('No checks');
});

it('drops an old repository list after back navigation and handles a failed Sync receipt', async () => {
  const pending = Promise.withResolvers<Response>();
  const other = { ...repo, id: 'r2', name: 'Other repo' };
  browse('/', (url) => {
    if (url === '/api/connections') return Response.json({ items: [repo, other] });
    if (url === '/api/connections/r.1/issues?state=open') return Response.json(snapshot([{ ...issue, author: null }]));
    if (url === '/api/connections/r2/issues?state=open') return pending.promise;
    if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'token' });
    if (url.endsWith('/sync')) return Response.json({ operationId: 'running' }, { status: 202 });
    return new Response(null, { status: 502 });
  });
  const tab = page.getByRole('link', { name: 'Other repo' });
  await expect.element(tab).toBeVisible();
  const anchor = tab.element();
  const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  anchor.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  await tab.click();
  expect(location.pathname).toBe('/connections/r2/issues');
  history.back();
  await vi.waitFor(() => expect(target.textContent).toContain('Unknown author'));
  pending.resolve(Response.json(snapshot([{ ...issue, title: 'Previous repository result' }])));
  await pending.promise;
  await tick();
  expect(target.textContent).not.toContain('Previous repository result');
  await press('Sync');
  await vi.waitFor(() => expect(target.textContent).toContain('Sync could not be checked'));
});

it('does not show an empty repo when access cannot be verified', async () => {
  browse('/', (path) => path === '/api/connections' ? Response.json({ items: [repo] })
    : Response.json({ code: 'ACCESS_UNVERIFIED' }, { status: 503 }));
  await vi.waitFor(() => expect(target.textContent).toContain('Repository access could not be verified'));
  expect(target.textContent).not.toContain('No records match');
});

it('offers reconnection without reading a disconnected repo', async () => {
  browse('/connections/r.1/issues', (path) => {
    if (path === '/api/connections') return Response.json({ items: [{ ...repo, state: 'needs_auth' }] });
    throw new Error(`Unexpected request: ${path}`);
  });
  await vi.waitFor(() => expect(target.textContent).toContain('Open Settings to reconnect it'));
});

it('distinguishes missing connections, unavailable sources, and a genuinely empty list', async () => {
  const replies = [
    Response.json({ items: null, freshness: 'unavailable', fetchedAt: null, nextCursor: null }),
    Response.json(snapshot([])),
  ];
  browse('/connections/r.1/issues?state=closed', (path) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    expect(path).toBe('/api/connections/r.1/issues?state=closed');
    return replies.shift()!;
  });
  await vi.waitFor(() => expect(target.textContent).toContain('This source is unavailable'));
  await press('Refresh list');
  await vi.waitFor(() => expect(target.textContent).toContain('No records match'));
});

it('shows a missing target without loading another repository by mistake', async () => {
  browse('/connections/unknown/issues', (path) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    throw new Error(`Unexpected request: ${path}`);
  });
  await vi.waitFor(() => expect(target.textContent).toContain('No repository selected'));
});

it('loads active pull requests by default and hides records after verified denial', async () => {
  let first = true;
  browse('/connections/r.1/pull-requests', (path) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    expect(path).toBe('/api/connections/r.1/pull-requests?state=active');
    if (first) {
      first = false;
      return Response.json(snapshot([pull]));
    }
    return Response.json({ code: 'ACCESS_DENIED' }, { status: 403 });
  });
  await vi.waitFor(() => expect(target.textContent).toContain('Improve startup'));
  expect(target.querySelector('[aria-current="page"][href$="state=active"]')).not.toBeNull();
  await press('Refresh list');
  await vi.waitFor(() => expect(target.textContent).toContain('Repository access was denied'));
  expect(target.textContent).not.toContain('Improve startup');
});

it('does not restore the previously opened issue when its request resolves late', async () => {
  const hold = Promise.withResolvers<Response>();
  browse('/', (path) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    if (path === '/api/connections/r.1/issues?state=open') {
      return Response.json(snapshot([issue, { ...issue, key: '43', title: 'Other issue' }]));
    }
    return path.endsWith('/42') ? hold.promise : Response.json({ description: { format: 'text', content: 'New detail' }, comments: { items: [] } });
  });
  await press('Document startup');
  await press('Other issue');
  await vi.waitFor(() => expect(target.textContent).toContain('New detail'));
  hold.resolve(Response.json({ description: { format: 'text', content: 'Old detail' }, comments: { items: [] } }));
  await hold.promise;
  await tick();
  expect(target.textContent).toContain('New detail');
  expect(target.textContent).not.toContain('Old detail');
});

it('renders the last snapshot as stale and reports unavailable issue details without hiding the list', async () => {
  browse('/', (path) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    if (path === '/api/connections/r.1/issues?state=open') return Response.json({ ...snapshot([issue]), freshness: 'stale' });
    return new Response(null, { status: 502 });
  });
  await press('Document startup');
  await vi.waitFor(() => expect(target.textContent).toContain('Could not load repository data'));
  expect(target.textContent).toContain('Stale snapshot');
  expect(target.textContent).toContain('Document startup');
});
