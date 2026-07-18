import {describe, expect, it} from 'vitest';
import {normalizeRefreshMs, refreshMsToSeconds, refreshSecondsToMs} from './refresh.utils.js';

describe('refreshSecondsToMs', () => {
  it('converts slider seconds, including half-second steps, to milliseconds', () => {
    expect(refreshSecondsToMs('1')).toBe(1000);
    expect(refreshSecondsToMs('2.5')).toBe(2500);
    expect(refreshSecondsToMs('5')).toBe(5000);
  });
});

describe('refreshMsToSeconds', () => {
  it('converts supported polling values to display seconds', () => {
    expect(refreshMsToSeconds(1000)).toBe(1);
    expect(refreshMsToSeconds(2500)).toBe(2.5);
    expect(refreshMsToSeconds(5000)).toBe(5);
  });
});

describe('normalizeRefreshMs', () => {
  it('keeps valid persisted values unchanged', () => {
    expect(normalizeRefreshMs('3500')).toBe(3500);
  });

  it('clamps old or invalid persisted values to the slider range and step', () => {
    expect(normalizeRefreshMs('500')).toBe(1000);
    expect(normalizeRefreshMs('6000')).toBe(5000);
    expect(normalizeRefreshMs('2750')).toBe(3000);
    expect(normalizeRefreshMs('not-a-number')).toBe(3000);
    expect(normalizeRefreshMs(null)).toBe(3000);
  });
});
