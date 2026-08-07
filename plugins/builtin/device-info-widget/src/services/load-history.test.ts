import {describe, expect, it} from 'vitest';

import {normalizeHistory, normalizePercent} from './load-history.js';

describe('normalizePercent', () => {
  it('rounds and clamps finite values to the percentage range', () => {
    expect(normalizePercent(-1)).toBe(0);
    expect(normalizePercent(42.6)).toBe(43);
    expect(normalizePercent(101)).toBe(100);
  });

  it('rejects non-finite values', () => {
    expect(normalizePercent(Number.NaN)).toBeNull();
    expect(normalizePercent(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('normalizeHistory', () => {
  it('filters invalid values and normalizes valid values', () => {
    expect(normalizeHistory([Number.NaN, -4, 12.4, 105])).toEqual([0, 12, 100]);
  });

  it('keeps the newest 64 normalized values', () => {
    const values = Array.from({length: 70}, (_, index) => index);

    expect(normalizeHistory(values)).toEqual(values.slice(6));
  });

  it('returns an empty array for empty input', () => {
    expect(normalizeHistory([])).toEqual([]);
  });
});
