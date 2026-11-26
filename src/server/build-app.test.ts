import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './build-app.js';
import { migrate } from './persistence/migrations.js';
import { openDatabase } from './persistence/open.js';

let directory: string;
let db: ReturnType<typeof openDatabase>;
let app: FastifyInstance | undefined;

const build = {
  revision: 'a'.repeat(40),
  builtAt: '2026-11-26T21:32:00.000Z',
  runUrl: 'https://github.com/arolariu/software-factory/actions/runs/123/attempts/2',
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'factory-foundation-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<main>Factory test entry</main>');
  writeFileSync(join(directory, 'assets', 'app-hash.js'), 'export {};');
  db = openDatabase(join(directory, 'factory.sqlite'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (db?.open) db.close();
  rmSync(directory, { recursive: true });
});

async function makeApp(isDraining?: () => boolean) {
  app = await buildApp({ db, staticRoot: directory, build, ...(isDraining && { isDraining }) });
  return app;
}

function seedConnections() {
  db.exec(`
    INSERT INTO users(id) VALUES ('u1'), ('u2');
    INSERT INTO identities(id, user_id, provider, issuer, subject)
      VALUES ('i1', 'u1', 'github', 'github.com', '101'),
             ('i2', 'u2', 'github', 'github.com', '102');
    INSERT INTO repositories(id, provider, canonical_host, provider_scope, provider_repo_id, canonical_url)
      VALUES ('r1', 'github', 'github.com', 'org', '23', 'https://github.com/example/repo');
    INSERT INTO repo_connections(id, repo_id, user_id, identity_id, connected_at)
      VALUES ('c1', 'r1', 'u1', 'i1', 1), ('c2', 'r1', 'u2', 'i2', 1);
  `);
}

describe('Fastify foundation', () => {
  it('reports healthy only after migration and stops reporting readiness during drain', async () => {
    let draining = false;
    const server = await makeApp(() => draining);
    expect((await server.inject('/healthz')).statusCode).toBe(503);

    migrate(db);
    const ready = await server.inject('/healthz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok' });

    draining = true;
    expect((await server.inject('/healthz')).statusCode).toBe(503);
  });

  it('serves the static entry, immutable assets, and artifact build metadata', async () => {
    const server = await makeApp();
    for (const url of ['/', '/connections/example/issues']) {
      const html = await server.inject({ url, headers: { accept: 'text/html' } });
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain('Factory test entry');
      expect(html.headers['cache-control']).toContain('no-cache');
    }
    const asset = await server.inject('/assets/app-hash.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await server.inject('/api/build')).json()).toEqual(build);
  });

  it('refuses to serve if the portal entry is not a file', async () => {
    rmSync(join(directory, 'index.html'));
    mkdirSync(join(directory, 'index.html'));
    await expect(makeApp()).rejects.toThrow('compiled portal assets');
  });

  it('does not rewrite API, auth, asset errors, or unsafe requests to the SPA', async () => {
    const server = await makeApp();
    for (const [method, url] of [
      ['GET', '/api'], ['GET', '/api/absent'], ['GET', '/auth/github/callback'],
      ['GET', '/assets/absent.js'], ['GET', '/missing.css'], ['POST', '/connections/example'],
    ] as const) {
      const response = await server.inject({ method, url, headers: { accept: 'text/html' } });
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain('Factory test entry');
    }
    expect((await server.inject('/connections/example')).statusCode).toBe(404);
    expect((await server.inject({ url: '/repo', headers: { accept: 'text/html;q=0' } })).statusCode).toBe(404);
    expect((await server.inject({
      url: '/repo', headers: { accept: 'text/html', 'sec-fetch-mode': 'cors' },
    })).statusCode).toBe(404);
  });

  it('does not rewrite missing reserved routes in absolute-form requests to the SPA', async () => {
    const server = await makeApp();
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    for (const path of ['/api/missing', '/auth/missing', '/assets/missing']) {
      const status = await new Promise<number | undefined>((done, fail) => {
        get(origin, { path: `http://localhost${path}`, headers: { accept: 'text/html' } }, (response) => {
          response.resume();
          done(response.statusCode);
        }).on('error', fail);
      });
      expect(status, path).toBe(404);
    }
  });
});

describe('SQLite foundation', () => {
  it('retains connections across reopened WAL databases and idempotent migrations', () => {
    migrate(db);
    seedConnections();
    db.close();
    db = openDatabase(join(directory, 'factory.sqlite'));
    migrate(db);
    expect(db.prepare('SELECT id FROM repo_connections ORDER BY id').all()).toEqual([
      { id: 'c1' }, { id: 'c2' },
    ]);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('rolls back a failed migration without advancing readiness', async () => {
    expect(() => migrate(db, [{
      version: 1,
      sql: 'CREATE TABLE partial (id TEXT); INSERT INTO nonexistent VALUES (1);',
    }])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeUndefined();
    expect((await (await makeApp()).inject('/healthz')).statusCode).toBe(503);
  });

  it('rejects readiness if a required schema object is missing despite the current version', async () => {
    migrate(db);
    db.exec('DROP INDEX one_active_task_per_repo_item');
    expect((await (await makeApp()).inject('/healthz')).statusCode).toBe(503);
  });

  it('rejects cross-owner connections and snapshots, and permits replacement only after retirement', () => {
    migrate(db);
    seedConnections();
    const connect = db.prepare(`
      INSERT INTO repo_connections(id, repo_id, user_id, identity_id, connected_at)
      VALUES (?, 'r1', 'u1', ?, 1)
    `);
    const insertSnapshot = db.prepare(`
      INSERT INTO repo_snapshots(connection_id, repo_id, user_id, identity_id, kind, payload_json, fetched_at)
      VALUES ('c2', 'r1', 'u1', 'i1', 'work_items', '[]', 1)
    `);
    expect(() => insertSnapshot.run()).toThrow(/FOREIGN KEY/);
    expect(() => connect.run('duplicate', 'i1')).toThrow(/UNIQUE/);
    db.exec("UPDATE repo_connections SET retired_at = 2 WHERE id = 'c1'");
    expect(() => connect.run('cross-owner', 'i2')).toThrow(/FOREIGN KEY/);
    expect(() => connect.run('replacement', 'i1')).not.toThrow();
  });

  it('rejects a second active task for the same canonical item even across connections', () => {
    migrate(db);
    seedConnections();
    const reserve = db.prepare(`
      INSERT INTO tasks(id, connection_id, repo_id, requester_id, repo_identity_id, copilot_identity_id,
                        work_item_key, start_request_id, runtime_kind, runtime_scope, state, created_at, updated_at)
      VALUES (?, ?, 'r1', ?, ?, ?, '23', ?, 'github_cloud', 'github.com', 'queued', 1, 1)
    `);
    expect(() => reserve.run('t0', 'c2', 'u1', 'i1', 'i1', 'foreign')).toThrow(/FOREIGN KEY/);
    reserve.run('t1', 'c1', 'u1', 'i1', 'i1', 'req1');
    expect(() => reserve.run('t2', 'c2', 'u2', 'i2', 'i2', 'req2')).toThrow(/UNIQUE/);
    db.exec("UPDATE tasks SET state = 'completed' WHERE id = 't1'");
    expect(() => reserve.run('t2', 'c2', 'u2', 'i2', 'i2', 'req2')).not.toThrow();
  });
});
