import type { FastifyInstance } from 'fastify';
import { SetupPair, SetupStatus } from '../../shared/api/management-schemas.js';
import type { SetupStore } from '../management/setup.js';
import { ApiFailure, sendProblem } from './problems.js';
import { sessionId } from './routes.js';

export interface ManagementRoutes {
  origin: string;
  setup: SetupStore;
}

export function registerManagementRoutes(app: FastifyInstance, management: ManagementRoutes) {
  app.get('/api/setup/status', {
    schema: { response: { 200: SetupStatus } }, errorHandler: sendProblem,
  }, (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { state } = management.setup.status();
    return { state, pairingAvailable: state === 'unclaimed', signInAvailable: false } satisfies SetupStatus;
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
}
