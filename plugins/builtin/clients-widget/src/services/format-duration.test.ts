import {describe, expect, it} from 'vitest';
import {formatCompactDuration, formatElapsed, formatFullDuration} from './format-duration.js';

describe('formatCompactDuration', () => {
  it.each([
    [0, '0s'],
    [1, '1s'],
    [45, '45s'],
    [59, '59s'],
    [60, '1m'],
    [90, '1m 30s'],
    [1483, '24m 43s'],
    [3600, '1h'],
    [8100, '2h 15m'],
    [86_400, '1d'],
    [99_000, '1d 3h'],
  ])('renders %i seconds as %s', (seconds, expected) => {
    expect(formatCompactDuration(seconds)).toBe(expected);
  });

  it('shows at most two units, dropping smaller ones entirely', () => {
    expect(formatCompactDuration(99_015)).toBe('1d 3h');
  });

  it('omits a zero second unit rather than printing "2h 0m"', () => {
    expect(formatCompactDuration(7200)).toBe('2h');
    expect(formatCompactDuration(120)).toBe('2m');
  });

  it('skips over a zero middle unit', () => {
    expect(formatCompactDuration(88_200)).toBe('1d 30m');
  });

  it('floors fractional seconds and clamps negatives to zero', () => {
    expect(formatCompactDuration(90.9)).toBe('1m 30s');
    expect(formatCompactDuration(-5)).toBe('0s');
  });
});

describe('formatElapsed', () => {
  it('appends " ago" to the compact form', () => {
    expect(formatElapsed(1483)).toBe('24m 43s ago');
    expect(formatElapsed(8100)).toBe('2h 15m ago');
    expect(formatElapsed(0)).toBe('0s ago');
  });
});

describe('formatFullDuration', () => {
  it.each([
    [0, '0 seconds'],
    [1, '1 second'],
    [45, '45 seconds'],
    [90, '1 minute, 30 seconds'],
    [8100, '2 hours, 15 minutes'],
    [99_000, '1 day, 3 hours, 30 minutes'],
  ])('renders %i seconds as %s', (seconds, expected) => {
    expect(formatFullDuration(seconds)).toBe(expected);
  });

  it('pluralizes each unit independently', () => {
    expect(formatFullDuration(90_061)).toBe('1 day, 1 hour, 1 minute, 1 second');
  });
});
