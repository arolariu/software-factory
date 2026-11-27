import type { FastifyRequest } from 'fastify';
import { opaqueIdSegment } from '../../shared/api/schemas.js';

const portalPath = new RegExp(
  `^/(?:setup|connections(?:/${opaqueIdSegment}(?:/(?:issues|pull-requests|tasks))?)?|settings(?:/(?:factory|copilot|repository))?|active-sessions|statistics)?$`,
);

export function isPortalPath(path: string): boolean {
  return !/[\r\n]/.test(path) && portalPath.test(path);
}

function acceptsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.toLowerCase().split(',').some((entry) => {
    const mediaType = entry.slice(0, entry.search(/;|$/)).trim();
    const parameters = entry.split(';').slice(1);
    const quality = parameters.find((parameter) => /^\s*q\s*=/.test(parameter));
    return mediaType === 'text/html' && (quality === undefined || Number(quality.split('=')[1]) > 0);
  });
}

function pathSegments(target: string): string[] {
  const path = target.startsWith('/') ? target.slice(0, target.search(/\?|$/)) : new URL(target).pathname;
  return decodeURIComponent(path).split('/').filter(Boolean);
}

export function isPageNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers['sec-fetch-mode'];
  if (mode && mode !== 'navigate') return false;
  if (!acceptsHtml(request.headers.accept)) return false;
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

export function isApiPath(target: string): boolean {
  try {
    return ['api', 'auth'].includes((pathSegments(target)[0] ?? '').toLowerCase());
  } catch {
    return /^\/(?:api|auth)(?:\/|$)/i.test(target);
  }
}
