import { mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import AppShell from '../AppShell.svelte';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

function mountSetup() {
  const root = document.createElement('div');
  document.body.append(root);
  const previous = location.href;
  history.replaceState(null, '', '/setup');
  try {
    const app = mount(AppShell, { target: root });
    cleanup = async () => { await unmount(app); root.remove(); };
  } finally {
    history.replaceState(null, '', previous);
  }
  return root;
}

const json = (value: unknown) => Response.json(value);
const noContent = () => new Response(null, { status: 204 });
async function click(root: HTMLElement, text: string) {
  await vi.waitFor(() => {
    const button = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
    expect(button).toBeDefined();
    expect(button?.disabled, text).toBe(false);
    button?.click();
  });
}

it('links Copilot separately and shows models and account quota in their reported units', async () => {
  let linked = false;
  let samples = 0;
  const wire = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/build') return json({ revision: null, builtAt: null, runUrl: null });
    if (path === '/api/setup/status') return json({ state: 'claimed', signInAvailable: true });
    if (path === '/api/me') return json({ user: { displayName: 'Owner' } });
    if (path === '/api/connections') return json({ items: [] });
    if (path === '/api/settings/instance') return json({ version: 0, repositoryEnabled: true, githubClientId: 'app', copilotEnabled: true });
    if (path === '/api/auth/csrf') return json({ csrfToken: 'fixture' });
    if (path === '/api/authorization/flows') {
      if (init?.method !== 'POST') return json({ flow: null });
      expect(init.body).toBe(JSON.stringify({ intent: 'link_copilot', hostId: 'github.com' }));
      return json({ flowId: 'flow', browserInstructions: { userCode: 'ABCD-EFGH' } });
    }
    if (path === '/api/authorization/flows/flow') return json({ state: 'ready' });
    if (path === '/api/authorization/flows/flow/complete') { linked = true; return noContent(); }
    if (path === '/api/copilot/accounts') return json({ items: linked ? [
      { id: 'grant', accountLabel: 'owner-copilot', state: 'connected', host: 'github.com' },
      { id: 'expired', accountLabel: 'former', state: 'needs_auth', host: 'github.com' },
    ] : [] });
    if (path === '/api/copilot/accounts/grant/catalog') {
      samples++;
      if (samples === 2) return json({ models: null, quota: [] });
      if (samples === 3) return json({ models: [], quota: null });
      return json({
        models: [{ id: 'a', name: 'Model Alpha', policy: 'disabled', reasoning: ['low', 'high'], defaultReasoning: 'high' }],
        quota: [
          { kind: 'premium_interactions', unit: 'requests', used: 12, limit: 100, unlimited: false, resetsAt: null },
          { kind: 'chat', unit: 'requests', used: 0, limit: null, unlimited: true, resetsAt: '2026-12-01T00:00:00.000Z' },
        ],
      });
    }
    throw new Error('Unexpected management request');
  });
  vi.stubGlobal('fetch', wire);
  const root = mountSetup();
  await click(root, 'Link GitHub Copilot');
  await click(root, 'Check approval');
  await click(root, 'Check Copilot catalog for owner-copilot');
  await vi.waitFor(() => {
    expect(root.textContent).toContain('Model Alpha');
    expect(root.textContent).toContain('12 / 100 requests used');
    expect(root.textContent).toContain('disabled');
    expect(root.textContent).toContain('low, high');
    expect(root.textContent).toContain('Reconnect Copilot for former');
    expect(root.textContent).toContain('Unlimited');
    expect(root.querySelector('time')?.dateTime).toBe('2026-12-01T00:00:00.000Z');
  });
  expect(wire.mock.calls.find(([path]) => path === '/api/copilot/accounts/grant/catalog')?.[1])
    .toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': 'fixture' } });
  await click(root, 'Check Copilot catalog for owner-copilot');
  await vi.waitFor(() => {
    expect(root.textContent).toContain('Models could not be read');
    expect(root.textContent).toContain('No quota reported');
    expect(root.textContent).not.toContain('Model Alpha');
  });
  await click(root, 'Check Copilot catalog for owner-copilot');
  await vi.waitFor(() => {
    expect(root.textContent).toContain('No models reported');
    expect(root.textContent).toContain('Account quota could not be read');
  });
});

it('pairs, completes GitHub sign-in, toggles settings and manages repository authorization', async () => {
  let signed = false;
  let claimed = false;
  let allowed = true;
  let ready = false;
  let connection = 'connected';
  let flowNumber = 0;
  const wire = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path === '/api/build') return json({ revision: null, builtAt: null, runUrl: null });
    if (path === '/api/setup/status') return json({ state: claimed ? 'claimed' : 'unclaimed', pairingAvailable: true, signInAvailable: true });
    if (path === '/api/me') return signed ? json({ user: { displayName: 'Owner' } }) : new Response(null, { status: 401 });
    if (path === '/api/auth/csrf') return json({ csrfToken: 'fixture' });
    if (path === '/api/setup/pair') return noContent();
    if (path === '/api/authorization/flows' && method === 'GET') return json({ flow: null });
    if (path === '/api/authorization/flows') {
      flowNumber++;
      return json({ flowId: `flow-${flowNumber}`, browserInstructions: { userCode: 'ABCD-EFGH' } });
    }
    if (path.startsWith('/api/authorization/flows/')) {
      if (path.endsWith('/complete')) { signed = true; claimed = true; return noContent(); }
      if (method === 'DELETE') return noContent();
      return json({ state: ready ? 'ready' : 'pending' });
    }
    if (path === '/api/settings/instance') {
      if (method === 'PUT') allowed = !allowed;
      return json({ version: allowed ? 0 : 1, repositoryEnabled: allowed, githubClientId: 'factory-client' });
    }
    if (path === '/api/connections') return json({ items: [{ id: 'connection', name: 'Sample', state: connection }] });
    if (path === '/api/connections/connection/authorization') { connection = 'needs_auth'; return noContent(); }
    if (path === '/api/auth/logout') { signed = false; return noContent(); }
    throw new Error('Unexpected management request');
  });
  vi.stubGlobal('fetch', wire);
  const root = mountSetup();
  await page.getByLabelText('Host pairing code').fill('pairing-code');
  await click(root, 'Pair this browser');
  await click(root, 'Sign in with GitHub');
  await click(root, 'Check approval');
  expect(root.textContent).toContain('ABCD-EFGH');
  ready = true;
  await click(root, 'Check approval');
  await vi.waitFor(() => expect(root.textContent).toContain('GitHub App Client ID: factory-client'));
  await click(root, 'Disable repository authorization');
  await page.getByLabelText('GitHub repository URL').fill('https://github.com/org/repo');
  await expect.element(page.getByRole('button', { name: 'Connect repository' })).toBeDisabled();
  await click(root, 'Enable repository authorization');
  await click(root, 'Connect repository');
  await click(root, 'Cancel authorization');
  await click(root, 'Reconnect Sample');
  await click(root, 'Check approval');
  await click(root, 'Disconnect Sample');
  await vi.waitFor(() => expect(root.textContent).toContain('needs_auth'));
  await click(root, 'Sign out');
  await vi.waitFor(() => expect(root.textContent).toContain('Sign in with GitHub'));
  const pair = wire.mock.calls.find(([url]) => url === '/api/setup/pair');
  expect(pair?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'fixture' });
});

it('makes an unavailable setup visible without exposing the response body', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => path === '/api/build'
    ? json({ revision: null, builtAt: null, runUrl: null }) : new Response('private detail', { status: 503 })));
  const root = mountSetup();
  await vi.waitFor(() => expect(root.querySelector('[role=alert]')).not.toBeNull());
  expect(root.textContent).not.toContain('private detail');
});

it('reports when public sign-in is not configured', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path === '/api/setup/status') return json({ state: 'claimed', pairingAvailable: false, signInAvailable: false });
    if (path === '/api/me') return new Response(null, { status: 401 });
    return json({ revision: null, builtAt: null, runUrl: null });
  }));
  const root = mountSetup();
  await vi.waitFor(() => expect(root.textContent).toContain('Public GitHub sign-in is not configured'));
});

it('offers a useful recovery path after repository device approval fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/setup/status') return json({ state: 'claimed', pairingAvailable: false, signInAvailable: true });
    if (path === '/api/authorization/flows') return json({ flow: {
      flowId: 'recovered', browserInstructions: { userCode: 'ABCD-EFGH' },
    } });
    if (path === '/api/authorization/flows/recovered') return json({ state: 'failed' });
    if (path === '/api/me') return new Response(null, { status: 401 });
    return json({ revision: null, builtAt: null, runUrl: null });
  }));
  const root = mountSetup();
  await click(root, 'Check approval');
  await vi.waitFor(() => expect(root.textContent).toContain('Check the GitHub App installation'));
  expect(root.textContent).not.toContain('ABCD-EFGH');
  expect(root.textContent).toContain('Cancel authorization');
});

it('resumes the paired browser flow after reloading without showing the pairing input again', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path === '/api/setup/status') return json({ state: 'unclaimed', pairingAvailable: true, paired: true, signInAvailable: true });
    if (path === '/api/authorization/flows') return json({ flow: { flowId: 'recovered', browserInstructions: { userCode: 'ABCD-EFGH' } } });
    if (path === '/api/me') return new Response(null, { status: 401 });
    return json({ revision: null, builtAt: null, runUrl: null });
  }));
  const root = mountSetup();
  await vi.waitFor(() => expect(root.textContent).toContain('ABCD-EFGH'));
  expect(root.querySelector('input[type=password]')).toBeNull();
});

it('allows entering a fresh host code after cancelling an expired pairing', async () => {
  let paired = true;
  const active = { flowId: 'original', browserInstructions: { userCode: 'ABCD-EFGH' } };
  vi.stubGlobal('fetch', vi.fn(async (path, init?: RequestInit) => {
    if (path === '/api/setup/status') return json({ state: 'unclaimed', pairingAvailable: true, paired, signInAvailable: true });
    if (path === '/api/me') return new Response(null, { status: 401 });
    if (path === '/api/auth/csrf') return json({ csrfToken: 'fixture' });
    if (path === '/api/authorization/flows/original' && init?.method === 'DELETE') { paired = false; return noContent(); }
    if (path === '/api/setup/pair') { paired = true; return noContent(); }
    if (path === '/api/authorization/flows') {
      return init?.method === 'POST'
        ? json({ flowId: 'new', browserInstructions: { userCode: 'WXYZ-ABCD' } })
        : json({ flow: paired ? active : null });
    }
    return json({ revision: null, builtAt: null, runUrl: null });
  }));
  const root = mountSetup();
  await click(root, 'Cancel authorization');
  await page.getByLabelText('Host pairing code').fill('fresh-code', { timeout: 2_000 });
  await click(root, 'Pair this browser');
  await click(root, 'Sign in with GitHub');
  await vi.waitFor(() => expect(root.textContent).toContain('WXYZ-ABCD'));
});
