import Type, { type Static, type TSchema } from 'typebox';
import { opaqueIdSegment } from './opaque-id.js';

export { opaqueIdSegment } from './opaque-id.js';

export const strictObject = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const object = strictObject;
const names = <const T extends readonly string[]>(...values: T) => Type.Enum(values);
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = Type.String({ pattern: `^${opaqueIdSegment}$` });
const text = Type.String();
const nonempty = Type.String({ minLength: 1 });
const url = Type.String({ format: 'uri', pattern: '^https://[^\\s/@\\\\?#]+(?:[/?#][^\\s\\\\]*)?$', maxLength: 4096 });
const at = Type.String({
  format: 'date-time',
  pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?Z$',
});
const count = Type.Integer({ minimum: 0 });
const credits = Type.Number({ minimum: 0 });
const reasonCode = Type.String({ pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 80 });
const cursor = Type.String({ minLength: 1, maxLength: 2048 });
const limit = Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|100)$' }));
const pagination = { cursor: Type.Optional(cursor), limit };
const page = <T extends TSchema>(item: T) => object({ items: Type.Array(item), nextCursor: nullable(cursor) });
const list = <T extends TSchema>(item: T) => object({ items: Type.Array(item) });
const snapshot = <T extends TSchema>(item: T) => Type.Union([
  object({ freshness: names('not_synced', 'unavailable'), items: Type.Null(), nextCursor: Type.Null(), fetchedAt: Type.Null() }),
  object({ freshness: names('current', 'stale'), items: Type.Array(item), nextCursor: nullable(cursor), fetchedAt: at }),
]);

const available = object({ available: Type.Literal(true) });
const unavailable = object({ available: Type.Literal(false), reasonCode });
const availability = Type.Union([available, unavailable]);
const availablePage = <T extends TSchema>(item: T) => Type.Union([
  object({ availability: available, items: Type.Array(item), nextCursor: nullable(cursor) }),
  object({ availability: unavailable, items: Type.Null(), nextCursor: Type.Null() }),
]);
const provider = names('github', 'azure_devops');
const runtime = names('github_cloud', 'ado_worktree');
const runningStates = ['queued', 'starting', 'running', 'waiting_input', 'publishing', 'stopping', 'needs_auth', 'needs_recovery'] as const;
const sessionState = names(...runningStates, 'unverified');
const taskState = names(...runningStates, 'completed', 'stopped', 'failed');
const account = object({
  id, host: nonempty, accountLabel: nonempty,
  state: names('connected', 'needs_auth'), entitlement: names('verified', 'unavailable', 'unverified'),
});
const person = object({ id, displayName: text });
const issueRow = object({
  key: id, title: text, url, state: names('open', 'closed'), author: nullable(person), createdAt: at,
  assignees: Type.Array(person), revision: nullable(id), taskId: nullable(id),
  linkedPr: nullable(object({ key: id, url })), launch: availability,
});
const bodyText = object({ format: names('text', 'markdown', 'html'), content: text });
const checkCounts = {
  available: { availability: available, passed: count, total: count },
  unavailable: { availability: unavailable, passed: Type.Null(), total: Type.Null() },
};
const checkRow = object({
  id, name: text, state: names('passed', 'failed', 'pending', 'not_run', 'unknown'), url: nullable(url),
});
const checkSummary = Type.Union([
  object({ headRevision: id, ...checkCounts.available }),
  object({ headRevision: id, ...checkCounts.unavailable }),
]);
const taskFields = { taskId: id, repoId: id, workItemKey: id, title: nullable(text), issueUrl: nullable(url) };
const task = object({ ...taskFields, state: taskState });
const usage = object({ measured: nullable(credits), unmeasuredTasks: count });
const outcomes = { activeTasks: count, completed: count, stopped: count, failed: count, draftPrs: count, credits: usage };

export const ApiSchemas = {
  empty: object({}),
  problem: object({
    type: Type.Literal('about:blank'), title: nonempty, status: Type.Integer({ minimum: 400, maximum: 599 }),
    code: reasonCode, requestId: nonempty,
    fields: Type.Optional(Type.Array(object({ field: nonempty, code: reasonCode }))),
  }),
  byId: object({ id }),
  byKey: object({ id, key: id }),
  providerPath: object({ provider: names('github', 'azure-devops') }),
  paging: object(pagination),
  issueQuery: object({ state: names('open', 'closed'), ...pagination }),
  issueDetailQuery: object({ commentCursor: Type.Optional(cursor), limit }),
  prQuery: object({ state: names('active', 'closed'), ...pagination }),
  checkQuery: object({ headRevision: id, ...pagination }),
  taskQuery: object({ state: Type.Literal('active'), ...pagination }),
  optionsQuery: object({ copilotAccountId: Type.Optional(id) }),
  callbackQuery: Type.Union([
    Type.Object({ state: cursor, code: nonempty, error: Type.Optional(Type.Never()) }),
    Type.Object({ state: cursor, error: nonempty, code: Type.Optional(Type.Never()) }),
  ]),
  health: object({ status: names('ok', 'unavailable') }),
  build: object({ revision: nullable(Type.String({ pattern: '^[a-f0-9]{40}$' })), builtAt: nullable(at), runUrl: nullable(url) }),
  csrf: object({ csrfToken: nonempty }),
  me: object({
    user: object({ ...person.properties, avatarUrl: nullable(url) }),
    accounts: Type.Array(object({ id, provider, host: nonempty, accountLabel: nonempty, avatarUrl: nullable(url) })),
  }),
  hosts: list(object({ id, label: nonempty, hostname: nonempty })),
  authorizationIntent: Type.Union([
    object({ intent: Type.Literal('sign_in'), hostId: id }),
    object({ intent: Type.Literal('connect'), repositoryUrl: url }),
    object({ intent: Type.Literal('reconnect'), connectionId: id }),
    object({ intent: Type.Literal('link_copilot'), hostId: id }),
    object({ intent: Type.Literal('reconnect_copilot'), copilotAccountId: id }),
  ]),
  authorizationStarted: object({ authorizationUrl: url }),
  copilotAccounts: object({ items: Type.Array(account), defaultAccountId: nullable(id) }),
  copilotCatalog: object({
    models: nullable(Type.Array(object({
      id: nonempty, name: nonempty, policy: names('enabled', 'disabled', 'unconfigured', 'unknown'),
      reasoning: Type.Array(nonempty), defaultReasoning: nullable(nonempty),
    }))),
    quota: nullable(Type.Array(object({
      kind: names('chat', 'completions', 'premium_interactions'), unit: Type.Literal('requests'),
      used: credits, limit: nullable(credits), unlimited: Type.Boolean(), resetsAt: nullable(at),
    }))),
  }),
  copilotDefault: object({ accountId: nullable(id) }),
  connections: list(object({
    id, repoId: id, name: nonempty, provider, host: nonempty, repositoryUrl: url, accountLabel: nonempty,
    state: names('connected', 'needs_auth', 'removing'),
  })),
  issues: snapshot(issueRow),
  issue: object({
    issue: issueRow, description: bodyText, fields: Type.Array(object({ label: text, value: text })),
    related: Type.Array(object({ label: text, url })),
    comments: page(object({ id, author: nullable(person), createdAt: at, body: bodyText })),
  }),
  pullRequests: snapshot(object({
    key: id, title: text, url, sourceBranch: nonempty, targetBranch: nonempty, state: names('active', 'merged', 'closed'),
    draft: Type.Boolean(), author: nullable(person), origin: names('mine', 'other', 'factory', 'unknown'),
    checks: nullable(checkSummary),
    session: nullable(Type.Union([
      object({ kind: Type.Literal('github_cloud'), url }),
      object({ kind: Type.Literal('ado_worktree'), id }),
    ])),
  })),
  checks: Type.Union([
    object({ headRevision: id, ...checkCounts.available, items: page(checkRow) }),
    object({ headRevision: id, ...checkCounts.unavailable, items: Type.Null() }),
  ]),
  operation: object({
    id, kind: names('sync_connection', 'remove_connection', 'task_input', 'archive_task'),
    state: names('queued', 'running', 'completed', 'partial', 'failed', 'needs_recovery'),
    problemCode: nullable(reasonCode),
    sources: Type.Optional(Type.Array(object({
      name: names('work_items', 'pull_requests', 'sessions'),
      state: names('pending', 'updated', 'unchanged', 'failed', 'unavailable'),
    }))),
  }),
  tasks: page(task),
  activeSessions: object({
    repositories: Type.Array(object({ id, name: nonempty, provider })),
    sessions: Type.Array(object({
      ...taskFields, state: sessionState, blocker: nullable(names('repo_auth', 'copilot_auth', 'recovery')),
    })),
  }),
  unlinkedSessions: availablePage(object({ id, runtimeKind: runtime, title: nullable(text), url: nullable(url) })),
  task: object({
    task, sessionState: nullable(sessionState), observedAt: nullable(at),
    pendingQuestion: nullable(object({ id, text })),
    actions: object({ context: availability, answer: availability, archive: availability }),
    draftPrUrl: nullable(url),
  }),
  activity: availablePage(object({ id, at, kind: id, summary: text })),
  taskOptions: object({
    copilotAccountId: nullable(id), launch: availability, featureBranch: availability,
    models: object({
      availability, items: Type.Array(object({ id, name: text, supportedEfforts: Type.Array(nonempty) })),
    }),
  }),
  statistics: object({
    ...outcomes, repositories: Type.Array(object({ repoId: id, ...outcomes })),
    weekly: Type.Array(object({
      weekStart: Type.String({ format: 'date' }), completed: nullable(count), credits: nullable(credits),
    })),
  }),
  startTask: object({
    startRequestId: id, workItemKey: id, copilotAccountId: id,
    overrides: Type.Optional(object({
      model: Type.Optional(nonempty), reasoningEffort: Type.Optional(nonempty),
      featureBranch: Type.Optional(nonempty), extraInstructions: Type.Optional(text),
    })),
  }),
  taskInput: Type.Union([
    object({ requestId: id, kind: Type.Literal('context'), text: nonempty }),
    object({ requestId: id, kind: Type.Literal('answer'), questionId: id, text: nonempty }),
  ]),
  confirmed: object({ confirmed: Type.Literal(true) }),
  closeIssue: object({ confirmed: Type.Literal(true), expectedRevision: Type.Optional(id) }),
  taskAccepted: object({ taskId: id, state: Type.Literal('queued') }),
  operationAccepted: object({ operationId: id }),
  issueClosed: object({ issue: object({ ...issueRow.properties, state: Type.Literal('closed') }) }),
} as const;

export type ApiDto<K extends keyof typeof ApiSchemas> = Static<(typeof ApiSchemas)[K]>;
export type ApiProblem = ApiDto<'problem'>;
export type ActiveSessionSummary = ApiDto<'activeSessions'>;
export type StartTask = ApiDto<'startTask'>;
export type TaskInput = ApiDto<'taskInput'>;
export type OperationView = ApiDto<'operation'>;
export type AuthorizationIntent = ApiDto<'authorizationIntent'>;
