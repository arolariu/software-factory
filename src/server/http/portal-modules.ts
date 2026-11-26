import type { ApiDto, ApiSchemas, AuthorizationIntent } from '../../shared/api/schemas.js';

export interface Requester { id: string }
type Result<T> = T | Promise<T>;
type Read<K extends keyof typeof ApiSchemas, A extends unknown[] = []> =
  (requester: Requester, ...args: A) => Result<ApiDto<K>>;
export type AuthorizationProvider = ApiDto<'providerPath'>['provider'];

export interface PortalModules {
  identity: {
    resolveRequester(sessionId: string): Result<Requester | null>;
    csrf(sessionId: string | undefined): Result<{ csrfToken: string; sessionId?: string }>;
    verifyCsrf(sessionId: string, token: string): Result<boolean>;
    githubHosts(): Result<ApiDto<'hosts'>['items']>;
    me: Read<'me'>;
    beginAuthorization(provider: AuthorizationProvider, intent: AuthorizationIntent, sessionId: string, requester: Requester | null): Result<ApiDto<'authorizationStarted'>>;
    completeAuthorization(provider: AuthorizationProvider, sessionId: string, input: { state: string; code: string | null }): Result<{ redirectTo: string; sessionId?: string }>;
    logout(requester: Requester, sessionId: string): Result<void>;
    copilotAccounts: Read<'copilotAccounts'>;
    setDefaultCopilotAccount(requester: Requester, accountId: string | null): Result<void>;
  };
  repositories: {
    connections: Read<'connections'>;
    issues: Read<'issues', [string, ApiDto<'issueQuery'>]>;
    issue: Read<'issue', [string, string, ApiDto<'issueDetailQuery'>]>;
    pullRequests: Read<'pullRequests', [string, ApiDto<'prQuery'>]>;
    checks: Read<'checks', [string, string, ApiDto<'checkQuery'>]>;
  };
  tasks: {
    tasks: Read<'tasks', [string, ApiDto<'taskQuery'>]>;
    activeSessions: Read<'activeSessions'>;
    unlinkedSessions: Read<'unlinkedSessions', [ApiDto<'paging'>]>;
    task: Read<'task', [string]>;
    activity: Read<'activity', [string, ApiDto<'paging'>]>;
    options: Read<'taskOptions', [string, ApiDto<'optionsQuery'>]>;
    statistics: Read<'statistics'>;
  };
  operations: {
    read: Read<'operation', [string]>;
  };
}

export interface PortalOptions {
  modules: PortalModules;
  publicOrigin: string;
}
