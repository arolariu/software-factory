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
