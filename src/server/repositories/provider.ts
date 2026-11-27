import type { ApiDto } from '../../shared/api/schemas.js';
import type { IdentityProvider, RepoTarget } from '../identity/github-hosts.js';

export interface RepositoryAccess {
  id: string;
  repoId: string;
  generation: number;
  grantId: string;
  provider: IdentityProvider;
  repositoryId: string;
  scope: string;
  target: RepoTarget;
  subject?: string;
}

export type IssueRow = NonNullable<ApiDto<'issues'>['items']>[number];
export type PullRequestRow = NonNullable<ApiDto<'pullRequests'>['items']>[number];
export type CheckRow = NonNullable<ApiDto<'checks'>['items']>['items'][number];

export interface RepositoryProvider {
  issues(): Promise<IssueRow[]>;
  pullRequests(): Promise<PullRequestRow[]>;
  issue(key: string, limit: number, cursor: string | null): Promise<ApiDto<'issue'>>;
  checks(key: string, revision: string): Promise<ApiDto<'checks'>>;
}
