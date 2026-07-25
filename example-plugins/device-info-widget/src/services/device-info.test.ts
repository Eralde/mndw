import type {RciManager, RciQuery} from '@rci-tools/core';
import {of, throwError} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {fetchDeviceInfo, formatUptime} from './device-info.js';

/** Fake RciManager whose queue() dispatches on the query path so the two calls get distinct data. */
function fakeRci(handler: (q: RciQuery) => unknown): RciManager {
  return {queue: (q: RciQuery) => of(handler(q))} as unknown as RciManager;
}

describe('fetchDeviceInfo', () => {
  it('maps identification, system, version, and load data into the DeviceInfo model', async () => {
    const queries: RciQuery[] = [];
    const info = await fetchDeviceInfo({
      queue: (query: RciQuery) => {
        queries.push(query);

        switch (query.path) {
          case 'show.identification':
            return of({servicetag: 'ST', serial: 'SN', mac: 'AA:BB', hwid: 'HW', cid: 'CID'});
          case 'show.system':
            return of({uptime: 90061, cpuload: 27, memtotal: 1000, memory: '610/1024'});
          case 'show.version':
            return of({model: 'Keenetic Giga (KN-1011)'});
          case 'show.system.rrd.cpu':
            return of({data: [{t: '30', v: 21}, {t: 10, v: 18}]});
          case 'show.system.rrd.memory':
            return of({data: [{t: '30', v: 620}, {t: 10, v: 500}]});
          default:
            return throwError(() => new Error(`unexpected query: ${query.path}`));
        }
      },
    } as unknown as RciManager);

    expect(info).toEqual({
      model: 'Keenetic Giga (KN-1011)',
      uptimeSeconds: 90061,
      cpuLoadPercent: 27,
      ramLoadPercent: 61,
      cpuHistory: [18, 21],
      ramHistory: [50, 62],
      serial: 'SN',
      serviceTag: 'ST',
      mac: 'AA:BB',
      hwid: 'HW',
      cid: 'CID',
    });

    expect(queries).toEqual(expect.arrayContaining([
      {path: 'show.identification', extractData: true},
      {path: 'show.system', extractData: true},
      {path: 'show.version', extractData: true},
      {path: 'show.system.rrd.cpu', extractData: true, data: {detail: 0, attribute: 'avg'}},
      {path: 'show.system.rrd.memory', extractData: true, data: {detail: 0, attribute: 'used'}},
    ]));
  });

  it('coerces uptime given as a string (firmware 5.2 returns "984")', async () => {
    const info = await fetchDeviceInfo(fakeRci((q) => q.path === 'show.system' ? {uptime: '984'} : {}));

    expect(info.uptimeSeconds).toBe(984);
  });

  it('falls back per field when values are missing', async () => {
    const info = await fetchDeviceInfo(fakeRci(() => ({})));

    expect(info).toEqual({
      model: 'Unknown',
      uptimeSeconds: null,
      cpuLoadPercent: 0,
      ramLoadPercent: 0,
      cpuHistory: [],
      ramHistory: [],
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

  it('keeps RAM history when the CPU RRD query fails', async () => {
    const info = await fetchDeviceInfo({
      queue: (query: RciQuery) => {
        switch (query.path) {
          case 'show.identification':
            return of({});
          case 'show.system':
            return of({memtotal: 1000, memory: '610/1024'});
          case 'show.version':
            return of({});
          case 'show.system.rrd.cpu':
            return throwError(() => new Error('CPU RRD unavailable'));
          case 'show.system.rrd.memory':
            return of({data: [{t: 1, v: 500}]});
          default:
            return throwError(() => new Error(`unexpected query: ${query.path}`));
        }
      },
    } as unknown as RciManager);

    expect(info.cpuHistory).toEqual([]);
    expect(info.ramHistory).toEqual([50]);
  });

  it('keeps CPU history when the RAM RRD query fails', async () => {
    const info = await fetchDeviceInfo({
      queue: (query: RciQuery) => {
        switch (query.path) {
          case 'show.identification':
            return of({});
          case 'show.system':
            return of({cpuload: 27, memtotal: 1000, memory: '610/1024'});
          case 'show.version':
            return of({});
          case 'show.system.rrd.cpu':
            return of({data: [{t: 1, v: 27}]});
          case 'show.system.rrd.memory':
            return throwError(() => new Error('RAM RRD unavailable'));
          default:
            return throwError(() => new Error(`unexpected query: ${query.path}`));
        }
      },
    } as unknown as RciManager);

    expect(info.cpuHistory).toEqual([27]);
    expect(info.ramHistory).toEqual([]);
  });

  it('sorts samples and keeps only the newest 64 points', async () => {
    const samples = Array.from({length: 70}, (_, index) => ({t: String(70 - index), v: index}));
    const info = await fetchDeviceInfo({
      queue: (query: RciQuery) => {
        switch (query.path) {
          case 'show.identification':
            return of({});
          case 'show.system':
            return of({memtotal: 1000, memory: '0/1000'});
          case 'show.version':
            return of({});
          case 'show.system.rrd.cpu':
            return of({data: samples});
          case 'show.system.rrd.memory':
            return of({data: []});
          default:
            return throwError(() => new Error(`unexpected query: ${query.path}`));
        }
      },
    } as unknown as RciManager);

    expect(info.cpuHistory).toEqual(
      samples
        .sort((left, right) => Number(left.t) - Number(right.t))
        .slice(6)
        .map((sample) => sample.v),
    );
  });
});

describe('formatUptime', () => {
  it('includes seconds in the formatted uptime', () => {
    expect(formatUptime(0)).toBe('0 seconds');
    expect(formatUptime(59)).toBe('59 seconds');
    expect(formatUptime(61)).toBe('1 minute, 1 second');
    expect(formatUptime(90061)).toBe('1 day, 1 hour, 1 minute, 1 second');
  });

  it('joins non-zero pluralized parts', () => {
    expect(formatUptime(2 * 86400 + 3 * 3600 + 4 * 60 + 5)).toBe('2 days, 3 hours, 4 minutes, 5 seconds');
  });
});
