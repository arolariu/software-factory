import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;
const sql = 'CREATE TABLE example (id INTEGER);';
const revision = '8'.repeat(40);
const runUrl = 'https://github.com/arolariu/software-factory/actions/runs/321/attempts/2';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-artifacts-'));
  for (const dir of ['scripts', 'src/server/persistence', 'dist/server/persistence']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'src', 'server', 'persistence', '001-foundation.sql'), sql);
});

afterEach(() => rmSync(root, { recursive: true }));

function stamp(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [fileURLToPath(new URL('./build-artifacts.sh', import.meta.url))], {
    cwd: root,
    env: { ...process.env, BUILD_REVISION: '', BUILD_TIMESTAMP: '', BUILD_RUN_URL: '', ...overrides },
    encoding: 'utf8',
  });
}

it('copies the migration and writes metadata for the exact producing run attempt', () => {
  expect(stamp({ BUILD_REVISION: revision, BUILD_TIMESTAMP: '2026-11-26T21:32:00Z', BUILD_RUN_URL: runUrl }).status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8'))).toEqual({
    revision, builtAt: '2026-11-26T21:32:00.000Z', runUrl,
  });
  expect(readFileSync(join(root, 'dist', 'server', 'persistence', '001-foundation.sql'), 'utf8')).toBe(sql);
});

it('keeps local provenance null', () => {
  expect(stamp().status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8'))).toEqual({
    revision: null, builtAt: null, runUrl: null,
  });
});

it.each([
  ['BUILD_TIMESTAMP', '2026-02-30T21:32:00Z'],
  ['BUILD_REVISION', 'abc'],
  ['BUILD_RUN_URL', 'https://example.test/arolariu/software-factory/actions/runs/321'],
])('rejects invalid %s before publishing metadata', (key, value) => {
  const result = stamp({ [key]: value });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(key);
  expect(existsSync(join(root, 'dist', 'build.json'))).toBe(false);
});
