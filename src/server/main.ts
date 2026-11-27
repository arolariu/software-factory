import { timingSafeEqual } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type BuildAppOptions, type BuildMetadata } from './build-app.js';
import { openIdentityPortal, type IdentityFiles } from './identity/portal.js';
import { hasCurrentSchema, migrate } from './persistence/migrations.js';
import { openDatabase } from './persistence/open.js';
import { openManagementRuntime, type ManagementOptions } from './management/runtime.js';
import { issueOperatorCode } from './management/operator.js';
import { rebindManagedOwner } from './management/owner-rebind.js';
import { createSetupStore } from './management/setup.js';

interface StartupOptions {
  dataDir: string;
  artifactDir: string;
  port: number;
  container?: boolean;
  logger?: boolean;
  identity?: IdentityFiles;
  management?: ManagementOptions;
  desktop?: { channelToken: string };
}

const supportedDataFilesystems = new Set(['ext4', 'xfs', 'btrfs', 'zfs']);
const invalidPort = 'PORT must be a valid TCP port.';
export const desktopOrigin = 'https://factory.localhost';
const channelPattern = /^[a-f0-9]{64}$/;

function desktopChannel(token: string): NonNullable<BuildAppOptions['allowRequest']> {
  const expected = Buffer.from(token, 'hex');
  return ({ headers, raw }) => {
    const supplied = headers['x-factory-desktop-channel'];
    const origin = headers.origin;
    return headers.host === `127.0.0.1:${raw.socket.localPort}` &&
      (origin === undefined || origin === desktopOrigin) && typeof supplied === 'string' &&
      channelPattern.test(supplied) && timingSafeEqual(expected, Buffer.from(supplied, 'hex'));
  };
}

export function verifyContainerData(dataDir: string, mode: number, mountInfo: string): void {
  const filesystem = mountInfo.split('\n')
    .findLast((line) => line.split(' ')[4] === '/data')?.split(' - ')[1]?.split(' ')[0];
  if (dataDir !== '/data' || !filesystem || !supportedDataFilesystems.has(filesystem) || (mode & 0o077) !== 0) {
    throw new Error('The container requires a private, writable mount at /data on ext4, XFS, Btrfs, or ZFS.');
  }
}

function verifyDataDirectory(dataDir: string, container: boolean | undefined): void {
  const info = statSync(dataDir);
  if (!info.isDirectory()) throw new Error('Factory data path must be a directory.');
  if (container) verifyContainerData(dataDir, info.mode, readFileSync('/proc/self/mountinfo', 'utf8'));
  accessSync(dataDir, constants.W_OK);
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) === 0) throw new Error(invalidPort);
  return Number(value);
}

export async function startServer(options: StartupOptions) {
  const { port, artifactDir, logger = false } = options;
  const { desktop } = options;
  if (desktop && (port !== 0 || options.container || options.identity ||
    options.management?.publicOrigin !== desktopOrigin || !options.management.loadVaultKey ||
    !channelPattern.test(desktop.channelToken))) {
    throw new Error('Desktop runtime requires ephemeral loopback, a native channel and a native vault key.');
  }
  const allowRequest = desktop && desktopChannel(desktop.channelToken);
  const dataDir = resolve(options.dataDir);
  if (!Number.isInteger(port) || port < (options.container ? 1 : 0) || port > 65535) throw new Error(invalidPort);
  verifyDataDirectory(dataDir, options.container);

  const build = JSON.parse(readFileSync(join(artifactDir, 'build.json'), 'utf8')) as BuildMetadata;
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  let auth: ReturnType<typeof openIdentityPortal> | undefined;
  let management: ReturnType<typeof openManagementRuntime> | undefined;
  let draining = false;

  try {
    migrate(db);
    if (!hasCurrentSchema(db)) throw new Error('The database is missing required schema objects.');
    if (options.management && options.identity) throw new Error('Configure either management mode or legacy identity, not both.');
    if (options.identity && createSetupStore(db).owner()) throw new Error('A claimed management instance cannot use legacy identity.');
    if (options.management) management = openManagementRuntime(db, dataDir, options.management);
    if (options.identity) auth = openIdentityPortal(db, dataDir, options.identity);
    const portal = auth?.portal ?? management?.portal;
    const app = await buildApp({
      db, staticRoot: join(artifactDir, 'web'), build, isDraining: () => draining, logger,
      ...(portal && { portal }),
      ...(management && { management }),
      ...(allowRequest && { allowRequest }),
    });
    const address = await app.listen({ host: desktop ? '127.0.0.1' : '0.0.0.0', port });
    auth?.start();
    management?.start();
    const close = async () => {
      if (draining) return;
      draining = true;
      auth?.stop();
      management?.stop();
      try {
        await app.close();
      } finally {
        await auth?.close();
        await management?.close();
        db.close();
      }
    };
    return { address, close };
  } catch (error) {
    await auth?.close();
    await management?.close();
    db.close();
    throw error;
  }
}

export async function runCli(env = process.env, args = process.argv, artifactDir = fileURLToPath(new URL('../', import.meta.url))) {
  try {
    const dataDir = env['FACTORY_DATA_DIR'] ?? '/data';
    const configFile = env['FACTORY_IDENTITY_CONFIG_FILE'];
    const managed = env['FACTORY_MANAGEMENT_MODE'] === '1';
    const publicOrigin = env['FACTORY_PUBLIC_ORIGIN'] ?? '';
    const githubClientId = env['FACTORY_GITHUB_CLIENT_ID'] ?? env['FACTORY_GITHUB_PORTAL_CLIENT_ID'];
    if (args[2] === 'setup-code') {
      if (!managed || configFile !== undefined) throw new Error('Setup code issuance requires management mode.');
      const code = issueOperatorCode(dataDir, publicOrigin, process.stdout.isTTY === true);
      process.stdout.write(`${code.code}\n`);
      return undefined;
    }
    if (args[2] === 'rebind-github-app') {
      if (!managed || configFile !== undefined) throw new Error('Owner rebind requires management mode.');
      await rebindManagedOwner(dataDir, publicOrigin, githubClientId, env['FACTORY_GITHUB_REBIND_CLIENT_ID'],
        process.stdout.isTTY === true, console.log);
      console.log('Owner verified. Start Factory with the replacement Client ID and sign in again.');
      return undefined;
    }
    const server = await startServer({
      dataDir,
      port: parsePort(env['PORT'] ?? '3000'),
      artifactDir,
      container: args.includes('--container'),
      logger: true,
      ...(managed && { management: {
        publicOrigin,
        ...(githubClientId && { githubClientId }),
      } }),
      ...(configFile !== undefined && { identity: {
        configFile, keyFile: env['FACTORY_CREDENTIAL_KEY_FILE'] ?? '/run/secrets/identity-key',
      } }),
    });
    const stop = async () => {
      process.off('SIGTERM', stop).off('SIGINT', stop);
      const deadline = setTimeout(() => process.exit(1), 8_000).unref();
      try {
        await server.close();
      } finally {
        clearTimeout(deadline);
      }
    };
    process.once('SIGTERM', stop).once('SIGINT', stop);
    return { ...server, close: stop };
  } catch (error) {
    console.error('Software Factory failed to start:', error);
    process.exitCode = 1;
    return undefined;
  }
}

if (import.meta.main) await runCli();
