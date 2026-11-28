import Type from 'typebox';
import Value from 'typebox/value';
import { ApiSchemas, type ApiDto } from '../../shared/api/schemas.js';
import { isGitHubName } from '../identity/github-hosts.js';
import { bearerHeaders } from '../provider-http.js';
import { verifiedCloudSessionUrl } from './cloud-session-link.js';

type StatusTarget = {
  owner: string; repository: string; repositoryId: string; ownerId: string;
  sessionId: string; sessionUrl: string;
};
const githubId = Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) });
const statusProof = Type.Object({
  id: Type.String(), html_url: Type.String(), creator_type: Type.Literal('user'),
  creator: githubId, owner: githubId, repository: githubId, state: ApiSchemas.cloudTaskStatus.properties.state,
});
const unavailable = { state: null } as const;
const pathSegment = (value: string) => isGitHubName(value) && value !== '.' && value !== '..';

export async function readCloudTaskStatus(target: StatusTarget, token: string, fetcher: typeof fetch): Promise<ApiDto<'cloudTaskStatus'>> {
  if (!verifiedCloudSessionUrl(target.sessionId, target.sessionUrl) ||
      !pathSegment(target.owner) || !pathSegment(target.repository) || !/^(?:ghu|gho)_[A-Za-z0-9_]+$/.test(token)) return unavailable;
  const [owner, repo, id] = [target.owner, target.repository, target.sessionId].map(encodeURIComponent);
  try {
    const response = await fetcher(`https://api.github.com/agents/repos/${owner}/${repo}/tasks/${id}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...bearerHeaders(token), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    if (!response.ok) return unavailable;
    const body: unknown = await response.json();
    if (!Value.Check(statusProof, body) || body.id !== target.sessionId || body.html_url !== target.sessionUrl ||
      String(body.owner.id) !== target.ownerId || String(body.creator.id) !== target.ownerId ||
      String(body.repository.id) !== target.repositoryId) return unavailable;
    return { state: body.state };
  } catch {
    return unavailable;
  }
}
