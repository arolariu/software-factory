import { createHash } from 'node:crypto';
import { ApiFailure } from '../http/problems.js';
import { bearerHeaders, publicHttpsUrl, rateLimitFailure, record } from '../provider-http.js';
import type { Tokens } from './credentials.js';
import { isGitHubName, type Registration, type RepoTarget } from './github-hosts.js';

export interface VerifiedRepository { id: string; host: string; scope: string; name: string; url: string }
export interface VerifiedAuthorization {
  subject: string;
  label: string;
  avatarUrl: string | null;
  tokens: Tokens;
  repo?: VerifiedRepository;
}
export interface Redemption {
  registration: Registration;
  callback: string;
  code: string;
  verifier: string;
  target: RepoTarget | null;
}

export class RepositoryAuthorizationDenied extends ApiFailure {
  readonly subject: string;
  constructor(subject: string) {
    super('ACCESS_DENIED');
    this.subject = subject;
  }
}

export function authorizationUrl(registration: Registration, callback: string, state: string, verifier: string): string {
  const url = new URL(registration.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: registration.clientId, redirect_uri: callback, state, response_type: 'code',
    scope: registration.requestedScope, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return url.href;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiFailure('PROVIDER_ERROR');
  return value;
}

function subject(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  const id = string(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiFailure('PROVIDER_ERROR');
  return id;
}

const maxTokenLifetimeSeconds = 31_536_000;

function lifetimeSeconds(expiry: unknown): number | undefined {
  if (expiry === undefined) return undefined;
  const seconds = typeof expiry === 'number' || typeof expiry === 'string' ? Number(expiry) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxTokenLifetimeSeconds) throw new ApiFailure('PROVIDER_ERROR');
  return seconds;
}

export function createOAuthTransport(fetcher = fetch, now = Date.now) {
  async function request(url: string, options: RequestInit, isToken = false): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ApiFailure('PROVIDER_ERROR');
    }
    const limited = rateLimitFailure(response);
    if (limited) throw limited;
    if (response.status === 401 || response.status === 403) {
      throw new ApiFailure(isToken ? 'PROVIDER_ERROR' : 'ACCESS_DENIED');
    }
    if (response.status === 404) throw new ApiFailure('NOT_FOUND');
    if (!response.ok && !(isToken && response.status === 400)) throw new ApiFailure('PROVIDER_ERROR');
    try {
      return record(await response.json());
    } catch {
      throw new ApiFailure('PROVIDER_ERROR');
    }
  }

  async function exchange(registration: Registration, parameters: Record<string, string>, previous?: Tokens): Promise<Tokens> {
    const payload = await request(registration.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: registration.clientId, client_secret: registration.secret,
        ...(registration.provider === 'azure-devops' && { scope: registration.requestedScope }),
        ...parameters,
      }),
    }, true);
    const error = payload['error'];
    if (error === 'invalid_grant' || error === 'bad_verification_code' || error === 'bad_refresh_token') {
      throw new ApiFailure(previous ? 'ACCESS_DENIED' : 'INVALID_REQUEST');
    }
    if (error !== undefined) throw new ApiFailure('PROVIDER_ERROR');
    if (string(payload['token_type']).toLowerCase() !== 'bearer') throw new ApiFailure('PROVIDER_ERROR');
    const accessToken = string(payload['access_token']);
    if (registration.provider === 'github' &&
        !accessToken.startsWith('ghu_') && !(registration.purpose === 'copilot' && accessToken.startsWith('gho_'))) {
      throw new ApiFailure('PROVIDER_ERROR');
    }
    const seconds = lifetimeSeconds(payload['expires_in']);
    const refreshed = payload['refresh_token'];
    return {
      accessToken, refreshToken: refreshed === undefined ? previous?.refreshToken ?? null : string(refreshed),
      expiresAt: seconds === undefined ? null : now() + seconds * 1_000,
    };
  }

  type Headers = NonNullable<RequestInit['headers']>;

  async function findInPages(origin: string, path: string, key: string, headers: Headers, match: (value: unknown) => boolean) {
    for (let page = 1; page <= 20; page += 1) {
      const values = (await request(`${origin}${path}?per_page=100&page=${page}`, { headers }))[key];
      if (!Array.isArray(values)) throw new ApiFailure('PROVIDER_ERROR');
      const value: unknown = values.find(match);
      if (value !== undefined) return value;
      if (values.length < 100) return undefined;
    }
    throw new ApiFailure('ACCESS_UNVERIFIED');
  }

  async function githubRepository(registration: Registration, target: RepoTarget, headers: Headers): Promise<VerifiedRepository> {
    const body = await request(
      `${registration.apiOrigin}/repos/${encodeURIComponent(target.scope)}/${encodeURIComponent(target.name)}`, { headers },
    );
    const owner = record(body['owner']);
    const ownerName = string(owner['login']);
    const repoName = string(body['name']);
    if (!isGitHubName(ownerName) || !isGitHubName(repoName)) throw new ApiFailure('PROVIDER_ERROR');
    const ownerId = subject(owner['id']);
    const repoId = subject(body['id']);
    const installation = await findInPages(registration.apiOrigin, '/user/installations', 'installations', headers,
      (value) => subject(record(record(value)['account'])['id']) === ownerId);
    if (installation === undefined) throw new ApiFailure('ACCESS_DENIED');
    const installationRecord = record(installation);
    const installedPermissions = record(installationRecord['permissions']);
    if (!['issues', 'pull_requests'].every((permission) =>
      installedPermissions[permission] === 'read' || installedPermissions[permission] === 'write')) {
      throw new ApiFailure('ACCESS_DENIED');
    }
    const installationId = subject(installationRecord['id']);
    const accessible = await findInPages(registration.apiOrigin, `/user/installations/${installationId}/repositories`, 'repositories', headers,
      (value) => subject(record(value)['id']) === repoId);
    if (accessible === undefined) throw new ApiFailure('ACCESS_DENIED');
    return {
      id: repoId, scope: ownerId, name: repoName, host: target.host,
      url: `https://${target.host}/${encodeURIComponent(ownerName)}/${encodeURIComponent(repoName)}`,
    };
  }

  async function azureRepository(registration: Registration, target: RepoTarget, headers: Headers): Promise<VerifiedRepository> {
    const scope = encodeURIComponent(target.scope);
    const project = encodeURIComponent(target.project ?? '');
    const body = await request(
      `${registration.apiOrigin}/${scope}/${project}/_apis/git/repositories/${encodeURIComponent(target.name)}?api-version=7.1`, { headers },
    );
    const projectRecord = record(body['project']);
    const repoName = string(body['name']);
    return {
      id: subject(body['id']), scope: subject(projectRecord['id']), name: repoName, host: target.host,
      url: `${registration.apiOrigin}/${scope}/${encodeURIComponent(string(projectRecord['name']))}/_git/${encodeURIComponent(repoName)}`,
    };
  }

  const repository = (registration: Registration, target: RepoTarget, headers: Headers) =>
    registration.provider === 'github' ? githubRepository(registration, target, headers) : azureRepository(registration, target, headers);

  return {
    async redeem({ registration, callback, code, verifier, target }: Redemption): Promise<VerifiedAuthorization> {
      const tokens = await exchange(registration, {
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback,
      });
      const headers = bearerHeaders(tokens.accessToken);
      const person = await request(registration.profileUrl, { headers });
      const label = registration.provider === 'github'
        ? person['name'] || person['login'] : person['displayName'];
      const account = subject(person['id']);
      const repo = target && await repository(registration, target, headers).catch((error: unknown) => {
        if (error instanceof ApiFailure && (error.code === 'ACCESS_DENIED' || error.code === 'NOT_FOUND')) {
          throw new RepositoryAuthorizationDenied(account);
        }
        throw error;
      });
      return {
        subject: account, label: string(label), avatarUrl: publicHttpsUrl(person['avatar_url']), tokens,
        ...(repo && { repo }),
      };
    },
    refresh(registration: Registration, previous: Tokens): Promise<Tokens> {
      if (!previous.refreshToken) throw new ApiFailure('ACCESS_DENIED');
      return exchange(registration, { grant_type: 'refresh_token', refresh_token: previous.refreshToken }, previous);
    },
  };
}
