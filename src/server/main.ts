import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type BuildMetadata } from './build-app.js';
import { hasCurrentSchema, migrate } from './persistence/migrations.js';
import { openDatabase } from './persistence/open.js';

interface StartupOptions {
  dataDir: string;
  artifactDir: string;
  port: number;
  container?: boolean;
  logger?: boolean;
}

const supportedDataFilesystems = new Set(['ext4', 'xfs', 'btrfs', 'zfs']);
const invalidPort = 'PORT must be a valid TCP port.';

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
  const dataDir = resolve(options.dataDir);
  if (!Number.isInteger(port) || port < (options.container ? 1 : 0) || port > 65535) throw new Error(invalidPort);
  verifyDataDirectory(dataDir, options.container);

  const build = JSON.parse(readFileSync(join(artifactDir, 'build.json'), 'utf8')) as BuildMetadata;
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  let draining = false;

  try {
    migrate(db);
    if (!hasCurrentSchema(db)) throw new Error('The database is missing required schema objects.');
    const app = await buildApp({ db, staticRoot: join(artifactDir, 'web'), build, isDraining: () => draining, logger });
    const address = await app.listen({ host: '0.0.0.0', port });
    const close = async () => {
      if (draining) return;
      draining = true;
      try {
        await app.close();
      } finally {
        db.close();
      }
    };
    return { address, close };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function runCli(env = process.env, args = process.argv, artifactDir = fileURLToPath(new URL('../', import.meta.url))) {
  try {
    const server = await startServer({
      dataDir: env['FACTORY_DATA_DIR'] ?? '/data',
      port: parsePort(env['PORT'] ?? '3000'),
      artifactDir,
      container: args.includes('--container'),
      logger: true,
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
