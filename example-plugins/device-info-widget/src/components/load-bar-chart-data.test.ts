import {describe, expect, it} from 'vitest';

import {barIndexAt, computeChartBars, hasChartHistory, prepareChartHistory} from './load-bar-chart-data.js';

describe('load bar chart data', () => {
  it('normalizes finite values and discards non-finite values', () => {
    expect(prepareChartHistory([Number.NaN, -4, 12.4, 105])).toEqual([0, 12, 100]);
  });

  it('keeps only the newest 64 values', () => {
    const values = Array.from({length: 70}, (_, index) => index);

    expect(prepareChartHistory(values)).toEqual(values.slice(6));
  });

  it('reports whether history can be drawn', () => {
    expect(prepareChartHistory([])).toEqual([]);
    expect(hasChartHistory([])).toBe(false);
    expect(hasChartHistory([42])).toBe(true);
  });
});

describe('computeChartBars', () => {
  it('lays bars out evenly across the width and grows them upward from the baseline', () => {
    const bars = computeChartBars([0, 50, 100], 30, 20, 0);

    expect(bars).toEqual([
      {value: 0, left: 0, top: 19, width: 10, height: 1},
      {value: 50, left: 10, top: 10, width: 10, height: 10},
      {value: 100, left: 20, top: 0, width: 10, height: 20},
    ]);
  });

  it('reserves the gap between bars while keeping a minimum bar width', () => {
    const [bar] = computeChartBars([100, 100], 20, 20, 2);

    expect(bar).toMatchObject({left: 0, width: 8});
  });

  it('returns no bars for empty history or a collapsed box', () => {
    expect(computeChartBars([], 30, 20, 1)).toEqual([]);
    expect(computeChartBars([50], 0, 20, 1)).toEqual([]);
    expect(computeChartBars([50], 30, 0, 1)).toEqual([]);
  });
});

describe('barIndexAt', () => {
  it('maps an offset anywhere over the plot area to the bar under it', () => {
    expect(barIndexAt(0, 30, 3)).toBe(0);
    expect(barIndexAt(15, 30, 3)).toBe(1);
    expect(barIndexAt(29, 30, 3)).toBe(2);
  });

  it('clamps offsets that fall outside the plot area', () => {
    expect(barIndexAt(-5, 30, 3)).toBe(0);
    expect(barIndexAt(60, 30, 3)).toBe(2);
  });

  it('returns null when there is nothing to hover', () => {
    expect(barIndexAt(10, 30, 0)).toBeNull();
    expect(barIndexAt(10, 0, 3)).toBeNull();
  });
});
