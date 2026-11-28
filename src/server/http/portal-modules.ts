import type { ApiDto, ApiSchemas, AuthorizationIntent } from '../../shared/api/schemas.js';

export interface Requester { id: string }
type Result<T> = T | Promise<T>;
type Read<K extends keyof typeof ApiSchemas, A extends unknown[] = []> =
  (requester: Requester, ...args: A) => Result<ApiDto<K>>;
export type AuthorizationProvider = ApiDto<'providerPath'>['provider'];
export type GatedEffect =
  | { kind: 'start'; connectionId: string; input: ApiDto<'startTask'> }
  | { kind: 'input'; taskId: string }
  | { kind: 'archive'; taskId: string }
  | { kind: 'remove'; connectionId: string }
  | { kind: 'close'; connectionId: string; workItemKey: string };

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
    copilotCatalog?: Read<'copilotCatalog', [string]>;
    setDefaultCopilotAccount(requester: Requester, accountId: string | null): Result<void>;
  };
  repositories: {
    connections: Read<'connections'>;
    issues: Read<'issues', [string, ApiDto<'issueQuery'>]>;
    issue: Read<'issue', [string, string, ApiDto<'issueDetailQuery'>]>;
    pullRequests: Read<'pullRequests', [string, ApiDto<'prQuery'>]>;
    checks: Read<'checks', [string, string, ApiDto<'checkQuery'>]>;
    closeIssue: Read<'issueClosed', [string, string, ApiDto<'closeIssue'>]>;
  };
  tasks: {
    tasks: Read<'tasks', [string, ApiDto<'taskQuery'>]>;
    activeSessions: Read<'activeSessions'>;
    unlinkedSessions: Read<'unlinkedSessions', [ApiDto<'paging'>]>;
    task: Read<'task', [string]>;
    cloudStatus?: Read<'cloudTaskStatus', [string]>;
    activity: Read<'activity', [string, ApiDto<'paging'>]>;
    options: Read<'taskOptions', [string, ApiDto<'optionsQuery'>]>;
    statistics: Read<'statistics'>;
    start: Read<'taskAccepted', [string, ApiDto<'startTask'>]>;
  };
  operations: {
    read: Read<'operation', [string]>;
    authorizeEffect(requester: Requester, effect: GatedEffect): Result<void>;
    sync: Read<'operationAccepted', [string]>;
    input: Read<'operationAccepted', [string, ApiDto<'taskInput'>]>;
    archive: Read<'operationAccepted', [string]>;
    remove: Read<'operationAccepted', [string]>;
  };
}

export interface PortalOptions {
  modules: PortalModules;
  publicOrigin: string;
}
