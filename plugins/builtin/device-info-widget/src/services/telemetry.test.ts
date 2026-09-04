import type {ProjectedSeries} from '@mndw/sdk';
import {describe, expect, it} from 'vitest';
import {sparklineSamplesFromProjection, sparklineTimeDomainFromProjection} from './telemetry.js';

describe('sparklineSamplesFromProjection', () => {
  it('preserves timed gap points while mapping to MndwChartSample', () => {
    const series: ProjectedSeries = {
      supported: true,
      unit: 'percent',
      points: [{time: 1, value: 50}, {time: 2, value: NaN}, {time: 3, value: 75}],
      segments: [],
      bands: [],
      valueDomain: {min: 0, max: 100},
    };

    const samples = sparklineSamplesFromProjection(series);

    expect(samples).toEqual([
      {time: 1, value: 50},
      {time: 2, value: Number.NaN},
      {time: 3, value: 75},
    ]);
  });

  it('preserves all timed gaps for an empty projection', () => {
    const series: ProjectedSeries = {
      supported: true,
      unit: 'celsius',
      points: [{time: 1, value: NaN}],
      segments: [],
      bands: [],
    };

    expect(sparklineSamplesFromProjection(series)).toEqual([{time: 1, value: Number.NaN}]);
  });

  it('derives the time domain from the complete projected timeline', () => {
    const series: ProjectedSeries = {
      supported: true,
      unit: 'percent',
      points: [{time: 1_000, value: Number.NaN}, {time: 2_000, value: 50}, {time: 3_000, value: Number.NaN}],
      segments: [],
      bands: [],
    };

    expect(sparklineTimeDomainFromProjection(series)).toEqual({start: 1_000, end: 3_000});
  });
});
