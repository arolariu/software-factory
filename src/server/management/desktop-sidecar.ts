import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { desktopOrigin, startServer, StartupAssetsError } from '../main.js';
import { InstanceLockError } from '../persistence/instance-lock.js';
import { ManagementVaultError, OwnerAppError } from './runtime.js';

type SidecarOptions = { dataDir: string; artifactDir: string; githubClientId?: string };
const invalidFrame = 'Invalid desktop startup frame.';
const startupCode = (error: unknown) => error instanceof StartupAssetsError ? 'assets'
  : error instanceof InstanceLockError ? 'locked' : error instanceof OwnerAppError ? 'owner'
    : error instanceof ManagementVaultError ? 'vault' : 'startup';

export async function runDesktopSidecar(control: Readable, readiness: Writable, options: SidecarOptions) {
  const reader = control.iterator({ destroyOnReturn: false });
  const frame = Buffer.alloc(64);
  const timeout = setTimeout(() => control.destroy(new Error(invalidFrame)), 10_000).unref();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    let offset = 0;
    while (offset < frame.length) {
      const { value, done } = await reader.next();
      if (done || !Buffer.isBuffer(value) || offset + value.length > frame.length) throw new Error(invalidFrame);
      offset += value.copy(frame, offset);
    }
    clearTimeout(timeout);
    let parentClosed = false;
    const closed = reader.next().then(
      (result) => { parentClosed = true; return result.done === true; },
      () => { parentClosed = true; return false; },
    );
    const starting = startServer({
      artifactDir: options.artifactDir,
      dataDir: options.dataDir,
      port: 0,
      desktop: { channelToken: frame.toString('hex', 0, 32) },
      management: {
        publicOrigin: desktopOrigin,
        loadVaultKey: () => frame.subarray(32),
        ...(options.githubClientId === undefined ? {} : { githubClientId: options.githubClientId }),
      },
    });
    try { server = await starting; }
    catch (error) {
      if (!parentClosed) await new Promise<void>((resolve) => readiness.write(`error ${startupCode(error)}\n`, () => resolve()));
      throw error;
    }
    frame.fill(0);
    if (!parentClosed) {
      const port = new URL(server.address).port;
      await new Promise<void>((resolve, reject) => {
        readiness.write(`ready ${port}\n`, (error) => { if (error) reject(error); else resolve(); });
      });
    }
    if (!await closed) throw new Error('Invalid desktop control stream.');
  } finally {
    clearTimeout(timeout);
    frame.fill(0);
    control.destroy();
    await server?.close();
  }
}

if (import.meta.main) {
  const [, , dataDir, githubClientId] = process.argv;
  if (!dataDir) process.exitCode = 1;
  else {
    await runDesktopSidecar(process.stdin, process.stdout, {
      dataDir,
      artifactDir: fileURLToPath(new URL('../../', import.meta.url)),
      ...(githubClientId === undefined ? {} : { githubClientId }),
    }).catch(() => { process.exitCode = 1; });
  }
}
