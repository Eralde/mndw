import type {ProjectedSeries, Translator} from '@mndw/sdk';
import type {MndwChartDomain, MndwChartSample} from '@mndw/ui';

export type DurableRange = '7d' | '30d';

export function formatTelemetryTime(
  translator: Translator,
  time: number,
  timeDomain?: MndwChartDomain,
): string {
  const span = timeDomain === undefined ? 0 : timeDomain.end - timeDomain.start;
  const options: Intl.DateTimeFormatOptions = span >= 24 * 60 * 60 * 1000
    ? {month: 'short', day: 'numeric'}
    : {hour: '2-digit', minute: '2-digit', second: '2-digit'};

  return translator.formatDate(new Date(time), options);
}

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
