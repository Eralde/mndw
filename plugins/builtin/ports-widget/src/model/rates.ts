import type {Counters} from '../rci/parse-counters.js';

export interface Rates {
  readonly rxBitsPerSecond: number | null;
  readonly txBitsPerSecond: number | null;
}

function bitsPerSecond(from: number | null, to: number | null, seconds: number): number | null {
  if (from === null || to === null || to < from) {
    return null;
  }

  return ((to - from) * 8) / seconds;
}

/** Per-direction bit rates; a decreased counter (a reset) yields no rate for that direction. */
export function computeRates(previous: Counters | null, current: Counters | null): Rates | null {
  if (previous === null || current === null) {
    return null;
  }

  const from = previous.timestampSeconds;
  const to = current.timestampSeconds;

  if (from === null || to === null || to <= from) {
    return null;
  }

  const seconds = to - from;

  return {
    rxBitsPerSecond: bitsPerSecond(previous.rxBytes, current.rxBytes, seconds),
    txBitsPerSecond: bitsPerSecond(previous.txBytes, current.txBytes, seconds),
  };
}
