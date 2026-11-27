import { tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import { mountPortal } from './main.js';

it('mounts the initial portal only where the static entry provides a root', async () => {
  expect(mountPortal(null)).toBeUndefined();
  const target = document.createElement('div');
  document.body.append(target);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ revision: null, builtAt: null, runUrl: null })));
  const app = mountPortal(target);
  try {
    await tick();
    expect(target.querySelector('h1')?.textContent).toBe('Software Factory');
  } finally {
    if (app) await unmount(app);
    vi.unstubAllGlobals();
    target.remove();
  }
});
