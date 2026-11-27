import Type, { type Static } from 'typebox';

export const SetupStatus = Type.Object({
  state: Type.Enum(['unclaimed', 'claimed']),
  pairingAvailable: Type.Boolean(),
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
export const FlowStatus = Type.Object({
  state: Type.Enum(['pending', 'ready', 'complete', 'cancelled', 'expired', 'failed']),
}, { additionalProperties: false });
export type FlowStatus = Static<typeof FlowStatus>;
