import {describe, expect, it} from 'vitest';
import {parseControllerTelemetry} from './controller-telemetry';

describe('parseControllerTelemetry', () => {
  it('assembles current values plus history series from raw RCI responses', () => {
    const now = 1_000_000;
    const result = parseControllerTelemetry(
      {cpuload: 12, memory: '500/1000', memtotal: 1000},
      {data: [{t: 100, v: 10}, {t: 103, v: 14}]},
      {data: [{t: 100, v: 400}, {t: 103, v: 500}]},
      [
        {interface: 'WifiMaster0', chart: {data: [{t: 200, v: {load: 28}}, {t: 203, v: {load: 31}}]}},
        {interface: 'WifiMaster1', chart: null},
      ],
      now,
    );

    expect(result?.cpuload).toBe(12);
    expect(result?.memoryUsed).toBe(500);
    expect(result?.memoryTotal).toBe(1000);
    expect(result?.telemetry.cpu).toEqual({times: [now - 3_000, now], values: [10, 14]});
    // Memory RRD is used-bytes; parseLiveTelemetry converts to percent against memtotal.
    expect(result?.telemetry.memory).toEqual({times: [now - 3_000, now], values: [40, 50]});
    expect(result?.telemetry.wifi24).toEqual({times: [now - 3_000, now], values: [28, 31]});
    expect(result?.telemetry.wifi5).toEqual({times: [], values: []});
  });

  it('degrades gracefully when the system query is missing', () => {
    const result = parseControllerTelemetry(null, null, null, [], 1_000);

    expect(result?.cpuload).toBeNull();
    expect(result?.memoryUsed).toBeNull();
    expect(result?.telemetry.cpu).toEqual({times: [], values: []});
  });
});
