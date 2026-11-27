import { createAzureDevOpsProvider } from './azure-devops.js';
import { createGitHubProvider } from './github.js';
import type { RepositoryAccess, RepositoryProvider } from './provider.js';

export function createRepositoryProvider(connection: RepositoryAccess, token: string, fetcher = fetch): RepositoryProvider {
  return connection.provider === 'github'
    ? createGitHubProvider(connection, token, fetcher)
    : createAzureDevOpsProvider(connection, token, fetcher);
}
