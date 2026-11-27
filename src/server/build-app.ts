import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type SQLite from 'better-sqlite3';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { ApiSchemas } from '../shared/api/schemas.js';
import type { PortalOptions } from './http/portal-modules.js';
import { ApiFailure, sendProblem } from './http/problems.js';
import { isPortalPath, registerPortalRoutes } from './http/routes.js';
import { registerManagementRoutes, type ManagementRoutes } from './http/management-routes.js';
import { hasCurrentSchema } from './persistence/migrations.js';

export interface BuildMetadata {
  revision: string | null;
  builtAt: string | null;
  runUrl: string | null;
}

export interface BuildAppOptions {
  db: SQLite.Database;
  staticRoot: string;
  build: BuildMetadata;
  isDraining?: () => boolean;
  logger?: boolean;
  portal?: PortalOptions;
  management?: ManagementRoutes;
}

function pathSegments(target: string): string[] {
  const path = target.startsWith('/') ? target.slice(0, target.search(/\?|$/)) : new URL(target).pathname;
  return decodeURIComponent(path).split('/').filter(Boolean);
}

function isPageNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers['sec-fetch-mode'];
  if (mode && mode !== 'navigate') return false;
  const acceptsHtml = request.headers.accept?.toLowerCase().split(',').some((entry) => {
    const mediaType = entry.slice(0, entry.search(/;|$/)).trim();
    const parameters = entry.split(';').slice(1);
    const quality = parameters.find((parameter) => /^\s*q\s*=/.test(parameter));
    return mediaType === 'text/html' && (quality === undefined || Number(quality.split('=')[1]) > 0);
  });
  if (!acceptsHtml) return false;
  let segments: string[];
  try {
    segments = pathSegments(request.url);
  } catch {
    return false;
  }
  const firstSegment = (segments[0] ?? '').toLowerCase();
  return !['api', 'auth', 'healthz', 'assets'].includes(firstSegment) &&
    (!segments.some((segment) => segment.includes('.')) || isPortalPath(`/${segments.join('/')}`));
}

function isApiPath(target: string) {
  try {
    return ['api', 'auth'].includes((pathSegments(target)[0] ?? '').toLowerCase());
  } catch {
    return /^\/(?:api|auth)(?:\/|$)/i.test(target);
  }
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const staticRoot = resolve(options.staticRoot);
  const assetsRoot = join(staticRoot, 'assets');
  if (!statSync(join(staticRoot, 'index.html')).isFile() || !statSync(assetsRoot).isDirectory()) {
    throw new Error('The compiled portal assets are missing.');
  }
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    frameworkErrors: sendProblem,
  });
  app.register(fastifyStatic, {
    root: assetsRoot,
    prefix: '/assets/',
    index: false,
    maxAge: '1y',
    immutable: true,
  });
  app.get('/healthz', { schema: { response: { 200: ApiSchemas.health, 503: ApiSchemas.health } } }, (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.isDraining?.() || !hasCurrentSchema(options.db)) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    return { status: 'ok' };
  });
  app.get('/api/build', { schema: { response: { 200: ApiSchemas.build } } }, (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return options.build;
  });
  registerPortalRoutes(app, options.portal, options.portal ? undefined : options.management?.setup.preSession);
  if (options.management) registerManagementRoutes(app, options.management, options.portal?.modules.identity);
  app.setNotFoundHandler((request, reply) => {
    if (isPageNavigation(request)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html', staticRoot, { cacheControl: false });
    }
    if (isApiPath(request.url)) return sendProblem(new ApiFailure('NOT_FOUND'), request, reply);
    return reply.code(404).send({ statusCode: 404, error: 'Not Found' });
  });
  await app.ready();
  return app;
}
