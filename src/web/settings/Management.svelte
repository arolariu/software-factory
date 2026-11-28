<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiDto, AuthorizationIntent } from '../../shared/api/schemas.js';
  import type { InstanceSettings, SetupStatus, FlowStatus } from '../../shared/api/management-schemas.js';

  type Flow = { flowId: string; browserInstructions: { userCode: string } };
  let setup = $state<SetupStatus>();
  let settings = $state<InstanceSettings>();
  let me = $state<ApiDto<'me'>>();
  let connections = $state<ApiDto<'connections'>['items']>([]);
  let copilotAccounts = $state<ApiDto<'copilotAccounts'>['items']>([]);
  let defaultCopilotAccount = $state<string | null>(null);
  let catalog = $state<{ accountId: string; data: ApiDto<'copilotCatalog'> }>();
  const quotaLabels = new Map([['chat', 'Chat'], ['completions', 'Completions'], ['premium_interactions', 'Premium interactions']]);
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
    catalog = undefined;
    copilotAccounts = [];
    defaultCopilotAccount = null;
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
    if (settings.copilotEnabled) {
      const { items, defaultAccountId } = await read<ApiDto<'copilotAccounts'>>('/api/copilot/accounts');
      copilotAccounts = items;
      defaultCopilotAccount = defaultAccountId;
    }
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

  function checkCatalog(accountId: string) {
    void perform(async () => {
      catalog = undefined;
      const data = await mutate<ApiDto<'copilotCatalog'>>(`/api/copilot/accounts/${encodeURIComponent(accountId)}/catalog`, 'POST');
      catalog = { accountId, data };
    });
  }

  function setDefaultCopilotAccount(accountId: string | null) {
    void perform(async () => {
      await mutate('/api/copilot/accounts/default', 'PUT', { accountId });
      defaultCopilotAccount = accountId;
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
      {#if settings.copilotEnabled}
        <p>Link your GitHub Copilot account separately to check models and account quota. This check does not start a task.</p>
        <button type="button" disabled={busy} onclick={() => start({ intent: 'link_copilot', hostId: 'github.com' })}>Link GitHub Copilot</button>
        {#each copilotAccounts as account (account.id)}
          <div class="copilot-account">
            <div class="account">
              <span><strong>{account.accountLabel}</strong>{#if account.id === defaultCopilotAccount} <span class="chip">Default for new tasks</span>{/if}</span>
              <div class="controls">
                {#if account.state === 'needs_auth'}
                  <button type="button" disabled={busy} onclick={() => start({ intent: 'reconnect_copilot', copilotAccountId: account.id })}>{`Reconnect Copilot for ${account.accountLabel}`}</button>
                {:else}
                  <button type="button" disabled={busy} onclick={() => checkCatalog(account.id)}>{`Check Copilot catalog for ${account.accountLabel}`}</button>
                  {#if account.id !== defaultCopilotAccount}
                    <button type="button" disabled={busy} onclick={() => setDefaultCopilotAccount(account.id)}>{`Use ${account.accountLabel} as default`}</button>
                  {/if}
                {/if}
                {#if account.id === defaultCopilotAccount}
                  <button type="button" disabled={busy} onclick={() => setDefaultCopilotAccount(null)}>Clear default</button>
                {/if}
              </div>
            </div>
            {#if catalog?.accountId === account.id}
              <div aria-live="polite">
                <h4>Models</h4>
                {#if catalog.data.models?.length}
                  <ul>
                    {#each catalog.data.models as model}
                      <li>
                        <strong>{model.name}</strong> <span class="chip">{model.policy}</span> <span class="muted">{model.reasoning.join(', ')}</span>
                        {#if model.tokenPricing}
                          {@const price = model.tokenPricing}
                          <span class="muted">{`Input ${price.inputPrice ?? 'not reported'}, output ${price.outputPrice ?? 'not reported'} ${price.unit === 'ai_credits' ? 'AI credits' : 'nano-AI units'} per ${price.batchSize} tokens`}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p>{catalog.data.models ? 'No models reported for this account.' : 'Models could not be read.'}</p>
                {/if}
                <h4>Account quota</h4>
                {#if catalog.data.quota?.length}
                  <ul>
                    {#each catalog.data.quota as quota (quota.kind)}
                      <li>
                        <strong>{quotaLabels.get(quota.kind)}</strong>
                        <span>{quota.limit === null ? `${quota.used} requests used` : `${quota.used} / ${quota.limit} requests used`}</span>
                        {#if quota.unlimited}<span class="chip">Unlimited</span>{/if}
                        {#if quota.resetsAt}<span class="muted">Resets <time datetime={quota.resetsAt}>{new Date(quota.resetsAt).toLocaleDateString()}</time></span>{/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p>{catalog.data.quota ? 'No quota reported for this account.' : 'Account quota could not be read.'}</p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {:else}
        <p>Not verified in this portal. GitHub sign-in does not verify Copilot access or a Copilot plan.</p>
        <a href="https://github.com/arolariu/software-factory#check-copilot-access">Read about the operator access check</a>
      {/if}
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
  .copilot-account { border-top: 1px solid var(--line); margin-block-start: .7rem; padding-block-start: .7rem; }
  h4 { margin: .75rem 0 .25rem; }
  @media (max-width: 480px) { .settings-head, .group { padding-inline: .85rem; } }
</style>
