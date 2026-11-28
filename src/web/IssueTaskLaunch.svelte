<script module lang="ts">
  import type { StartTask } from '../shared/api/schemas.js';

  export type StartAttempt = {
    input: StartTask;
    state: 'starting' | 'retry' | 'queued' | 'blocked';
    note?: string;
  };
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { SvelteMap } from 'svelte/reactivity';
  import { opaqueIdSegment } from '../shared/api/opaque-id.js';
  import type { ApiDto } from '../shared/api/schemas.js';
  import { problemCode, readPortal } from './portal-read.js';

  let { issue, connectionId, attempts, lifetime, onAccessLost }: {
    issue: ApiDto<'issue'>['issue'];
    connectionId: string;
    attempts: SvelteMap<string, StartAttempt>;
    lifetime: AbortSignal;
    onAccessLost: (error: unknown) => boolean;
  } = $props();

  const panel = new AbortController();
  const cleanId = new RegExp(`^${opaqueIdSegment}$`);
  const scope = $derived(`${encodeURIComponent(connectionId)}/${encodeURIComponent(issue.key)}`);
  const attempt = $derived(attempts.get(scope));
  const path = $derived(`/api/connections/${encodeURIComponent(connectionId)}`);
  const unavailable = 'Task launch is unavailable for this issue.';
  let account = $state<string>();
  let status = $state('');

  onMount(() => {
    if (issue.launch.available && issue.taskId === null && !attempts.has(scope)) void loadOptions();
    return () => panel.abort();
  });

  async function loadOptions() {
    status = 'Checking task eligibility...';
    try {
      const options = await readPortal<ApiDto<'taskOptions'>>(`${path}/task-options`, panel.signal);
      if (panel.signal.aborted) return;
      if (options.launch.available && options.copilotAccountId && cleanId.test(options.copilotAccountId)) {
        account = options.copilotAccountId;
        status = '';
      } else status = unavailable;
    } catch (error) {
      if (!panel.signal.aborted && !onAccessLost(error)) status = 'Could not check task eligibility. Reopen this issue to try again.';
    }
  }

  async function start(accountId: string) {
    if (attempt && attempt.state !== 'retry') return;
    const input = attempt?.input ?? { workItemKey: issue.key, copilotAccountId: accountId, startRequestId: crypto.randomUUID() };
    const key = scope;
    const url = `${path}/tasks`;
    const pending = { input, state: 'starting' } as const;
    attempts.set(key, pending);
    try {
      const { csrfToken } = await readPortal<ApiDto<'csrf'>>('/api/auth/csrf', panel.signal);
      if (panel.signal.aborted) {
        if (attempts.get(key) === pending) attempts.set(key, { input, state: 'retry' });
        return;
      }
      const receipt = await readPortal<ApiDto<'taskAccepted'>>(url, lifetime, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (receipt.state !== 'queued' || typeof receipt.taskId !== 'string' || !cleanId.test(receipt.taskId)) throw new Error('Unconfirmed receipt');
      if (attempts.get(key) === pending) attempts.set(key, { input, state: 'queued' });
    } catch (error) {
      if (lifetime.aborted || onAccessLost(error) || attempts.get(key) !== pending) return;
      const code = problemCode(error);
      if (code === 'TASK_ALREADY_ACTIVE' || code === 'CAPABILITY_UNAVAILABLE' || code === 'COPILOT_REAUTH_REQUIRED') {
        const note = code === 'TASK_ALREADY_ACTIVE' ? 'A task is already active for this issue.'
          : code === 'COPILOT_REAUTH_REQUIRED' ? 'Reconnect Copilot in Settings before starting a task.' : unavailable;
        attempts.set(key, { input, state: 'blocked', note });
      } else attempts.set(key, { input, state: 'retry' });
    }
  }
</script>

<div class="task-launch">
  {#if attempt?.state === 'queued'}
    <p role="status">Task queued. <a href="/active-sessions">View Active Sessions</a></p>
  {:else if issue.taskId !== null}
    <p class="muted">A task is already linked to this issue.</p>
  {:else if !issue.launch.available}
    <p class="muted">{unavailable}</p>
  {:else if attempt?.state === 'blocked'}
    <p role="status">{attempt.note}</p>
  {:else if attempt?.state === 'starting'}
    <button class="primary" type="button" disabled>Starting task...</button>
  {:else if attempt?.state === 'retry'}
    {@const previousAccount = attempt.input.copilotAccountId}
    <p role="status">Start was not confirmed. Retrying uses the same request.</p>
    <button class="primary" type="button" onclick={() => void start(previousAccount)}>Retry start</button>
  {:else if account}
    {@const selectedAccount = account}
    <button class="primary" type="button" onclick={() => void start(selectedAccount)}>Start task</button>
  {:else}
    <p class="muted" role="status">{status}</p>
  {/if}
</div>

<style>
  .task-launch { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .75rem; border-block-start: 1px solid var(--line); margin-block: .65rem; padding-block-start: .65rem; }
  p { margin: 0; overflow-wrap: anywhere; }
</style>
