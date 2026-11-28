<script module lang="ts">
  import type { ApiDto, StartTask } from '../shared/api/schemas.js';

  export type StartAttempt = {
    input: StartTask;
    state: 'starting' | 'retry' | 'queued' | 'blocked';
    note?: string;
    taskId?: string;
    taskState?: ApiDto<'task'>['task']['state'];
  };
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { SvelteMap } from 'svelte/reactivity';
  import { opaqueIdSegment } from '../shared/api/opaque-id.js';
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
  const trackedId = $derived(attempt?.taskId ?? issue.taskId);
  let durable = $state<{ id: string; value: ApiDto<'task'> }>();
  const trackedTask = $derived(durable?.id === trackedId ? durable?.value : undefined);
  let taskError = $state('');
  const terminal = (state: string) => ['completed', 'stopped', 'failed'].includes(state);
  const states: Record<string, string> = {
    queued: 'Task queued', starting: 'Task starting', running: 'Task running', waiting_input: 'Task needs your answer',
    publishing: 'Task publishing', stopping: 'Task stopping', needs_auth: 'Task needs reauthorization',
    needs_recovery: 'Task needs recovery', completed: 'Task completed', stopped: 'Task stopped', failed: 'Task failed',
  };

  onMount(() => {
    if (issue.launch.available && issue.taskId === null && !attempts.has(scope)) void loadOptions();
    return () => panel.abort();
  });

  $effect(() => {
    const id = trackedId;
    if (!id) return;
    const controller = new AbortController();
    void watchTask(id, controller.signal);
    return () => controller.abort();
  });

  async function watchTask(id: string, signal: AbortSignal) {
    taskError = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => clearTimeout(timer);
    signal.addEventListener('abort', abort, { once: true });
    const sample = async () => {
      try {
        const value = await readPortal<ApiDto<'task'>>(`/api/tasks/${encodeURIComponent(id)}`, signal);
        if (signal.aborted) return;
        if (value.task.taskId !== id) throw new Error('Unconfirmed task');
        durable = { id, value };
        const cached = attempts.get(scope);
        if (cached?.taskId === id && cached.taskState !== value.task.state) {
          attempts.set(scope, { ...cached, taskState: value.task.state });
        }
        taskError = '';
        if (terminal(value.task.state)) return;
      } catch (error) {
        if (signal.aborted || onAccessLost(error)) return;
        taskError = 'Task status could not be refreshed.';
        if (problemCode(error) === 'NOT_FOUND') return;
      }
      timer = setTimeout(() => void sample(), 3_000);
    };
    await sample();
  }

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

  function resetStart() {
    attempts.delete(scope);
    account = undefined;
    canConfigure = false;
    configured = false;
    models = undefined;
    modelId = '';
    effort = '';
    modelNote = '';
    void loadOptions();
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
      if (attempts.get(key) === pending) attempts.set(key, { input, state: 'queued', taskId: receipt.taskId });
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
  {#if trackedId}
    <p role="status">{trackedTask ? states[trackedTask.task.state] : attempt?.state === 'queued'
      ? states[attempt.taskState ?? 'queued'] : 'A task is already linked to this issue.'}</p>
    {#if taskError}<p class="muted">{taskError}</p>{/if}
    {#if trackedTask?.sessionUrl}<a href={trackedTask.sessionUrl} target="_blank" rel="noreferrer">View Copilot session</a>{/if}
    {#if trackedTask && terminal(trackedTask.task.state)}
      {#if attempt?.taskId && issue.taskId === null}
        <button type="button" onclick={resetStart}>Refresh launch options</button>
      {:else}<p class="muted">Reopen the issue to check new launch options.</p>{/if}
    {/if}
  {:else if !issue.launch.available}
    <p class="muted">{unavailable}</p>
  {:else if attempt?.state === 'blocked'}
    <p role="status">{attempt.note}</p>
    <button type="button" onclick={resetStart}>Refresh launch options</button>
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
