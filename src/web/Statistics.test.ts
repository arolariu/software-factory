import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import Statistics from './Statistics.svelte';

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
  try { app = mount(Statistics, { target }); }
  finally { history.replaceState(null, '', previous); }
}

async function press(label: string) {
  await vi.waitFor(() => {
    const button = [...target.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    expect(button?.disabled).toBe(false);
    button?.click();
  });
}

it('reports that statistics are unavailable without displaying zeroes', async () => {
  browse('/statistics', () => new Response(null, { status: 503 }));
  await vi.waitFor(() => expect(target.textContent).toContain('Statistics are unavailable'));
  expect(target.querySelector('dl')).toBeNull();
});

it('does not invent a reporting range or repository comparison when no series was measured', async () => {
  browse('/statistics', () => Response.json({
    activeTasks: 0, completed: 0, failed: 0, stopped: 0, draftPrs: 0,
    credits: { measured: null, unmeasuredTasks: 0 }, weekly: [], repositories: [],
  }));
  await vi.waitFor(() => expect(target.textContent).toContain('Weekly outcomes'));
  expect(target.textContent).not.toContain('Week starts:');
  expect(target.querySelector('meter')).toBeNull();
});

it('shows measured outcomes without treating unknown usage as zero', async () => {
  let calls = 0;
  await page.viewport(1080, 720);
  browse('/statistics', (url) => {
    expect(url).toBe('/api/statistics');
    return Response.json({
      activeTasks: 2, completed: 12, failed: 1, stopped: 2, draftPrs: 7,
      credits: { measured: calls++ ? 10 : null, unmeasuredTasks: 3 },
      repositories: calls === 1 ? [] : [{
        repoId: 'factory', activeTasks: 2, completed: 8, stopped: 1, failed: 1, draftPrs: 3,
        credits: { measured: 10, unmeasuredTasks: 3 },
      }], weekly: [
        { weekStart: '2026-11-23', completed: null, credits: 10 },
        { weekStart: '2026-11-30', completed: 0, credits: null },
      ],
    });
  });
  await vi.waitFor(() => expect(target.querySelector('table td')?.textContent).toBe('Not measured'));
  expect(target.textContent).toContain('3 tasks have no recorded credits');
  expect(target.textContent).toContain('12');
  await press('Refresh');
  await vi.waitFor(() => expect(target.textContent).toContain('Measured credits: 10'));
  expect(target.textContent).toContain('2026-11-23 through 2026-11-30');
  expect(target.querySelector('meter')?.value).toBe(8);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1080);
  await page.viewport(390, 720);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});
