import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Time-ordered id: ten base-36 digits of the clock, then sixteen random ones. The same shape as accounts-sync's ulidish(). */
export function ulidish(now: number = Date.now()): string {
  const rnd = randomBytes(16);
  return now.toString(36).padStart(10, '0') + Array.from(rnd, (b) => ALPHABET[b % 36]).join('');
}

export const userId = () => `usr_${ulidish()}`;
