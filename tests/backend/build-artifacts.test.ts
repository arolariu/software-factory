import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  copyFileSync(new URL('../../scripts/build-artifacts.mjs', import.meta.url), join(root, 'scripts', 'build-artifacts.mjs'));
  writeFileSync(join(root, 'src', 'server', 'persistence', '001-foundation.sql'), sql);
});

afterEach(() => rmSync(root, { recursive: true }));

function stamp(builtAt: string) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'build-artifacts.mjs')], {
    env: { ...process.env, BUILD_REVISION: revision, BUILD_TIMESTAMP: builtAt, BUILD_RUN_URL: runUrl },
    encoding: 'utf8',
  });
}

it('copies the migration and writes metadata for the exact producing run attempt', () => {
  expect(stamp('2026-11-26T21:32:00Z').status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8'))).toEqual({
    revision, builtAt: '2026-11-26T21:32:00.000Z', runUrl,
  });
  expect(readFileSync(join(root, 'dist', 'server', 'persistence', '001-foundation.sql'), 'utf8')).toBe(sql);
});

it('rejects an impossible UTC build date instead of silently changing it', () => {
  const result = stamp('2026-02-30T21:32:00Z');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('BUILD_TIMESTAMP');
});
