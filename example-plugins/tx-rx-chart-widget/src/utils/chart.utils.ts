import type {RrdTick} from '../types/rci.types';

export const MIN_Y_AXIS_UPPER_LIMIT = 5000;
export const EXPECTED_POINTS = 64;
export const INTERVAL_SECONDS = 3;
export const WINDOW_SECONDS = EXPECTED_POINTS * INTERVAL_SECONDS;

export const formatSpeed = (value: number): string => {
  if (value === 0) {
    return '0 b/s';
  }

  const abs = Math.abs(value);
  const units = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
  let unitIndex = 0;
  let v = abs;

  while (v >= 1000 && unitIndex < units.length - 1) {
    v /= 1000;
    unitIndex++;
  }

  return `${unitIndex === 0 ? v : v.toFixed(1)} ${units[unitIndex]}`;
};

export const getSpeedUpperLimit = (speed: number): number => {
  if (speed <= 0) {
    return MIN_Y_AXIS_UPPER_LIMIT;
  }

  const pow = String(Math.floor(speed)).length - 1;
  const multiplier = Math.pow(10, pow);
  const limit = Math.ceil(speed / multiplier) * multiplier;

  return Math.max(limit, MIN_Y_AXIS_UPPER_LIMIT);
};

export const padData = (data: RrdTick[], expectedLength: number): RrdTick[] => {
  if (data.length >= expectedLength) {
    return data;
  }

  const minT = Math.min(...data.map((d) => d.t));
  const padCount = expectedLength - data.length;
  const pads: RrdTick[] = [];

  for (let i = 0; i < padCount; i++) {
    pads.push({t: minT + (padCount - i) * 3, v: 0});
  }

  return [...pads, ...data];
};
