import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type SQLite from 'better-sqlite3';
import Value from 'typebox/value';
import { ApiSchemas, type ApiDto, type OperationView } from '../../shared/api/schemas.js';
import type { Requester } from '../http/portal-modules.js';
import { ApiFailure } from '../http/problems.js';
import type { IssueRow, PullRequestRow, RepositoryAccess, RepositoryProvider } from './provider.js';

interface Access {
  resolve(id: string, requester: Requester): RepositoryAccess | undefined;
  readGrant(id: string, requester: Requester): 'valid' | 'denied' | 'unverified';
  verify(connection: RepositoryAccess, requester: Requester): Promise<void>;
  deny(id: string, requester: Requester, generation: number): void;
  recordVerification(id: string, requester: Requester, generation: number): void;
}
interface Options {
  db: SQLite.Database;
  cursorKey: Uint8Array;
  access: Access;
  provider(connection: RepositoryAccess, requester: Requester): RepositoryProvider | Promise<RepositoryProvider>;
  now?: () => number;
}
type Source = 'work_items' | 'pull_requests';
type SourceResults = NonNullable<OperationView['sources']>;
type Snapshot<Row> =
  | { freshness: 'unavailable' | 'not_synced'; items: null; fetchedAt: null; nextCursor: null }
  | { freshness: 'current' | 'stale'; items: Row[]; fetchedAt: string; nextCursor: string | null };
type Paging = { cursor?: string; limit?: string };
type Job = {
  id: string; connection_id: string; user_id: string; generation: number; state: OperationView['state'];
  problem_code: string | null; sources: string | null;
};
const catalog = ['work_items', 'pull_requests'] as const;
const status = (error: unknown) => error instanceof ApiFailure ? error.code : 'PROVIDER_ERROR';
const pageLimit = (input: { limit?: string }) => Number(input.limit ?? '50');

export function createRepositoryService({ db, cursorKey, access, provider, now = Date.now }: Options) {
  const byJob = db.prepare<[string], Job>('SELECT * FROM repository_sync WHERE id=?');
  const source = db.prepare<[string, Source, number], {
    revision: string | null; fetched_at: number | null; failed: number;
  }>('SELECT revision,fetched_at,failed FROM repository_sources WHERE connection_id=? AND source=? AND generation=?');
  const sourceRows = db.prepare<[string, Source, string, number, number], { ordinal: number; payload: string }>(`
    SELECT ordinal,payload FROM repository_rows WHERE connection_id=? AND source=? AND view_state=? AND ordinal>?
    ORDER BY ordinal LIMIT ?`);
  const mac = (encoded: string) => createHmac('sha256', cursorKey).update(encoded).digest();
  function cursor(scope: string, revision: string, position: number | string) {
    const encoded = Buffer.from(JSON.stringify([scope, revision, position])).toString('base64url');
    return `${encoded}.${mac(encoded).toString('base64url')}`;
  }
  function position<T extends number | string>(input: string | undefined, scope: string, revision: string, initial: T): T {
    if (input === undefined) return initial;
    const [encoded, signature, extra] = input.split('.');
    if (!encoded || !signature || extra !== undefined) throw new ApiFailure('SNAPSHOT_CHANGED');
    const bytes = Buffer.from(signature, 'base64url');
    const expected = mac(encoded);
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) throw new ApiFailure('SNAPSHOT_CHANGED');
    const [owner, current, value] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as [string, string, T];
    if (owner !== scope || current !== revision || typeof value !== typeof initial) throw new ApiFailure('SNAPSHOT_CHANGED');
    return value;
  }

  function connection(id: string, requester: Requester, cached = false) {
    const found = access.resolve(id, requester);
    if (!found) throw new ApiFailure('NOT_FOUND');
    const grant = access.readGrant(id, requester);
    if (grant === 'denied') throw new ApiFailure('ACCESS_DENIED');
    if (grant === 'unverified' && cached) throw new ApiFailure('ACCESS_UNVERIFIED');
    return { found, grant };
  }
  const current = (original: RepositoryAccess, principal: Requester) =>
    access.resolve(original.id, principal)?.generation === original.generation &&
    access.readGrant(original.id, principal) !== 'denied';

  function snapshot<Row>(requester: Requester, id: string, kind: Source, query: Paging & { state: string }): Snapshot<Row> {
    const { found } = connection(id, requester, true);
    const meta = source.get(id, kind, found.generation);
    if (!meta?.revision || meta.fetched_at === null) {
      if (query.cursor) throw new ApiFailure('SNAPSHOT_CHANGED');
      return { freshness: meta?.failed ? 'unavailable' : 'not_synced', items: null, fetchedAt: null, nextCursor: null };
    }
    // A successful read in another provider scope cannot renew this source's cached rows.
    if (now() - meta.fetched_at >= 900_000 || now() < meta.fetched_at) throw new ApiFailure('ACCESS_UNVERIFIED');
    const scope = JSON.stringify([requester.id, id, found.generation, kind, query.state]);
    const limit = pageLimit(query);
    const after = position<number>(query.cursor, scope, meta.revision, -1);
    const rows = sourceRows.all(id, kind, query.state, after, limit + 1);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      freshness: meta.failed ? 'stale' : 'current',
      items: rows.slice(0, limit).map((row) => JSON.parse(row.payload) as Row),
      fetchedAt: new Date(meta.fetched_at).toISOString(),
      nextCursor: last ? cursor(scope, meta.revision, last.ordinal) : null,
    };
  }

  function save(connection: RepositoryAccess, requester: Requester, kind: Source, rows: IssueRow[] | PullRequestRow[]) {
    db.prepare(`INSERT INTO repository_sources VALUES (?,?,?,?,?,0) ON CONFLICT(connection_id,source) DO UPDATE SET
      generation=excluded.generation,revision=excluded.revision,fetched_at=excluded.fetched_at,failed=0`)
      .run(connection.id, kind, connection.generation, randomUUID(), now());
    db.prepare('DELETE FROM repository_rows WHERE connection_id=? AND source=?').run(connection.id, kind);
    const insert = db.prepare('INSERT INTO repository_rows VALUES (?,?,?,?,?)');
    const factoryKeys = kind === 'pull_requests' ? new Set(db.prepare<[string, string], { key: string }>(
      `SELECT draft_pr_key AS key FROM tasks WHERE requester_id=? AND connection_id=? AND draft_pr_key IS NOT NULL`,
    ).all(requester.id, connection.id).map(({ key }) => key)) : new Set<string>();
    rows.forEach((row, index) => insert.run(connection.id, kind, row.state === 'merged' ? 'closed' : row.state, index,
      JSON.stringify(factoryKeys.has(row.key) ? { ...row, origin: 'factory' } : row)));
  }

  function failSource(original: RepositoryAccess, kind: Source) {
    db.prepare(`INSERT INTO repository_sources VALUES (?,?,?,NULL,NULL,1) ON CONFLICT(connection_id,source) DO UPDATE SET
      revision=CASE WHEN generation=excluded.generation THEN revision END,
      fetched_at=CASE WHEN generation=excluded.generation THEN fetched_at END,
      generation=excluded.generation,failed=1`).run(original.id, kind, original.generation);
  }
  function finish(job: Job, state: Job['state'], problem: string | null, sources: SourceResults | null) {
    db.prepare("UPDATE repository_sync SET state=?,problem_code=?,sources=? WHERE id=? AND state='running'")
      .run(state, problem, sources ? JSON.stringify(sources) : null, job.id);
  }

  async function live<T>(requester: Requester, id: string, call: (client: RepositoryProvider, repo: RepositoryAccess) => Promise<T>): Promise<T> {
    const { found, grant } = connection(id, requester);
    try {
      if (grant === 'unverified') await access.verify(found, requester);
      const result = await call(await provider(found, requester), found);
      if (!current(found, requester)) throw new ApiFailure('ACCESS_UNVERIFIED');
      if (grant === 'unverified') access.recordVerification(id, requester, found.generation);
      return result;
    } catch (error) {
      if (status(error) === 'ACCESS_DENIED') access.deny(id, requester, found.generation);
      if (grant === 'unverified' && status(error) === 'PROVIDER_ERROR') throw new ApiFailure('ACCESS_UNVERIFIED');
      throw error;
    }
  }

  return {
    issues: (requester: Requester, id: string, query: ApiDto<'issueQuery'>) => snapshot<IssueRow>(requester, id, 'work_items', query),
    pullRequests: (requester: Requester, id: string, query: ApiDto<'prQuery'>) => snapshot<PullRequestRow>(requester, id, 'pull_requests', query),
    async issue(requester: Requester, id: string, key: string, query: ApiDto<'issueDetailQuery'>) {
      return live(requester, id, async (client, found) => {
        const limit = pageLimit(query);
        const scope = JSON.stringify([requester.id, id, found.generation, key, 'comments', limit]);
        const after = position<string>(query.commentCursor, scope, 'comments', '');
        const detail = await client.issue(key, limit, after || null);
        const next = detail.comments.nextCursor;
        return { ...detail, comments: { ...detail.comments, nextCursor: next === null ? null : cursor(scope, 'comments', next) } };
      });
    },
    async checks(requester: Requester, id: string, key: string, query: ApiDto<'checkQuery'>) {
      return live(requester, id, async (client, found) => {
        const result = await client.checks(key, query.headRevision);
        if (result.headRevision !== query.headRevision) throw new ApiFailure('PR_REVISION_CHANGED');
        if (!result.items) {
          if (query.cursor !== undefined) throw new ApiFailure('SNAPSHOT_CHANGED');
          return result;
        }
        const scope = JSON.stringify([requester.id, id, found.generation, key, 'checks']);
        const revision = createHash('sha256').update(JSON.stringify(result)).digest('hex');
        const from = position<number>(query.cursor, scope, revision, 0);
        const to = from + pageLimit(query);
        return { ...result, items: {
          items: result.items.items.slice(from, to),
          nextCursor: to < result.items.items.length ? cursor(scope, revision, to) : null,
        } } as ApiDto<'checks'>;
      });
    },
    sync(requester: Requester, id: string) {
      const { found } = connection(id, requester);
      const job = db.transaction(() => {
        const queued = db.prepare<[string, number], { id: string }>(`SELECT id FROM repository_sync
          WHERE connection_id=? AND generation=? AND state IN ('queued','running')`).get(id, found.generation);
        if (queued) return queued.id;
        const operationId = randomUUID();
        db.prepare("INSERT INTO repository_sync VALUES (?,?,?,?,'queued',NULL,NULL,?)")
          .run(operationId, id, requester.id, found.generation, now());
        return operationId;
      }).immediate();
      return { operationId: job };
    },
    read(requester: Requester, id: string): OperationView {
      const job = byJob.get(id);
      if (!job || job.user_id !== requester.id) throw new ApiFailure('NOT_FOUND');
      const { found } = connection(job.connection_id, requester);
      if (found.generation !== job.generation) throw new ApiFailure('NOT_FOUND');
      return { id, kind: 'sync_connection', state: job.state, problemCode: job.problem_code,
        ...(job.sources && { sources: JSON.parse(job.sources) as SourceResults }) };
    },
    recoverInterrupted() {
      db.prepare("UPDATE repository_sync SET state='queued' WHERE state='running'").run();
    },
    async runNextOperation(signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return false;
      const job = db.prepare<[], Job>(`UPDATE repository_sync SET state='running' WHERE id=(
        SELECT id FROM repository_sync WHERE state='queued' ORDER BY created_at,id LIMIT 1
      ) RETURNING *`).get();
      if (!job) return false;
      const requester = { id: job.user_id };
      let original: RepositoryAccess | undefined;
      try {
        original = access.resolve(job.connection_id, requester);
        if (!original || original.generation !== job.generation) throw new ApiFailure('ACCESS_UNVERIFIED');
        if (access.readGrant(original.id, requester) === 'denied') throw new ApiFailure('ACCESS_DENIED');
        const active = original;
        await access.verify(original, requester);
        const client = await provider(original, requester);
        const observeDenial = <T>(pending: Promise<T>) => pending.catch((error: unknown) => {
          if (status(error) === 'ACCESS_DENIED') access.deny(active.id, requester, active.generation);
          throw error;
        });
        const results = await Promise.allSettled([observeDenial(client.issues()), observeDenial(client.pullRequests())]);
        if (signal?.aborted) return true;
        if (results.some((item) => item.status === 'rejected' && status(item.reason) === 'ACCESS_DENIED')) {
          throw new ApiFailure('ACCESS_DENIED');
        }
        if (!current(original, requester)) throw new ApiFailure('ACCESS_UNVERIFIED');
        db.transaction(() => {
          const outcomes: SourceResults = [];
          let completed = 0;
          for (const [index, kind] of catalog.entries()) {
            const value = results[index];
            const schema = kind === 'work_items' ? ApiSchemas.issues : ApiSchemas.pullRequests;
            const complete = value?.status === 'fulfilled' && Value.Check(schema, {
              freshness: 'current', items: value.value, nextCursor: null, fetchedAt: new Date(now()).toISOString(),
            });
            if (complete && value?.status === 'fulfilled') {
              save(active, requester, kind, value.value);
              completed++;
              outcomes.push({ name: kind, state: 'updated' });
            } else {
              const retained = source.get(active.id, kind, active.generation)?.revision;
              failSource(active, kind);
              outcomes.push({ name: kind, state: retained ? 'unchanged' : 'failed' });
            }
          }
          outcomes.push({ name: 'sessions', state: 'unavailable' });
          if (completed > 0) access.recordVerification(active.id, requester, active.generation);
          finish(job, completed === catalog.length ? 'completed' : completed ? 'partial' : 'failed',
            completed === catalog.length ? null : 'PROVIDER_ERROR', outcomes);
        }).immediate();
      } catch (error) {
        if (signal?.aborted) return true;
        if (original && status(error) === 'ACCESS_DENIED') access.deny(original.id, requester, original.generation);
        finish(job, 'failed', status(error), null);
      }
      return true;
    },
  };
}
