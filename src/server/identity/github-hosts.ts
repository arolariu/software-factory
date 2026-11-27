import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { strictObject } from '../../shared/api/schemas.js';
import { sha256Hex } from '../digest.js';
import { ApiFailure } from '../http/problems.js';
import type { AuthorizationProvider } from '../http/portal-modules.js';

const nonempty = Type.String({ minLength: 1 });
const app = strictObject({ id: nonempty, clientId: nonempty, secret: nonempty, scope: Type.Optional(nonempty) });
const profile = strictObject({
  hostname: nonempty, label: nonempty,
  registrations: strictObject({
    portal: app, repository: Type.Optional(app), copilot: Type.Optional(app),
  }),
});
const entra = strictObject({
  tenantId: Type.String({ pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' }),
  registration: app,
});
const config = strictObject({
  publicOrigin: nonempty, github: Type.Array(profile), azureDevOps: Type.Optional(entra),
});

type App = Static<typeof app>;
export type GitHubHostProfile = Static<typeof profile>;
export type Purpose = 'portal' | 'repository' | 'copilot';
export type IdentityProvider = 'github' | 'azure_devops';
export interface Registration extends App {
  hostId: string;
  issuer: string;
  provider: AuthorizationProvider;
  purpose: Purpose;
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  apiOrigin: string;
  requestedScope: string;
  binding: string;
}
export interface RepoTarget { host: string; scope: string; project: string | null; name: string }

export const isGitHubName = (value: string) => /^[\w.-]+$/.test(value);
export const storedProvider = (provider: AuthorizationProvider): IdentityProvider =>
  provider === 'github' ? 'github' : 'azure_devops';

export function createRegistry(hosts: readonly GitHubHostProfile[], azureDevOps?: Static<typeof entra>) {
  const entries = new Map<string, Registration>();
  const labels = new Map<string, string>();
  const appIds = new Set<string>();

  function add(spec: App, options: Omit<Registration, keyof App | 'binding'>) {
    const appKey = JSON.stringify([options.issuer, spec.clientId]);
    if (appIds.has(appKey)) throw new Error('Authorization purposes require distinct app registrations.');
    appIds.add(appKey);
    const binding = sha256Hex(JSON.stringify([options, spec.id, spec.clientId]));
    entries.set(`${options.hostId}:${options.purpose}`, { ...spec, ...options, binding });
  }
  for (const host of hosts) {
    const id = host.hostname;
    if (!/^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/.test(id) || labels.has(id)) {
      throw new Error('GitHub hosts must be distinct, explicitly configured github.com or tenant.ghe.com names.');
    }
    labels.set(id, host.label);
    const apiOrigin = id === 'github.com' ? 'https://api.github.com' : `https://api.${id}`;
    for (const purpose of ['portal', 'repository', 'copilot'] as const) {
      const spec = host.registrations[purpose];
      if (!spec) continue;
      add(spec, {
        hostId: id, issuer: id, provider: 'github', purpose, apiOrigin,
        authorizeUrl: `https://${id}/login/oauth/authorize`, tokenUrl: `https://${id}/login/oauth/access_token`,
        profileUrl: `${apiOrigin}/user`, requestedScope: spec.scope ?? 'offline_access',
      });
    }
  }
  if (azureDevOps) {
    const hostId = 'azure-devops';
    const issuer = `login.microsoftonline.com/${azureDevOps.tenantId.toLowerCase()}`;
    add(azureDevOps.registration, {
      hostId, issuer, provider: 'azure-devops', purpose: 'repository', apiOrigin: 'https://dev.azure.com',
      authorizeUrl: `https://${issuer}/oauth2/v2.0/authorize`, tokenUrl: `https://${issuer}/oauth2/v2.0/token`,
      profileUrl: 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
      requestedScope: '499b84ac-1321-427f-aa17-267ca6975798/.default offline_access',
    });
  }
  return {
    githubHosts: () => [...labels].map(([hostname, label]) => ({ id: hostname, hostname, label })),
    registration(hostId: string, purpose: Purpose): Registration {
      const entry = entries.get(`${hostId}:${purpose}`);
      if (!entry) throw new ApiFailure('INVALID_REQUEST');
      return entry;
    },
    bound(hostId: string, purpose: Purpose, binding: string): Registration | undefined {
      const entry = entries.get(`${hostId}:${purpose}`);
      return entry?.binding === binding ? entry : undefined;
    },
    repository(raw: string, provider: AuthorizationProvider): { hostId: string; target: RepoTarget } {
      let url: URL;
      try { url = new URL(raw); } catch { throw new ApiFailure('INVALID_REQUEST'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || raw.includes('\\')) {
        throw new ApiFailure('INVALID_REQUEST');
      }
      const host = url.hostname;
      const hostId = provider === 'github' ? host : 'azure-devops';
      const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
      if (!entries.has(`${hostId}:repository`)) throw new ApiFailure('INVALID_REQUEST');
      if (provider === 'github') {
        const [scope, name] = parts;
        if (parts.length !== 2 || !scope || !name || !isGitHubName(scope) || !isGitHubName(name)) {
          throw new ApiFailure('INVALID_REQUEST');
        }
        return { hostId, target: { host, scope, project: null, name } };
      }
      const [scope, encodedProject, marker, encodedName] = parts;
      if (host !== 'dev.azure.com' || parts.length !== 4 || marker !== '_git' || !scope ||
          !/^[A-Za-z0-9-]+$/.test(scope) || !encodedProject || !encodedName) throw new ApiFailure('INVALID_REQUEST');
      try {
        const project = decodeURIComponent(encodedProject);
        const name = decodeURIComponent(encodedName);
        if (!/^[\p{L}\p{N} _.-]+$/u.test(project) || !/^[\p{L}\p{N} _.-]+$/u.test(name) || project === '.' || name === '.') {
          throw new Error('Unsupported repository path');
        }
        return { hostId, target: { host, scope, project, name } };
      } catch {
        throw new ApiFailure('INVALID_REQUEST');
      }
    },
  };
}

export function parseIdentityConfig(input: unknown) {
  if (!Value.Check(config, input)) throw new Error('Invalid identity configuration.');
  let origin: URL;
  try { origin = new URL(input.publicOrigin); } catch { throw new Error('Invalid public HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.origin !== input.publicOrigin) throw new Error('Invalid public HTTPS origin.');
  return { origin: origin.origin, registry: createRegistry(input.github, input.azureDevOps) };
}

export type Registry = ReturnType<typeof createRegistry>;
