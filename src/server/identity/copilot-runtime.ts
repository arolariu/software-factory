import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogReader } from './copilot-catalog.js';

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

export const createSdk: RuntimeFactory<Runtime & CatalogReader> = async (options) => {
  // The pinned SDK declaration exception is documented in the dependency baseline.
  const packageName: string = '@github/copilot-sdk';
  const { CopilotClient } = await import(packageName) as { CopilotClient: new (options: RuntimeOptions) => Runtime & CatalogReader };
  return new CopilotClient(options);
};

export async function withCopilotRuntime<R extends Runtime, Result>(token: string,
  create: RuntimeFactory<R>, read: (runtime: R) => Promise<Result>) {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'factory-copilot-'));
  const { PATH, SystemRoot, TEMP, TMP } = process.env;
  const client = await create({
    gitHubToken: token, useLoggedInUser: false, mode: 'empty',
    workingDirectory: directory.path, baseDirectory: directory.path,
    env: { PATH, SystemRoot, TEMP, TMP }, logLevel: 'none',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.start().then(() => read(client)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Copilot access check timed out.')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.forceStop();
  }
}
