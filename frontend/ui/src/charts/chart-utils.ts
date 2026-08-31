import type {MndwChartDomain, MndwChartPoint, MndwChartSeries} from './chart-types.js';

export const MIN_Y_AXIS_UPPER_LIMIT = 5000;

export const formatSpeed = (value: number): string => {
  if (value === 0) {
    return '0 b/s';
  }

  const abs = Math.abs(value);
  const units = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
  let unitIndex = 0;
  let scaled = abs;

  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }

  return `${unitIndex === 0 ? scaled : scaled.toFixed(1)} ${units[unitIndex]}`;
};

export const getSpeedUpperLimit = (speed: number): number => {
  if (!Number.isFinite(speed) || speed <= 0) {
    return MIN_Y_AXIS_UPPER_LIMIT;
  }

  const power = String(Math.floor(speed)).length - 1;
  const multiplier = Math.pow(10, power);
  const limit = Math.ceil(speed / multiplier) * multiplier;

  return Math.max(limit, MIN_Y_AXIS_UPPER_LIMIT);
};

/** Formats an epoch-ms timestamp as a local `HH:MM:SS` clock label for compact chart axes. */
export const formatClockTime = (epochMs: number): string => {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const filterFinitePoints = (points: readonly MndwChartPoint[]): MndwChartPoint[] => {
  return points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
};

export const resolveDomain = (
  points: readonly MndwChartPoint[],
  explicit: MndwChartDomain | undefined,
): MndwChartDomain | null => {
  if (
    explicit !== undefined
    && Number.isFinite(explicit.start)
    && Number.isFinite(explicit.end)
    && explicit.start < explicit.end
  ) {
    return {start: explicit.start, end: explicit.end};
  }

  const validPoints = filterFinitePoints(points);

  if (validPoints.length === 0) {
    return null;
  }

  return {
    start: Math.min(...validPoints.map((point) => point.time)),
    end: Math.max(...validPoints.map((point) => point.time)),
  };
};

const formatRange = (points: readonly MndwChartPoint[], label: string): string | null => {
  const validPoints = filterFinitePoints(points);

  if (validPoints.length === 0) {
    return null;
  }

  const latest = validPoints.reduce((current, point) => point.time > current.time ? point : current);
  const min = Math.min(...validPoints.map((point) => point.value));
  const max = Math.max(...validPoints.map((point) => point.value));

  return `${label}: latest ${formatSpeed(latest.value)}; range ${formatSpeed(min)} to ${formatSpeed(max)}`;
};

export const buildLineAriaLabel = (series: readonly MndwChartSeries[], emptyLabel: string): string => {
  const segments = series
    .map((item) => formatRange(item.data, item.label ?? item.id))
    .filter((segment): segment is string => segment !== null);

  return segments.length > 0 ? `Chart. ${segments.join('; ')}` : emptyLabel;
};

export const buildBarAriaLabel = (
  points: readonly MndwChartPoint[],
  valueLabel: string,
  emptyLabel: string,
): string => {
  return formatRange(points, valueLabel) ?? emptyLabel;
};
