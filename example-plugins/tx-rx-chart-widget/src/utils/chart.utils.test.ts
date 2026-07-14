import {describe, expect, it} from 'vitest';

import {formatSpeed, getSpeedUpperLimit, padData} from './chart.utils.js';

describe('formatSpeed', () => {
  it('formats zero and scales units', () => {
    expect(formatSpeed(0)).toBe('0 b/s');
    expect(formatSpeed(500)).toBe('500 b/s');
    expect(formatSpeed(1500)).toBe('1.5 Kb/s');
    expect(formatSpeed(2_000_000)).toBe('2.0 Mb/s');
  });
});

describe('getSpeedUpperLimit', () => {
  it('floors at the minimum and rounds up by magnitude', () => {
    expect(getSpeedUpperLimit(0)).toBe(5000);
    expect(getSpeedUpperLimit(1234)).toBe(5000);
    expect(getSpeedUpperLimit(73000)).toBe(80000);
  });
});

describe('padData', () => {
  it('left-pads with zero-value ticks to the expected length', () => {
    const padded = padData([{t: 100, v: 9}], 3);

    expect(padded).toHaveLength(3);
    expect(padded.at(-1)).toEqual({t: 100, v: 9});
    expect(padded.slice(0, 2).every((data) => data.v === 0)).toBe(true);
  });

  it('returns input unchanged when already long enough', () => {
    const data = [{t: 1, v: 1}, {t: 2, v: 2}];

    expect(padData(data, 2)).toBe(data);
  });
});
