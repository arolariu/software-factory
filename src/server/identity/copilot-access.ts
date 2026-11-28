import { setTimeout as wait } from 'node:timers/promises';
import { createGitHubDeviceFlow, githubDeviceApproval } from './device-flow.js';
import { createSdk, withCopilotRuntime, type AccessReader, type Runtime, type RuntimeFactory } from './copilot-runtime.js';

export async function inspectCopilotAccess(client: AccessReader) {
  const status = await client.getAuthStatus();
  if (!status.isAuthenticated || status.authType !== 'token') return { state: 'unverified' } as const;
  const models = await client.listModels();
  return {
    state: 'authenticated', login: status.login ?? null, models: models.length,
    disabledByPolicy: models.filter((model) => model.policy?.state === 'disabled').length,
  } as const;
}

export async function authorizeCopilotCheck(
  clientId: string, device: ReturnType<typeof createGitHubDeviceFlow>, showCode: (code: string) => void,
  pause: (ms: number) => Promise<unknown>, now: () => number,
): Promise<string> {
  const approval = await device.start(clientId);
  showCode(approval.userCode);
  let interval = approval.intervalMs;
  while (now() + interval < approval.expiresAt) {
    await pause(interval);
    if (now() >= approval.expiresAt) break;
    const result = await device.poll(clientId, approval.deviceCode);
    if (result.kind === 'authorized') return result.tokens.accessToken;
    if (result.kind === 'denied') throw new Error('GitHub device approval was denied.');
    if (result.kind === 'expired') break;
    if (result.kind === 'slow_down') interval += 5_000;
  }
  throw new Error('GitHub device approval expired.');
}

export function inspectWithSdk(token: string, create: RuntimeFactory<Runtime> = createSdk) {
  return withCopilotRuntime(token, create, inspectCopilotAccess);
}

export async function runCopilotAccessCheck(
  clientId: string | undefined, terminal: boolean,
  show: (message: string) => void, report: (message: string) => void,
  authorize = (id: string, display: (code: string) => void) =>
    authorizeCopilotCheck(id, createGitHubDeviceFlow(), display, wait, Date.now),
  inspect = inspectWithSdk,
): Promise<number> {
  if (!terminal || !clientId || !/^[A-Za-z0-9_.-]+$/.test(clientId)) {
    report('Run from an interactive terminal with FACTORY_GITHUB_CLIENT_ID set to the public GitHub App Client ID.');
    return 2;
  }
  try {
    const token = await authorize(clientId, (code) => show(`Open ${githubDeviceApproval} and enter ${code}.`));
    const result = await inspect(token);
    show(JSON.stringify(result));
    return result.state === 'authenticated' && result.models > result.disabledByPolicy ? 0 : 1;
  } catch {
    report('Copilot access was not verified. Check device approval, account access, and organization policy, then retry.');
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCopilotAccessCheck(
    process.env['FACTORY_GITHUB_CLIENT_ID'], process.stdout.isTTY === true, console.log, console.error,
  );
}
