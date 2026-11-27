import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { ActiveFlow, FlowPath, FlowStart, FlowStatus, InstanceSettings, SetupPair, SetupStatus, UpdateInstanceSettings } from '../../shared/api/management-schemas.js';
import { ApiSchemas, type ApiDto, type AuthorizationIntent } from '../../shared/api/schemas.js';
import type { AuthorizationService } from '../management/authorization.js';
import type { SetupStore } from '../management/setup.js';
import type { ManagementSettings } from '../management/settings.js';
import { ApiFailure, sendProblem } from './problems.js';
import type { PortalModules, Requester } from './portal-modules.js';
import { sessionId, setSession } from './routes.js';

export interface ManagementRoutes {
  origin: string;
  setup: SetupStore;
  authorization?: AuthorizationService | undefined;
  settings?: ManagementSettings | undefined;
  disconnectRepository?: ((id: string, requester: Requester) => void) | undefined;
}

export function registerManagementRoutes(app: FastifyInstance, management: ManagementRoutes, identity?: PortalModules['identity']) {
  app.get('/api/setup/status', {
    schema: { response: { 200: SetupStatus } }, errorHandler: sendProblem,
  }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { state } = management.setup.status();
    const id = sessionId(request);
    return { state, pairingAvailable: state === 'unclaimed', paired: !!id && management.setup.hasClaim(id),
      signInAvailable: !!management.authorization } satisfies SetupStatus;
  });
  app.post<{ Body: SetupPair }>('/api/setup/pair', {
    schema: { body: SetupPair }, errorHandler: sendProblem,
  }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const session = sessionId(request);
    const csrf = request.headers['x-csrf-token'];
    if (request.headers.origin !== management.origin || !session ||
        typeof csrf !== 'string' || !management.setup.validateAnonymous(session, csrf)) {
      throw new ApiFailure('CSRF_INVALID');
    }
    management.setup.pair(session, request.body.code);
    return reply.code(204).send();
  });
  const { authorization, settings, disconnectRepository } = management;
  if (!authorization || !identity || !settings || !disconnectRepository) return;
  const { resolveRequester, verifyCsrf } = identity;
  function session(request: FastifyRequest) {
    const id = sessionId(request);
    if (!id) throw new ApiFailure('AUTH_REQUIRED');
    return id;
  }
  async function verified(request: FastifyRequest) {
    const id = session(request);
    const token = request.headers['x-csrf-token'];
    if (request.headers.origin !== management.origin || typeof token !== 'string' ||
      !await verifyCsrf(id, token)) throw new ApiFailure('CSRF_INVALID');
    return id;
  }
  async function principal(id: string) {
    const requester = await resolveRequester(id);
    if (!requester) throw new ApiFailure('AUTH_REQUIRED');
    return requester;
  }
  app.post<{ Body: AuthorizationIntent }>('/api/authorization/flows', {
    schema: { body: ApiSchemas.authorizationIntent, response: { 200: FlowStart } }, errorHandler: sendProblem,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return authorization.start(await verified(request), request.body);
  });
  app.get('/api/authorization/flows', {
    schema: { response: { 200: ActiveFlow } }, errorHandler: sendProblem,
  }, (request, reply) => {
    const id = sessionId(request);
    reply.header('Cache-Control', 'no-store');
    return { flow: id ? authorization.active(id) : null };
  });
  app.get<{ Params: FlowPath }>('/api/authorization/flows/:id', {
    schema: { params: FlowPath, response: { 200: FlowStatus } }, errorHandler: sendProblem,
  }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return authorization.status(session(request), request.params.id);
  });
  app.delete<{ Params: FlowPath }>('/api/authorization/flows/:id', {
    schema: { params: FlowPath }, errorHandler: sendProblem,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    authorization.cancel(await verified(request), request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: FlowPath }>('/api/authorization/flows/:id/complete', {
    schema: { params: FlowPath }, errorHandler: sendProblem,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const completed = authorization.complete(await verified(request), request.params.id);
    if (completed.sessionId) setSession(reply, completed.sessionId);
    return reply.code(204).send();
  });
  app.get('/api/settings/instance', {
    schema: { response: { 200: InstanceSettings } }, errorHandler: sendProblem,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const requester = await principal(session(request));
    return settings.read(requester);
  });
  app.put<{ Body: UpdateInstanceSettings }>('/api/settings/instance', {
    schema: { body: UpdateInstanceSettings, response: { 200: InstanceSettings } }, errorHandler: sendProblem,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const requester = await principal(await verified(request));
    return settings.update(requester, request.body);
  });
  app.delete<{ Params: ApiDto<'byId'> }>('/api/connections/:id/authorization', {
    schema: { params: ApiSchemas.byId }, errorHandler: sendProblem,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const requester = await principal(await verified(request));
    disconnectRepository(request.params.id, requester);
    return reply.code(204).send();
  });
}
