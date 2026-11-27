import type { ApiDto } from '../../shared/api/schemas.js';
import { ApiFailure } from '../http/problems.js';
import { publicHttpsUrl, record } from '../provider-http.js';
import {
  account, createProviderClient, disabled, encoded, id, invalid, list, numeric, optionalText, person, pullOrigin, text,
  unloadedChecks, type RecordValue,
} from './client.js';
import type { CheckRow, IssueRow, PullRequestRow, RepositoryAccess, RepositoryProvider } from './provider.js';

const ciForbidden = { available: false, reasonCode: 'CHECKS_NOT_PERMITTED' } as const;
const failedConclusions = ['failure', 'cancelled', 'timed_out', 'action_required'];

function listFailure(error: unknown): never {
  if (error instanceof ApiFailure && error.code === 'NOT_FOUND') throw new ApiFailure('ACCESS_DENIED');
  throw error;
}

async function checkSource<T>(pending: Promise<T>) {
  try {
    return { status: 'fulfilled', value: await pending } as const;
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'ACCESS_DENIED') throw error;
    return { status: 'rejected', reason: error } as const;
  }
}

function runState(run: RecordValue): CheckRow['state'] {
  if (run['status'] !== 'completed') return 'pending';
  if (run['conclusion'] === 'success') return 'passed';
  return failedConclusions.includes(String(run['conclusion'])) ? 'failed' : 'not_run';
}

function statusState(state: unknown): CheckRow['state'] {
  if (state === 'success') return 'passed';
  if (state === 'failure' || state === 'error') return 'failed';
  return state === 'pending' ? 'pending' : 'unknown';
}

function checkRows(runs: RecordValue[], statuses: RecordValue[]): CheckRow[] {
  const rows: CheckRow[] = runs.map((run) => ({
    id: `run:${id(run['id'])}`, name: text(run['name']), url: publicHttpsUrl(run['html_url']), state: runState(run),
  }));
  const seen = new Set<string>();
  for (const entry of statuses) {
    const name = text(entry['context']);
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ id: `status:${id(entry['id'])}`, name, url: publicHttpsUrl(entry['target_url']), state: statusState(entry['state']) });
  }
  return rows;
}

export function createGitHubProvider(connection: RepositoryAccess, token: string, fetcher: typeof fetch): RepositoryProvider {
  const { target } = connection;
  const origin = target.host === 'github.com' ? 'https://api.github.com' : `https://api.${target.host}`;
  const site = `https://${target.host}/${[target.scope, target.name].map(encoded).join('/')}`;
  const git = `/repositories/${encoded(connection.repositoryId)}`;
  const client = createProviderClient(origin, token, fetcher);

  const paged = (path: string, read = list, optionalCi = false) => client.pages(
    (page) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, read, (_length, next) => next, optionalCi,
  );

  function issueRow(data: RecordValue): IssueRow {
    if (data['pull_request']) throw new ApiFailure('NOT_FOUND');
    const key = id(data['number']);
    const state = data['state'];
    if (state !== 'open' && state !== 'closed') throw invalid();
    return { key, state, title: text(data['title']), url: `${site}/issues/${key}`, author: person(data['user']),
      createdAt: text(data['created_at']), assignees: list(data['assignees']).map(account),
      revision: text(data['updated_at']), taskId: null, linkedPr: null, launch: disabled };
  }

  function pullRow(data: RecordValue): PullRequestRow {
    const state = data['state'];
    if (state !== 'open' && state !== 'closed') throw invalid();
    const author = person(data['user']);
    const key = id(data['number']);
    const head = record(data['head']);
    return {
      key, title: text(data['title']), url: `${site}/pull/${key}`,
      sourceBranch: text(head['ref']), targetBranch: text(record(data['base'])['ref']),
      state: state === 'open' ? 'active' : data['merged_at'] ? 'merged' : 'closed',
      draft: data['draft'] === true, author, origin: pullOrigin(author, connection.subject),
      checks: unloadedChecks(head['sha']), session: null,
    };
  }

  return {
    async issues() {
      const rows = await paged(`${git}/issues?state=all`).catch(listFailure);
      return rows.filter((entry) => !entry['pull_request']).map(issueRow);
    },
    async pullRequests() {
      return (await paged(`${git}/pulls?state=all`).catch(listFailure)).map(pullRow);
    },
    async issue(key, limit, cursor) {
      numeric(key);
      const path = `${git}/issues/${key}`;
      const data = record((await client.get(path)).data);
      const issue = issueRow(data);
      const comments = await client.get(`${path}/comments?per_page=${limit}&page=${cursor === null ? 1 : numeric(cursor)}`);
      return {
        issue, description: { format: 'markdown', content: optionalText(data['body']) }, fields: [], related: [],
        comments: {
          items: list(comments.data).map((row) => ({
            id: id(row['id']), author: person(row['user']), createdAt: text(row['created_at']),
            body: { format: 'markdown', content: optionalText(row['body']) },
          })),
          nextCursor: comments.next ? String(Number(cursor ?? '1') + 1) : null,
        },
      };
    },
    async checks(key, revision) {
      numeric(key);
      const item = record((await client.get(`${git}/pulls/${key}`)).data);
      const head = text(record(item['head'])['sha']);
      if (head !== revision) throw new ApiFailure('PR_REVISION_CHANGED');
      const withheld = (availability: Extract<ApiDto<'checks'>['availability'], { available: false }>): ApiDto<'checks'> =>
        ({ headRevision: head, availability, passed: null, total: null, items: null });
      try {
        const commit = `${git}/commits/${encoded(head)}`;
        const [runPage, statusPage] = await Promise.all([
          checkSource(paged(`${commit}/check-runs`, (data) => list(record(data)['check_runs']), true)),
          checkSource(paged(`${commit}/statuses`, list, true)),
        ]);
        if (runPage.status === 'rejected') throw runPage.reason;
        if (statusPage.status === 'rejected') throw statusPage.reason;
        const details = checkRows(runPage.value, statusPage.value);
        return { headRevision: head, availability: { available: true }, passed: details.filter((row) => row.state === 'passed').length,
          total: details.length, items: { items: details, nextCursor: null } };
      } catch (error) {
        if (error instanceof ApiFailure && error.code === 'ACCESS_UNVERIFIED') {
          return withheld({ available: false, reasonCode: 'CHECKS_INCOMPLETE' });
        }
        if (error instanceof ApiFailure && ['CAPABILITY_UNAVAILABLE', 'NOT_FOUND'].includes(error.code)) return withheld(ciForbidden);
        throw error;
      }
    },
  };
}
