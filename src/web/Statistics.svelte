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
    <dl data-numeric>
      <div><dt>Active tasks</dt><dd>{stats.activeTasks}</dd></div>
      <div><dt>Completed</dt><dd>{stats.completed}</dd></div>
      <div><dt>Stopped</dt><dd>{stats.stopped}</dd></div>
      <div><dt>Failed</dt><dd>{stats.failed}</dd></div>
      <div><dt>Draft PRs</dt><dd>{stats.draftPrs}</dd></div>
    </dl>
    <p class="muted">{`Measured credits: ${stats.credits.measured ?? 'Not measured'}. ${stats.credits.unmeasuredTasks} tasks have no recorded credits.`}</p>
    {#if weeks.length}
      <p class="muted">{`Week starts: ${range}`}</p>
    {/if}
    <div class="statistics-grid">
    <div class="table-wrap">
    <table>
      <caption>Weekly outcomes</caption>
      <thead><tr><th scope="col">Week</th><th scope="col">Completed</th><th scope="col">Credits</th></tr></thead>
      <tbody>
        {#each weeks as week (week.weekStart)}
          <tr><th scope="row">{week.weekStart}</th><td>{week.completed ?? 'Not measured'}</td><td>{week.credits ?? 'Not measured'}</td></tr>
        {/each}
      </tbody>
    </table>
    </div>
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
    </div>
  {/if}
</ReportFrame>

<style>
  dl { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem 1.65rem; margin: 0; padding: .8rem 1rem; border-bottom: 1px solid var(--line); background: var(--quiet); }
  dt { color: var(--muted); font-size: .84rem; font-weight: 600; }
  dd { margin: 0; font-size: 1.2rem; font-weight: 700; }
  p { margin: 0; padding: .4rem 1rem; }
  td, th { border-top: 1px solid var(--line); overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; text-align: left; }
  caption, td, th { padding: .45rem .7rem; }
  caption { text-align: left; font-weight: 700; }
  thead { color: var(--muted); background: var(--quiet); font-size: .84rem; }
  .statistics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: .8rem; padding: .6rem 1rem 1rem; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
  meter { display: block; width: 4rem; height: .45rem; }
  meter::-webkit-meter-bar { background: var(--quiet); border: 0; }
  meter::-webkit-meter-optimum-value { background: var(--action); }
  meter::-moz-meter-bar { background: var(--action); }
</style>
