import { ApiFailure } from '../http/problems.js';
import { record } from '../provider-http.js';
import {
  createProviderClient, disabled, encoded, id, invalid, list, maxPages, numeric, optionalText, person, pullOrigin, text,
  unloadedChecks, type RecordValue,
} from './client.js';
import type { IssueRow, PullRequestRow, RepositoryAccess, RepositoryProvider } from './provider.js';

const version = 'api-version=7.1';
const pageSize = 100;

function commentFormat(value: unknown): 'markdown' | 'html' | 'text' {
  if (value === 'markdown' || value === 'html') return value;
  return 'text';
}

export function createAzureDevOpsProvider(connection: RepositoryAccess, token: string, fetcher: typeof fetch): RepositoryProvider {
  const { target } = connection;
  const site = `https://${target.host}/${[target.scope, target.project, '_git', target.name]
    .filter((part): part is string => part !== null).map(encoded).join('/')}`;
  const projectPath = `/${encoded(target.scope)}/${encoded(connection.scope)}/_apis`;
  const git = `${projectPath}/git/repositories/${encoded(connection.repositoryId)}`;
  const client = createProviderClient('https://dev.azure.com', token, fetcher);

  const states = new Map<string, Promise<Map<string, string>>>();
  function stateCategory(type: string, state: string) {
    const pending = states.get(type) ?? client.get(`${projectPath}/wit/workitemtypes/${encoded(type)}/states?${version}`)
      .then(({ data }) => new Map(list(record(data)['value']).map((row) => [text(row['name']), text(row['category'])])))
      .catch((error: unknown) => { states.delete(type); throw error; });
    states.set(type, pending);
    return pending.then((categories) => {
      const category = categories.get(state);
      if (!category) throw invalid();
      return category;
    });
  }

  async function issueRow(data: RecordValue): Promise<IssueRow> {
    const fields = record(data['fields']);
    if (fields['System.TeamProject'] !== target.project) throw new ApiFailure('NOT_FOUND');
    const category = await stateCategory(text(fields['System.WorkItemType']), text(fields['System.State']));
    const key = id(data['id']);
    const assigned = person(fields['System.AssignedTo']);
    return {
      key, title: text(fields['System.Title']), url: `https://dev.azure.com/${encoded(target.scope)}/${encoded(target.project ?? '')}/_workitems/edit/${key}`,
      state: category === 'Completed' || category === 'Removed' ? 'closed' : 'open',
      author: person(fields['System.CreatedBy']), createdAt: text(fields['System.CreatedDate']),
      assignees: assigned ? [assigned] : [], revision: id(data['rev']), taskId: null, linkedPr: null, launch: disabled,
    };
  }

  function pullRow(data: RecordValue): PullRequestRow {
    const state = data['status'];
    if (state !== 'active' && state !== 'completed' && state !== 'abandoned') throw invalid();
    const author = person(data['createdBy']);
    const key = id(data['pullRequestId']);
    const source = data['lastMergeSourceCommit'] && record(data['lastMergeSourceCommit'])['commitId'];
    return {
      key, title: text(data['title']), url: `${site}/pullrequest/${key}`,
      sourceBranch: text(data['sourceRefName']), targetBranch: text(data['targetRefName']),
      state: state === 'active' ? 'active' : state === 'completed' ? 'merged' : 'closed',
      draft: data['isDraft'] === true, author, origin: pullOrigin(author, connection.subject),
      checks: unloadedChecks(source), session: null,
    };
  }

  return {
    async issues() {
      const rows: IssueRow[] = [];
      let after = 0;
      for (let page = 1; page <= maxPages; page++) {
        const selected = await client.get(`${projectPath}/wit/wiql?${version}&$top=${pageSize}`, {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject]=@project AND [System.Id]>${after} ORDER BY [System.Id]`,
        });
        const ids = list(record(selected.data)['workItems']).map((item) => numeric(id(item['id'])));
        if (ids.length === 0) return rows;
        const wanted = new Set(ids);
        for (const next of ids) {
          if (next <= after) throw invalid();
          after = next;
        }
        const data = list(record((await client.get(`${projectPath}/wit/workitems?${version}&ids=${ids.join(',')}`)).data)['value']);
        for (const item of data) if (!wanted.delete(numeric(id(item['id'])))) throw invalid();
        if (wanted.size !== 0) throw new ApiFailure('ACCESS_UNVERIFIED');
        rows.push(...await Promise.all(data.map(issueRow)));
        if (ids.length < pageSize) return rows;
      }
      throw new ApiFailure('ACCESS_UNVERIFIED');
    },
    async pullRequests() {
      const rows = await client.pages(
        (page) => `${git}/pullrequests?${version}&searchCriteria.status=all&$top=${pageSize}&$skip=${(page - 1) * pageSize}`,
        (data) => list(record(data)['value']), (length) => length === pageSize,
      );
      return rows.map(pullRow);
    },
    async issue(key, limit, cursor) {
      numeric(key);
      const path = `${projectPath}/wit/workitems/${key}`;
      const data = record((await client.get(`${path}?${version}`)).data);
      const issue = await issueRow(data);
      const continuation = cursor === null ? '' : `&continuationToken=${encoded(cursor)}`;
      const comments = record((await client.get(`${path}/comments?api-version=7.1-preview.4&$top=${limit}${continuation}`)).data);
      return {
        issue, description: { format: 'html', content: optionalText(record(data['fields'])['System.Description']) },
        fields: [], related: [],
        comments: {
          items: list(comments['comments']).map((row) => ({
            id: id(row['id']), author: person(row['createdBy']), createdAt: text(row['createdDate']),
            body: { format: commentFormat(row['format']), content: optionalText(row['text']) },
          })),
          nextCursor: optionalText(comments['continuationToken']) || null,
        },
      };
    },
    async checks(key, revision) {
      numeric(key);
      const item = record((await client.get(`${git}/pullrequests/${key}?${version}`)).data);
      const head = text(record(item['lastMergeSourceCommit'])['commitId']);
      if (head !== revision) throw new ApiFailure('PR_REVISION_CHANGED');
      return { headRevision: head, availability: disabled, passed: null, total: null, items: null };
    },
  };
}
