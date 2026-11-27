<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { readReport } from './report-read.svelte.js';
  const { title, report, children }: { title: string; report: ReturnType<typeof readReport>; children: Snippet } = $props();
</script>

<section aria-labelledby="report-heading" class="sheet report">
  <div class="report-header">
    <h2 id="report-heading" class="sheet-title">{title}</h2>
    <div class="read-controls">
      {#if report.checkedAt}<span class="muted">Last read: <time datetime={report.checkedAt}>{report.checkedAt.replace('T', ' ').slice(0, 19)} UTC</time></span>{/if}
      <button type="button" onclick={report.refresh} disabled={report.pending}>{report.notice && !report.data ? 'Retry' : 'Refresh'}</button>
    </div>
  </div>
  {#if report.notice}
    <div class="state-panel" role="status">
      <p class="state-heading">{report.notice}</p>
      {#if report.needsSync}<a href="/">Open Repositories</a>{/if}
    </div>
  {/if}
  {#if report.pending}<p class="notice" role="status">Reading from Factory...</p>{/if}
  {@render children()}
</section>

<style>
  .report-header, .read-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem 1rem; }
  .report-header { justify-content: space-between; padding: .8rem 1rem; border-bottom: 1px solid var(--line); }
  .read-controls span { font-size: .86rem; }
  .state-panel { border-bottom: 1px solid var(--line); }
</style>
