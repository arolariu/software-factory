import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import type SQLite from 'better-sqlite3';
import { openCredentialVault } from '../identity/credentials.js';
import { createRegistry } from '../identity/github-hosts.js';
import { createConfiguredPortal } from '../identity/portal.js';
import { createGitHubDeviceFlow } from '../identity/device-flow.js';
import { createAuthorizationService } from './authorization.js';
import { createManagementSettings } from './settings.js';
import { createSetupStore } from './setup.js';
import { loadOrInitializeVaultKey } from './vault-key.js';
import type { CatalogInspection } from '../identity/copilot-catalog.js';

export class OwnerAppError extends Error {}
export class ManagementVaultError extends Error {}

export function managementOrigin(value: string): string {
  const parsed = URL.parse(value);
  if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== value) {
    throw new Error('Management mode requires a canonical HTTPS public origin.');
  }
  return parsed.origin;
}

export function assertManagementData(db: SQLite.Database) {
  const setup = createSetupStore(db);
  if (!setup.owner() && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    throw new Error('Management setup cannot claim a populated legacy instance.');
  }
  return setup;
}

export interface ManagementOptions {
  publicOrigin: string;
  githubClientId?: string;
  // The runtime clears the returned buffer after opening the vault.
  loadVaultKey?: (vaultExists: boolean) => Buffer;
  inspectCopilot?: CatalogInspection;
}

export function openManagementRuntime(db: SQLite.Database, dataDir: string, options: ManagementOptions, fetcher = fetch) {
  const origin = managementOrigin(options.publicOrigin);
  const setup = assertManagementData(db);
  const vaultPath = join(dataDir, 'credentials.sqlite');
  const { githubClientId, inspectCopilot } = options;
  const copilotEnabled = inspectCopilot !== undefined;
  const registry = createRegistry(githubClientId ? [{
    hostname: 'github.com', label: 'GitHub', deviceClientId: githubClientId, copilotEnabled,
  }] : []);
  const owner = setup.owner();
  if (owner && !registry.bound(owner.host, 'portal', owner.registrationId)) {
    throw new OwnerAppError('Configured GitHub App does not match the Factory owner. Restore the current Client ID or rebind the owner.');
  }
  const vaultExists = existsSync(vaultPath);
  const key = (() => {
    try { return options.loadVaultKey ? options.loadVaultKey(vaultExists)
      : loadOrInitializeVaultKey(join(dataDir, 'management-vault.key'), vaultExists); }
    catch (error) {
      if (!options.loadVaultKey) throw error;
      throw new ManagementVaultError('Could not load the native credential vault key.');
    }
  })();
  try {
    const vault = (() => {
      try { return openCredentialVault(vaultPath, key); }
      catch (error) {
        if (!options.loadVaultKey) throw error;
        throw new ManagementVaultError('Could not open the native credential vault.');
      }
    })();
    const cursorKey = createHmac('sha256', key).update('software-factory/repository-cursors/v1').digest();
    const lifecycle = new AbortController();
    const fetchWhileOpen: typeof fetch = (input, options) => fetcher(input, {
      ...options, signal: AbortSignal.any([lifecycle.signal, ...(options?.signal ? [options.signal] : [])]),
    });
    const configured = githubClientId ? createConfiguredPortal(db, { origin, registry }, vault, cursorKey, fetchWhileOpen, inspectCopilot) : undefined;
    const settings = githubClientId ? createManagementSettings(db, githubClientId, copilotEnabled) : undefined;
    const authorization = configured && settings ? createAuthorizationService({
      db, vault, setup, registry, identity: configured.identity, transport: configured.transport, device: createGitHubDeviceFlow(fetchWhileOpen),
      repositoryAllowed: settings.repositoryAllowed, copilotEnabled,
    }) : undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending: Promise<void> | undefined;
    const stop = () => { clearInterval(timer); lifecycle.abort(); configured?.stop(); };
    return {
      origin, setup, authorization, portal: configured?.portal, settings,
      disconnectRepository: configured?.identity.disconnectRepository,
      start() {
        configured?.start();
        if (authorization) timer = setInterval(() => {
          if (pending) return;
          pending = authorization.pollNext().catch(() => console.error('Authorization worker failed.'))
            .finally(() => { pending = undefined; });
        }, 1_000).unref();
      },
      stop,
      async close() {
        stop();
        await pending;
        if (configured) await configured.close();
        else { cursorKey.fill(0); vault.close(); }
      },
    };
  } finally { key.fill(0); }
}
