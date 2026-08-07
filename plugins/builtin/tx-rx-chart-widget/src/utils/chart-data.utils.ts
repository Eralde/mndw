import type {MndwChartDomain, MndwChartPoint, MndwChartSeries} from '@mndw/ui';
import type {RrdTick} from '../types/rci.types';

export const EXPECTED_POINTS = 64;
export const INTERVAL_SECONDS = 3;
export const WINDOW_SECONDS = EXPECTED_POINTS * INTERVAL_SECONDS;

export interface TxRxChartData {
  series: MndwChartSeries[];
  domain: MndwChartDomain | undefined;
}

const validTicks = (ticks: readonly RrdTick[]): RrdTick[] => {
  return ticks.filter((tick) => Number.isFinite(Number(tick.t)) && Number.isFinite(tick.v));
};

const padData = (ticks: readonly RrdTick[]): RrdTick[] => {
  const valid = validTicks(ticks);

  if (valid.length === 0 || valid.length >= EXPECTED_POINTS) {
    return [...valid];
  }

  const minT = Math.min(...valid.map((tick) => Number(tick.t)));
  const padCount = EXPECTED_POINTS - valid.length;
  const pads: RrdTick[] = [];

  for (let index = 0; index < padCount; index += 1) {
    pads.push({t: minT - (padCount - index) * INTERVAL_SECONDS, v: 0});
  }

  return [...pads, ...valid];
};

const toSeries = (
  id: string,
  label: string,
  color: 'accent' | 'success',
  ticks: readonly RrdTick[],
  deviceTime: Date,
  mostRecentT: number,
): MndwChartSeries => {
  const data: MndwChartPoint[] = ticks.map((tick) => ({
    time: deviceTime.getTime() - (mostRecentT - Number(tick.t)) * 1000,
    value: tick.v,
  }));

  return {id, label, color, fill: true, data};
};

export function toTxRxChartData(
  txData: readonly RrdTick[],
  rxData: readonly RrdTick[],
  deviceTime: Date | null,
): TxRxChartData {
  const emptySeries: MndwChartSeries[] = [
    {id: 'tx', label: 'TX', color: 'accent', fill: true, data: []},
    {id: 'rx', label: 'RX', color: 'success', fill: true, data: []},
  ];

  if (deviceTime === null) {
    return {series: emptySeries, domain: undefined};
  }

  const paddedTx = padData(txData);
  const paddedRx = padData(rxData);
  const allTicks = [...paddedTx, ...paddedRx];

  if (allTicks.length === 0) {
    return {
      series: emptySeries,
      domain: {
        start: deviceTime.getTime() - WINDOW_SECONDS * 1000,
        end: deviceTime.getTime(),
      },
    };
  }

  const mostRecentT = Math.max(...allTicks.map((tick) => Number(tick.t)));

  return {
    series: [
      toSeries('tx', 'TX', 'accent', paddedTx, deviceTime, mostRecentT),
      toSeries('rx', 'RX', 'success', paddedRx, deviceTime, mostRecentT),
    ],
    domain: {
      start: deviceTime.getTime() - WINDOW_SECONDS * 1000,
      end: deviceTime.getTime(),
    },
  };
}
