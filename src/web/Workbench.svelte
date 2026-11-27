<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiDto } from '../shared/api/schemas.js';

  type Connection = ApiDto<'connections'>['items'][number];
  type Snapshot = ApiDto<'issues'> | ApiDto<'pullRequests'>;
  const path = location.pathname.split('/');
  const kind = path[3] === 'pull-requests' ? 'pull-requests' : 'issues';
  const closed = new URLSearchParams(location.search).get('state') === 'closed';
  const filter = closed ? 'closed' : { issues: 'open', 'pull-requests': 'active' }[kind];
  const repoPath = (id: string) => `/connections/${encodeURIComponent(id)}`;
  let repos = $state<Connection[]>([]);
  let selected = $state<Connection>();
  let snapshot = $state<Snapshot>();
  let detail = $state<ApiDto<'issue'>>();
  let expanded = $state<string>();
  let alert = $state('');
  let detailAlert = $state('');
  let syncNote = $state('');
  let busy = $state(true);
  let detailVersion = 0;
  const lifetime = new AbortController();
  const problems: Record<string, string> = {
    AUTH_REQUIRED: 'Signed out. Use Setup and settings to sign in.',
    ACCESS_DENIED: 'Repository access was denied. Reconnect it in Settings.',
    ACCESS_UNVERIFIED: 'Repository access could not be verified. Try Sync to check it again.',
    SNAPSHOT_CHANGED: 'The snapshot changed. Refresh the list to continue.',
  };
  const syncStates: Record<string, string> = {
    completed: 'Sync complete.', partial: 'Sync partially completed. Check each list for freshness.',
    failed: 'Sync failed. Try again or check repository access.', needs_recovery: 'Sync needs recovery. Try again later.',
  };

  async function read<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: lifetime.signal });
    if (response.status === 401) throw new Error(problems['AUTH_REQUIRED']);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string };
      throw new Error(problems[body.code ?? ''] ?? 'Could not load repository data. Try again.');
    }
    return await response.json() as T;
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : 'Could not load repository data. Try again.';
  }

  async function list(repo: Connection, cursor?: string) {
    const query = new URLSearchParams({ state: filter });
    if (cursor) query.set('cursor', cursor);
    const result = await read<Snapshot>(`/api${repoPath(repo.id)}/${kind}?${query}`);
    if (cursor && result.items && snapshot?.items) {
      snapshot = { ...result, items: [...snapshot.items, ...result.items] } as Snapshot;
    } else snapshot = result;
  }

  async function run(action: () => Promise<void>) {
    busy = true;
    alert = '';
    try { await action(); }
    catch (error) {
      snapshot = undefined;
      closeDetail();
      alert = message(error);
    } finally { busy = false; }
  }

  function closeDetail() {
    detailVersion++;
    expanded = undefined;
    detail = undefined;
    detailAlert = '';
  }

  onMount(() => {
    void run(async () => {
      repos = (await read<ApiDto<'connections'>>('/api/connections')).items;
      selected = path[1] === 'connections' && path[2] ? repos.find((repo) => encodeURIComponent(repo.id) === path[2]) : repos[0];
      if (selected?.state === 'connected') await list(selected);
    });
    return () => lifetime.abort();
  });

  async function openIssue(repo: Connection, key: string) {
    const wasOpen = expanded === key;
    closeDetail();
    if (wasOpen) return;
    expanded = key;
    const version = detailVersion;
    try {
      const response = await read<ApiDto<'issue'>>(`/api${repoPath(repo.id)}/issues/${encodeURIComponent(key)}`);
      if (version === detailVersion) detail = response;
    } catch (error) {
      if (version === detailVersion) detailAlert = message(error);
    }
  }

  function sync(repo: Connection) {
    closeDetail();
    syncNote = 'Sync requested.';
    void run(async () => {
      const { csrfToken } = await read<ApiDto<'csrf'>>('/api/auth/csrf');
      const { operationId } = await read<ApiDto<'operationAccepted'>>(`/api${repoPath(repo.id)}/sync`, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
      });
      for (let attempt = 0; attempt < 30; attempt++) {
        const operation = await read<ApiDto<'operation'>>(`/api/operations/${encodeURIComponent(operationId)}`);
        const note = syncStates[operation.state];
        if (note) {
          syncNote = note;
          await list(repo);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        lifetime.signal.throwIfAborted();
      }
      syncNote = 'Sync is still running. Refresh the list to check for new records.';
    });
  }
</script>

<section class="workbench" aria-labelledby="repository-heading">
  <div class="heading">
    <h2 id="repository-heading">Repositories</h2>
    <a href="/settings/factory">Manage connections</a>
  </div>
  {#if repos.length}
    <nav aria-label="Repositories" class="repos">
      {#each repos as repo (repo.id)}
        <a href={`${repoPath(repo.id)}/issues?state=open`} aria-current={repo.id === selected?.id ? 'page' : undefined}>{repo.name}</a>
      {/each}
    </nav>
  {/if}
  {#if selected?.state === 'connected'}
    {@const repo = selected}
    <div class="toolbar">
      <nav aria-label="Repository views">
        <a href={`${repoPath(repo.id)}/issues?state=open`} aria-current={filter === 'open' ? 'page' : undefined}>Open issues</a>
        <a href={`${repoPath(repo.id)}/issues?state=closed`} aria-current={closed && kind === 'issues' ? 'page' : undefined}>Closed issues</a>
        <a href={`${repoPath(repo.id)}/pull-requests?state=active`} aria-current={filter === 'active' ? 'page' : undefined}>Active PRs</a>
        <a href={`${repoPath(repo.id)}/pull-requests?state=closed`} aria-current={closed && kind === 'pull-requests' ? 'page' : undefined}>Closed PRs</a>
      </nav>
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => { closeDetail(); void run(() => list(repo)); }}>Refresh list</button>
        <button type="button" disabled={busy} onclick={() => sync(repo)}>Sync</button>
      </div>
    </div>
    {#if syncNote}<p role="status">{syncNote}</p>{/if}
    {#if snapshot?.fetchedAt}
      <p class="freshness">{snapshot.freshness === 'stale' ? 'Stale snapshot' : 'Last synced'}: <time datetime={snapshot.fetchedAt}>{snapshot.fetchedAt}</time></p>
    {/if}
    {#if snapshot?.items?.length}
      <ul class="records">
        {#each snapshot.items as row (row.key)}
          <li class:expanded={expanded === row.key}>
            <div class="row">
              <span class="meta">#{row.key}</span>
              {#if 'sourceBranch' in row}
                <a href={row.url}>{row.title}</a>
                <span class="meta">{row.sourceBranch} to {row.targetBranch}</span>
              {:else}
                <button class="title" type="button" aria-expanded={expanded === row.key} onclick={() => void openIssue(repo, row.key)}>{row.title}</button>
              {/if}
              <span class="meta">{row.state}</span>
            </div>
            {#if expanded === row.key}
              <div class="evidence">
                <a href={row.url}>View source issue</a>
                {#if detail}
                  <p class="description">{detail.description.content}</p>
                  {#each detail.comments.items as comment (comment.id)}
                    <p class="description">{comment.body.content}</p>
                  {/each}
                {:else if detailAlert}
                  <p role="alert">{detailAlert}</p>
                {:else}
                  <p role="status">Loading issue details...</p>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if snapshot.nextCursor}
        {@const cursor = snapshot.nextCursor}
        <button type="button" disabled={busy} onclick={() => void run(() => list(repo, cursor))}>Load more</button>
      {/if}
    {:else if snapshot?.items}
      <p>No records match this view.</p>
    {:else if snapshot}
      <p>{snapshot.freshness === 'not_synced' ? 'Sync to load issues and pull requests.' : 'This source is unavailable. Try Sync again.'}</p>
    {/if}
  {:else if selected}
    <p>This connection needs attention. Open Settings to reconnect it.</p>
  {:else if !busy && !alert}
    <p>No repository selected. Choose a repository or connect one in Settings.</p>
  {/if}
  {#if alert}<p role="alert">{alert}</p>{/if}
  {#if busy}<p role="status">Loading repository data...</p>{/if}
</section>

<style>
  .workbench { background: #fff; border: 1px solid #dcd6e6; border-radius: 4px; min-width: 0; }
  .heading, .toolbar, .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .heading, .toolbar { justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #dcd6e6; }
  h2 { margin: 0; font-size: 15px; }
  nav, .actions { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .repos { padding: 6px 12px; background: #f4f0f9; }
  nav a { padding: 4px 8px; }
  .repos [aria-current] { background: #e6dcf8; font-weight: 600; border-radius: 4px; }
  .toolbar [aria-current] { border-bottom: 2px solid #5933a1; font-weight: 600; }
  a { color: #165f9b; text-underline-offset: 2px; }
  button { font: inherit; color: #211c2c; background: #fff; border: 1px solid #8b8098; border-radius: 4px; padding: 3px 8px; min-height: 28px; }
  button:disabled { color: #665c70; background: #f4f0f9; }
  button:not(:disabled):hover { background: #f4f0f9; }
  a:focus-visible, button:focus-visible { outline: 2px solid #165f9b; outline-offset: 2px; }
  .records { list-style: none; padding: 0; margin: 0; }
  .records li { border-top: 1px solid #dcd6e6; }
  .row { padding: 4px 12px; min-height: 30px; overflow-wrap: anywhere; }
  .title { font-weight: 600; border-color: transparent; background: transparent; text-align: left; }
  .expanded { background: #f0e9fb; }
  .evidence { margin: 0 12px 8px; padding: 8px 12px; background: #fff; border: 1px solid #dcd6e6; border-radius: 4px; }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; padding-inline: 0; }
  .meta, .freshness { color: #60566c; font-size: 12px; }
  p { margin: 0; padding: 6px 12px; }
  section > button { margin: 8px 12px; }
</style>
