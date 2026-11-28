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
  const fieldId = $props.id();
  const cleanId = new RegExp(`^${opaqueIdSegment}$`);
  const scope = $derived(`${encodeURIComponent(connectionId)}/${encodeURIComponent(issue.key)}`);
  const attempt = $derived(attempts.get(scope));
  const path = $derived(`/api/connections/${encodeURIComponent(connectionId)}`);
  const unavailable = 'Task launch is unavailable for this issue.';
  let account = $state<string>();
  let status = $state('');
  let canConfigure = $state(false);
  let configured = $state(false);
  let models = $state<ApiDto<'taskOptions'>['models']['items']>();
  let modelNote = $state('');
  let modelId = $state('');
  let effort = $state('');
  const selectedModel = $derived(models?.find((model) => model.id === modelId));

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
        canConfigure = options.modelPicker === true;
        status = '';
      } else status = unavailable;
    } catch (error) {
      if (!panel.signal.aborted && !onAccessLost(error)) status = 'Could not check task eligibility. Reopen this issue to try again.';
    }
  }

  async function toggleModels(accountId: string) {
    configured = !configured;
    if (!configured || models || modelNote === 'Loading models...') return;
    modelNote = 'Loading models...';
    try {
      const options = await readPortal<ApiDto<'taskOptions'>>(`${path}/task-options?includeModels=1`, panel.signal);
      if (panel.signal.aborted) return;
      if (options.copilotAccountId === accountId && options.models.availability.available) {
        models = options.models.items;
        modelNote = models.length ? '' : 'No models are approved for this account.';
      } else modelNote = 'Models are unavailable. You can still start with defaults.';
    } catch (error) {
      if (!panel.signal.aborted && !onAccessLost(error)) modelNote = 'Could not load models. Close and reopen configuration to retry.';
    }
  }

  async function start(accountId: string, overrides?: StartTask['overrides']) {
    if (attempt && attempt.state !== 'retry') return;
    const input = attempt?.input ?? {
      workItemKey: issue.key, copilotAccountId: accountId, startRequestId: crypto.randomUUID(),
      ...(overrides && { overrides }),
    };
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
    {#if canConfigure}
      <button type="button" aria-expanded={configured} onclick={() => void toggleModels(selectedAccount)}>
        {configured ? 'Hide configuration' : 'Configure model'}
      </button>
    {/if}
    {#if configured}
      <div class="model-options">
        {#if modelNote}<p class="muted" role="status">{modelNote}</p>{/if}
        {#if models?.length}
          <div class="model-field">
            <label for={`${fieldId}-model`}>Model</label>
            <select id={`${fieldId}-model`} bind:value={modelId} onchange={() => { effort = ''; }}>
              <option value="">Choose a model</option>
              {#each models as model (model.id)}<option value={model.id}>{model.name}</option>{/each}
            </select>
          </div>
          {#if selectedModel?.supportedEfforts.length}
            <div class="model-field">
              <label for={`${fieldId}-effort`}>Reasoning effort</label>
              <select id={`${fieldId}-effort`} bind:value={effort}>
                <option value="">Model default</option>
                {#each selectedModel.supportedEfforts as choice}<option value={choice}>{choice}</option>{/each}
              </select>
            </div>
          {/if}
          <button type="button" disabled={!selectedModel} onclick={() => void start(selectedAccount, {
            model: modelId, ...(effort && { reasoningEffort: effort }),
          })}>Start with configuration</button>
        {/if}
      </div>
    {/if}
  {:else}
    <p class="muted" role="status">{status}</p>
  {/if}
</div>

<style>
  .task-launch { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .75rem; border-block-start: 1px solid var(--line); margin-block: .65rem; padding-block-start: .65rem; }
  .model-options { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
  .model-field { display: grid; gap: .2rem; min-inline-size: 0; max-inline-size: 100%; }
  .model-options select { min-inline-size: 0; }
  p { margin: 0; overflow-wrap: anywhere; }
</style>
