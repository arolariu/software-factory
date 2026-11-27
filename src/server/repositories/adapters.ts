import { ApiFailure } from '../http/problems.js';
import type { ApiDto } from '../../shared/api/schemas.js';
import type { CheckRow, IssueRow, PullRequestRow, RepositoryAccess, RepositoryProvider } from './provider.js';

type RecordValue = Record<string, unknown>;
const invalid = () => new ApiFailure('PROVIDER_ERROR');
const disabled = { available: false, reasonCode: 'CAPABILITY_UNAVAILABLE' } as const;
const notLoaded = { available: false, reasonCode: 'CHECKS_NOT_LOADED' } as const;
const ciForbidden = { available: false, reasonCode: 'CHECKS_NOT_PERMITTED' } as const;
const version = 'api-version=7.1';
const encoded = encodeURIComponent;
const optionalText = (value: unknown) => typeof value === 'string' ? value : '';
function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  return value as RecordValue;
}
function list(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map(object);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw invalid();
  return value;
}
function id(value: unknown): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) throw invalid();
  return result;
}
function numeric(key: string): number {
  const value = Number(key);
  if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(value)) throw new ApiFailure('INVALID_REQUEST');
  return value;
}
function publicUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s/@\\?#]+(?:[/?#][^\s\\]*)?$/.test(value) ? value : null;
}
function person(value: unknown): IssueRow['author'] {
  if (!value) return null;
  const person = object(value);
  return { id: id(person['id']), displayName: text(person['login'] ?? person['displayName']) };
}
function commentFormat(value: unknown): 'markdown' | 'html' | 'text' {
  if (value === 'markdown' || value === 'html') return value;
  return 'text';
}

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

export function createRepositoryProvider(connection: RepositoryAccess, token: string, fetcher = fetch): RepositoryProvider {
  const { target } = connection;
  const github = connection.provider === 'github';
  const origin = github ? (target.host === 'github.com' ? 'https://api.github.com' : `https://api.${target.host}`) : 'https://dev.azure.com';
  const site = `https://${target.host}/${[target.scope, target.project, ...(github ? [] : ['_git']), target.name]
    .filter((part): part is string => part !== null).map(encoded).join('/')}`;
  const projectPath = `/${encoded(target.scope)}/${encoded(connection.scope)}/_apis`;
  const git = github ? `/repositories/${encoded(connection.repositoryId)}` :
    `${projectPath}/git/repositories/${encoded(connection.repositoryId)}`;
  async function get(path: string, query?: string, optionalCi = false) {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'software-factory',
          ...(query !== undefined && { 'Content-Type': 'application/json' }) },
        ...(query !== undefined && { method: 'POST', body: JSON.stringify({ query }) }),
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw invalid();
    }
    if (response.status === 429 || (response.status === 403 &&
        (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
      throw new ApiFailure('RATE_LIMITED', Number(response.headers.get('retry-after') ?? NaN));
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiFailure(response.status === 403 && optionalCi ? 'CAPABILITY_UNAVAILABLE' : 'ACCESS_DENIED');
    }
    if (response.status === 404) throw new ApiFailure('NOT_FOUND');
    if (!response.ok) throw invalid();
    try {
      return { data: await response.json() as unknown, next: /\brel="next"/.test(response.headers.get('link') ?? '') };
    } catch {
      throw invalid();
    }
  }

  async function pages(path: (page: number) => string, read: (data: unknown) => RecordValue[],
    more: (length: number, next: boolean) => boolean, optionalCi = false) {
    const rows: RecordValue[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await get(path(page), undefined, optionalCi);
      const batch = read(response.data);
      rows.push(...batch);
      if (!more(batch.length, response.next)) return rows;
    }
    throw new ApiFailure('ACCESS_UNVERIFIED');
  }
  const ghPages = (path: string, read = list, optionalCi = false) =>
    pages((page) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, read, (_length, next) => next, optionalCi);
  const states = new Map<string, Promise<Map<string, string>>>();
  function adoCategory(type: string, state: string) {
    const pending = states.get(type) ?? get(`${projectPath}/wit/workitemtypes/${encoded(type)}/states?${version}`)
      .then(({ data }) => new Map(list(object(data)['value']).map((row) => [text(row['name']), text(row['category'])])))
      .catch((error: unknown) => { states.delete(type); throw error; });
    states.set(type, pending);
    return pending.then((categories) => {
      const category = categories.get(state);
      if (!category) throw invalid();
      return category;
    });
  }

  function githubIssue(data: RecordValue): IssueRow {
    if (data['pull_request']) throw new ApiFailure('NOT_FOUND');
    const key = id(data['number']);
    const state = data['state'];
    if (state !== 'open' && state !== 'closed') throw invalid();
    return { key, state, title: text(data['title']), url: `${site}/issues/${key}`, author: person(data['user']),
      createdAt: text(data['created_at']), assignees: list(data['assignees']).flatMap((value) => person(value) ?? []),
      revision: text(data['updated_at']), taskId: null, linkedPr: null, launch: disabled };
  }
  async function adoIssue(data: RecordValue): Promise<IssueRow> {
    const fields = object(data['fields']);
    if (fields['System.TeamProject'] !== target.project) throw new ApiFailure('NOT_FOUND');
    const category = await adoCategory(text(fields['System.WorkItemType']), text(fields['System.State']));
    const key = id(data['id']);
    const assigned = person(fields['System.AssignedTo']);
    return {
      key, title: text(fields['System.Title']), url: `https://dev.azure.com/${encoded(target.scope)}/${encoded(target.project ?? '')}/_workitems/edit/${key}`,
      state: category === 'Completed' || category === 'Removed' ? 'closed' : 'open',
      author: person(fields['System.CreatedBy']), createdAt: text(fields['System.CreatedDate']),
      assignees: assigned ? [assigned] : [], revision: id(data['rev']), taskId: null, linkedPr: null, launch: disabled,
    };
  }
  function pull(data: RecordValue): PullRequestRow {
    const state = github ? data['state'] : data['status'];
    const author = person(github ? data['user'] : data['createdBy']);
    const key = id(github ? data['number'] : data['pullRequestId']);
    const head = github ? object(data['head'])['sha'] : data['lastMergeSourceCommit'] && object(data['lastMergeSourceCommit'])['commitId'];
    if (!['open', 'closed', 'active', 'completed', 'abandoned'].includes(String(state))) throw invalid();
    return {
      key, title: text(data['title']), url: `${site}/${github ? 'pull' : 'pullrequest'}/${key}`,
      sourceBranch: text(github ? object(data['head'])['ref'] : data['sourceRefName']),
      targetBranch: text(github ? object(data['base'])['ref'] : data['targetRefName']),
      state: state === 'open' || state === 'active' ? 'active' : state === 'completed' || data['merged_at'] ? 'merged' : 'closed',
      draft: (github ? data['draft'] : data['isDraft']) === true, author,
      origin: !author || !connection.subject ? 'unknown' : author.id === connection.subject ? 'mine' : 'other',
      checks: head ? { headRevision: id(head), availability: notLoaded, passed: null, total: null } : null,
      session: null,
    };
  }

  return {
    async issues() {
      if (github) return (await ghPages(`${git}/issues?state=all`).catch(listFailure))
        .filter((entry) => !entry['pull_request']).map(githubIssue);
      const rows: IssueRow[] = [];
      let after = 0;
      for (let page = 1; page <= 20; page++) {
        const selected = await get(`${projectPath}/wit/wiql?${version}&$top=100`,
          `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject]=@project AND [System.Id]>${after} ORDER BY [System.Id]`);
        const ids = list(object(selected.data)['workItems']).map((item) => numeric(id(item['id'])));
        if (ids.length === 0) return rows;
        const wanted = new Set(ids);
        for (const next of ids) {
          if (next <= after) throw invalid();
          after = next;
        }
        const data = list(object((await get(`${projectPath}/wit/workitems?${version}&ids=${ids.join(',')}`)).data)['value']);
        for (const item of data) if (!wanted.delete(numeric(id(item['id'])))) throw invalid();
        if (wanted.size !== 0) throw new ApiFailure('ACCESS_UNVERIFIED');
        rows.push(...await Promise.all(data.map(adoIssue)));
        if (ids.length < 100) return rows;
      }
      throw new ApiFailure('ACCESS_UNVERIFIED');
    },
    async pullRequests() {
      if (github) return (await ghPages(`${git}/pulls?state=all`).catch(listFailure)).map(pull);
      return (await pages((page) =>
        `${git}/pullrequests?${version}&searchCriteria.status=all&$top=100&$skip=${(page - 1) * 100}`,
        (data) => list(object(data)['value']), (length) => length === 100)).map(pull);
    },
    async issue(key, limit, cursor) {
      numeric(key);
      const path = github ? `${git}/issues/${key}` : `${projectPath}/wit/workitems/${key}`;
      const data = object((await get(github ? path : `${path}?${version}`)).data);
      const issue = github ? githubIssue(data) : await adoIssue(data);
      const comments = await get(github
        ? `${path}/comments?per_page=${limit}&page=${cursor === null ? 1 : numeric(cursor)}`
        : `${path}/comments?api-version=7.1-preview.4&$top=${limit}${cursor === null ? '' : `&continuationToken=${encoded(cursor)}`}`);
      const body = github ? data['body'] : object(data['fields'])['System.Description'];
      const format = github ? 'markdown' : 'html';
      return { issue, description: { format, content: optionalText(body) }, fields: [], related: [],
        comments: {
          items: list(github ? comments.data : object(comments.data)['comments']).map((row) => ({
            id: id(row['id']), author: person(github ? row['user'] : row['createdBy']),
            createdAt: text(github ? row['created_at'] : row['createdDate']),
            body: { format: github ? format : commentFormat(row['format']), content: optionalText(github ? row['body'] : row['text']) },
          })),
          nextCursor: github ? (comments.next ? String(Number(cursor ?? '1') + 1) : null) :
            optionalText(object(comments.data)['continuationToken']) || null,
        } };
    },
    async checks(key, revision) {
      numeric(key);
      const item = object((await get(github ? `${git}/pulls/${key}` : `${git}/pullrequests/${key}?${version}`)).data);
      const head = text(github ? object(item['head'])['sha'] : object(item['lastMergeSourceCommit'])['commitId']);
      if (head !== revision) throw new ApiFailure('PR_REVISION_CHANGED');
      const unavailable: ApiDto<'checks'> = { headRevision: head, availability: disabled, passed: null, total: null, items: null };
      if (!github) return unavailable;
      try {
        const commit = `${git}/commits/${encoded(head)}`;
        const [runPage, statusPage] = await Promise.all([
          checkSource(ghPages(`${commit}/check-runs`, (data) => list(object(data)['check_runs']), true)),
          checkSource(ghPages(`${commit}/statuses`, list, true)),
        ]);
        if (runPage.status === 'rejected') throw runPage.reason;
        if (statusPage.status === 'rejected') throw statusPage.reason;
        const runs = runPage.value;
        const statuses = statusPage.value;
        const details: CheckRow[] = runs.map((run) => ({
          id: `run:${id(run['id'])}`, name: text(run['name']), url: publicUrl(run['html_url']),
          state: run['status'] !== 'completed' ? 'pending' : run['conclusion'] === 'success' ? 'passed'
            : ['failure', 'cancelled', 'timed_out', 'action_required'].includes(String(run['conclusion'])) ? 'failed' : 'not_run',
        }));
        const seen = new Set<string>();
        for (const entry of statuses) {
          const name = text(entry['context']);
          if (seen.has(name)) continue;
          seen.add(name);
          const state = entry['state'];
          details.push({
            id: `status:${id(entry['id'])}`, name, url: publicUrl(entry['target_url']),
            state: state === 'success' ? 'passed' : state === 'failure' || state === 'error' ? 'failed' : state === 'pending' ? 'pending' : 'unknown',
          });
        }
        return { headRevision: head, availability: { available: true }, passed: details.filter((row) => row.state === 'passed').length,
          total: details.length, items: { items: details, nextCursor: null } };
      } catch (error) {
        if (error instanceof ApiFailure && ['CAPABILITY_UNAVAILABLE', 'NOT_FOUND', 'ACCESS_UNVERIFIED'].includes(error.code)) {
          return { ...unavailable, availability: ciForbidden };
        }
        throw error;
      }
    },
  };
}
