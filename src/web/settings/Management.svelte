<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiDto, AuthorizationIntent } from '../../shared/api/schemas.js';
  import type { InstanceSettings, SetupStatus, FlowStatus } from '../../shared/api/management-schemas.js';

  type Flow = { flowId: string; browserInstructions: { userCode: string } };
  let setup = $state<SetupStatus>();
  let settings = $state<InstanceSettings>();
  let me = $state<ApiDto<'me'>>();
  let connections = $state<ApiDto<'connections'>['items']>([]);
  let flow = $state<Flow>();
  let flowState = $state<FlowStatus['state']>('pending');
  const flowHelp: Partial<Record<FlowStatus['state'], string>> = {
    failed: 'GitHub approval could not be verified. Check the GitHub App installation and approved read permissions if you were connecting a repository, then try again.',
    expired: 'That device code expired. Cancel this attempt and request a new code.',
    cancelled: 'This attempt was cancelled. Return to Settings to start again.',
    complete: 'This attempt is already complete. Return to Settings.',
  };
  const recovery = $derived(flowHelp[flowState]);
  let code = $state('');
  let repo = $state('');
  let paired = $state(false);
  let busy = $state(false);
  let message = $state('');
  const lifetime = new AbortController();

  async function read<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: lifetime.signal });
    if (!response.ok) throw new Error(`Factory request failed (${response.status}).`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async function mutate<T>(path: string, method: string, payload?: object) {
    const { csrfToken } = await read<{ csrfToken: string }>('/api/auth/csrf');
    return read<T>(path, {
      method, headers: { 'X-CSRF-Token': csrfToken, ...(payload && { 'Content-Type': 'application/json' }) },
      ...(payload && { body: JSON.stringify(payload) }),
    });
  }

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    message = '';
    try { await action(); }
    catch { if (!lifetime.signal.aborted) message = 'That action could not be completed. Check your session or try again.'; }
    finally { busy = false; }
  }

  async function loadSetup() {
    setup = await read<SetupStatus>('/api/setup/status');
    paired = setup.paired;
    return setup;
  }

  async function load() {
    if ((await loadSetup()).signInAvailable) {
      const active = await read<{ flow: Flow | null }>('/api/authorization/flows');
      flow = active.flow ?? undefined;
    }
    const identity = await fetch('/api/me', { signal: lifetime.signal });
    if (identity.status === 401) { me = undefined; return; }
    if (!identity.ok) throw new Error('Could not load identity.');
    me = await identity.json() as ApiDto<'me'>;
    settings = await read<InstanceSettings>('/api/settings/instance');
    connections = (await read<ApiDto<'connections'>>('/api/connections')).items;
  }
  onMount(() => {
    void perform(load);
    return () => lifetime.abort();
  });

  function pair() {
    void perform(async () => {
      const submitted = code.trim();
      code = '';
      await mutate('/api/setup/pair', 'POST', { code: submitted });
      paired = true;
    });
  }

  function start(intent: AuthorizationIntent) {
    void perform(async () => {
      flow = await mutate<Flow>('/api/authorization/flows', 'POST', intent);
      flowState = 'pending';
    });
  }

  function check(current: Flow) {
    void perform(async () => {
      const path = `/api/authorization/flows/${current.flowId}`;
      const { state } = await read<FlowStatus>(path);
      flowState = state;
      if (state === 'ready') {
        await mutate(`${path}/complete`, 'POST');
        flow = undefined;
        await load();
      }
    });
  }

  function cancel(current: Flow) {
    void perform(async () => {
      await mutate(`/api/authorization/flows/${current.flowId}`, 'DELETE');
      flow = undefined;
      if (!me) await loadSetup();
    });
  }

  function toggle(previous: InstanceSettings) {
    void perform(async () => {
      settings = await mutate<InstanceSettings>('/api/settings/instance', 'PUT', {
        version: previous.version, repositoryEnabled: !previous.repositoryEnabled,
      });
    });
  }
</script>

<section aria-labelledby="management-heading">
  <h2 id="management-heading">Factory setup and settings</h2>
  {#if message}<p role="alert">{message}</p>{/if}
  {#if flow}
    {@const current = flow}
    {#if recovery}
      <p role="status">{recovery}</p>
    {:else}
      <p>Open <a href="https://github.com/login/device" target="_blank" rel="noreferrer">GitHub device approval</a> and enter <strong class="device-code">{flow.browserInstructions.userCode}</strong>.</p>
    {/if}
    <p aria-live="polite">{`Authorization: ${flowState}`}</p>
    <button type="button" onclick={() => check(current)} disabled={busy || !!recovery}>Check approval</button>
    <button type="button" onclick={() => cancel(current)} disabled={busy}>Cancel authorization</button>
  {:else if me && settings}
    {@const currentSettings = settings}
    <div class="group">
      <h3>Account</h3>
      <p>{`Signed in as ${me.user.displayName}`}</p>
      <p>{`GitHub App Client ID: ${settings.githubClientId}.`}</p>
      <button type="button" disabled={busy} onclick={() => void perform(async () => {
        await mutate('/api/auth/logout', 'POST');
        await load();
      })}>Sign out</button>
    </div>
    <div class="group">
      <h3>Repository connections</h3>
      <p>Install the GitHub App on the repositories you want to read. Connecting a repository will ask for approval.</p>
      <button type="button" disabled={busy}
        onclick={() => toggle(currentSettings)}>{settings.repositoryEnabled ? 'Disable repository authorization' : 'Enable repository authorization'}</button>
      <form onsubmit={(event) => { event.preventDefault(); start({ intent: 'connect', repositoryUrl: repo }); }}>
        <label>GitHub repository URL <input type="url" bind:value={repo} placeholder="https://github.com/org/repo" required /></label>
        <button type="submit" disabled={busy || !settings.repositoryEnabled || !repo}>Connect repository</button>
      </form>
      <ul>
        {#each connections as connection (connection.id)}
          <li>
            <strong>{connection.name}</strong>
            <span>{connection.state}</span>
            <button type="button" disabled={busy || !settings.repositoryEnabled} onclick={() => start({ intent: 'reconnect', connectionId: connection.id })}>{`Reconnect ${connection.name}`}</button>
            <button type="button" disabled={busy} onclick={() => void perform(async () => {
              await mutate(`/api/connections/${encodeURIComponent(connection.id)}/authorization`, 'DELETE');
              await load();
            })}>{`Disconnect ${connection.name}`}</button>
          </li>
        {/each}
      </ul>
    </div>
    <div class="group">
      <h3>Copilot access</h3>
      <p>Not verified in this portal. GitHub sign-in does not verify Copilot access or a Copilot plan.</p>
      <a href="https://github.com/arolariu/software-factory#check-copilot-access">Read about the operator access check</a>
    </div>
  {:else if setup}
    {#if setup.state === 'unclaimed' && !paired}
      <p>Generate a setup code in the host terminal, then enter it here.</p>
      <label>Host pairing code <input type="password" bind:value={code} autocomplete="off" /></label>
      <button type="button" onclick={pair} disabled={busy || !code}>Pair this browser</button>
    {:else if setup.signInAvailable}
      <button type="button" disabled={busy} onclick={() => start({ intent: 'sign_in', hostId: 'github.com' })}>Sign in with GitHub</button>
    {:else}
      <p>Public GitHub sign-in is not configured on this instance.</p>
    {/if}
  {/if}
</section>

<style>
  section { background: white; border: 1px solid #dcd6e6; border-radius: 4px; padding: 12px 16px; }
  h2 { margin: 0 0 8px; font-size: 16px; }
  h3 { margin: 0 0 4px; font-size: 14px; }
  p { margin: 4px 0 8px; }
  .group { padding: 12px 0; border-top: 1px solid #dcd6e6; }
  .group:last-child { padding-bottom: 0; }
  .device-code { font: 600 1.1em Consolas, monospace; }
  form, li { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
  label { display: grid; gap: 2px; margin: 6px 0; max-width: 100%; }
  button, input { font: inherit; color: #211c2c; background: #fff; border: 1px solid #8b8098; border-radius: 4px; padding: 3px 8px; min-height: 28px; box-sizing: border-box; }
  button { margin: 4px 6px 6px 0; }
  button:hover:not(:disabled), button:disabled { background: #f4f0f9; }
  button:disabled { color: #665c70; }
  input { width: min(22rem, 100%); }
  ul { margin: 4px 0 0; padding: 0; list-style: none; }
  li { align-items: center; gap: 4px 8px; border-top: 1px solid #dcd6e6; padding: 3px 0; }
  a { color: #165f9b; }
  :is(a, button, input):focus-visible { outline: 2px solid #165f9b; outline-offset: 2px; }
  p[role='alert'] { color: #8c2039; }
</style>
