import {describe, expect, it} from 'vitest';
import type {MndwChartSeries} from './chart-types.js';
import {
  buildBarAriaLabel,
  buildLineAriaLabel,
  filterFinitePoints,
  formatSpeed,
  getSpeedUpperLimit,
  resolveDomain,
} from './chart-utils.js';

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

describe('filterFinitePoints', () => {
  it('filters invalid time and value fields without mutating input', () => {
    const points = [
      {time: 1000, value: 100},
      {time: Number.NaN, value: 200},
      {time: 3000, value: Number.POSITIVE_INFINITY},
    ];

    expect(filterFinitePoints(points)).toEqual([{time: 1000, value: 100}]);
    expect(points).toEqual([
      {time: 1000, value: 100},
      {time: Number.NaN, value: 200},
      {time: 3000, value: Number.POSITIVE_INFINITY},
    ]);
  });
});

describe('resolveDomain', () => {
  const points = [{time: 1000, value: 10}, {time: 3000, value: 30}];

  it('prefers a valid explicit domain', () => {
    expect(resolveDomain(points, {start: 0, end: 5000})).toEqual({start: 0, end: 5000});
  });

  it('derives a domain when explicit values are malformed or reversed', () => {
    expect(resolveDomain(points, {start: 4000, end: 1000})).toEqual({start: 1000, end: 3000});
    expect(resolveDomain(points, {start: Number.NaN, end: 5000})).toEqual({start: 1000, end: 3000});
  });

  it('returns null when no valid points exist', () => {
    expect(resolveDomain([{time: Number.NaN, value: 1}], undefined)).toBeNull();
  });
});

describe('accessibility fallback labels', () => {
  const series: MndwChartSeries[] = [
    {
      id: 'upload',
      label: 'Upload',
      color: 'accent',
      data: [
        {time: 1000, value: 100},
        {time: 2000, value: 200},
      ],
    },
  ];

  it('derives line labels from series labels', () => {
    expect(buildLineAriaLabel(series, 'No data')).toContain(
      'Upload: latest 200 b/s; range 100 b/s to 200 b/s',
    );
  });

  it('derives bar labels from the supplied noun', () => {
    expect(buildBarAriaLabel(series[0]?.data ?? [], 'Values', 'No data')).toContain(
      'Values: latest 200 b/s; range 100 b/s to 200 b/s',
    );
  });

  it('uses the empty label when bar data is invalid', () => {
    expect(buildBarAriaLabel([], 'Values', 'No data')).toBe('No data');
  });
});
