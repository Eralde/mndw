import {describe, expect, it} from 'vitest';
import {EXPECTED_POINTS, INTERVAL_SECONDS, WINDOW_SECONDS, toTxRxChartData} from './chart-data.utils';

describe('toTxRxChartData', () => {
  const deviceTime = new Date('2026-01-01T12:00:00.000Z');

  it('converts relative RRD ticks to epoch-millisecond points', () => {
    const result = toTxRxChartData(
      [{t: 10, v: 100}, {t: 13, v: 200}],
      [{t: 13, v: 50}],
      deviceTime,
    );

    expect(result.series[0]?.data.at(-1)).toEqual({time: deviceTime.getTime(), value: 200});
    expect(result.series[1]?.data.at(-1)).toEqual({time: deviceTime.getTime(), value: 50});
  });

  it('accepts string RRD timestamps returned by the router', () => {
    const result = toTxRxChartData(
      [{t: '10', v: 100}],
      [{t: '13', v: 50}],
      deviceTime,
    );

    expect(result.series[0]?.data.at(-1)).toEqual({time: deviceTime.getTime() - 3000, value: 100});
    expect(result.series[1]?.data.at(-1)).toEqual({time: deviceTime.getTime(), value: 50});
  });

  it('filters invalid ticks before sparse-data padding', () => {
    const result = toTxRxChartData(
      [{t: 'bad', v: 100}, {t: '10', v: 7}],
      [{t: Number.NaN, v: 5}],
      deviceTime,
    );

    expect(result.series[0]?.data).toHaveLength(EXPECTED_POINTS);
    expect(result.series[0]?.data.at(-1)).toEqual({time: deviceTime.getTime(), value: 7});
    expect(result.series[1]?.data).toEqual([]);
  });

  it('sets plugin series labels, colors, fills, and fixed window domain', () => {
    const result = toTxRxChartData([{t: 10, v: 100}], [{t: 10, v: 50}], deviceTime);

    expect(result.series).toMatchObject([
      {id: 'tx', label: 'TX', color: 'accent', fill: true},
      {id: 'rx', label: 'RX', color: 'success', fill: true},
    ]);
    expect(result.domain).toEqual({
      start: deviceTime.getTime() - WINDOW_SECONDS * 1000,
      end: deviceTime.getTime(),
    });
  });

  it('left-pads sparse data at the configured interval', () => {
    const result = toTxRxChartData([{t: 100, v: 9}], [], deviceTime);
    const data = result.series[0]?.data ?? [];

    expect(data).toHaveLength(EXPECTED_POINTS);
    expect(data.slice(0, -1).every((point) => point.value === 0)).toBe(true);
    expect(data.at(-1)?.time).toBe(deviceTime.getTime());
    expect(data.at(-2)?.time).toBe(deviceTime.getTime() - INTERVAL_SECONDS * 1000);
  });

  it('keeps empty series empty and handles a null device time', () => {
    const empty = toTxRxChartData([], [], deviceTime);
    const noTime = toTxRxChartData([{t: 10, v: 1}], [{t: 10, v: 1}], null);

    expect(empty.series[0]?.data).toEqual([]);
    expect(empty.series[1]?.data).toEqual([]);
    expect(noTime.series[0]?.data).toEqual([]);
    expect(noTime.series[1]?.data).toEqual([]);
    expect(noTime.domain).toBeUndefined();
  });
});
