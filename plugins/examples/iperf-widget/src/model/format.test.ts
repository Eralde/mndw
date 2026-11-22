import {describe, expect, it} from 'vitest';
import {formatBitRate, gaugeAngle, gaugeTop} from './format.js';

describe('speed formatting and gauge scale', () => {
  it('formats bit rates with locale-aware numbers', () => {
    expect(formatBitRate(412e6, 'en')).toBe('412 Mbit/s');
    expect(formatBitRate(1.25e9, 'en')).toBe('1.3 Gbit/s');
  });

  it('maps every scale tick exactly and stays monotonic as the range expands', () => {
    const ticks = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 2500, 10000].map((tick) => tick * 1e6);
    const angles = ticks.map((bps) => gaugeAngle(bps));

    expect(angles).toEqual([...angles].sort((a, b) => a - b));
    angles.forEach((angle, index) => {
      expect(angle).toBeCloseTo(index * 18, 10);
    });
    expect(gaugeAngle(1_001e6)).toBeGreaterThan(gaugeAngle(1_000e6));
    expect(gaugeAngle(2_501e6)).toBeGreaterThan(gaugeAngle(2_500e6));
  });

  it('extends the gauge range after one and two-and-a-half gigabits', () => {
    expect(gaugeTop(1_200e6)).toBe(2500);
    expect(gaugeTop(3_000e6)).toBe(10000);
  });
});
