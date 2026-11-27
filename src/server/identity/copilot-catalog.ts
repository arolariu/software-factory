import Type from 'typebox';
import Value from 'typebox/value';
import type { ApiDto } from '../../shared/api/schemas.js';
import { ApiFailure } from '../http/problems.js';
import type { Requester } from '../http/portal-modules.js';
import { sha256Hex } from '../digest.js';
import { createSdk, withCopilotRuntime } from './copilot-runtime.js';

export interface CatalogReader {
  getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string }>;
  listModels(): Promise<unknown>;
  rpc: { account: { getQuota(input: Record<never, never>): Promise<unknown> } };
}

const label = Type.String({ minLength: 1, maxLength: 256 });
const catalogModels = Type.Array(Type.Object({
  id: label,
  name: label,
  policy: Type.Optional(Type.Object({ state: Type.String() })),
  supportedReasoningEfforts: Type.Optional(Type.Array(label, { maxItems: 32 })),
  defaultReasoningEffort: Type.Optional(label),
}), { maxItems: 512 });
const quotaResult = Type.Object({ quotaSnapshots: Type.Record(Type.String(), Type.Unknown()) });
const quotaItem = Type.Object({
  isUnlimitedEntitlement: Type.Boolean(),
  usedRequests: Type.Number({ minimum: 0 }),
  entitlementRequests: Type.Number({ minimum: -1 }),
  resetDate: Type.Optional(Type.String()),
});
const quotaKinds = ['chat', 'completions', 'premium_interactions'] as const;

function modelsView(raw: unknown): ApiDto<'copilotCatalog'>['models'] {
  if (!Value.Check(catalogModels, raw)) return null;
  return raw.map((model) => {
    const policy = model.policy?.state;
    const reasoning = model.supportedReasoningEfforts ?? [];
    return {
      id: model.id, name: model.name, reasoning,
      policy: policy === 'enabled' || policy === 'disabled' || policy === 'unconfigured' ? policy : 'unknown',
      defaultReasoning: reasoning.find((effort) => effort === model.defaultReasoningEffort) ?? null,
    };
  });
}

function quotaView(raw: unknown): ApiDto<'copilotCatalog'>['quota'] {
  if (!Value.Check(quotaResult, raw)) return null;
  const result: NonNullable<ApiDto<'copilotCatalog'>['quota']> = [];
  for (const kind of quotaKinds) {
    const value = raw.quotaSnapshots[kind];
    if (value === undefined) continue;
    if (!Value.Check(quotaItem, value)) return null;
    const reset = Date.parse(value.resetDate ?? '');
    result.push({
      kind, unit: 'requests', used: value.usedRequests,
      unlimited: value.isUnlimitedEntitlement,
      limit: value.isUnlimitedEntitlement || value.entitlementRequests < 0 ? null : value.entitlementRequests,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
    });
  }
  return result;
}

export async function inspectCatalog(client: CatalogReader): Promise<ApiDto<'copilotCatalog'>> {
  const status = await client.getAuthStatus();
  if (!status.isAuthenticated || status.authType !== 'token') throw new ApiFailure('COPILOT_REAUTH_REQUIRED');
  const [models, quota] = await Promise.allSettled([client.listModels(), client.rpc.account.getQuota({})]);
  return {
    models: models.status === 'fulfilled' ? modelsView(models.value) : null,
    quota: quota.status === 'fulfilled' ? quotaView(quota.value) : null,
  };
}

export const inspectCatalogWithSdk = (token: string) => withCopilotRuntime(token, createSdk, inspectCatalog);

export type CatalogInspection = (token: string) => Promise<ApiDto<'copilotCatalog'>>;

export function createCopilotCatalog(
  tokenForAccount: (id: string, requester: Requester) => Promise<string>, inspect: CatalogInspection,
) {
  const active = new Map<string, ReturnType<CatalogInspection>>();
  return async (requester: Requester, accountId: string) => {
    const token = await tokenForAccount(accountId, requester);
    const key = sha256Hex(JSON.stringify([requester.id, accountId, token]));
    let task = active.get(key);
    if (!task) {
      if (active.size >= 4) throw new ApiFailure('RATE_LIMITED', 5);
      task = inspect(token).finally(() => active.delete(key));
      active.set(key, task);
    }
    const result = await task;
    if (await tokenForAccount(accountId, requester) !== token) throw new ApiFailure('ACCESS_UNVERIFIED');
    return result;
  };
}
