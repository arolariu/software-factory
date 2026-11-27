import { expect, it } from 'vitest';
import { createRegistry, parseIdentityConfig } from './github-hosts.js';

const app = { id: 'signin', clientId: 'signin', secret: 'test' };
const github = { hostname: 'github.com', label: 'GitHub', registrations: { portal: app } };
const withRepo = { ...github, registrations: { ...github.registrations, repository: { ...app, id: 'repo', clientId: 'repo' } } };
const entra = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', registration: { ...app, id: 'entra' } };

it('requires a canonical HTTPS public origin and resolves only configured host registries', () => {
  const { origin, registry } = parseIdentityConfig({ publicOrigin: 'https://factory.example', github: [github] });
  expect(origin).toBe('https://factory.example');
  expect(registry.githubHosts()).toEqual([{ hostname: 'github.com', id: 'github.com', label: 'GitHub' }]);
  expect(registry.registration('github.com', 'portal').apiOrigin).toBe('https://api.github.com');
  expect(() => registry.registration('github.com', 'repository')).toThrow('INVALID_REQUEST');
  expect(registry.bound('foreign.ghe.com', 'portal', 'unrecognized')).toBeUndefined();
  for (const publicOrigin of ['bad-url', 'http://example.test', 'https://example.test/path']) {
    expect(() => parseIdentityConfig({ publicOrigin, github: [github] })).toThrow('Invalid public HTTPS origin');
  }
  expect(() => parseIdentityConfig({ publicOrigin: 'https://factory.example', github: [], azureDevOps: { ...entra, tenantId: 'common' } }))
    .toThrow('Invalid identity configuration');
  expect(() => createRegistry([github, github])).toThrow(/distinct/);
  expect(() => createRegistry([{ ...github, hostname: 'github.example.test' }])).toThrow(/explicitly configured/);
  expect(() => createRegistry([{ ...github, registrations: { portal: app, copilot: app } }])).toThrow(/distinct app/);
});

it.each([
  'invalid',
  'http://github.com/o/r',
  'https://u@github.com/o/r',
  'https://u:p@github.com/o/r',
  'https://github.com:555/o/r',
  'https://github.com/o/r?redirect=other',
  'https://github.com/o/r#section',
  'https://github.com/o\\r',
  'https://github.com/o/r/extra',
  'https://github.com/o/',
  'https://github.com/o%20o/r',
  'https://github.com/o/r%20r',
  'https://unknown.ghe.com/o/r',
])('rejects a noncanonical or unsupported GitHub repo URL before any outbound request (%s)', (url) => {
  expect(() => createRegistry([withRepo]).repository(url, 'github')).toThrow('INVALID_REQUEST');
});

it.each([
  'https://other.example/org/project/_git/repo',
  'https://dev.azure.com/org/project/repo',
  'https://dev.azure.com/org/project/_repos/repo',
  'https://dev.azure.com//project/_git/repo',
  'https://dev.azure.com/org%20name/project/_git/repo',
  'https://dev.azure.com/org//_git/repo',
  'https://dev.azure.com/org/project/_git/',
  'https://dev.azure.com/org/proj%2Fect/_git/repo',
  'https://dev.azure.com/org/project/_git/re%2Fpo',
  'https://dev.azure.com/org/proj%zz/_git/repo',
])('rejects Azure DevOps paths outside its supported canonical URL form (%s)', (url) => {
  expect(() => createRegistry([withRepo], entra).repository(url, 'azure-devops')).toThrow('INVALID_REQUEST');
});
