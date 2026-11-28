import { addAbortListener } from 'node:events';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../main.js';
import { issueOperatorCode } from '../management/operator.js';
import { inspectCatalogWithSdk } from '../identity/copilot-catalog.js';
import { cloudTrialOrigin } from './github-cloud-admission.js';

type TrialInput = {
  terminal: boolean;
  clientId: string | undefined;
  publicOrigin: string;
  repositoryId: string | undefined;
  userId: string | undefined;
};
type TrialIO = {
  confirm: (label: string) => Promise<string>;
  show: (details: { backend: string; origin: string; pairingCode: string }) => void;
  report: (message: string) => void;
};

const clientIdPattern = /^[A-Za-z0-9_.-]+$/;
const numericId = /^[1-9][0-9]{0,19}$/;

export async function runPortalTrial(input: TrialInput, io: TrialIO, artifactDir: string, signal: AbortSignal): Promise<number> {
  const { terminal, clientId, publicOrigin, repositoryId, userId } = input;
  if (!terminal || !clientId || !clientIdPattern.test(clientId) || publicOrigin !== cloudTrialOrigin ||
      !repositoryId || !numericId.test(repositoryId) || !userId || !numericId.test(userId)) {
    io.report('Use an interactive terminal, a public GitHub App Client ID, and the numeric repository and user IDs for one approved disposable repository.');
    return 2;
  }
  const label = `${repositoryId}:${userId}`;
  if (signal.aborted || await io.confirm(label).catch(() => '') !== label || signal.aborted) {
    io.report('Portal trial cancelled before opening the listener.');
    return 2;
  }
  try {
    using workspace = mkdtempDisposableSync(join(tmpdir(), 'factory-copilot-portal-trial-'));
    const server = await startServer({
      artifactDir, dataDir: workspace.path, port: 0,
      cloudTrial: { repoId: repositoryId, ownerId: userId },
      management: { publicOrigin, githubClientId: clientId, inspectCopilot: inspectCatalogWithSdk },
    });
    try {
      if (!signal.aborted) {
        const { code } = issueOperatorCode(workspace.path, publicOrigin, terminal);
        const stopped = Promise.withResolvers<void>();
        const listener = addAbortListener(signal, () => stopped.resolve());
        try {
          io.show({ backend: server.address, origin: publicOrigin, pairingCode: code });
          await stopped.promise;
        } finally {
          listener[Symbol.dispose]();
        }
      }
    } finally {
      await server.close();
    }
    return 0;
  } catch {
    io.report('The isolated portal trial could not run. Check the build and local configuration.');
    return 1;
  }
}

if (import.meta.main) {
  const [, , repositoryId, userId] = process.argv;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop).once('SIGTERM', stop);
  try {
    process.exitCode = await runPortalTrial({
      terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
      clientId: process.env['FACTORY_GITHUB_CLIENT_ID'],
      publicOrigin: cloudTrialOrigin,
      repositoryId: process.argv.length === 4 ? repositoryId : undefined, userId,
    }, {
      report: console.error,
      show({ backend, origin, pairingCode }) {
        console.log(`Proxy ${origin} to ${backend} without changing the Host header.`);
        console.log(`Then visit ${origin}/setup. Pairing code: ${pairingCode}`);
      },
      async confirm(label) {
        const shell = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await shell.question(`This portal can request billable sessions. Type ${label} to confirm the repository is disposable and approved: `, { signal: abort.signal });
        } finally {
          shell.close();
        }
      },
    }, fileURLToPath(new URL('../../', import.meta.url)), abort.signal);
  } finally {
    process.off('SIGINT', stop).off('SIGTERM', stop);
  }
}
