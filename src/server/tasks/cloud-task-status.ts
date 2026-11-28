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
  sessions: Type.Optional(Type.Unknown()),
});
const sessionIdentifier = Type.Object({ id: Type.String() });
const sessionProof = Type.Object({
  task_id: Type.String(), user: githubId, owner: githubId, repository: githubId,
  usage: Type.Object({
    type: Type.Enum(['ai_credits', 'premium_requests']),
    amount: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }),
});
const unavailable = { state: null } as const;
const pathSegment = (value: string) => isGitHubName(value) && value !== '.' && value !== '..';

function linkedUsage(sessions: unknown, target: StatusTarget): ApiDto<'cloudTaskStatus'>['usage'] {
  if (!Array.isArray(sessions)) return undefined;
  const matches = sessions.filter((session: unknown) =>
    Value.Check(sessionIdentifier, session) && session.id === target.sessionId);
  if (matches.length !== 1) return undefined;
  const session: unknown = matches[0];
  if (!Value.Check(sessionProof, session) || session.task_id !== target.sessionId ||
      String(session.user.id) !== target.ownerId || String(session.owner.id) !== target.ownerId ||
      String(session.repository.id) !== target.repositoryId) return undefined;
  return { unit: session.usage.type, amount: session.usage.amount };
}

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
    const usage = linkedUsage(body.sessions, target);
    return { state: body.state, ...(usage && { usage }) };
  } catch {
    return unavailable;
  }
}
