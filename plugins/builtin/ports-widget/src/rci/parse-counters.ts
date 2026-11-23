import {isRecord, toNumber} from './value.js';

const COUNTER_KEYS = {
  rxBytes: 'rxbytes',
  txBytes: 'txbytes',
  rxPackets: 'rxpackets',
  txPackets: 'txpackets',
  rxErrors: 'rxerrors',
  txErrors: 'txerrors',
  rxDropped: 'rxdropped',
  txDropped: 'txdropped',
} as const;

/** One port's counters from `show interface stat name=<id>`. */
export interface Counters {
  readonly timestampSeconds: number | null;
  readonly rxBytes: number | null;
  readonly txBytes: number | null;
  readonly rxPackets: number | null;
  readonly txPackets: number | null;
  readonly rxErrors: number | null;
  readonly txErrors: number | null;
  readonly rxDropped: number | null;
  readonly txDropped: number | null;
}

/** Accepts the flat reply, a `{stat: …}` wrapper, or a wrapper keyed by interface id. */
function unwrap(reply: Record<string, unknown>, interfaceId: string | undefined): Record<string, unknown> {
  let current = reply;

  for (let depth = 0; depth < 2; depth++) {
    const keyed = interfaceId === undefined ? undefined : current[interfaceId];

    if (isRecord(keyed)) {
      current = keyed;

      continue;
    }

    if (isRecord(current.stat)) {
      current = current.stat;

      continue;
    }

    break;
  }

  return current;
}

function hasCounters(source: Record<string, unknown>): boolean {
  return source.timestamp !== undefined || Object.values(COUNTER_KEYS).some((key) => source[key] !== undefined);
}

export function parseCounters(reply: unknown, interfaceId?: string): Counters | null {
  if (!isRecord(reply)) {
    return null;
  }

  const source = unwrap(reply, interfaceId);

  if (!hasCounters(source)) {
    return null;
  }

  return {
    timestampSeconds: toNumber(source.timestamp),
    rxBytes: toNumber(source[COUNTER_KEYS.rxBytes]),
    txBytes: toNumber(source[COUNTER_KEYS.txBytes]),
    rxPackets: toNumber(source[COUNTER_KEYS.rxPackets]),
    txPackets: toNumber(source[COUNTER_KEYS.txPackets]),
    rxErrors: toNumber(source[COUNTER_KEYS.rxErrors]),
    txErrors: toNumber(source[COUNTER_KEYS.txErrors]),
    rxDropped: toNumber(source[COUNTER_KEYS.rxDropped]),
    txDropped: toNumber(source[COUNTER_KEYS.txDropped]),
  };
}
