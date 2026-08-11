import {describe, expect, it} from 'vitest';
import {filterValidRrdTicks, sortRrdTicks, toDeviceTimeMs} from './rrd.js';

describe('filterValidRrdTicks', () => {
  it('removes invalid timestamps and values, normalizes timestamps, and does not mutate input', () => {
    const input = [
      {t: '2', v: 20},
      {t: 'bad', v: 30},
      {t: 3, v: Number.NaN},
    ];

    expect(filterValidRrdTicks(input)).toEqual([{t: 2, v: 20}]);
    expect(input).toEqual([
      {t: '2', v: 20},
      {t: 'bad', v: 30},
      {t: 3, v: Number.NaN},
    ]);
  });
});

describe('sortRrdTicks', () => {
  it('returns samples in ascending timestamp order without mutating input', () => {
    const input = [{t: 30, v: 3}, {t: 10, v: 1}, {t: 20, v: 2}];

    expect(sortRrdTicks(input)).toEqual([
      {t: 10, v: 1},
      {t: 20, v: 2},
      {t: 30, v: 3},
    ]);
    expect(input).toEqual([{t: 30, v: 3}, {t: 10, v: 1}, {t: 20, v: 2}]);
  });
});

describe('toDeviceTimeMs', () => {
  it('maps newest RRD sample to device time and preserves second offsets', () => {
    expect(toDeviceTimeMs(10, 13, 1_000_000)).toBe(997_000);
    expect(toDeviceTimeMs(13, 13, 1_000_000)).toBe(1_000_000);
  });
});
