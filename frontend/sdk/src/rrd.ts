/** @module @mndw/sdk/rrd */
export interface RrdTick {
  t: string | number;
  v: number;
}

export interface NumericRrdTick {
  t: number;
  v: number;
}

export interface RrdResponse {
  data?: RrdTick[];
}

const toFiniteTimestamp = (value: RrdTick['t']): number | null => {
  const timestamp = Number(value);

  return Number.isFinite(timestamp) ? timestamp : null;
};

export function filterValidRrdTicks(ticks: readonly RrdTick[]): NumericRrdTick[] {
  return ticks.flatMap((tick) => {
    const timestamp = toFiniteTimestamp(tick.t);

    if (timestamp === null || !Number.isFinite(tick.v)) {
      return [];
    }

    return [{t: timestamp, v: tick.v}];
  });
}

export function sortRrdTicks(ticks: readonly NumericRrdTick[]): NumericRrdTick[] {
  return [...ticks].sort((left, right) => left.t - right.t);
}

export function toDeviceTimeMs(
  timestamp: number,
  mostRecentTimestamp: number,
  deviceTimeMs: number,
): number {
  return deviceTimeMs - (mostRecentTimestamp - timestamp) * 1000;
}
