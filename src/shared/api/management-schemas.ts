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
