import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { authorizeCopilotCheck } from '../identity/copilot-access.js';
import { createGitHubDeviceFlow, githubDeviceApproval } from '../identity/device-flow.js';
import { createRegistry } from '../identity/github-hosts.js';
import { createOAuthTransport } from '../identity/oauth.js';
import { probeCloudTaskWithSdk } from './cloud-launch.js';

type TrialInput = {
  clientId: string | undefined;
  terminal: boolean;
  repository: string | undefined;
  repositoryId: string | undefined;
  userId: string | undefined;
};
type TrialIO = {
  show: (message: string) => void;
  report: (message: string) => void;
  confirm: (label: string) => Promise<string>;
  authorize?: (clientId: string, sendCode: (code: string) => void) => Promise<string>;
  fetcher?: typeof fetch;
  dispatch?: typeof probeCloudTaskWithSdk;
};

const publicClientId = /^[A-Za-z0-9_.-]+$/;
const canonicalRepo = /^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/;
const githubId = /^[1-9][0-9]{0,19}$/;
const trialPrompt = 'Read README.md only and give a short summary. Do not edit files, run shell commands, or create branches, commits, issues, or pull requests.';

export async function runCloudTrial(input: TrialInput, io: TrialIO): Promise<number> {
  const { clientId, repository = '', repositoryId, userId } = input;
  const { confirm, show, report, fetcher = fetch, dispatch = probeCloudTaskWithSdk } = io;
  if (!input.terminal || !clientId || !publicClientId.test(clientId) || !canonicalRepo.test(repository) ||
    repository.endsWith('/.') || repository.endsWith('/..') ||
    !repositoryId || !githubId.test(repositoryId) || !userId || !githubId.test(userId)) {
    report('Use an interactive terminal, a public GitHub App Client ID, and the canonical disposable repository URL and numeric repository and user IDs.');
    return 2;
  }
  const label = repository.slice('https://github.com/'.length);
  if (await confirm(label).catch(() => '') !== label) {
    report('Trial cancelled before requesting device approval.');
    return 2;
  }
  let token: string;
  let destination: { owner: string; name: string };
  try {
    const authorize = io.authorize ?? ((id, sendCode) =>
      authorizeCopilotCheck(id, createGitHubDeviceFlow(fetcher), sendCode, wait, Date.now));
    token = await authorize(clientId, (code) => show(`Open ${githubDeviceApproval} and enter ${code}.`));
    if (!/^ghu_[A-Za-z0-9_]+$/.test(token)) throw new Error('Unsupported grant');
    const registry = createRegistry([{ hostname: 'github.com', label: 'GitHub', deviceClientId: clientId }]);
    const github = createOAuthTransport(fetcher);
    const registration = registry.registration('github.com', 'repository');
    const person = await github.verifyIdentity(registration, { accessToken: token, refreshToken: null, expiresAt: null }, null);
    if (person.subject !== userId) throw new Error('Account mismatch');
    const { target } = registry.repository(repository, 'github');
    const verified = await github.verifyRepository(registration, target, token);
    if (verified.id !== repositoryId || verified.scope !== userId || verified.url !== repository) throw new Error('Repository mismatch');
    destination = { owner: target.scope, name: target.name };
  } catch {
    report('GitHub could not verify the exact account or repository. No Copilot session was requested.');
    return 1;
  }

  const requestedSessionId = randomUUID();
  show(`Requesting one cloud session: ${requestedSessionId}`);
  try {
    const { sessionId, usage, sessionUrl } = await dispatch(token, {
      requestedSessionId, repository: destination, expectedLogin: destination.owner, turnId: randomUUID(), prompt: trialPrompt,
    });
    if (sessionId !== requestedSessionId) throw new Error('Session mismatch');
    show(JSON.stringify({ state: 'delivery_confirmed', repository, repositoryId, userId, sessionId, sessionUrl, usage }));
    return 0;
  } catch {
    report('Cloud delivery could not be confirmed. Do not retry until you check the reported session ID in GitHub Copilot.');
    return 1;
  }
}

if (import.meta.main) {
  const [, , repository, repositoryId, userId] = process.argv;
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  process.exitCode = await runCloudTrial({
    clientId: process.env['FACTORY_GITHUB_CLIENT_ID'], terminal,
    repository: process.argv.length === 5 ? repository : undefined, repositoryId, userId,
  }, {
    show: console.log,
    report: console.error,
    async confirm(label) {
      const shell = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await shell.question(`This starts one billable cloud session. Type ${label} to confirm it is disposable and approved: `);
      } finally {
        shell.close();
      }
    },
  });
}
