import {describe, expect, it} from 'vitest';
import {formatCpuLoad, formatMemory, formatRate, formatRssi, formatSpeed, formatUptime} from './format';

describe('telemetry formatters', () => {
  it('uses a dash for missing and non-finite values', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatCpuLoad(Number.NaN)).toBe('—');
    expect(formatRssi(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
  });

  it('formats uptime using two truncated units', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(48)).toBe('48s');
    expect(formatUptime(19 * 3_600 + 12 * 60)).toBe('19h 12m');
    expect(formatUptime(4 * 86_400 + 7 * 3_600 + 12 * 60)).toBe('4d 7h');
    expect(formatUptime(-1)).toBe('—');
  });

  it('converts memory from KiB and clamps CPU load', () => {
    expect(formatMemory(171_412, 262_144)).toBe('167 / 256 MiB');
    expect(formatMemory(5120, 262_144)).toBe('5.0 / 256 MiB');
    expect(formatCpuLoad(-4)).toBe('0%');
    expect(formatCpuLoad(101)).toBe('100%');
    expect(formatCpuLoad(42.5)).toBe('43%');
  });

  it('formats rates, speeds, and RSSI with documented boundaries', () => {
    expect(formatRssi(-61.5)).toBe('−61 dBm');
    expect(formatRate(0)).toBe('—');
    expect(formatRate(1201)).toBe('1.2 Gbit/s');
    expect(formatRate(1000)).toBe('1 Gbit/s');
    expect(formatSpeed('100')).toBe('100 Mbit/s');
    expect(formatSpeed('not-a-speed')).toBe('—');
  });
});
