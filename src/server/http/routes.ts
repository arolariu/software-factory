import cookiePlugin from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { ApiSchemas as s, type ApiDto } from '../../shared/api/schemas.js';
import { isPortalPath } from './navigation.js';
import type { GatedEffect, PortalModules, PortalOptions, Requester } from './portal-modules.js';
import { ApiFailure, sendProblem } from './problems.js';

const cookieName = 'factory_session';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');

type Request<P, Q, B> = FastifyRequest<{ Params: P; Querystring: Q; Body: B }>;
type Part = keyof typeof s;
type Parsed<K> = K extends Part ? ApiDto<K> : unknown;
type Parts<P, Q, B> = { params?: P; querystring?: Q; body?: B };

function validated<T>(schema: TSchema, output: unknown): T {
  if (!Value.Check(schema, output)) throw new ApiFailure('INTERNAL_ERROR');
  return output as T;
}

function json(reply: FastifyReply, schema: TSchema, output: unknown) {
  return reply.send(validated(schema, output));
}

function accepted(reply: FastifyReply, kind: 'tasks' | 'operations', result: unknown) {
  const body = validated<ApiDto<'taskAccepted'> | ApiDto<'operationAccepted'>>(
    kind === 'tasks' ? s.taskAccepted : s.operationAccepted, result);
  const id = 'taskId' in body ? body.taskId : body.operationId;
  return reply.header('Location', `/api/${kind}/${encodeURIComponent(id)}`).code(202).send(body);
}

function sessionId(request: FastifyRequest): string | undefined {
  const cookie = request.cookies[cookieName];
  return cookie && sessionIdPattern.test(cookie) ? cookie : undefined;
}

function setSession(reply: FastifyReply, session: string) {
  if (!sessionIdPattern.test(session)) throw new ApiFailure('INTERNAL_ERROR');
  reply.setCookie(cookieName, session, cookieOptions);
}

export function registerPortalRoutes(app: FastifyInstance, options?: PortalOptions): void {
  app.register(cookiePlugin);
  function modules(): PortalModules {
    if (!options) throw new ApiFailure('TEMPORARILY_UNAVAILABLE');
    return options.modules;
  }

  async function optionalRequester(request: FastifyRequest): Promise<Requester | null> {
    const session = sessionId(request);
    return session && options ? options.modules.identity.resolveRequester(session) : null;
  }

  async function requester(request: FastifyRequest): Promise<Requester> {
    const principal = await optionalRequester(request);
    if (!principal) throw new ApiFailure('AUTH_REQUIRED');
    return principal;
  }

  async function verifyUnsafe(request: FastifyRequest): Promise<string> {
    const session = sessionId(request);
    const token = request.headers['x-csrf-token'];
    if (!options || request.headers.origin !== options.publicOrigin || !session ||
        typeof token !== 'string' || !token || !await options.modules.identity.verifyCsrf(session, token)) {
      throw new ApiFailure('CSRF_INVALID');
    }
    return session;
  }

  function route<P extends Part, Q extends Part, B extends Part>(
    method: HTTPMethods, url: string, parts: Parts<P, Q, B>,
    handler: (request: Request<Parsed<P>, Parsed<Q>, Parsed<B>>, reply: FastifyReply) => Promise<unknown>,
  ): void {
    app.route<{ Params: Parsed<P>; Querystring: Parsed<Q>; Body: Parsed<B> }>({
      method, url,
      ...(method === 'GET' && { exposeHeadRoute: false }),
      schema: {
        querystring: s[parts.querystring ?? 'empty'],
        ...(parts.params && { params: s[parts.params] }),
        ...(parts.body && { body: s[parts.body] }),
      },
      ...(parts.body === 'empty' && {
        preValidation: (request, _reply, done) => {
          if (request.body === undefined) Object.assign(request, { body: {} });
          done();
        },
      }),
      errorHandler: sendProblem,
      async handler(request, reply) {
        noStore(reply);
        return handler(request, reply);
      },
    });
  }

  function read<P extends Part, Q extends Part, O extends Part>(
    path: string, parts: Parts<P, Q, never>, output: O,
    select: (ports: PortalModules, principal: Requester, request: Request<Parsed<P>, Parsed<Q>, unknown>) => ApiDto<O> | Promise<ApiDto<O>>,
  ) {
    route('GET', path, parts, async (request, reply) => {
      const principal = await requester(request);
      return json(reply, s[output], await select(modules(), principal, request));
    });
  }

  route('GET', '/api/auth/csrf', {}, async (request, reply) => {
    const csrf = await modules().identity.csrf(sessionId(request));
    if (csrf.sessionId !== undefined) setSession(reply, csrf.sessionId);
    return json(reply, s.csrf, { csrfToken: csrf.csrfToken });
  });
  route('GET', '/api/auth/github/hosts', {}, async (_request, reply) =>
    json(reply, s.hosts, { items: await modules().identity.githubHosts() }));
  route('POST', '/api/auth/:provider/start', { params: 'providerPath', body: 'authorizationIntent' }, async (request, reply) => {
    const identity = modules().identity;
    const { provider } = request.params;
    const intent = request.body;
    if (provider === 'azure-devops' && (intent.intent === 'sign_in' || intent.intent === 'link_copilot' || intent.intent === 'reconnect_copilot')) {
      throw new ApiFailure('INVALID_REQUEST');
    }
    const session = await verifyUnsafe(request);
    const principal = intent.intent === 'sign_in' ? await optionalRequester(request) : await requester(request);
    if ('hostId' in intent && !(await identity.githubHosts()).some(({ id }) => id === intent.hostId)) {
      throw new ApiFailure('INVALID_REQUEST');
    }
    return json(reply, s.authorizationStarted, await identity.beginAuthorization(provider, intent, session, principal));
  });
  route('GET', '/auth/:provider/callback', { params: 'providerPath', querystring: 'callbackQuery' }, async (request, reply) => {
    const session = sessionId(request);
    if (!session) throw new ApiFailure('AUTH_REQUIRED');
    const result = await modules().identity.completeAuthorization(request.params.provider, session, {
      state: request.query.state, code: request.query.code ?? null,
    });
    const target = result.redirectTo;
    if (!isPortalPath(target)) throw new ApiFailure('INTERNAL_ERROR');
    if (result.sessionId !== undefined) setSession(reply, result.sessionId);
    return reply.redirect(target, 303);
  });
  route('POST', '/api/auth/logout', { body: 'empty' }, async (request, reply) => {
    const principal = await requester(request);
    await modules().identity.logout(principal, await verifyUnsafe(request));
    reply.clearCookie(cookieName, cookieOptions);
    return reply.code(204).send();
  });

  read('/api/me', {}, 'me', (m, p) => m.identity.me(p));
  read('/api/copilot/accounts', {}, 'copilotAccounts', (m, p) => m.identity.copilotAccounts(p));
  read('/api/connections', {}, 'connections', (m, p) => m.repositories.connections(p));
  read('/api/connections/:id/issues', { params: 'byId', querystring: 'issueQuery' }, 'issues',
    (m, p, r) => m.repositories.issues(p, r.params.id, r.query));
  read('/api/connections/:id/issues/:key', { params: 'byKey', querystring: 'issueDetailQuery' }, 'issue',
    (m, p, r) => m.repositories.issue(p, r.params.id, r.params.key, r.query));
  read('/api/connections/:id/pull-requests', { params: 'byId', querystring: 'prQuery' }, 'pullRequests',
    (m, p, r) => m.repositories.pullRequests(p, r.params.id, r.query));
  read('/api/connections/:id/pull-requests/:key/checks', { params: 'byKey', querystring: 'checkQuery' }, 'checks',
    (m, p, r) => m.repositories.checks(p, r.params.id, r.params.key, r.query));
  read('/api/operations/:id', { params: 'byId' }, 'operation', (m, p, r) => m.operations.read(p, r.params.id));
  read('/api/connections/:id/tasks', { params: 'byId', querystring: 'taskQuery' }, 'tasks',
    (m, p, r) => m.tasks.tasks(p, r.params.id, r.query));
  read('/api/active-sessions', {}, 'activeSessions', (m, p) => m.tasks.activeSessions(p));
  read('/api/unlinked-sessions', { querystring: 'paging' }, 'unlinkedSessions', (m, p, r) => m.tasks.unlinkedSessions(p, r.query));
  read('/api/tasks/:id', { params: 'byId' }, 'task', (m, p, r) => m.tasks.task(p, r.params.id));
  read('/api/tasks/:id/activity', { params: 'byId', querystring: 'paging' }, 'activity',
    (m, p, r) => m.tasks.activity(p, r.params.id, r.query));
  read('/api/connections/:id/task-options', { params: 'byId', querystring: 'optionsQuery' }, 'taskOptions',
    (m, p, r) => m.tasks.options(p, r.params.id, r.query));
  read('/api/statistics', {}, 'statistics', (m, p) => m.tasks.statistics(p));

  async function command(request: FastifyRequest, effect?: GatedEffect) {
    const principal = await requester(request);
    await verifyUnsafe(request);
    const ports = modules();
    if (effect) await ports.operations.authorizeEffect(principal, effect);
    return { principal, ports };
  }

  route('PUT', '/api/copilot/accounts/default', { body: 'copilotDefault' }, async (request, reply) => {
    const { principal, ports } = await command(request);
    await ports.identity.setDefaultCopilotAccount(principal, request.body.accountId);
    return reply.code(204).send();
  });
  route('POST', '/api/connections/:id/sync', { params: 'byId', body: 'empty' }, async (request, reply) => {
    const { principal, ports } = await command(request);
    return accepted(reply, 'operations', await ports.operations.sync(principal, request.params.id));
  });
  route('POST', '/api/connections/:id/tasks', { params: 'byId', body: 'startTask' }, async (request, reply) => {
    const connectionId = request.params.id;
    const { principal, ports } = await command(request, { kind: 'start', connectionId, input: request.body });
    return accepted(reply, 'tasks', await ports.tasks.start(principal, connectionId, request.body));
  });
  route('POST', '/api/tasks/:id/inputs', { params: 'byId', body: 'taskInput' }, async (request, reply) => {
    const taskId = request.params.id;
    const { principal, ports } = await command(request, { kind: 'input', taskId });
    return accepted(reply, 'operations', await ports.operations.input(principal, taskId, request.body));
  });
  route('POST', '/api/tasks/:id/archive', { params: 'byId', body: 'confirmed' }, async (request, reply) => {
    const taskId = request.params.id;
    const { principal, ports } = await command(request, { kind: 'archive', taskId });
    return accepted(reply, 'operations', await ports.operations.archive(principal, taskId));
  });
  route('POST', '/api/connections/:id/remove', { params: 'byId', body: 'confirmed' }, async (request, reply) => {
    const connectionId = request.params.id;
    const { principal, ports } = await command(request, { kind: 'remove', connectionId });
    return accepted(reply, 'operations', await ports.operations.remove(principal, connectionId));
  });
  route('POST', '/api/connections/:id/issues/:key/close', { params: 'byKey', body: 'closeIssue' }, async (request, reply) => {
    const { id: connectionId, key: workItemKey } = request.params;
    const { principal, ports } = await command(request, { kind: 'close', connectionId, workItemKey });
    return json(reply, s.issueClosed, await ports.repositories.closeIssue(principal, connectionId, workItemKey, request.body));
  });
}
