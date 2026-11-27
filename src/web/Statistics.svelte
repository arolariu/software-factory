<script lang="ts">
  import ReportFrame from './ReportFrame.svelte';
  import { readReport } from './report-read.svelte.js';
  const report = readReport<'statistics'>('/api/statistics', 'Statistics are unavailable. Try again later.');
  const stats = $derived(report.data);
  const weeks = $derived((stats?.weekly ?? []).toSorted((left, right) => left.weekStart.localeCompare(right.weekStart)));
  const largest = $derived(Math.max(1, ...(stats?.repositories ?? []).map((repo) => repo.completed)));
  const range = $derived(weeks.map((week) => week.weekStart).slice(0, 1).concat(weeks.slice(-1).map((week) => week.weekStart)).join(' through '));
</script>

<ReportFrame title="Statistics" {report}>
  {#if stats}
    <dl>
      <div><dt>Active tasks</dt><dd>{stats.activeTasks}</dd></div>
      <div><dt>Completed</dt><dd>{stats.completed}</dd></div>
      <div><dt>Stopped</dt><dd>{stats.stopped}</dd></div>
      <div><dt>Failed</dt><dd>{stats.failed}</dd></div>
      <div><dt>Draft PRs</dt><dd>{stats.draftPrs}</dd></div>
    </dl>
    <p>{`Measured credits: ${stats.credits.measured ?? 'Not measured'}. ${stats.credits.unmeasuredTasks} tasks have no recorded credits.`}</p>
    {#if weeks.length}
      <p>{`Week starts: ${range}`}</p>
    {/if}
    <table>
      <caption>Weekly outcomes</caption>
      <thead><tr><th scope="col">Week</th><th scope="col">Completed</th><th scope="col">Credits</th></tr></thead>
      <tbody>
        {#each weeks as week (week.weekStart)}
          <tr><th scope="row">{week.weekStart}</th><td>{week.completed ?? 'Not measured'}</td><td>{week.credits ?? 'Not measured'}</td></tr>
        {/each}
      </tbody>
    </table>
    {#if stats.repositories.length}
      <div class="table-wrap">
        <table>
          <caption>Repository outcomes</caption>
          <thead><tr><th scope="col">Repository</th><th scope="col">Completed</th><th scope="col">Stopped</th><th scope="col">Failed</th><th scope="col">Draft PRs</th></tr></thead>
          <tbody>
            {#each stats.repositories as repo (repo.repoId)}
              <tr>
                <th scope="row">{repo.repoId}</th>
                <td>{repo.completed} <meter aria-label={`Completed tasks for ${repo.repoId}`} min="0" max={largest} value={repo.completed}></meter></td>
                <td>{repo.stopped}</td><td>{repo.failed}</td><td>{repo.draftPrs}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</ReportFrame>

<style>
  dl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 12px; border-bottom: 1px solid #dcd6e6; }
  p { margin: 0; padding: 8px 12px; }
  td, th { border-top: 1px solid #dcd6e6; }
  dl { margin: 0; }
  dd { margin: 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; text-align: left; }
  caption, td, th { padding: 6px 12px; }
  caption { text-align: left; font-weight: 600; }
  .table-wrap { overflow-x: auto; }
  meter { display: block; width: 4rem; }
</style>
