import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type SQLite from 'better-sqlite3';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
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
}

function isPageNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers['sec-fetch-mode'];
  if (mode && mode !== 'navigate') return false;
  const acceptsHtml = request.headers.accept?.toLowerCase().split(',').some((entry) => {
    const [mediaType, ...parameters] = entry.split(';');
    const quality = parameters.find((parameter) => /^\s*q\s*=/.test(parameter));
    return mediaType.trim() === 'text/html' && (quality === undefined || Number(quality.split('=')[1]) > 0);
  });
  if (!acceptsHtml) return false;
  let pathname: string;
  try {
    const target = request.url;
    pathname = decodeURIComponent(target.startsWith('/') ? target.split('?')[0] : new URL(target).pathname);
  } catch {
    return false;
  }
  const segments = pathname.split('/').filter(Boolean);
  return !['api', 'auth', 'healthz', 'assets'].includes(segments[0]?.toLowerCase()) &&
    !segments.some((segment) => segment.includes('.'));
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
  });
  app.register(fastifyStatic, {
    root: assetsRoot,
    prefix: '/assets/',
    index: false,
    maxAge: '1y',
    immutable: true,
  });
  app.get('/healthz', (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.isDraining?.() || !hasCurrentSchema(options.db)) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    return { status: 'ok' };
  });
  app.get('/api/build', (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return options.build;
  });
  app.setNotFoundHandler((request, reply) => {
    if (isPageNavigation(request)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html', staticRoot, { cacheControl: false });
    }
    return reply.code(404).send({ statusCode: 404, error: 'Not Found' });
  });
  await app.ready();
  return app;
}
