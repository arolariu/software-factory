import Type, { type Static } from 'typebox';

export const SetupStatus = Type.Object({
  state: Type.Enum(['unclaimed', 'claimed']),
  pairingAvailable: Type.Boolean(),
  paired: Type.Boolean(),
  signInAvailable: Type.Boolean(),
}, { additionalProperties: false });
export type SetupStatus = Static<typeof SetupStatus>;

export const SetupPair = Type.Object({
  code: Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }),
}, { additionalProperties: false });
export type SetupPair = Static<typeof SetupPair>;

const flowId = Type.String({ pattern: '^[a-f0-9-]{36}$' });
export const FlowPath = Type.Object({ id: flowId }, { additionalProperties: false });
export type FlowPath = Static<typeof FlowPath>;
export const FlowStart = Type.Object({
  flowId, expiresAt: Type.Integer({ minimum: 0 }),
  browserInstructions: Type.Object({
    url: Type.Literal('https://github.com/login/device'),
    userCode: Type.String({ pattern: '^[A-Z0-9-]{4,32}$' }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export const ActiveFlow = Type.Object({ flow: Type.Union([FlowStart, Type.Null()]) }, { additionalProperties: false });
export const FlowStatus = Type.Object({
  state: Type.Enum(['pending', 'ready', 'complete', 'cancelled', 'expired', 'failed']),
}, { additionalProperties: false });
export type FlowStatus = Static<typeof FlowStatus>;

const version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const InstanceSettings = Type.Object({
  version, repositoryEnabled: Type.Boolean(), githubClientId: Type.String(),
  copilotEnabled: Type.Optional(Type.Literal(true)),
}, { additionalProperties: false });
export type InstanceSettings = Static<typeof InstanceSettings>;
export const UpdateInstanceSettings = Type.Object({ version, repositoryEnabled: Type.Boolean() }, { additionalProperties: false });
export type UpdateInstanceSettings = Static<typeof UpdateInstanceSettings>;
