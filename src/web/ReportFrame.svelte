<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { readReport } from './report-read.svelte.js';
  const { title, report, children }: { title: string; report: ReturnType<typeof readReport>; children: Snippet } = $props();
</script>

<section aria-labelledby="report-heading" class="report">
  <div class="report-header">
    <h2 id="report-heading">{title}</h2>
    <div class="read-controls">
      {#if report.checkedAt}<span>Last read: <time datetime={report.checkedAt}>{report.checkedAt}</time></span>{/if}
      <button type="button" onclick={report.refresh} disabled={report.pending}>{report.notice && !report.data ? 'Retry' : 'Refresh'}</button>
    </div>
  </div>
  {#if report.notice}
    <p class="notice" role="status">{report.notice} {#if report.needsSync}<a href="/">Open Repositories</a>{/if}</p>
  {/if}
  {#if report.pending}<p role="status">Reading from Factory...</p>{/if}
  {@render children()}
</section>

<style>
  section { background: #fff; border: 1px solid #dcd6e6; border-radius: 4px; min-width: 0; }
  .report-header, .read-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
  .report-header { justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #dcd6e6; }
  h2 { margin: 0; font-size: 15px; }
  .report :global(button), .report :global(select) { font: inherit; color: #211c2c; border: 1px solid #8b8098; border-radius: 4px; background: #fff; padding: 3px 8px; min-height: 28px; }
  .report :global(button:hover:not(:disabled)) { background: #f4f0f9; }
  .report :global(:is(a, button, select):focus-visible) { outline: 2px solid #165f9b; outline-offset: 2px; }
  .report :global(a) { color: #165f9b; }
  p { margin: 0; padding: 8px 12px; }
  .notice { color: #44394f; background: #f7f6fa; border-bottom: 1px solid #dcd6e6; }
</style>
