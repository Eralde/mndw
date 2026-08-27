import {describe, expect, it} from 'vitest';

import {createUptimeBaseline, getUptimeSeconds} from './uptime.js';

describe('uptime baseline', () => {
  it('returns null when device uptime is unavailable', () => {
    const baseline = createUptimeBaseline(null, 10_000);

    expect(baseline).toBeNull();
    expect(getUptimeSeconds(baseline, 10_000)).toBeNull();
  });

  it('adds elapsed whole seconds to the synchronized device value', () => {
    const baseline = createUptimeBaseline(1000, 10_000);

    expect(baseline).toEqual({deviceSeconds: 1000, syncedAtMs: 10_000});
    expect(getUptimeSeconds(baseline, 10_000)).toBe(1000);
    expect(getUptimeSeconds(baseline, 10_999)).toBe(1000);
    expect(getUptimeSeconds(baseline, 11_000)).toBe(1001);
  });

  it('uses a later device response as a new baseline', () => {
    const oldBaseline = createUptimeBaseline(1000, 10_000);
    const newBaseline = createUptimeBaseline(2000, 20_000);

    expect(getUptimeSeconds(oldBaseline, 20_000)).toBe(1010);
    expect(getUptimeSeconds(newBaseline, 20_000)).toBe(2000);
  });
});
