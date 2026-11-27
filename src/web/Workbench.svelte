<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  import type { ApiDto } from '../shared/api/schemas.js';
  import { accessProblem, problemCode, readPortal, requestVersion } from './portal-read.js';

  type Connection = ApiDto<'connections'>['items'][number];
  type Snapshot = ApiDto<'issues'> | ApiDto<'pullRequests'>;
  const readLocation = (url: URL) => {
    const path = url.pathname.split('/');
    return { id: path[2], kind: path[3] === 'pull-requests' ? 'pull-requests' as const : 'issues' as const,
      closed: url.searchParams.get('state') === 'closed' };
  };
  let view = $state(readLocation(new URL(location.href)));
  const kind = $derived(view.kind);
  const closed = $derived(view.closed);
  const filter = $derived(closed ? 'closed' : { issues: 'open', 'pull-requests': 'active' }[kind]);
  const repoPath = (id: string) => `/connections/${encodeURIComponent(id)}`;
  let repos = $state<Connection[]>([]);
  let selected = $state<Connection>();
  let snapshot = $state<Snapshot>();
  let detail = $state<ApiDto<'issue'>>();
  let expanded = $state<string>();
  let alert = $state('');
  let detailAlert = $state('');
  const syncNotes = new SvelteMap<string, string>();
  let busy = $state(true);
  let commentBusy = $state(false);
  let syncing = $state(false);
  const detailVersion = requestVersion();
  const listVersion = requestVersion();
  const viewVersion = requestVersion();
  const origins: Record<string, string> = { mine: 'Mine', other: 'Others', factory: 'Factory', unknown: 'Unknown origin' };
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

  function read<T>(url: string, init?: RequestInit): Promise<T> {
    return readPortal<T>(url, lifetime.signal, init);
  }

  function message(error: unknown) {
    return problems[accessProblem(error) ?? problemCode(error) ?? ''] ?? 'Could not load repository data. Try again.';
  }

  async function list(repo: Connection, cursor?: string) {
    const ticket = listVersion.next();
    const query = new URLSearchParams({ state: filter });
    if (cursor) query.set('cursor', cursor);
    const result = await read<Snapshot>(`/api${repoPath(repo.id)}/${kind}?${query}`);
    if (!listVersion.current(ticket)) return;
    if (cursor && result.items && snapshot?.items) {
      snapshot = { ...result, items: [...snapshot.items, ...result.items] } as Snapshot;
    } else snapshot = result;
  }

  function clearAccess(error: unknown, repo?: Connection) {
    const code = accessProblem(error);
    if (!code) return false;
    if (code === 'AUTH_REQUIRED') repos = [];
    if (!repo || selected?.id === repo.id || code === 'AUTH_REQUIRED') {
      listVersion.next();
      snapshot = undefined;
      closeDetail();
      alert = message(error);
      if (code === 'AUTH_REQUIRED') selected = undefined;
    }
    return true;
  }

  async function run(action: () => Promise<void>, repo?: Connection) {
    const ticket = viewVersion.next();
    busy = true;
    alert = '';
    try { await action(); }
    catch (error) {
      if (!clearAccess(error, repo) && viewVersion.current(ticket)) {
        if (snapshot?.items) snapshot = { ...snapshot, freshness: 'stale' } as Snapshot;
        alert = message(error);
      }
    } finally { if (viewVersion.current(ticket)) busy = false; }
  }

  function closeDetail() {
    detailVersion.next();
    expanded = undefined;
    detail = undefined;
    detailAlert = '';
    commentBusy = false;
  }

  function selectView() {
    selected = view.id ? repos.find((repo) => encodeURIComponent(repo.id) === view.id) : repos[0];
    viewVersion.next();
    listVersion.next();
    closeDetail();
    snapshot = undefined;
    alert = '';
    busy = false;
    const repo = selected;
    if (repo?.state === 'connected') void run(() => list(repo), repo);
  }

  function navigate(event: MouseEvent) {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const link = event.currentTarget as HTMLAnchorElement;
    const url = new URL(link.href);
    history.pushState(null, '', url);
    view = readLocation(url);
    selectView();
  }

  function restoreView() {
    view = readLocation(new URL(location.href));
    selectView();
  }

  onMount(() => {
    void run(async () => {
      repos = (await read<ApiDto<'connections'>>('/api/connections')).items;
      selectView();
    });
    return () => lifetime.abort();
  });

  async function readIssue(repo: Connection, key: string, cursor?: string) {
    const version = detailVersion.next();
    commentBusy = true;
    detailAlert = '';
    try {
      const query = cursor ? `?${new URLSearchParams({ commentCursor: cursor })}` : '';
      const response = await read<ApiDto<'issue'>>(`/api${repoPath(repo.id)}/issues/${encodeURIComponent(key)}${query}`);
      if (detailVersion.current(version)) {
        detail = cursor && detail ? {
          ...detail, comments: { ...response.comments, items: [...detail.comments.items, ...response.comments.items] },
        } : response;
      }
    } catch (error) {
      if (!clearAccess(error, repo) && detailVersion.current(version)) detailAlert = message(error);
    } finally {
      if (detailVersion.current(version)) commentBusy = false;
    }
  }

  function openIssue(repo: Connection, key: string) {
    const wasOpen = expanded === key;
    closeDetail();
    if (wasOpen) return;
    expanded = key;
    void readIssue(repo, key);
  }

  function providerMarkup(body: ApiDto<'issue'>['description']) {
    const html = body.format === 'markdown' ? marked.parse(body.content, { async: false }) : body.content;
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
      ALLOWED_ATTR: ['href', 'title'], ALLOWED_URI_REGEXP: /^https?:\/\//i, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    });
  }

  async function sync(repo: Connection) {
    closeDetail();
    syncing = true;
    syncNotes.set(repo.id, 'Sync requested.');
    try {
      const { csrfToken } = await read<ApiDto<'csrf'>>('/api/auth/csrf');
      const { operationId } = await read<ApiDto<'operationAccepted'>>(`/api${repoPath(repo.id)}/sync`, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
      });
      for (let attempt = 0; attempt < 30; attempt++) {
        const operation = await read<ApiDto<'operation'>>(`/api/operations/${encodeURIComponent(operationId)}`);
        const note = syncStates[operation.state];
        if (note) {
          syncNotes.set(repo.id, note);
          if (selected?.id === repo.id) await run(() => list(repo), repo);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        lifetime.signal.throwIfAborted();
      }
      syncNotes.set(repo.id, 'Sync is still running. Refresh the list to check for new records.');
    } catch (error) {
      if (clearAccess(error, repo)) syncNotes.delete(repo.id);
      else syncNotes.set(repo.id, 'Sync could not be checked. Refresh the list or retry Sync.');
    } finally { syncing = false; }
  }
</script>

<svelte:window onpopstate={restoreView} />
{#snippet providerText(body: ApiDto<'issue'>['description'])}
  {#if body.format === 'text'}<p class="description">{body.content}</p>
  {:else}<div class="description">{@html providerMarkup(body)}</div>{/if}
{/snippet}

<section class="workbench" aria-labelledby="repository-heading">
  <div class="heading">
    <h2 id="repository-heading">Repositories</h2>
    <a href="/settings/factory">Manage connections</a>
  </div>
  {#if repos.length}
    <nav aria-label="Repositories" class="repos">
      {#each repos as repo (repo.id)}
        <a onclick={navigate} href={`${repoPath(repo.id)}/issues?state=open`} aria-current={repo.id === selected?.id ? 'page' : undefined}>{repo.name}</a>
      {/each}
    </nav>
  {/if}
  {#if selected?.state === 'connected'}
    {@const repo = selected}
    {@const syncNote = syncNotes.get(repo.id)}
    <div class="toolbar">
      <nav aria-label="Repository views">
        <a onclick={navigate} href={`${repoPath(repo.id)}/issues?state=open`} aria-current={filter === 'open' ? 'page' : undefined}>Open issues</a>
        <a onclick={navigate} href={`${repoPath(repo.id)}/issues?state=closed`} aria-current={closed && kind === 'issues' ? 'page' : undefined}>Closed issues</a>
        <a onclick={navigate} href={`${repoPath(repo.id)}/pull-requests?state=active`} aria-current={filter === 'active' ? 'page' : undefined}>Active PRs</a>
        <a onclick={navigate} href={`${repoPath(repo.id)}/pull-requests?state=closed`} aria-current={closed && kind === 'pull-requests' ? 'page' : undefined}>Closed PRs</a>
      </nav>
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => { closeDetail(); void run(() => list(repo), repo); }}>Refresh list</button>
        <button type="button" disabled={busy || syncing} onclick={() => void sync(repo)}>Sync</button>
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
              <span class="meta">{`#${row.key}`}</span>
              {#if 'sourceBranch' in row}
                <a href={row.url} target="_blank" rel="noreferrer">{row.title}</a>
                <span class="meta">{`${row.sourceBranch} to ${row.targetBranch}`}</span>
                <span class="meta">{origins[row.origin]}</span>
                {#if row.draft}<span class="meta">Draft</span>{/if}
                {#if row.state === 'merged'}<span class="meta">Merged</span>{:else if row.state === 'closed'}<span class="meta">Closed without merge</span>{/if}
                <span class="meta">{row.checks?.total == null ? 'Checks unavailable' : row.checks.total === 0 ? 'No checks' : `${row.checks.passed}/${row.checks.total} passed`}</span>
              {:else}
                <button class="title" type="button" aria-expanded={expanded === row.key} onclick={() => void openIssue(repo, row.key)}>{row.title}</button>
                <span class="meta">{row.author?.displayName ?? 'Unknown author'}</span>
                <time class="meta" datetime={row.createdAt}>{row.createdAt.slice(0, 10)}</time>
                <span class="meta">{row.assignees.map((person) => person.displayName).join(', ') || 'Unassigned'}</span>
              {/if}
            </div>
            {#if expanded === row.key}
              <div class="evidence">
                <a href={row.url}>View source issue</a>
                {#if detail}
                  {@render providerText(detail.description)}
                  {#each detail.comments.items as comment (comment.id)}
                    {@render providerText(comment.body)}
                  {/each}
                  {#if detail.comments.nextCursor}
                    {@const cursor = detail.comments.nextCursor}
                    <button type="button" disabled={commentBusy} onclick={() => void readIssue(repo, row.key, cursor)}>Load more comments</button>
                  {/if}
                {:else if !detailAlert}
                  <p role="status">Loading issue details...</p>
                {/if}
                {#if detailAlert}<p role="alert">{detailAlert}</p>{/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if snapshot.nextCursor}
        {@const cursor = snapshot.nextCursor}
        <button type="button" disabled={busy} onclick={() => void run(() => list(repo, cursor), repo)}>Load more</button>
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
