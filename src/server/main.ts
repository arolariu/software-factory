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

export function verifyContainerData(dataDir: string, mode: number, mountInfo: string): void {
  const mounted = mountInfo.split('\n').some((line) => line.split(' ')[4] === '/data');
  if (dataDir !== '/data' || !mounted || (mode & 0o077) !== 0) {
    throw new Error('The container requires a private, writable mount at /data.');
  }
}

export async function startServer(options: StartupOptions) {
  const { port, artifactDir, logger = false } = options;
  const dataDir = resolve(options.dataDir);
  if (!Number.isInteger(port) || port < (options.container ? 1 : 0) || port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  const dataInfo = statSync(dataDir);
  if (!dataInfo.isDirectory()) throw new Error('Factory data path must be a directory.');
  if (options.container) verifyContainerData(dataDir, dataInfo.mode, readFileSync('/proc/self/mountinfo', 'utf8'));
  accessSync(dataDir, constants.W_OK);

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
    const port = Number(env['PORT'] ?? '3000');
    if (port === 0) throw new Error('PORT must be a valid TCP port.');
    const server = await startServer({
      dataDir: env['FACTORY_DATA_DIR'] ?? '/data',
      port,
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
