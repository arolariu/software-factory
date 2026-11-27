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

<section class="sheet settings" aria-labelledby="management-heading">
  <div class="settings-head">
    <h2 class="sheet-title" id="management-heading">Factory setup and settings</h2>
    <p class="muted">Manage GitHub sign-in and the repositories this Factory can read.</p>
  </div>
  {#if message}<p class="notice" role="alert">{message}</p>{/if}
  {#if flow}
    {@const current = flow}
    <div class="group approval">
    <h3>Approve in GitHub</h3>
    {#if recovery}
      <p role="status">{recovery}</p>
    {:else}
      <p>Open <a href="https://github.com/login/device" target="_blank" rel="noreferrer">GitHub device approval</a> and enter this code. Then return here to check approval.</p>
      <strong class="device-code">{flow.browserInstructions.userCode}</strong>
    {/if}
    <p class="muted" aria-live="polite">{`Authorization: ${flowState}`}</p>
    <div class="controls">
      <button class="primary" type="button" onclick={() => check(current)} disabled={busy || !!recovery}>Check approval</button>
      <button type="button" onclick={() => cancel(current)} disabled={busy}>Cancel authorization</button>
    </div>
    </div>
  {:else if me && settings}
    {@const currentSettings = settings}
    <div class="group">
      <h3>Account</h3>
      <div class="account">
      <div>
        <p>{`Signed in as ${me.user.displayName}`}</p>
        <p class="muted">{`GitHub App Client ID: ${settings.githubClientId}.`}</p>
      </div>
      <button type="button" disabled={busy} onclick={() => void perform(async () => {
        await mutate('/api/auth/logout', 'POST');
        await load();
      })}>Sign out</button>
      </div>
    </div>
    <div class="group">
      <h3>Repository connections</h3>
      <p>Install the GitHub App on the repositories you want to read. Connecting a repository will ask for approval.</p>
      <button class="policy" type="button" disabled={busy}
        onclick={() => toggle(currentSettings)}>{settings.repositoryEnabled ? 'Disable repository authorization' : 'Enable repository authorization'}</button>
      <form onsubmit={(event) => { event.preventDefault(); start({ intent: 'connect', repositoryUrl: repo }); }}>
        <label>GitHub repository URL <input type="url" bind:value={repo} placeholder="https://github.com/org/repo" required /></label>
        <button class="primary" type="submit" disabled={busy || !settings.repositoryEnabled || !repo}>Connect repository</button>
      </form>
      <ul>
        {#each connections as connection (connection.id)}
          <li>
            <div class="connection-name"><strong>{connection.name}</strong> <span class="chip">{connection.state}</span></div>
            <button type="button" disabled={busy || !settings.repositoryEnabled} onclick={() => start({ intent: 'reconnect', connectionId: connection.id })}>{`Reconnect ${connection.name}`}</button>
            <button class="danger-action" type="button" disabled={busy} onclick={() => void perform(async () => {
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
    <div class="group approval">
    {#if setup.state === 'unclaimed' && !paired}
      <h3>Pair this browser</h3>
      <p>Generate a setup code in the host terminal, then enter it here.</p>
      <label>Host pairing code <input type="password" bind:value={code} autocomplete="off" /></label>
      <button class="primary" type="button" onclick={pair} disabled={busy || !code}>Pair this browser</button>
    {:else if setup.signInAvailable}
      <h3>Sign in</h3>
      <p>Use your own GitHub account. You’ll approve a device code in a separate tab.</p>
      <button class="primary" type="button" disabled={busy} onclick={() => start({ intent: 'sign_in', hostId: 'github.com' })}>Sign in with GitHub</button>
    {:else}
      <p>Public GitHub sign-in is not configured on this instance.</p>
    {/if}
    </div>
  {:else if busy}
    <p class="notice" role="status">Loading Factory settings...</p>
  {/if}
</section>

<style>
  .settings { max-inline-size: 52rem; overflow-wrap: anywhere; }
  .settings-head { padding: 1rem 1.25rem; background: var(--quiet); border-radius: var(--radius) var(--radius) 0 0; }
  h3 { margin: 0 0 .4rem; font-size: 1rem; font-weight: 700; }
  p:not(.notice) { margin: .25rem 0 .65rem; max-inline-size: 68ch; }
  .group { padding: 1rem 1.25rem; border-top: 1px solid var(--line); }
  .account { display: flex; align-items: center; justify-content: space-between; gap: .6rem 1rem; flex-wrap: wrap; }
  .account p:last-child, .settings-head p:last-child { margin-bottom: 0; }
  .controls, form, li { display: flex; flex-wrap: wrap; gap: .5rem; }
  .approval { min-block-size: 9rem; }
  .device-code { display: inline-block; font: 650 1.18rem/1.5 var(--mono); letter-spacing: .05em; background: var(--selection); border: 1px solid var(--line); border-radius: var(--radius); padding: .3rem .6rem; }
  .policy { margin-block: .2rem .7rem; }
  form { align-items: end; }
  label { display: grid; gap: .25rem; max-inline-size: 100%; color: var(--muted); font-weight: 600; }
  form label { flex: 1 1 18rem; }
  input { inline-size: 100%; }
  .approval label { max-inline-size: 21rem; margin-block-end: .55rem; }
  ul { margin: .8rem 0 0; padding: 0; list-style: none; }
  li { align-items: center; border-top: 1px solid var(--line); padding-block: .55rem; }
  .connection-name { flex: 1 1 10rem; }
  .connection-name strong { margin-inline-end: .35rem; }
  @media (max-width: 480px) { .settings-head, .group { padding-inline: .85rem; } }
</style>
