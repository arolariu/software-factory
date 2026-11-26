<script lang="ts">
  import { onMount } from 'svelte';

  let build: { revision: string | null; builtAt: string | null; runUrl: string | null } | null = $state(null);

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
  <span>Signed out</span>
</header>
<main>
  <h1>Software Factory</h1>
  <section aria-labelledby="repository-heading">
    <h2 id="repository-heading">Repositories</h2>
    <p>Repository access is not configured in this build.</p>
  </section>
</main>
<footer>
  {#if build?.revision && build.runUrl}
    <a href="https://github.com/arolariu/software-factory/commit/{build.revision}">{build.revision.slice(0, 7)}</a>
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
  header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 24px; }
  header { background: #eee8f8; border-bottom: 1px solid #cbc1d8; font-weight: 600; }
  main { padding: 24px; min-width: 0; }
  h1 { margin: 0 0 14px; font-size: 23px; }
  section { background: white; border: 1px solid #dcd6e6; border-radius: 4px; padding: 12px 16px; }
  h2 { margin: 0 0 4px; font-size: 15px; }
  p { margin: 0; }
  footer { justify-content: start; border-top: 1px solid #dcd6e6; font-family: Consolas, monospace; }
  a { color: #165f9b; }
  a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
