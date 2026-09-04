import type {ProjectedSeries} from '@mndw/sdk';
import type {MndwChartDomain, MndwChartSample} from '@mndw/ui';

export type DurableRange = '7d' | '30d';

export function sparklineSamplesFromProjection(series: ProjectedSeries): MndwChartSample[] {
  return series.points.map((point) => ({time: point.time, value: point.value}));
}

export function sparklineTimeDomainFromProjection(series: ProjectedSeries): MndwChartDomain | undefined {
  const start = series.points[0]?.time;
  const end = series.points[series.points.length - 1]?.time;

  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return undefined;
  }

  return {start, end};
}
