import {describe, expect, it} from 'vitest';

import {hasChartHistory, prepareChartHistory} from './load-bar-chart-data.js';

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
