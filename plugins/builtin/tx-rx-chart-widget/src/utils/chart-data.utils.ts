import type {MndwChartDomain, MndwChartPoint, MndwChartSeries} from '@mndw/ui';
import {type NumericRrdTick, type RrdTick, filterValidRrdTicks, toDeviceTimeMs} from '@mndw/sdk/rrd';

export const EXPECTED_POINTS = 64;
export const INTERVAL_SECONDS = 3;
export const WINDOW_SECONDS = EXPECTED_POINTS * INTERVAL_SECONDS;

export interface TxRxChartData {
  series: MndwChartSeries[];
  domain: MndwChartDomain | undefined;
}

const padData = (ticks: readonly RrdTick[]): NumericRrdTick[] => {
  const valid = filterValidRrdTicks(ticks);

  if (valid.length === 0 || valid.length >= EXPECTED_POINTS) {
    return [...valid];
  }

  const minT = Math.min(...valid.map((tick) => tick.t));
  const padCount = EXPECTED_POINTS - valid.length;
  const pads: NumericRrdTick[] = [];

  for (let index = 0; index < padCount; index += 1) {
    pads.push({t: minT - (padCount - index) * INTERVAL_SECONDS, v: 0});
  }

  return [...pads, ...valid];
};

const toSeries = (
  id: string,
  label: string,
  color: 'accent' | 'success',
  ticks: readonly NumericRrdTick[],
  deviceTime: Date,
  mostRecentT: number,
): MndwChartSeries => {
  const data: MndwChartPoint[] = ticks.map((tick) => ({
    time: toDeviceTimeMs(tick.t, mostRecentT, deviceTime.getTime()),
    value: tick.v,
  }));

  return {id, label, color, fill: true, data};
};

export const getMostRecentRrdTimestamp = (
  txData: readonly RrdTick[],
  rxData: readonly RrdTick[],
): number | null => {
  const ticks = [...filterValidRrdTicks(txData), ...filterValidRrdTicks(rxData)];

  return ticks.length === 0 ? null : Math.max(...ticks.map((tick) => tick.t));
};

export function toTxRxChartData(
  txData: readonly RrdTick[],
  rxData: readonly RrdTick[],
  deviceTime: Date | null,
  deviceTimeRrdTimestamp: number | null = null,
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

  const mostRecentT = Math.max(...allTicks.map((tick) => tick.t));
  const projectedDeviceTime = new Date(
    deviceTime.getTime()
      + (deviceTimeRrdTimestamp === null ? 0 : mostRecentT - deviceTimeRrdTimestamp) * 1000,
  );

  return {
    series: [
      toSeries('tx', 'TX', 'accent', paddedTx, projectedDeviceTime, mostRecentT),
      toSeries('rx', 'RX', 'success', paddedRx, projectedDeviceTime, mostRecentT),
    ],
    domain: {
      start: projectedDeviceTime.getTime() - WINDOW_SECONDS * 1000,
      end: projectedDeviceTime.getTime(),
    },
  };
}
