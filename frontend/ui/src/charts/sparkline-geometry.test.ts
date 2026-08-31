import {describe, expect, it} from 'vitest';
import {barIndexAt, computeSparklineBars} from './sparkline-geometry.js';

describe('computeSparklineBars', () => {
  it('lays bars out evenly with a gap and a baseline-anchored height', () => {
    const bars = computeSparklineBars([0, 50, 100], 100, 30, 20, 2);

    expect(bars).toHaveLength(3);
    expect(bars.map((bar) => bar.left)).toEqual([0, 10, 20]);
    expect(bars.every((bar) => bar.width === 8)).toBe(true);
    // 0% floors to 1px; 50% -> 10px from the baseline (top 10); 100% -> full height.
    expect(bars.map((bar) => bar.height)).toEqual([1, 10, 20]);
    expect(bars.map((bar) => bar.top)).toEqual([19, 10, 0]);
  });

  it('scales against max and clamps out-of-range and non-finite values', () => {
    const bars = computeSparklineBars([-5, Number.NaN, 300], 200, 30, 20, 0);

    expect(bars.map((bar) => bar.height)).toEqual([1, 1, 20]);
  });

  it('returns nothing for empty input or a degenerate box', () => {
    expect(computeSparklineBars([], 100, 30, 20, 1)).toEqual([]);
    expect(computeSparklineBars([50], 100, 0, 20, 1)).toEqual([]);
    expect(computeSparklineBars([50], 0, 30, 20, 1)).toEqual([]);
  });
});

describe('barIndexAt', () => {
  it('maps an offset to the bar beneath it and clamps to the ends', () => {
    expect(barIndexAt(0, 30, 3)).toBe(0);
    expect(barIndexAt(15, 30, 3)).toBe(1);
    expect(barIndexAt(29, 30, 3)).toBe(2);
    expect(barIndexAt(999, 30, 3)).toBe(2);
    expect(barIndexAt(5, 30, 0)).toBeNull();
  });
});
