<script lang="ts">
  import { onMount } from 'svelte';
  import { opaqueIdSegment } from '../shared/api/schemas.js';
  import Management from './settings/Management.svelte';
  import Workbench from './Workbench.svelte';
  import ActiveSessions from './ActiveSessions.svelte';
  import Statistics from './Statistics.svelte';

  let build: { revision: string | null; builtAt: string | null; runUrl: string | null } | null = $state(null);
  const path = location.pathname;
  const management = path === '/setup' || path === '/settings/factory';
  const saved = sessionStorage.getItem('factory.last-workbench') ?? '';
  const savedPane = new RegExp(`^/connections/${opaqueIdSegment}/(?:issues|pull-requests)\\?state=(?:open|closed|active)$`);
  const repositoriesHref = savedPane.test(saved.replace(/%3a/gi, ':')) ? saved.replace(/:|%3a/gi, '%3A') : '/';

  onMount(() => {
    const controller = new AbortController();
    fetch('/api/build', { signal: controller.signal })
      .then(async (response) => { if (response.ok) build = await response.json(); })
      .catch(() => {});
    return () => controller.abort();
  });
</script>

<header>
  <span>Software Factory</span>
  <nav aria-label="Factory">
    <a href={repositoriesHref}>Repositories</a>
    <a href="/active-sessions">Active Sessions</a>
    <a href="/statistics">Statistics</a>
    <a href="/setup">Setup and settings</a>
  </nav>
</header>
<main>
  <h1>Software Factory</h1>
  {#if management}
    <Management />
  {:else if path === '/active-sessions'}
    <ActiveSessions />
  {:else if path === '/statistics'}
    <Statistics />
  {:else}
    <Workbench />
  {/if}
</main>
<footer>
  {#if build?.revision && build.runUrl}
    <a href={`https://github.com/arolariu/software-factory/commit/${build.revision}`}>{build.revision.slice(0, 7)}</a>
  {:else if build?.revision}
    <span>{build.revision.slice(0, 7)}</span>
  {/if}
  {#if build?.builtAt && build.runUrl}
    <a href={build.runUrl}><time datetime={build.builtAt}>{build.builtAt}</time></a>
  {:else if build?.builtAt}
    <time datetime={build.builtAt}>{build.builtAt}</time>
  {:else}
    <span>Build provenance unavailable</span>
  {/if}
</footer>

<style>
  :global(html) {
    color-scheme: light;
    font: 14px/1.45 'Segoe UI', sans-serif;
    background: #f7f6fa;
    color: #211c2c;
  }

  :global(body) { margin: 0; }
  :global(#app) { display: grid; min-height: 100dvh; grid-template-rows: auto 1fr auto; }
  header, footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 24px; }
  nav { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  header { background: #eee8f8; border-bottom: 1px solid #cbc1d8; font-weight: 600; }
  main { padding: 24px; min-width: 0; }
  h1 { margin: 0 0 14px; font-size: 23px; }
  footer { justify-content: start; border-top: 1px solid #dcd6e6; font-family: Consolas, monospace; }
  a { color: #165f9b; }
  a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
