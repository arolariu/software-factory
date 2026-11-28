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
  usage: Type.Optional(Type.Unknown()), state: Type.Optional(Type.Unknown()), completed_at: Type.Optional(Type.Unknown()),
});
const usageProof = Type.Object({
  type: Type.Enum(['ai_credits', 'premium_requests']),
  amount: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export type CloudOutcome = ApiDto<'recordedCloudOutcome'> & { terminalAt: number };
type Evidence = { status: ApiDto<'cloudTaskStatus'>; outcome?: CloudOutcome };
const outcomes = new Map<string, CloudOutcome['state']>([
  ['completed', 'completed'], ['failed', 'failed'], ['timed_out', 'failed'], ['cancelled', 'stopped'],
]);
const unavailable: Evidence = { status: { state: null } };
const pathSegment = (value: string) => isGitHubName(value) && value !== '.' && value !== '..';

function linkedSession(sessions: unknown, target: StatusTarget) {
  if (!Array.isArray(sessions)) return undefined;
  const matches = sessions.filter((session: unknown) =>
    Value.Check(sessionIdentifier, session) && session.id === target.sessionId);
  if (matches.length !== 1) return undefined;
  const session: unknown = matches[0];
  if (!Value.Check(sessionProof, session) || session.task_id !== target.sessionId ||
      String(session.user.id) !== target.ownerId || String(session.owner.id) !== target.ownerId ||
      String(session.repository.id) !== target.repositoryId) return undefined;
  return session;
}

function terminalOutcome(state: ApiDto<'cloudTaskStatus'>['state'], session: ReturnType<typeof linkedSession>): CloudOutcome | undefined {
  const mapped = outcomes.get(state ?? '');
  const timestamp = session?.completed_at;
  if (!mapped || session?.state !== state || typeof timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(timestamp)) return undefined;
  const terminalAt = Date.parse(timestamp);
  const canonical = timestamp.length === 20 ? `${timestamp.slice(0, -1)}.000Z` : timestamp;
  if (!Number.isFinite(terminalAt) || new Date(terminalAt).toISOString() !== canonical) return undefined;
  return { state: mapped, terminalAt };
}

export async function readCloudTaskEvidence(target: StatusTarget, token: string, fetcher: typeof fetch): Promise<Evidence> {
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
    const session = linkedSession(body.sessions, target);
    const usage = session?.usage;
    const outcome = terminalOutcome(body.state, session);
    return {
      status: { state: body.state, ...(Value.Check(usageProof, usage) && { usage: { unit: usage.type, amount: usage.amount } }) },
      ...(outcome && { outcome }),
    };
  } catch {
    return unavailable;
  }

}
