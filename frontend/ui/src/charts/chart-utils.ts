import type {
  MndwChartColor,
  MndwChartDomain,
  MndwChartPoint,
  MndwChartSample,
  MndwChartSeries,
  MndwChartValueFormatter,
} from './chart-types.js';

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

export const defaultPercentFormatter: MndwChartValueFormatter = (value) => `${Math.round(value)}%`;

export const resolveChartMax = (max: number): number => Number.isFinite(max) && max > 0 ? max : 100;

const CHART_COLORS: readonly MndwChartColor[] = ['accent', 'success', 'warning', 'muted'];

export const resolveChartColor = (color: MndwChartColor): MndwChartColor => {
  return CHART_COLORS.includes(color) ? color : 'accent';
};

export const normalizeChartSamples = (samples: readonly MndwChartSample[]): MndwChartSample[] => {
  return samples.flatMap((sample) => {
    if (!Number.isFinite(sample.value) || (sample.time !== undefined && !Number.isFinite(sample.time))) {
      return [];
    }

    return sample.time === undefined
      ? [{value: sample.value}]
      : [{time: sample.time, value: sample.value}];
  });
};

export const filterFinitePoints = (points: readonly MndwChartPoint[]): MndwChartPoint[] => {
  return points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
};

export const splitFinitePoints = (points: readonly MndwChartPoint[]): MndwChartPoint[][] => {
  const result: MndwChartPoint[][] = [];
  let segment: MndwChartPoint[] = [];

  for (const point of points) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) {
      if (segment.length > 0) {
        result.push(segment);
        segment = [];
      }

      continue;
    }

    segment.push(point);
  }

  if (segment.length > 0) {
    result.push(segment);
  }

  return result;
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

export const formatChartRange = (
  samples: readonly MndwChartSample[],
  label: string,
  formatter: MndwChartValueFormatter,
): string | null => {
  const validSamples = normalizeChartSamples(samples);

  if (validSamples.length === 0) {
    return null;
  }

  const allTimed = validSamples.every((sample) => sample.time !== undefined);
  const latest = allTimed
    ? validSamples.reduce((current, sample) => {
      if (current.time === undefined || sample.time === undefined) {
        return current;
      }

      return sample.time > current.time ? sample : current;
    })
    : validSamples[validSamples.length - 1];
  const min = Math.min(...validSamples.map((sample) => sample.value));
  const max = Math.max(...validSamples.map((sample) => sample.value));

  if (latest === undefined) {
    return null;
  }

  return `${label}: latest ${formatter(latest.value)}; range ${formatter(min)} to ${formatter(max)}`;
};

export const buildLineAriaLabel = (
  series: readonly MndwChartSeries[],
  emptyLabel: string,
  formatter: MndwChartValueFormatter = formatSpeed,
  valueLabel?: string,
): string => {
  const segments = series
    .map((item) => formatChartRange(item.data, item.label ?? item.id, formatter))
    .filter((segment): segment is string => segment !== null);

  if (segments.length === 0) {
    return emptyLabel;
  }

  const prefix = valueLabel === undefined ? 'Chart. ' : `Chart. ${valueLabel}: `;

  return `${prefix}${segments.join('; ')}`;
};

export const buildBarAriaLabel = (
  points: readonly MndwChartPoint[],
  valueLabel: string,
  emptyLabel: string,
  formatter: MndwChartValueFormatter = formatSpeed,
): string => {
  return formatChartRange(points, valueLabel, formatter) ?? emptyLabel;
};
