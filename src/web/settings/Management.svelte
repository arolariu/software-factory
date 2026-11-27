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
    <p>Open <a href="https://github.com/login/device" target="_blank" rel="noreferrer">GitHub device approval</a> and enter <strong>{flow.browserInstructions.userCode}</strong>.</p>
    {@const current = flow}
    <p aria-live="polite">{`Authorization: ${flowState}`}</p>
    <button type="button" onclick={() => check(current)} disabled={busy}>Check approval</button>
    <button type="button" onclick={() => cancel(current)} disabled={busy}>Cancel authorization</button>
  {:else if me && settings}
    {@const currentSettings = settings}
    <p>{`Signed in as ${me.user.displayName}`}</p>
    <p>{`Portal registration: ${settings.portalClientId}. Repository registration: ${settings.repositoryClientId ?? 'Not configured'}.`}</p>
    <button type="button" disabled={busy || !settings.repositoryConfigured}
      onclick={() => toggle(currentSettings)}>{settings.repositoryEnabled ? 'Disable repository authorization' : 'Enable repository authorization'}</button>
    <label>GitHub repository URL <input type="url" bind:value={repo} placeholder="https://github.com/org/repo" /></label>
    <button type="button" disabled={busy || !settings.repositoryEnabled || !repo} onclick={() => start({ intent: 'connect', repositoryUrl: repo })}>Connect repository</button>
    <ul>
      {#each connections as connection (connection.id)}
        <li>
          {`${connection.name} (${connection.state})`}
          <button type="button" disabled={busy || !settings.repositoryEnabled} onclick={() => start({ intent: 'reconnect', connectionId: connection.id })}>{`Reconnect ${connection.name}`}</button>
          <button type="button" disabled={busy} onclick={() => void perform(async () => {
            await mutate(`/api/connections/${encodeURIComponent(connection.id)}/authorization`, 'DELETE');
            await load();
          })}>{`Disconnect ${connection.name}`}</button>
        </li>
      {/each}
    </ul>
    <button type="button" disabled={busy} onclick={() => void perform(async () => {
      await mutate('/api/auth/logout', 'POST');
      await load();
    })}>Sign out</button>
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
  label { display: block; margin: 10px 0; }
  button { margin: 4px 8px 4px 0; }
  input { min-width: min(24rem, 80vw); margin-left: 8px; }
  p[role='alert'] { color: #8c2039; }
</style>
