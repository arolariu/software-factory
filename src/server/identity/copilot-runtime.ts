import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogReader } from './copilot-catalog.js';
import type { CloudLaunchClient } from '../tasks/cloud-launch.js';

export interface AccessReader {
  getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string; login?: string }>;
  listModels(): Promise<readonly { policy?: { state: string } }[]>;
}
interface RuntimeOptions {
  gitHubToken: string;
  useLoggedInUser: false;
  mode: 'empty';
  workingDirectory: string;
  baseDirectory: string;
  env: NodeJS.ProcessEnv;
  logLevel: 'none';
}
export type Runtime = AccessReader & { start(): Promise<void>; forceStop(): Promise<void> };
export type RuntimeFactory<R extends Runtime> = (options: RuntimeOptions) => Promise<R>;

type CopilotRuntime = Runtime & CatalogReader & CloudLaunchClient;
export const createSdk: RuntimeFactory<CopilotRuntime> = async (options) => {
  // The pinned SDK declaration exception is documented in the dependency baseline.
  const packageName: string = '@github/copilot-sdk';
  const { CopilotClient } = await import(packageName) as { CopilotClient: new (options: RuntimeOptions) => CopilotRuntime };
  return new CopilotClient(options);
};

export async function withCopilotRuntime<R extends Runtime, Result>(token: string,
  create: RuntimeFactory<R>, read: (runtime: R) => Promise<Result>, timeoutMs = 20_000, startTimeoutMs = 20_000) {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'factory-copilot-'));
  let client: R | undefined;
  try {
    const { PATH, SystemRoot, TEMP, TMP } = process.env;
    client = await create({
      gitHubToken: token, useLoggedInUser: false, mode: 'empty',
      workingDirectory: directory.path, baseDirectory: directory.path,
      env: { PATH, SystemRoot, TEMP, TMP }, logLevel: 'none',
    });
    await deadline(client.start(), Math.min(startTimeoutMs, timeoutMs));
    return await deadline(read(client), timeoutMs);
  } finally {
    try { if (client) await deadline(client.forceStop(), 5_000); }
    catch { console.warn('Copilot runtime cleanup could not be confirmed.'); }
    try { directory.remove(); }
    catch { console.warn('Copilot runtime temporary directory could not be removed.'); }
  }
}

async function deadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Copilot access check timed out.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
