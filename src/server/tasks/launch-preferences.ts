import { opaqueIdSegment } from '../../shared/api/opaque-id.js';
import type { StartTask } from '../../shared/api/schemas.js';
import { ApiFailure } from '../http/problems.js';

export type LaunchPreferences = { model: string; reasoningEffort?: string };
const choice = new RegExp(`^${opaqueIdSegment}$`);
export const isLaunchChoice = (value: string) => choice.test(value);

export function launchPreferences(overrides: StartTask['overrides']): LaunchPreferences | undefined {
  const { model, reasoningEffort, featureBranch, extraInstructions } = overrides ?? {};
  if (featureBranch !== undefined || extraInstructions !== undefined) throw new ApiFailure('CAPABILITY_UNAVAILABLE');
  if (model === undefined && reasoningEffort === undefined) return undefined;
  if (model === undefined || !choice.test(model) || (reasoningEffort !== undefined && !choice.test(reasoningEffort))) {
    throw new ApiFailure('INVALID_REQUEST');
  }
  return reasoningEffort === undefined ? { model } : { model, reasoningEffort };
}
