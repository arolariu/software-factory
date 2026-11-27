import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppShell from './AppShell.svelte';

let target: HTMLDivElement;
let app: ReturnType<typeof mount> | undefined;
const revision = 'c'.repeat(40);
const builtAt = '2026-11-26T22:00:00.000Z';
const runUrl = 'https://github.com/arolariu/software-factory/actions/runs/13/attempts/2';

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  vi.unstubAllGlobals();
  target.remove();
});

function show(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async (url) => url === '/api/build' ? response : new Response(null, { status: 401 })));
  app = mount(AppShell, { target });
}

const repo = { id: 'r.1', name: 'Factory', provider: 'github', state: 'connected' };
const issue = { key: '42', title: 'Document startup', url: 'https://github.com/org/repo/issues/42', state: 'open' };
const pull = { key: '8', title: 'Improve startup', url: 'https://github.com/org/repo/pull/8', state: 'active', sourceBranch: 'change', targetBranch: 'main' };
const snapshot = (items: object[], nextCursor: string | null = null) => ({ items, fetchedAt: builtAt, freshness: 'current', nextCursor });

function browse(path: string, handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const previous = location.href;
  history.replaceState(null, '', path);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url === '/api/build'
    ? Response.json({ revision, builtAt, runUrl }) : handler(url, init)));
  try { app = mount(AppShell, { target }); }
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
      description: { content: '<img src=x>' }, comments: { items: [{ id: 'one', body: { content: 'Provider comment' } }] },
    });
    return new Response(null, { status: 404 });
  });
  await press('Document startup');
  await vi.waitFor(() => expect(target.textContent).toContain('<img src=x>'));
  expect(target.textContent).toContain('Provider comment');
  expect(target.querySelector('img')).toBeNull();
  expect(target.querySelector('a[href="/connections/r.1/pull-requests?state=active"]')).not.toBeNull();
  await press('Document startup');
  expect(target.textContent).not.toContain('<img src=x>');
  await press('Load more');
  await vi.waitFor(() => expect(target.textContent).toContain('More evidence'));
});

it('opens a PR deep link and refreshes the snapshot through an explicit Sync receipt', async () => {
  let synced = false;
  let checked = false;
  browse('/connections/r.1/pull-requests?state=closed', (path, init) => {
    if (path === '/api/connections') return Response.json({ items: [repo] });
    if (path === '/api/connections/r.1/pull-requests?state=closed') return Response.json(synced ? snapshot([pull])
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
    return path.endsWith('/42') ? hold.promise : Response.json({ description: { content: 'New detail' }, comments: { items: [] } });
  });
  await press('Document startup');
  await press('Other issue');
  await vi.waitFor(() => expect(target.textContent).toContain('New detail'));
  hold.resolve(Response.json({ description: { content: 'Old detail' }, comments: { items: [] } }));
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

it('links the exact full revision and producing run for a stamped artifact', async () => {
  show(Response.json({ revision, builtAt, runUrl }));
  await vi.waitFor(() => {
    expect(target.querySelector(`a[href="https://github.com/arolariu/software-factory/commit/${revision}"]`)?.textContent).toBe('ccccccc');
    expect(target.querySelector(`a[href="${runUrl}"] time`)?.getAttribute('datetime')).toBe(builtAt);
  });
});

it('renders local provenance as plain text instead of inventing links', async () => {
  show(Response.json({ revision, builtAt, runUrl: null }));
  await vi.waitFor(() => {
    expect(target.querySelector('footer time')?.textContent).toBe(builtAt);
    expect(target.querySelector('footer')?.textContent).toContain('ccccccc');
    expect(target.querySelector('footer a')).toBeNull();
  });
});

it('shows signed-out state and unavailable provenance when the artifact is unstamped', async () => {
  show(Response.json({ revision: null, builtAt: null, runUrl: null }));
  await vi.waitFor(() => expect(target.textContent).toContain('Signed out'));
  expect(target.querySelector('footer')?.textContent).toContain('Build provenance unavailable');
  expect(target.querySelector('footer a')).toBeNull();
});

it('does not render a time link if the producing run has no timestamp', async () => {
  show(Response.json({ revision, builtAt: null, runUrl }));
  await vi.waitFor(() => {
    expect(target.querySelector('footer a')?.textContent).toBe('ccccccc');
    expect(target.querySelector('footer time')).toBeNull();
    expect(target.querySelector('footer')?.textContent).toContain('Build provenance unavailable');
  });
});

it('links known build time even if the revision is unavailable', async () => {
  show(Response.json({ revision: null, builtAt, runUrl }));
  await vi.waitFor(() => {
    expect(target.querySelector(`a[href="${runUrl}"] time`)?.textContent).toBe(builtAt);
    expect(target.querySelectorAll('footer a')).toHaveLength(1);
  });
});

it('keeps the shell available when build metadata returns an HTTP error', async () => {
  show(new Response(null, { status: 503 }));
  await tick();
  expect(target.querySelector('main h1')?.textContent).toBe('Software Factory');
  expect(target.querySelector('footer')?.textContent).toContain('Build provenance unavailable');
});

it('cancels its request on removal without surfacing a metadata transport failure', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return Promise.reject(new Error('offline'));
  });
  app = mount(AppShell, { target });
  await tick();
  expect(target.querySelector('footer')?.textContent).toContain('Build provenance unavailable');
  await unmount(app);
  app = undefined;
  expect(signal?.aborted).toBe(true);
});
