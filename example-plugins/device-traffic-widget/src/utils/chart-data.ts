import type {MndwChartPoint} from '@mndw/ui';
import type {BarTick, HostBar} from '../types.js';

export interface DeviceTrafficChartData {
  points: MndwChartPoint[];
  averageTx: number;
  averageRx: number;
}

const attributeData = (bar: HostBar, attribute: string): BarTick[] => {
  return bar.bars.find((item) => item.attribute === attribute)?.data ?? [];
};

const average = (data: readonly BarTick[]): number => {
  const valid = data.filter((point) => Number.isFinite(point.v));

  if (valid.length === 0) {
    return 0;
  }

  return valid.reduce((sum, point) => sum + point.v, 0) / valid.length;
};

export function toDeviceTrafficChartData(
  data: readonly HostBar[],
  deviceTime: Date | null,
): DeviceTrafficChartData {
  const host = data[0];

  if (host === undefined) {
    return {points: [], averageTx: 0, averageRx: 0};
  }

  const sumspeed = attributeData(host, 'sumspeed')
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .sort((first, second) => first.t - second.t);
  const txspeed = attributeData(host, 'txspeed');
  const rxspeed = attributeData(host, 'rxspeed');

  if (deviceTime === null || sumspeed.length === 0) {
    return {
      points: [],
      averageTx: average(txspeed),
      averageRx: average(rxspeed),
    };
  }

  const mostRecentT = sumspeed[sumspeed.length - 1]?.t;

  if (mostRecentT === undefined) {
    return {
      points: [],
      averageTx: average(txspeed),
      averageRx: average(rxspeed),
    };
  }

  return {
    points: sumspeed.map((point) => ({
      time: deviceTime.getTime() - (mostRecentT - point.t) * 1000,
      value: point.v,
    })),
    averageTx: average(txspeed),
    averageRx: average(rxspeed),
  };
}
