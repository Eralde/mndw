import {describe, expect, it} from 'vitest';
import type {HostBar} from '../types.js';
import {toDeviceTrafficChartData} from './chart-data.js';

describe('toDeviceTrafficChartData', () => {
  const deviceTime = new Date('2026-01-01T12:00:00.000Z');
  const host: HostBar = {
    mac: 'aa:bb',
    bars: [
      {
        attribute: 'sumspeed',
        data: [{t: 'bad', v: 999}, {t: '20', v: 200}, {t: 10, v: 100}],
      },
      {
        attribute: 'txspeed',
        data: [{t: 1, v: 300}, {t: 2, v: 500}],
      },
      {
        attribute: 'rxspeed',
        data: [{t: 1, v: 100}, {t: 2, v: 200}],
      },
    ],
  };

  it('filters, sorts, and maps sumspeed points to device time', () => {
    const result = toDeviceTrafficChartData([host], deviceTime);

    expect(result.points).toEqual([
      {time: deviceTime.getTime() - 10_000, value: 100},
      {time: deviceTime.getTime(), value: 200},
    ]);
  });

  it('computes average TX and RX values from their own attributes', () => {
    const result = toDeviceTrafficChartData([host], deviceTime);

    expect(result.averageTx).toBe(400);
    expect(result.averageRx).toBe(150);
  });

  it('returns empty points and zero averages for missing data', () => {
    const result = toDeviceTrafficChartData([], deviceTime);
    const missingAttributes = toDeviceTrafficChartData([{mac: 'aa:bb', bars: []}], deviceTime);

    expect(result).toEqual({points: [], averageTx: 0, averageRx: 0});
    expect(missingAttributes).toEqual({points: [], averageTx: 0, averageRx: 0});
  });

  it('does not mutate input and omits points without device time', () => {
    const input = structuredClone([host]);
    const result = toDeviceTrafficChartData(input, null);

    expect(result.points).toEqual([]);
    expect(result.averageTx).toBe(400);
    expect(result.averageRx).toBe(150);
    expect(input).toEqual([host]);
  });
});
