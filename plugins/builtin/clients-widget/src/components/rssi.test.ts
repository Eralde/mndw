import {describe, expect, it} from 'vitest';
import {DEFAULT_RSSI_THRESHOLDS, isValidRssiThresholds, rssiQuality} from './rssi.js';

describe('rssiQuality', () => {
  it.each(
    [
      [-64, 'good'],
      [-65, 'good'],
      [-66, 'fair'],
      [-75, 'fair'],
      [-76, 'weak'],
      [-90, 'weak'],
    ] as const,
  )('maps %s dBm to %s with the default thresholds', (rssi, quality) => {
    expect(rssiQuality(rssi, DEFAULT_RSSI_THRESHOLDS)).toBe(quality);
  });

  it('maps a missing or non-finite RSSI to unknown', () => {
    expect(rssiQuality(null, DEFAULT_RSSI_THRESHOLDS)).toBe('unknown');
    expect(rssiQuality(Number.NaN, DEFAULT_RSSI_THRESHOLDS)).toBe('unknown');
    expect(rssiQuality(Number.POSITIVE_INFINITY, DEFAULT_RSSI_THRESHOLDS)).toBe('unknown');
  });

  it('uses custom thresholds', () => {
    const thresholds = {good: -50, fair: -60};

    expect(rssiQuality(-50, thresholds)).toBe('good');
    expect(rssiQuality(-51, thresholds)).toBe('fair');
    expect(rssiQuality(-60, thresholds)).toBe('fair');
    expect(rssiQuality(-61, thresholds)).toBe('weak');
  });
});

describe('isValidRssiThresholds', () => {
  it.each([
    [{good: -65, fair: -75}],
    [{good: -20, fair: -100}],
  ])('accepts %j', (value) => {
    expect(isValidRssiThresholds(value)).toBe(true);
  });

  it.each([
    ['missing', null],
    ['non-object', 'good'],
    ['non-integer', {good: -65.5, fair: -75}],
    ['out of range', {good: -19, fair: -75}],
    ['out of range', {good: -65, fair: -101}],
    ['good not above fair', {good: -75, fair: -75}],
    ['good below fair', {good: -80, fair: -70}],
    ['missing field', {good: -65}],
  ])('rejects %s', (_label, value) => {
    expect(isValidRssiThresholds(value)).toBe(false);
  });
});
