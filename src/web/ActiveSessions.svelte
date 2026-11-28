<script lang="ts">
  import type { ApiDto } from '../shared/api/schemas.js';
  import { readPortal, requestVersion } from './portal-read.js';
  import { readReport } from './report-read.svelte.js';
  import ReportFrame from './ReportFrame.svelte';

  type Session = ApiDto<'activeSessions'>['sessions'][number];
  const attention = ['waiting_input', 'needs_auth', 'needs_recovery'] as const;
  const labels: Record<Session['state'], string> = {
    waiting_input: 'Needs your answer', needs_auth: 'Reconnect required', needs_recovery: 'Needs recovery',
    queued: 'Queued', starting: 'Starting', running: 'Running', publishing: 'Publishing',
    stopping: 'Stopping', unverified: 'Unverified',
  };
  const cloudLabels = new Map([
    ['queued', 'Queued'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['failed', 'Failed'],
    ['idle', 'Idle'], ['waiting_for_user', 'Waiting for you'], ['timed_out', 'Timed out'], ['cancelled', 'Cancelled'],
  ]);
  const cloudUnavailable = 'GitHub status unavailable.';
  const usageLabels = new Map([['ai_credits', 'AI credits'], ['premium_requests', 'premium requests']]);
  const sections = [true, false] as const;
  const initial = new URLSearchParams(location.search);
  let repository = $state(initial.get('repository') ?? '');
  let status = $state(initial.get('status') ?? '');
  let detail = $state<ApiDto<'task'>>();
  let taskId = $state('');
  let detailNote = $state('');
  let cloudNote = $state('');
  let cloudUsage = $state<ApiDto<'cloudTaskStatus'>['usage']>();
  let checkingCloud = $state(false);
  const detailVersion = requestVersion();
  const report = readReport<'activeSessions'>('/api/active-sessions', 'Active Sessions are unavailable. Try again later.', closeTask);
  const results = $derived(report.data);
  const repositories = $derived(new Map(results?.repositories.map((repo) => [repo.id, repo.name])));
  const effectiveRepository = $derived(repositories.has(repository) ? repository : '');
  const effectiveStatus = $derived(Object.hasOwn(labels, status) ? status : '');
  const scoped = $derived((results?.sessions ?? []).filter((session) => !effectiveRepository || session.repoId === effectiveRepository));
  const visible = $derived(scoped.filter((session) => !effectiveStatus || session.state === effectiveStatus));
  const counts = $derived(attention.map((state) => ({ state, count: scoped.filter((session) => session.state === state).length })));
  const isAttention = (session: Session) => attention.some((state) => state === session.state);
  function clearCloud() {
    cloudNote = '';
    cloudUsage = undefined;
    checkingCloud = false;
  }

  function closeTask() {
    taskId = '';
    detailVersion.next();
    detail = undefined;
    detailNote = '';
    clearCloud();
  }

  function updateFilters() {
    const query = new URLSearchParams({ repository: effectiveRepository, status: effectiveStatus });
    for (const name of ['repository', 'status']) {
      if (!query.get(name)) query.delete(name);
    }
    const search = query.toString();
    history.replaceState(history.state, '', `/active-sessions${search ? `?${search}` : ''}`);
  }

  async function viewTask(id: string) {
    const closed = taskId === id;
    const version = detailVersion.next();
    taskId = closed ? '' : id;
    detail = undefined;
    detailNote = '';
    clearCloud();
    if (closed) return;
    try {
      const result = await readPortal<ApiDto<'task'>>(`/api/tasks/${encodeURIComponent(id)}`, report.signal);
      if (detailVersion.current(version)) detail = result;
    } catch (error) {
      if (!report.clearAccess(error) && detailVersion.current(version)) detailNote = 'Task details are unavailable.';
    }
  }

  async function checkCloudStatus(id: string) {
    if (checkingCloud) return;
    const version = detailVersion.next();
    checkingCloud = true;
    cloudNote = 'Checking GitHub status...';
    cloudUsage = undefined;
    try {
      const { state, usage } = await readPortal<ApiDto<'cloudTaskStatus'>>(`/api/tasks/${encodeURIComponent(id)}/cloud-status`, report.signal);
      if (!detailVersion.current(version)) return;
      const label = cloudLabels.get(state ?? '');
      cloudNote = label ? `GitHub status: ${label}` : cloudUnavailable;
      cloudUsage = usage;
    } catch (error) {
      if (!report.clearAccess(error) && detailVersion.current(version)) cloudNote = cloudUnavailable;
    } finally {
      if (detailVersion.current(version)) checkingCloud = false;
    }
  }

</script>

<ReportFrame title="Active Sessions" {report}>
  {#if results}
    <div class="attention" role="group" aria-label="Attention filters">
      {#each counts as { state, count } (state)}
        <button type="button" aria-pressed={effectiveStatus === state} class:question={state === 'waiting_input' && count > 0}
          onclick={() => { status = state; updateFilters(); }}>{`${labels[state]} ${count}`}</button>
      {/each}
    </div>
    <div class="filters">
      <div class="filter">
        <label for="report-repository">Repository</label>
        <select id="report-repository" bind:value={() => effectiveRepository, (value) => { repository = value; updateFilters(); }}>
          <option value="">All repositories</option>
          {#each results.repositories as repo (repo.id)}
            <option value={repo.id}>{repo.name}</option>
          {/each}
        </select>
      </div>
      <div class="filter">
        <label for="report-status">Status</label>
        <select id="report-status" bind:value={() => effectiveStatus, (value) => { status = value; updateFilters(); }}>
          <option value="">All statuses</option>
          {#each Object.entries(labels) as [state, label] (state)}
            <option value={state}>{label}</option>
          {/each}
        </select>
      </div>
      <span class="result-count muted" data-numeric>{`${visible.length} of ${scoped.length} sessions`}</span>
    </div>
    {#if !visible.length}
      <div class="state-panel"><p class="state-heading">{scoped.length ? 'No sessions match this status.' : 'No active sessions in this repository scope.'}</p></div>
    {/if}
    {#each sections as priority (priority)}
      {@const rows = visible.filter((session) => isAttention(session) === priority)}
      {#if rows.length}
        <h3>{priority ? 'Needs attention' : 'Other sessions'}</h3>
        <ul>
          {#each rows as session (session.taskId)}
            <li>
              <div class="session">
                <span class="muted">{repositories.get(session.repoId)}</span>
                <strong>{`#${session.workItemKey} ${session.title ?? 'Untitled task'}`}</strong>
                <span class="chip">{labels[session.state]}</span>
                {#if session.issueUrl}<a href={session.issueUrl}>View issue</a>{/if}
                <button type="button" aria-expanded={taskId === session.taskId} onclick={() => void viewTask(session.taskId)}>View task</button>
              </div>
              {#if taskId === session.taskId}
                <div class="inset">
                  {#if detail}
                    <p>{`Task state: ${detail.task.state}`}</p>
                    {#if detail.pendingQuestion}<p>{detail.pendingQuestion.text}</p>{/if}
                    {#if detail.sessionUrl}
                      <p><a href={detail.sessionUrl} target="_blank" rel="noreferrer">Open in GitHub Copilot</a></p>
                    {/if}
                    {#if detail.cloudStatusAvailable}
                      <div class="cloud-status">
                        <button type="button" disabled={checkingCloud} onclick={() => void checkCloudStatus(session.taskId)}>Check GitHub status</button>
                        <span class="muted" role="status">{cloudNote}</span>
                        {#if cloudUsage}
                          <span class="muted">{`GitHub-reported usage: ${cloudUsage.amount} ${usageLabels.get(cloudUsage.unit)}`}</span>
                        {/if}
                      </div>
                    {/if}
                    {#if detail.sdkUsage}
                      <p>
                        Last usage sample:
                        {detail.sdkUsage.nanoAiu === null ? 'AI units not measured' : `${detail.sdkUsage.nanoAiu} nano-AI units`};
                        {detail.sdkUsage.premiumRequests === null ? 'premium requests not measured' : `${detail.sdkUsage.premiumRequests} premium requests`}.
                        <time datetime={detail.sdkUsage.observedAt}>{detail.sdkUsage.observedAt}</time>
                      </p>
                    {/if}
                  {:else}
                    <p role="status">{detailNote || 'Loading task details...'}</p>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
  {/if}
</ReportFrame>

<style>
  .attention, .filters, .session { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem 1rem; min-width: 0; }
  .filter { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; min-width: 0; }
  .filter select { min-width: 0; }
  .filter label { color: var(--muted); font-weight: 600; }
  .attention, .filters { padding: .65rem 1rem; border-bottom: 1px solid var(--line); }
  .attention { background: var(--quiet); }
  .result-count { margin-inline-start: auto; font-size: .88rem; }
  h3 { margin: 0; font-size: .94rem; padding: .55rem 1rem; background: var(--rail); }
  button.question { color: var(--question); background: var(--question-surface); }
  button[aria-pressed="true"] { color: var(--action-hover); background: var(--selection); border-color: var(--action); }
  .inset p { margin: 0; padding: .55rem .8rem; }
  .cloud-status { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .75rem; padding: .2rem .8rem .55rem; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { border-top: 1px solid var(--line); }
  .session { padding: .55rem 1rem; overflow-wrap: anywhere; }
  .session strong { flex: 1 1 12rem; }
  .inset { margin: 0 1rem .75rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--quiet); }
</style>
