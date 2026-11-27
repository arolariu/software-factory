import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiFailure } from '../http/problems.js';

export function createCursorCodec(key: Uint8Array) {
  const mac = (encoded: string) => createHmac('sha256', key).update(encoded).digest();
  return {
    encode(scope: string, revision: string, position: number | string): string {
      const encoded = Buffer.from(JSON.stringify([scope, revision, position])).toString('base64url');
      return `${encoded}.${mac(encoded).toString('base64url')}`;
    },
    decode<T extends number | string>(input: string | undefined, scope: string, revision: string, initial: T): T {
      if (input === undefined) return initial;
      const [encoded, signature, extra] = input.split('.');
      if (!encoded || !signature || extra !== undefined) throw new ApiFailure('SNAPSHOT_CHANGED');
      const bytes = Buffer.from(signature, 'base64url');
      const expected = mac(encoded);
      if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) throw new ApiFailure('SNAPSHOT_CHANGED');
      const [owner, current, value] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as [string, string, T];
      if (owner !== scope || current !== revision || typeof value !== typeof initial) throw new ApiFailure('SNAPSHOT_CHANGED');
      return value;
    },
  };
}
