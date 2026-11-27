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

  function rememberView(url: URL) {
    if (url.pathname.startsWith('/connections/')) sessionStorage.setItem('factory.last-workbench', `${url.pathname}${url.search}`);
  }

  function navigate(event: MouseEvent) {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const link = event.currentTarget as HTMLAnchorElement;
    const url = new URL(link.href);
    history.pushState(null, '', url);
    rememberView(url);
    view = readLocation(url);
    selectView();
  }

  function restoreView() {
    const url = new URL(location.href);
    rememberView(url);
    view = readLocation(url);
    selectView();
  }

  onMount(() => {
    const id = view.id;
    if (id) sessionStorage.setItem('factory.last-workbench', `/connections/${id}/${kind}?state=${filter}`);
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

<section class="workbench sheet" aria-labelledby="repository-heading">
  <div class="heading">
    <div>
      <h2 class="sheet-title" id="repository-heading">Repositories</h2>
      <p class="muted">Triage issues and review pull requests across your connected repositories.</p>
    </div>
    <a class="control-link" href="/settings/factory">Manage connections</a>
  </div>
  {#if repos.length}
    <nav aria-label="Repositories" class="repos">
      {#each repos as repo (repo.id)}
        <a onclick={navigate} href={`${repoPath(repo.id)}/issues?state=open`} aria-current={repo.id === selected?.id ? 'page' : undefined}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h13v13H7a2 2 0 0 0 0 4h11m-13-2V6a2 2 0 0 1 2-2m2 4h5"/></svg>
          {repo.name}
        </a>
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
        <button class="primary" type="button" disabled={busy || syncing} onclick={() => void sync(repo)}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5v5h-5M4 19v-5h5m-4.1-4a7.5 7.5 0 0 1 12.7-3L20 10M4 14l2.4 3a7.5 7.5 0 0 0 12.7-3"/></svg>
          Sync
        </button>
      </div>
    </div>
    {#if syncNote}<p class="notice" role="status">{syncNote}</p>{/if}
    {#if snapshot?.fetchedAt}
      <p class="freshness">{snapshot.freshness === 'stale' ? 'Stale snapshot' : 'Last synced'}: <time datetime={snapshot.fetchedAt}>{snapshot.fetchedAt.replace('T', ' ').slice(0, 19)} UTC</time></p>
    {/if}
    {#if snapshot?.items?.length}
      <div class:issue-columns={kind === 'issues'} class="register-head" aria-hidden="true">
        <span>Ref.</span><span>{kind === 'issues' ? 'Issue' : 'Pull request'}</span>
        {#if kind === 'issues'}<span>Author</span><span>Opened</span><span>Assigned to</span>
        {:else}<span>Branch</span><span>Details</span><span>Checks</span>{/if}
      </div>
      <ul class="records" aria-label="Repository records">
        {#each snapshot.items as row (row.key)}
          <li class:expanded={expanded === row.key}>
            <div class="row" class:issue-columns={kind === 'issues'}>
              <span class="record-ref">{`#${row.key}`}</span>
              {#if 'sourceBranch' in row}
                <a class="pr-title" href={row.url} target="_blank" rel="noreferrer">{row.title}</a>
                <span class="meta">{`${row.sourceBranch} to ${row.targetBranch}`}</span>
                <div class="badges">
                  <span class="chip">{origins[row.origin]}</span>
                  {#if row.draft}<span class="chip">Draft</span>{/if}
                  {#if row.state === 'merged'}<span class="chip">Merged</span>{:else if row.state === 'closed'}<span class="chip">Closed without merge</span>{/if}
                </div>
                <span class="meta" data-numeric>{row.checks?.total == null ? 'Checks unavailable' : row.checks.total === 0 ? 'No checks' : `${row.checks.passed}/${row.checks.total} passed`}</span>
              {:else}
                <button class="title" type="button" aria-expanded={expanded === row.key} onclick={() => void openIssue(repo, row.key)}>
                  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>
                  <span>{row.title}</span>
                </button>
                <span class="meta"><span class="metadata-term">Author: </span>{row.author?.displayName ?? 'Unknown author'}</span>
                <span class="meta"><span class="metadata-term">Opened: </span><time datetime={row.createdAt}>{row.createdAt.slice(0, 10)}</time></span>
                <span class="meta"><span class="metadata-term">Assigned to: </span>{row.assignees.map((person) => person.displayName).join(', ') || 'Unassigned'}</span>
              {/if}
            </div>
            {#if expanded === row.key}
              <div class="evidence">
                <header class="evidence-heading"><strong>Issue details</strong><a href={row.url}>View source issue</a></header>
                {#if detail}
                  {@render providerText(detail.description)}
                  {#each detail.comments.items as comment (comment.id)}
                    <div class="comment">{@render providerText(comment.body)}</div>
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
      <div class="state-panel"><p class="state-heading">No records match this view.</p><p class="muted">Try another tab or Sync to check for new activity.</p></div>
    {:else if snapshot}
      <div class="state-panel"><p class="state-heading">{snapshot.freshness === 'not_synced' ? 'Sync to load issues and pull requests.' : 'This source is unavailable. Try Sync again.'}</p></div>
    {/if}
  {:else if selected}
    <div class="state-panel"><p class="state-heading">This connection needs attention. Open Settings to reconnect it.</p><a href="/settings/factory">Open Settings</a></div>
  {:else if !busy && !alert}
    <div class="state-panel"><p class="state-heading">No repository selected. Choose a repository or connect one in Settings.</p><a href="/settings/factory">Connect a repository</a></div>
  {/if}
  {#if alert}<div class="state-panel"><p class="notice" role="alert">{alert}</p></div>{/if}
  {#if busy}<p class="notice" role="status">Loading repository data...</p>{/if}
</section>

<style>
  .heading, .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .7rem 1rem; padding: .8rem 1rem; border-bottom: 1px solid var(--line); }
  .heading p { margin: .25rem 0 0; }
  nav, .actions, .badges { display: flex; flex-wrap: wrap; gap: .3rem .5rem; align-items: center; }
  .repos { padding: .5rem 1rem; background: var(--quiet); border-bottom: 1px solid var(--line); }
  nav a { display: inline-flex; gap: .4rem; align-items: center; padding: .35rem .55rem; min-height: 32px; color: var(--muted); text-decoration: none; overflow-wrap: anywhere; }
  nav a:hover, nav [aria-current] { color: var(--action-hover); background: var(--selection); font-weight: 600; }
  .repos a { border-radius: var(--radius); }
  .toolbar [aria-current] { box-shadow: inset 0 -2px var(--action); }
  svg { width: 16px; height: 16px; flex: none; }
  .records { list-style: none; padding: 0; margin: 0; }
  .records li { border-top: 1px solid var(--line); }
  .row, .register-head { display: grid; align-items: center; grid-template-columns: 3.2rem minmax(0, 2fr) minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, .9fr); gap: .4rem .8rem; padding: .5rem 1rem; overflow-wrap: anywhere; }
  .issue-columns { grid-template-columns: 3.2rem minmax(0, 2.4fr) minmax(0, 1fr) minmax(0, .9fr) minmax(0, 1fr); }
  .register-head { background: var(--quiet); color: var(--muted); font-size: .82rem; font-weight: 650; }
  .record-ref { color: var(--muted); font: .88rem/1.5 var(--mono); }
  .title, .pr-title { font-weight: 700; }
  .title { display: flex; gap: .35rem; align-items: center; min-width: 0; padding-inline: 0 .4rem; border-color: transparent; background: transparent; text-align: left; }
  .title span { min-width: 0; overflow-wrap: anywhere; }
  .title svg { transition: transform 160ms ease-out; color: var(--action); }
  .title[aria-expanded='true'] svg { transform: rotate(90deg); }
  .expanded { background: var(--selection); }
  .evidence { margin: 0 1rem .7rem; padding: .75rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
  .evidence-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem 1rem; padding-block-end: .45rem; border-block-end: 1px solid var(--line); }
  .description { max-inline-size: 72ch; overflow-wrap: anywhere; margin-block: .6rem; }
  p.description { white-space: pre-wrap; }
  .description :global(p), .description :global(ul), .description :global(ol) { margin-block: .5rem; }
  .description :global(pre), .description :global(table) { display: block; max-width: 100%; overflow-x: auto; }
  .comment { border-block-start: 1px solid var(--line); }
  .meta, .freshness { color: var(--muted); font-size: .86rem; }
  .metadata-term { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
  .freshness { margin: 0; padding: .45rem 1rem; }
  section > button { margin: .65rem 1rem; }
  @media (max-width: 955px) {
    .register-head { display: none; }
    .row { display: flex; flex-wrap: wrap; }
    .title, .pr-title { flex: 1 0 calc(100% - 5rem); }
    .metadata-term { position: static; width: auto; height: auto; clip-path: none; font-weight: 600; }
  }
  @media (prefers-reduced-motion: reduce) { .title svg { transition: none; } }
</style>
