import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiProblem } from '../../shared/api/schemas.js';

const problems = {
  INVALID_REQUEST: [400, 'Invalid request'],
  AUTH_REQUIRED: [401, 'Sign-in required'],
  ACCESS_DENIED: [403, 'Access denied'],
  CSRF_INVALID: [403, 'Request verification failed'],
  NOT_FOUND: [404, 'Not found'],
  CAPABILITY_UNAVAILABLE: [409, 'Capability unavailable'],
  CONNECTION_ACCOUNT_CONFLICT: [409, 'Connection account conflict'],
  COPILOT_REAUTH_REQUIRED: [409, 'Copilot reauthorization required'],
  COPILOT_REPO_IDENTITY_MISMATCH: [409, 'Copilot and repository identities differ'],
  ISSUE_CHANGED: [409, 'Issue has changed'],
  PR_REVISION_CHANGED: [409, 'Pull request revision has changed'],
  REQUEST_ID_REUSED: [409, 'Request ID was reused'],
  SNAPSHOT_CHANGED: [409, 'Snapshot has changed'],
  STALE_QUESTION: [409, 'Question is no longer pending'],
  TASK_ALREADY_ACTIVE: [409, 'Task already active'],
  TASK_OPERATION_PENDING: [409, 'A task operation is still pending'],
  RATE_LIMITED: [429, 'Too many requests'],
  SETUP_CODE_INVALID: [400, 'Setup could not be verified'],
  SETUP_ALREADY_CLAIMED: [409, 'Factory setup is already complete'],
  AUTH_FLOW_ACTIVE: [409, 'An authorization flow is already active'],
  AUTH_FLOW_NOT_READY: [409, 'Authorization cannot be completed'],
  SETTINGS_CHANGED: [409, 'Instance settings have changed'],
  INTERNAL_ERROR: [500, 'Internal server error'],
  PROVIDER_ERROR: [502, 'Provider request failed'],
  ACCESS_UNVERIFIED: [503, 'Access could not be verified'],
  TEMPORARILY_UNAVAILABLE: [503, 'Temporarily unavailable'],
} as const;

export class ApiFailure extends Error {
  readonly code: keyof typeof problems;
  readonly retryAfter: number | undefined;

  constructor(code: keyof typeof problems, retryAfter?: number) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function sendProblem(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const failure = error instanceof ApiFailure ? error : undefined;
  const inputError = typeof error === 'object' && error !== null && 'statusCode' in error &&
    typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
  const code = failure?.code ?? (inputError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR');
  const [status, title] = problems[code];
  if (failure?.code === 'RATE_LIMITED' && failure.retryAfter !== undefined &&
    Number.isSafeInteger(failure.retryAfter) && failure.retryAfter >= 0) {
    reply.header('Retry-After', failure.retryAfter);
  }
  const body: ApiProblem = { type: 'about:blank', title, status, code, requestId: request.id };
  return reply.header('Cache-Control', 'no-store').code(status).type('application/problem+json').send(body);
}
