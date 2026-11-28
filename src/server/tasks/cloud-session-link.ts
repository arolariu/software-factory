import { opaqueIdSegment } from '../../shared/api/opaque-id.js';

const sessionIdentifier = new RegExp(`^${opaqueIdSegment}$`);

export function verifiedCloudSessionUrl(sessionId: string | null, raw: unknown): string | undefined {
  if (!sessionId || !sessionIdentifier.test(sessionId)) return undefined;
  const expected = `https://github.com/copilot/tasks/${encodeURIComponent(sessionId)}`;
  return raw === expected ? expected : undefined;
}
