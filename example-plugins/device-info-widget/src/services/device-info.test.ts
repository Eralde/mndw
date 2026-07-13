import {of, throwError} from 'rxjs';
import type {RciManager, RciQuery} from '@rci-tools/core';
import {describe, expect, it} from 'vitest';

import {fetchDeviceInfo, formatUptime} from './device-info.js';

/** Fake RciManager whose queue() dispatches on the query path so the two calls get distinct data. */
function fakeRci(handler: (q: RciQuery) => unknown): RciManager {
  return {queue: (q: RciQuery) => of(handler(q))} as unknown as RciManager;
}

describe('fetchDeviceInfo', () => {
  it('maps identification + system into the DeviceInfo model', async () => {
    const info = await fetchDeviceInfo(fakeRci((q) =>
      q.path === 'show.identification'
        ? {servicetag: 'ST', serial: 'SN', mac: 'AA:BB', hwid: 'HW', cid: 'CID'}
        : {model: 'Keenetic Giga', uptime: 90061}
    ));

    expect(info).toEqual({
      model: 'Keenetic Giga',
      uptimeSeconds: 90061,
      serial: 'SN',
      serviceTag: 'ST',
      mac: 'AA:BB',
      hwid: 'HW',
      cid: 'CID',
    });
  });

  it('falls back per field when values are missing', async () => {
    const info = await fetchDeviceInfo(fakeRci(() => ({})));

    expect(info).toEqual({
      model: 'Unknown',
      uptimeSeconds: null,
      serial: '',
      serviceTag: '',
      mac: '',
      hwid: '',
      cid: '',
    });
  });

  it('rejects when a query errors (no device)', async () => {
    const rci = {queue: () => throwError(() => new Error('no device'))} as unknown as RciManager;

    await expect(fetchDeviceInfo(rci)).rejects.toThrow('no device');
  });
});

describe('formatUptime', () => {
  it('returns "< 1 minute" under 60s', () => {
    expect(formatUptime(59)).toBe('< 1 minute');
  });

  it('joins non-zero pluralized parts', () => {
    expect(formatUptime(90061)).toBe('1 day, 1 hour, 1 minute');
    expect(formatUptime(2 * 86400 + 3 * 3600 + 4 * 60)).toBe('2 days, 3 hours, 4 minutes');
  });
});
