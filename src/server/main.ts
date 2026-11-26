import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type BuildMetadata } from './build-app.js';
import { migrate } from './persistence/migrations.js';
import { openDatabase } from './persistence/open.js';

async function main() {
  const dataDir = resolve(process.env.FACTORY_DATA_DIR ?? '/data');
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (!statSync(dataDir).isDirectory()) throw new Error('Factory data path must be a directory.');
  accessSync(dataDir, constants.W_OK);

  const staticRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const build = JSON.parse(readFileSync(new URL('../build.json', import.meta.url), 'utf8')) as BuildMetadata;
  const db = openDatabase(join(dataDir, 'factory.sqlite'));
  let draining = false;

  try {
    migrate(db);
    const app = await buildApp({ db, staticRoot, build, isDraining: () => draining, logger: true });
    const shutdown = async () => {
      if (draining) return;
      draining = true;
      const deadline = setTimeout(() => process.exit(1), 8_000).unref();
      try {
        await app.close();
      } finally {
        db.close();
        clearTimeout(deadline);
      }
    };
    await app.listen({ host: '0.0.0.0', port });
    const stop = () => void shutdown().catch(() => { process.exitCode = 1; });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    db.close();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  console.error('Software Factory failed to start:', error instanceof Error ? error.message : 'unexpected error');
  process.exitCode = 1;
}
