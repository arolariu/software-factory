<script lang="ts">
  import { onMount } from 'svelte';
  import { opaqueIdSegment } from '../shared/api/opaque-id.js';
  import Management from './settings/Management.svelte';
  import Workbench from './Workbench.svelte';
  import ActiveSessions from './ActiveSessions.svelte';
  import Statistics from './Statistics.svelte';
  import './portal.css';

  let build: { revision: string | null; builtAt: string | null; runUrl: string | null } | null = $state(null);
  const path = location.pathname;
  const management = path === '/setup' || path === '/settings/factory';
  const saved = sessionStorage.getItem('factory.last-workbench') ?? '';
  const savedPane = new RegExp(`^/connections/${opaqueIdSegment}/(?:issues|pull-requests)\\?state=(?:open|closed|active)$`);
  const repositoriesHref = savedPane.test(saved.replace(/%3a/gi, ':')) ? saved.replace(/:|%3a/gi, '%3A') : '/';
  const activeSection = management ? '/setup' : ['/active-sessions', '/statistics'].includes(path) ? path : repositoriesHref;
  const links = [
    { href: repositoriesHref, label: 'Repositories', icon: 'M2 5h5l2 2h13v13H2z' },
    { href: '/active-sessions', label: 'Active Sessions', icon: 'M3 12h4l3-7 4 14 3-7h4' },
    { href: '/statistics', label: 'Statistics', icon: 'M4 20V4m0 16h16M8 16v-4m5 4V8m5 8v-6' },
    { href: '/setup', label: 'Setup and settings', icon: 'M4 7h16M4 17h16M9 4v6m6 4v6' },
  ];

  onMount(() => {
    const controller = new AbortController();
    fetch('/api/build', { signal: controller.signal })
      .then(async (response) => { if (response.ok) build = await response.json(); })
      .catch(() => {});
    return () => controller.abort();
  });
</script>

<a class="skip" href="#workspace">Skip to workspace</a>
<header>
  <div class="brand">
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19.5v-8l5 2.5v-4l5 2.5v-6h5v13zM8 17h1m3 0h1m3 0h1"/></svg>
    <span>Software Factory</span>
  </div>
  <nav aria-label="Factory">
    {#each links as link (link.label)}
      <a href={link.href} aria-current={link.href === activeSection ? 'page' : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d={link.icon} /></svg>
        {link.label}
      </a>
    {/each}
  </nav>
</header>
<div class="workspace-layout">
<aside class="proof-rail" aria-label="Workspace context">
  <div class="rail-note">
    <span class="rail-rule"></span>
    <strong>Read-only workspace</strong>
    <p>Browse repository evidence and review activity. Task execution is disabled.</p>
  </div>
</aside>
  <footer>
    <span class="build-label">Build provenance</span>
    <div class="build-details">
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
    </div>
  </footer>
<main id="workspace" tabindex="-1">
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
</div>

<style>
  :global(#app) { display: grid; min-height: 100dvh; grid-template-rows: auto 1fr; }
  .skip { position: absolute; z-index: 1; inset: .5rem auto auto .5rem; padding: .5rem 1rem; background: var(--surface); transform: translateY(-200%); }
  .skip:focus { transform: none; }
  header { display: flex; align-items: center; gap: 1.4rem; flex-wrap: wrap; padding: .55rem 1.15rem; background: var(--chrome); border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: .55rem; font-weight: 700; white-space: nowrap; }
  .brand svg { width: 30px; height: 30px; padding: 3px; border-radius: var(--radius); background: var(--action); color: var(--surface); }
  nav { display: flex; flex-wrap: wrap; gap: .25rem; }
  nav a { display: inline-flex; gap: .45rem; align-items: center; min-height: 34px; padding: .25rem .65rem; border-radius: var(--radius); color: var(--muted); text-decoration: none; font-weight: 600; }
  nav a svg { width: 16px; height: 16px; flex: none; }
  nav a:hover, nav a[aria-current] { background: var(--selection); color: var(--action-hover); }
  nav a[aria-current] { box-shadow: inset 0 -2px var(--action); }
  .workspace-layout { display: grid; grid-template-columns: 164px minmax(0, 1fr); grid-template-rows: 1fr auto; min-width: 0; }
  .proof-rail { padding: 1rem; background: var(--rail); border-inline-end: 1px solid var(--line); }
  .rail-note { font-size: .86rem; }
  .rail-note p { color: var(--muted); margin: .45rem 0 0; }
  .rail-rule { display: block; width: 24px; border-block-start: 2px solid var(--action); margin-block-end: .7rem; }
  footer { grid-area: 2 / 1; display: grid; gap: .4rem; padding: .8rem 1rem; background: var(--rail); border-block-start: 1px solid var(--line); border-inline-end: 1px solid var(--line); }
  .build-label { color: var(--muted); font-size: .8rem; font-weight: 650; }
  .build-details { display: flex; flex-wrap: wrap; gap: .25rem .65rem; color: var(--muted); font: .78rem/1.5 var(--mono); overflow-wrap: anywhere; }
  main { grid-area: 1 / 2 / span 2; padding: clamp(1rem, 2.2vw, 2rem); min-width: 0; }
  h1 { margin: 0 0 1rem; font-size: clamp(1.5rem, 2.4vw, 1.9rem); font-weight: 700; letter-spacing: -.025em; line-height: 1.2; }
  @media (max-width: 760px) {
    .workspace-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: 1fr auto; }
    main { grid-area: 1 / 1; }
    .proof-rail { display: none; }
    footer { border-inline-end: 0; }
    header { gap: .5rem; }
    nav a { padding-inline: .5rem; }
  }
</style>
