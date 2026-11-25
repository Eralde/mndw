import type {Sample} from '../model/api';

export const WAKE_CONSENT_PREFIX = 'wake-consent:';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/** Browser storage subset needed to remember which drives were already approved for wake. */
export interface WakeConsentStorage {
  keys(): Promise<string[]>;
  set(key: string, value: string): Promise<void>;
}

/**
 * FNV-1a is used as a stable key derivation for the drive identity, not for security: crypto.subtle is unavailable on
 * the router's plain-HTTP origin and the raw serial must not be stored in browser storage.
 */
/* eslint-disable no-bitwise -- FNV-1a is defined with xor and a 64-bit mask */
export function fnv1a64Hex(value: string): string {
  let hash = FNV_OFFSET_BASIS;

  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }

  return hash.toString(16).padStart(16, '0');
}
/* eslint-enable no-bitwise */

/** Returns the stored-consent key for a trustworthy drive identity, or null when consent cannot be remembered. */
export function wakeConsentKey(sample: Sample | null): string | null {
  if (sample?.identity.reliable !== true) { return null; }

  const {model, serial} = sample.identity;

  if (model === null || serial === null) { return null; }

  return `${WAKE_CONSENT_PREFIX}${fnv1a64Hex(`${model}\u0000${serial}`)}`;
}
